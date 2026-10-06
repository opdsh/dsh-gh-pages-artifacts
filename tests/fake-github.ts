/**
 * In-memory GitHub REST fake covering the endpoints the plugin uses: users, repositories,
 * Git Data (refs, commits, trees, blobs), contents PUT for empty repositories, and Pages.
 * Objects are content-addressed, trees are nested like real git, and ref updates enforce
 * fast-forward, so concurrency and retry paths behave like the real API.
 */
import { createHash } from 'node:crypto'

export interface FakeRepo {
  readonly owner: string
  readonly name: string
  empty: boolean
  defaultBranch: string
  refs: Map<string, string>
  pages?: { branch: string; path: '/' | '/docs'; buildType?: 'legacy' | 'workflow'; htmlUrl?: string }
  push: boolean
  /** Polls of builds/latest that still report the head as building. */
  buildLag?: number
  /** Ref updates are rejected like a protected branch. */
  protectedBranch?: boolean
  topics?: string[]
  /** The token lacks Pages: read (Pages endpoints answer 403). */
  pagesForbidden?: boolean
  private?: boolean
}

interface Commit { tree: string; parents: string[]; message: string; author?: { name: string; email: string } }
interface TreeEntry { path: string; mode: string; type: 'blob' | 'tree'; sha: string }

export interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly path: string
  readonly body: unknown
  readonly authorization: string | null
}

type Interceptor = (request: RecordedRequest) => Response | undefined | Promise<Response | undefined>

export class FakeGitHub {
  readonly repos = new Map<string, FakeRepo>()
  readonly blobs = new Map<string, Buffer>()
  readonly trees = new Map<string, TreeEntry[]>()
  readonly commits = new Map<string, Commit>()
  readonly requests: RecordedRequest[] = []
  readonly interceptors: Interceptor[] = []
  token = 'ghp_faketoken000000000000000000000000000000'
  login = 'octo'
  /** Organizations the user belongs to. */
  readonly orgs = new Set<string>()
  apiBase = 'https://api.github.com'

  constructor() {
    this.trees.set(this.hashTree([]), [])
  }

  /** Create a repository, optionally with a branch holding the given files. */
  addRepo(name: string, options: { owner?: string; branch?: string; files?: Record<string, string>; pages?: FakeRepo['pages'] | null; empty?: boolean } = {}): FakeRepo {
    const owner = options.owner ?? this.login
    const repo: FakeRepo = {
      owner, name, empty: options.empty ?? false, defaultBranch: 'main', refs: new Map(), push: true,
      ...options.pages === null ? {} : { pages: options.pages ?? { branch: options.branch ?? 'gh-pages', path: '/' } },
    }
    this.repos.set(`${owner}/${name}`.toLowerCase(), repo)
    if (!repo.empty) {
      const main = this.commitFiles({ 'README.md': '# artifacts\n' }, [], 'Initial commit')
      repo.refs.set('main', main)
      if (options.branch !== undefined && options.branch !== 'main') {
        repo.refs.set(options.branch, this.commitFiles(options.files ?? { '.nojekyll': '' }, [], 'init pages'))
      } else if (options.files !== undefined) {
        repo.refs.set('main', this.commitFiles({ 'README.md': '# artifacts\n', ...options.files }, [main], 'files'))
      }
    }
    return repo
  }

  /** Files of a branch head as path -> text. */
  filesOf(repo: FakeRepo, branch: string): Map<string, string> {
    const head = repo.refs.get(branch)
    if (head === undefined) return new Map()
    const out = new Map<string, string>()
    for (const [path, sha] of this.flatten(this.commits.get(head)!.tree)) out.set(path, this.blobs.get(sha)!.toString('utf8'))
    return out
  }

  /** Push a commit that writes `files` on top of `branch`, like another client would. */
  pushFiles(repo: FakeRepo, branch: string, files: Record<string, string>, message = 'concurrent change'): string {
    const head = repo.refs.get(branch)
    const flat = head === undefined ? new Map<string, string>() : this.flatten(this.commits.get(head)!.tree)
    for (const [path, text] of Object.entries(files)) flat.set(path, this.putBlob(Buffer.from(text)))
    const sha = this.putCommit({ tree: this.buildTree(flat), parents: head === undefined ? [] : [head], message })
    repo.refs.set(branch, sha)
    return sha
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    init?.signal?.throwIfAborted()
    const request: RecordedRequest = { method, url: url.href, path: url.pathname + url.search, body, authorization: headers.get('authorization') }
    this.requests.push(request)
    for (const interceptor of [...this.interceptors]) {
      const response = await interceptor(request)
      if (response !== undefined) return response
    }
    if (!url.href.startsWith(this.apiBase)) return this.servePages(url, method)
    if (headers.get('authorization') !== `Bearer ${this.token}`) return json(401, { message: 'Bad credentials' })
    if (headers.get('user-agent') === null) return json(403, { message: 'Missing User-Agent' })
    return this.route(method, url, body)
  }

  private route(method: string, url: URL, body: unknown): Response {
    const path = url.pathname.slice(new URL(this.apiBase).pathname.replace(/\/$/, '').length)
    if (method === 'GET' && path === '/user') return json(200, { login: this.login })
    if (method === 'GET' && path === '/user/repos') {
      const page = Number(url.searchParams.get('page') ?? '1')
      const all = [...this.repos.values()].map(repo => ({ name: repo.name, owner: { login: repo.owner }, topics: repo.topics ?? [] }))
      return json(200, all.slice((page - 1) * 100, page * 100))
    }
    const user = /^\/users\/([^/]+)$/.exec(path)
    if (user !== null && method === 'GET') {
      const name = decodeURIComponent(user[1]!)
      if (this.orgs.has(name.toLowerCase())) return json(200, { login: name, type: 'Organization' })
      return json(200, { login: name, type: 'User' })
    }
    const create = path === '/user/repos' ? this.login : /^\/orgs\/([^/]+)\/repos$/.exec(path)?.[1]
    if (create !== undefined && method === 'POST') {
      const owner = decodeURIComponent(create)
      if (path !== '/user/repos' && !this.orgs.has(owner.toLowerCase())) return json(404, { message: 'Not Found' })
      const b = (body ?? {}) as Record<string, any>
      if (this.repos.has(`${owner}/${String(b.name)}`.toLowerCase())) return json(422, { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] })
      const created = this.addRepo(String(b.name), { owner, empty: b.auto_init !== true, pages: null })
      created.private = b.private === true
      return json(201, { full_name: `${owner}/${created.name}`, html_url: `https://github.com/${owner}/${created.name}`, private: created.private })
    }
    const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path)
    if (match === null) return json(404, { message: 'Not Found' })
    const repo = this.repos.get(`${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`.toLowerCase())
    if (repo === undefined) return json(404, { message: 'Not Found' })
    const rest = match[3] ?? ''
    const b = (body ?? {}) as Record<string, any>

    if (rest === '' && method === 'GET') return json(200, { full_name: `${repo.owner}/${repo.name}`, private: repo.private === true, permissions: { push: repo.push, admin: true } })
    if (rest.startsWith('/pages') && repo.pagesForbidden === true) {
      return json(403, { message: 'Resource not accessible by personal access token' }, { 'x-accepted-github-permissions': 'pages=read' })
    }
    if (rest === '/pages' && method === 'GET') {
      if (repo.pages === undefined) return json(404, { message: 'Not Found' })
      return json(200, {
        html_url: repo.pages.htmlUrl ?? `http://${repo.owner.toLowerCase()}.github.io/${repo.name}/`,
        source: { branch: repo.pages.branch, path: repo.pages.path }, build_type: repo.pages.buildType ?? 'legacy', status: 'built',
      })
    }
    if (rest === '/topics' && method === 'PUT') {
      repo.topics = [...(b.names ?? [])]
      return json(200, { names: repo.topics })
    }
    if (rest === '/pages' && (method === 'POST' || method === 'PUT')) {
      if (method === 'POST' && repo.pages !== undefined) return json(409, { message: 'GitHub Pages is already enabled.' })
      if (method === 'PUT' && repo.pages === undefined) return json(404, { message: 'Not Found' })
      const source = (b.source ?? {}) as { branch?: string; path?: '/' | '/docs' }
      if (source.branch === undefined || !repo.refs.has(source.branch)) return json(422, { message: 'The selected branch does not exist' })
      repo.pages = { branch: source.branch, path: source.path ?? '/', buildType: b.build_type === 'workflow' ? 'workflow' : 'legacy' }
      return method === 'POST' ? json(201, { html_url: `https://${repo.owner.toLowerCase()}.github.io/${repo.name}/` }) : new Response(null, { status: 204 })
    }
    if (rest === '/pages/builds/latest' && method === 'GET') {
      if (repo.pages === undefined) return json(404, { message: 'Not Found' })
      const head = repo.refs.get(repo.pages.branch) ?? null
      if ((repo.buildLag ?? 0) > 0) {
        repo.buildLag = repo.buildLag! - 1
        return json(200, { status: 'building', commit: head, error: { message: null } })
      }
      return json(200, { status: 'built', commit: head, error: { message: null } })
    }
    const contents = /^\/contents\/(.+)$/.exec(rest)
    if (contents !== null && method === 'PUT') {
      const filePath = decodeURIComponent(contents[1]!)
      const text = Buffer.from(String(b.content), 'base64').toString('utf8')
      if (repo.empty) {
        const sha = this.commitFiles({ [filePath]: text }, [], String(b.message), b.author)
        repo.empty = false
        repo.refs.set(repo.defaultBranch, sha)
        return json(201, { commit: { sha } })
      }
      const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch
      if (this.filesOf(repo, branch).has(filePath)) return json(422, { message: '"sha" wasn\'t supplied.' })
      const sha = this.pushFiles(repo, branch, { [filePath]: text }, String(b.message))
      return json(201, { commit: { sha } })
    }
    if (repo.empty && rest.startsWith('/git/')) return json(409, { message: 'Git Repository is empty.' })

    // Like GitHub: reads use the singular git/ref, updates the plural git/refs.
    const ref = method === 'GET' ? /^\/git\/ref\/heads\/(.+)$/.exec(rest) : method === 'PATCH' ? /^\/git\/refs\/heads\/(.+)$/.exec(rest) : null
    if (ref !== null) {
      const branch = decodeURIComponent(ref[1]!)
      const current = repo.refs.get(branch)
      if (method === 'GET') return current === undefined ? json(404, { message: 'Not Found' }) : json(200, { ref: `refs/heads/${branch}`, object: { type: 'commit', sha: current } })
      if (method === 'PATCH') {
        if (current === undefined) return json(422, { message: 'Reference does not exist' })
        const next = String(b.sha)
        if (!this.commits.has(next)) return json(422, { message: 'Object does not exist' })
        if (repo.protectedBranch === true) return json(422, { message: `Protected branch update failed for refs/heads/${branch}.` })
        if (b.force !== true && !this.isAncestor(current, next)) return json(422, { message: 'Update is not a fast forward' })
        repo.refs.set(branch, next)
        return json(200, { ref: `refs/heads/${branch}`, object: { type: 'commit', sha: next } })
      }
    }
    if (rest === '/git/refs' && method === 'POST') {
      const branch = String(b.ref).replace(/^refs\/heads\//, '')
      if (repo.refs.has(branch)) return json(422, { message: 'Reference already exists' })
      if (!this.commits.has(String(b.sha))) return json(422, { message: 'Object does not exist' })
      repo.refs.set(branch, String(b.sha))
      // Observed on github.com: pushing a gh-pages branch enables Pages from it.
      if (branch === 'gh-pages' && repo.pages === undefined) repo.pages = { branch: 'gh-pages', path: '/' }
      return json(201, { ref: b.ref, object: { sha: b.sha } })
    }
    const commit = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest)
    if (commit !== null && method === 'GET') {
      const found = this.commits.get(commit[1]!)
      if (found === undefined) return json(404, { message: 'Not Found' })
      return json(200, { sha: commit[1], tree: { sha: found.tree }, parents: found.parents.map(sha => ({ sha })), message: found.message })
    }
    if (rest === '/git/commits' && method === 'POST') {
      if (!this.trees.has(String(b.tree))) return json(422, { message: 'Tree does not exist' })
      const parents = (b.parents ?? []) as string[]
      if (parents.some(sha => !this.commits.has(sha))) return json(422, { message: 'Parent does not exist' })
      const sha = this.putCommit({ tree: String(b.tree), parents, message: String(b.message), ...b.author === undefined ? {} : { author: b.author } })
      return json(201, { sha, tree: { sha: b.tree } })
    }
    const tree = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest)
    if (tree !== null && method === 'GET') {
      const entries = this.trees.get(tree[1]!)
      if (entries === undefined) return json(404, { message: 'Not Found' })
      const recursive = url.searchParams.get('recursive') !== null
      return json(200, { sha: tree[1], tree: recursive ? this.walk(tree[1]!, '') : entries.map(entry => ({ ...entry })), truncated: false })
    }
    if (rest === '/git/trees' && method === 'POST') {
      const flat = b.base_tree === undefined ? new Map<string, string>() : this.flatten(String(b.base_tree))
      for (const entry of (b.tree ?? []) as Array<Record<string, any>>) {
        const entryPath = String(entry.path)
        if ('content' in entry && 'sha' in entry) return json(422, { message: 'Must supply either tree.sha or tree.content, not both' })
        if ('content' in entry) {
          flat.set(entryPath, this.putBlob(Buffer.from(String(entry.content), 'utf8')))
        } else if (entry.sha === null) {
          const under = [...flat.keys()].filter(key => key === entryPath || key.startsWith(`${entryPath}/`))
          if (under.length === 0) return json(422, { message: 'GitRPC::BadObjectState' })
          for (const key of under) flat.delete(key)
        } else {
          if (!this.blobs.has(String(entry.sha))) return json(422, { message: 'Invalid sha' })
          flat.set(entryPath, String(entry.sha))
        }
      }
      const sha = this.buildTree(flat)
      return json(201, { sha, tree: this.trees.get(sha), truncated: false })
    }
    if (rest === '/git/blobs' && method === 'POST') {
      const content = b.encoding === 'base64' ? Buffer.from(String(b.content), 'base64') : Buffer.from(String(b.content), 'utf8')
      return json(201, { sha: this.putBlob(content) })
    }
    const blob = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest)
    if (blob !== null && method === 'GET') {
      const found = this.blobs.get(blob[1]!)
      if (found === undefined) return json(404, { message: 'Not Found' })
      return json(200, { sha: blob[1], content: found.toString('base64').replace(/(.{60})/g, '$1\n'), encoding: 'base64', size: found.length })
    }
    return json(404, { message: `fake: no route for ${method} ${rest}` })
  }

  /** Serve files from Pages branches at https://<owner>.github.io/<repo>/... */
  private servePages(url: URL, method: string): Response {
    const host = /^([a-z0-9-]+)\.github\.io$/.exec(url.hostname)
    if (host === null) return new Response(null, { status: 404 })
    const [repoName, ...rest] = url.pathname.split('/').filter(part => part !== '')
    const repo = [...this.repos.values()].find(item => item.owner.toLowerCase() === host[1] && item.name === repoName)
    if (repo?.pages === undefined) return new Response(null, { status: 404 })
    let path = rest.join('/')
    if (url.pathname.endsWith('/')) path = path === '' ? 'index.html' : `${path}/index.html`
    const prefix = repo.pages.path === '/docs' ? 'docs/' : ''
    const file = this.filesOf(repo, repo.pages.branch).get(prefix + decodeURIComponent(path))
    if (file === undefined) return new Response(null, { status: 404 })
    return new Response(method === 'HEAD' ? null : file, { status: 200, headers: { 'content-type': 'text/html' } })
  }

  private putBlob(content: Buffer): string {
    const sha = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
    this.blobs.set(sha, content)
    return sha
  }

  private hashTree(entries: TreeEntry[]): string {
    return createHash('sha1').update(`tree ${JSON.stringify(entries)}`).digest('hex')
  }

  private putCommit(commit: Commit): string {
    const sha = createHash('sha1').update(`commit ${JSON.stringify(commit)} ${this.commits.size}`).digest('hex')
    this.commits.set(sha, commit)
    return sha
  }

  private commitFiles(files: Record<string, string>, parents: string[], message: string, author?: { name: string; email: string }): string {
    const flat = new Map<string, string>()
    for (const [path, text] of Object.entries(files)) flat.set(path, this.putBlob(Buffer.from(text)))
    return this.putCommit({ tree: this.buildTree(flat), parents, message, ...author === undefined ? {} : { author } })
  }

  /** Author recorded on a commit, if one was given. */
  authorOf(sha: string): { name: string; email: string } | undefined {
    return this.commits.get(sha)?.author
  }

  /** Build nested trees from path -> blob sha; returns the root tree sha. */
  private buildTree(flat: Map<string, string>): string {
    const children = new Map<string, Map<string, string>>()
    const entries: TreeEntry[] = []
    for (const [path, sha] of flat) {
      const slash = path.indexOf('/')
      if (slash < 0) {
        entries.push({ path, mode: '100644', type: 'blob', sha })
      } else {
        const dir = path.slice(0, slash)
        let sub = children.get(dir)
        if (sub === undefined) children.set(dir, sub = new Map())
        sub.set(path.slice(slash + 1), sha)
      }
    }
    for (const [dir, sub] of children) entries.push({ path: dir, mode: '040000', type: 'tree', sha: this.buildTree(sub) })
    entries.sort((a, b) => a.path.localeCompare(b.path))
    const sha = this.hashTree(entries)
    this.trees.set(sha, entries)
    return sha
  }

  private flatten(treeSha: string, prefix = ''): Map<string, string> {
    const out = new Map<string, string>()
    for (const entry of this.trees.get(treeSha) ?? []) {
      const path = prefix === '' ? entry.path : `${prefix}/${entry.path}`
      if (entry.type === 'tree') for (const [key, value] of this.flatten(entry.sha, path)) out.set(key, value)
      else out.set(path, entry.sha)
    }
    return out
  }

  private walk(treeSha: string, prefix: string): TreeEntry[] {
    const out: TreeEntry[] = []
    for (const entry of this.trees.get(treeSha) ?? []) {
      const path = prefix === '' ? entry.path : `${prefix}/${entry.path}`
      out.push({ ...entry, path })
      if (entry.type === 'tree') out.push(...this.walk(entry.sha, path))
    }
    return out
  }

  private isAncestor(ancestor: string, descendant: string): boolean {
    const seen = new Set<string>()
    const stack = [descendant]
    while (stack.length > 0) {
      const sha = stack.pop()!
      if (sha === ancestor) return true
      if (seen.has(sha)) continue
      seen.add(sha)
      stack.push(...this.commits.get(sha)?.parents ?? [])
    }
    return false
  }
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })
}
