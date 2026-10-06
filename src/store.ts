/**
 * Repository-backed artifact store. The Pages branch is the single source of truth: every
 * change is one atomic commit built with the Git Data API and applied with a fast-forward-only
 * ref update, retried on a fresh snapshot when another writer got there first.
 */
import { encodePath, GitHubApiError, type GitHubClient } from './github.js'
import { emptyManifest, MANIFEST_PATH, parseManifest, serializeManifest, type Manifest } from './manifest.js'

/** Where artifacts live. */
export interface RepoTarget {
  readonly owner: string
  readonly repo: string
  readonly branch: string
  /** Pages source folder, '' or 'docs'. */
  readonly siteDir: string
  /** Folder under the site root that holds artifacts, '' for the root. */
  readonly pathPrefix: string
  /**
   * 'folder': many artifacts, each in `<siteDir>/<pathPrefix>/<id>/` (a shared repository).
   * 'root': one artifact at the site root (a repository created for that artifact).
   */
  readonly layout: 'folder' | 'root'
}

/** One file to write. Text goes inline in the tree; bytes become a base64 blob. */
export type FileWrite =
  | { readonly path: string; readonly text: string }
  | { readonly path: string; readonly bytes: Uint8Array }

/** A change computed from one snapshot. */
export interface Plan<T> {
  readonly message: string
  readonly writes: readonly FileWrite[]
  /** Repository-relative paths of existing files to delete. */
  readonly deletes: readonly string[]
  readonly manifest: Manifest
  readonly result: T
}

/** How the site root relates to Jekyll. */
export type JekyllState =
  /** `.nojekyll` is present: files are served exactly as committed. */
  | 'disabled'
  /** No `.nojekyll` and no Jekyll site files: the plugin adds `.nojekyll`. */
  | 'add-nojekyll'
  /** The site root is an existing Jekyll site; the plugin must not change how it builds. */
  | 'jekyll-site'

/** Read-only view of the branch at one commit. */
export interface Snapshot {
  /**
   * 'missing-branch' when the branch does not exist yet and 'empty-repository' when the repository
   * has no commits at all; reads then see nothing.
   */
  readonly state: 'ready' | 'missing-branch' | 'empty-repository'
  readonly headSha: string | undefined
  /** Root tree of the head commit. */
  readonly treeSha: string | undefined
  readonly manifest: Manifest
  /**
   * List every file under a repository-relative directory.
   * @param dir - directory path.
   * @returns repository-relative file paths, sorted.
   */
  listFiles(dir: string): Promise<string[]>
  /**
   * Read a file.
   * @param path - repository-relative path.
   * @returns the bytes, or undefined when absent.
   */
  readFile(path: string): Promise<Uint8Array | undefined>
  /** Whether the site root serves files verbatim, needs `.nojekyll`, or is a Jekyll site. */
  jekyll(): Promise<JekyllState>
}

/** Result of a successful mutation. */
export interface Committed<T> {
  readonly result: T
  readonly commitSha: string
}

/** Options for {@link ArtifactStore}. */
export interface StoreOptions {
  /** Optional commit author/committer. */
  readonly author?: { readonly name: string; readonly email: string } | undefined
  /** Attempts before giving up on a branch that keeps moving. */
  readonly maxAttempts?: number
  /** Sleep between attempts, replaceable in tests. */
  readonly sleep?: (ms: number) => Promise<void>
}

interface RefResponse { object: { sha: string } }
interface CommitResponse { sha: string; tree: { sha: string } }
interface TreeItem { path: string; mode: string; type: 'blob' | 'tree' | 'commit'; sha: string; size?: number }
interface TreeResponse { sha: string; tree: TreeItem[]; truncated: boolean }
interface BlobResponse { content: string; encoding: string }

type TreeEntryInput =
  | { path: string; mode: '100644'; type: 'blob'; content: string }
  | { path: string; mode: '100644'; type: 'blob'; sha: string | null }

const NOJEKYLL = '.nojekyll'
const NOJEKYLL_TEXT = '# Disables Jekyll so GitHub Pages serves files exactly as committed.\n'
/** Files and folders that mark a Jekyll site. */
const JEKYLL_MARKERS = new Set(['_config.yml', '_config.yaml', '_config.toml', 'Gemfile', '_layouts', '_includes', '_posts', '_data', '_sass'])

/** Error for a repository the token cannot see. */
export class RepositoryNotFoundError extends Error {
  override readonly name = 'RepositoryNotFoundError'
}

/** Error for a ref update GitHub refuses for good, such as a protected branch. */
export class BranchRejectedError extends Error {
  override readonly name = 'BranchRejectedError'
}

/** Error for a site root that is an existing Jekyll site. */
export class JekyllSiteError extends Error {
  override readonly name = 'JekyllSiteError'
}

type Moved = { kind: 'ok' } | { kind: 'retry'; reason: string }

/** Performs atomic commits on the Pages branch. Callers serialize writes within one process. */
export class ArtifactStore {
  private readonly maxAttempts: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(
    private readonly gh: GitHubClient,
    readonly target: RepoTarget,
    private readonly options: StoreOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 5
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  private get repoPath(): string {
    return `/repos/${encodeURIComponent(this.target.owner)}/${encodeURIComponent(this.target.repo)}`
  }

  private get refReadPath(): string {
    return `${this.repoPath}/git/ref/heads/${encodePath(this.target.branch)}`
  }

  /** Human name of the branch, for messages. */
  get branchLabel(): string {
    return `${this.target.branch} branch of ${this.target.owner}/${this.target.repo}`
  }

  /**
   * @param id - artifact id.
   * @returns the repository-relative folder of one artifact.
   */
  artifactDir(id: string): string {
    return this.target.layout === 'root' ? this.target.siteDir : joinPath(this.target.siteDir, this.target.pathPrefix, id)
  }

  /**
   * List the files that belong to one artifact, relative to its folder. In the root layout the
   * site root also holds the plugin's own bookkeeping files, which are not part of the artifact.
   * @param snapshot - branch snapshot.
   * @param id - artifact id.
   */
  async artifactFiles(snapshot: Snapshot, id: string): Promise<string[]> {
    const dir = this.artifactDir(id)
    const files = (await snapshot.listFiles(dir)).map(path => dir === '' ? path : path.slice(dir.length + 1))
    if (this.target.layout === 'folder') return files
    const reserved = new Set([NOJEKYLL, ...this.target.siteDir === '' ? [MANIFEST_PATH] : []])
    return files.filter(file => !reserved.has(file))
  }

  /**
   * Take a consistent snapshot of the branch head. Never writes.
   * @param signal - cancellation.
   */
  async snapshot(signal?: AbortSignal): Promise<Snapshot> {
    const ref = await this.gh.request<RefResponse>('GET', this.refReadPath, { allowStatus: [404, 409], signal })
    if (ref.status === 409) {
      const message = (ref.data as { message?: string } | undefined)?.message ?? ''
      if (!/empty/i.test(message)) {
        throw new Error(`Repository ${this.target.owner}/${this.target.repo} is unavailable (${message || 'HTTP 409'}); if it was just created, try again in a minute`)
      }
      return emptySnapshot('empty-repository')
    }
    if (ref.status === 404) {
      await this.assertRepositoryVisible(signal)
      return emptySnapshot('missing-branch')
    }
    const headSha = ref.data.object.sha
    const commit = await this.gh.request<CommitResponse>('GET', `${this.repoPath}/git/commits/${headSha}`, { signal })
    const reader = new TreeReader(this.gh, this.repoPath, commit.data.tree.sha, signal)
    const manifestBytes = await reader.readFile(MANIFEST_PATH)
    const manifest = manifestBytes === undefined ? emptyManifest() : parseManifest(decodeUtf8(manifestBytes, MANIFEST_PATH))
    const siteDir = this.target.siteDir
    return {
      state: 'ready', headSha, treeSha: commit.data.tree.sha, manifest,
      listFiles: dir => reader.listFiles(dir),
      readFile: path => reader.readFile(path),
      async jekyll() {
        const names = await reader.listNames(siteDir)
        if (names.includes(NOJEKYLL)) return 'disabled'
        return names.some(name => JEKYLL_MARKERS.has(name)) ? 'jekyll-site' : 'add-nojekyll'
      },
    }
  }

  /**
   * Apply one change atomically. `build` runs against a fresh snapshot on every attempt, so a
   * concurrent writer never loses its change and `build` can re-check its preconditions.
   * @param build - computes the plan from a snapshot; may throw to abort.
   * @param signal - cancellation.
   * @returns the plan result and the new commit.
   */
  async mutate<T>(build: (snapshot: Snapshot) => Promise<Plan<T>>, signal?: AbortSignal): Promise<Committed<T>> {
    let lastConflict = ''
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      signal?.throwIfAborted()
      if (attempt > 0) await this.sleep(Math.min(4000, 300 * 2 ** attempt) + Math.floor(Math.random() * 200))
      const snapshot = await this.snapshot(signal)
      if (snapshot.state === 'empty-repository') {
        // Only a mutation, which runs after approval, may give an empty repository its first commit.
        await this.initializeEmptyRepository(signal)
        lastConflict = 'the repository was empty'
        continue
      }
      const plan = await build(snapshot)
      signal?.throwIfAborted()
      const entries = await this.treeEntries(plan, snapshot, signal)
      const parents = snapshot.headSha === undefined ? [] : [snapshot.headSha]
      const baseTree = snapshot.treeSha
      const tree = await this.gh.request<{ sha: string }>('POST', `${this.repoPath}/git/trees`, {
        body: baseTree === undefined ? { tree: entries } : { base_tree: baseTree, tree: entries }, signal,
      })
      const commitBody: Record<string, unknown> = { message: plan.message, tree: tree.data.sha, parents }
      if (this.options.author !== undefined) {
        commitBody['author'] = { ...this.options.author }
        commitBody['committer'] = { ...this.options.author }
      }
      const commit = await this.gh.request<{ sha: string }>('POST', `${this.repoPath}/git/commits`, { body: commitBody, signal })
      const commitSha = commit.data.sha
      signal?.throwIfAborted()
      const moved = snapshot.headSha === undefined
        ? await this.createBranch(commitSha, signal)
        : await this.fastForward(commitSha, snapshot.headSha, signal)
      if (moved.kind === 'ok') return { result: plan.result, commitSha }
      lastConflict = moved.reason
    }
    throw new Error(`The ${this.branchLabel} kept changing while publishing (${lastConflict}); try again`)
  }

  private async treeEntries<T>(plan: Plan<T>, snapshot: Snapshot, signal?: AbortSignal): Promise<TreeEntryInput[]> {
    const entries: TreeEntryInput[] = []
    const written = new Set<string>()
    for (const write of plan.writes) {
      if (written.has(write.path)) throw new Error(`internal error: ${write.path} written twice`)
      written.add(write.path)
      if ('text' in write) {
        entries.push({ path: write.path, mode: '100644', type: 'blob', content: write.text })
      } else {
        const blob = await this.gh.request<{ sha: string }>('POST', `${this.repoPath}/git/blobs`, {
          body: { content: Buffer.from(write.bytes).toString('base64'), encoding: 'base64' }, signal,
        })
        entries.push({ path: write.path, mode: '100644', type: 'blob', sha: blob.data.sha })
      }
    }
    for (const path of plan.deletes) {
      if (written.has(path)) continue
      if (snapshot.headSha !== undefined) entries.push({ path, mode: '100644', type: 'blob', sha: null })
    }
    entries.push({ path: MANIFEST_PATH, mode: '100644', type: 'blob', content: serializeManifest(plan.manifest) })
    const jekyll = snapshot.state === 'missing-branch' ? 'add-nojekyll' : await snapshot.jekyll()
    if (jekyll === 'jekyll-site') throw jekyllSiteError(this.target)
    if (jekyll === 'add-nojekyll') {
      entries.push({ path: joinPath(this.target.siteDir, NOJEKYLL), mode: '100644', type: 'blob', content: NOJEKYLL_TEXT })
    }
    return entries
  }

  /**
   * Move the branch to a new commit if it still points at the snapshot head. A refusal while the
   * branch has not moved (protected branch, ruleset, missing permission) is permanent.
   */
  private async fastForward(commitSha: string, expectedHead: string, signal?: AbortSignal): Promise<Moved> {
    const refPath = `${this.repoPath}/git/refs/heads/${encodePath(this.target.branch)}`
    let refusal: string
    try {
      const response = await this.gh.request('PATCH', refPath, {
        body: { sha: commitSha, force: false }, allowStatus: [409, 422], retry: false, signal,
      })
      if (response.status === 200) return { kind: 'ok' }
      refusal = (response.data as { message?: string } | undefined)?.message ?? `HTTP ${response.status}`
    } catch (error) {
      if (signal?.aborted === true) throw error
      if (error instanceof GitHubApiError && error.status < 500) throw new BranchRejectedError(`GitHub refused to update the ${this.branchLabel}: ${error.apiMessage}${permissionHint(error)}`)
      // A lost response may hide a successful update: trust the ref, not the transport.
      const head = await this.currentHead(signal)
      if (head === commitSha) return { kind: 'ok' }
      return { kind: 'retry', reason: error instanceof Error ? error.message : String(error) }
    }
    const head = await this.currentHead(signal)
    if (head === commitSha) return { kind: 'ok' }
    if (head === expectedHead) throw new BranchRejectedError(`GitHub refused to update the ${this.branchLabel}: ${refusal}. Branch protection or rulesets may block direct pushes; use a branch without them.`)
    return { kind: 'retry', reason: refusal }
  }

  private async createBranch(commitSha: string, signal?: AbortSignal): Promise<Moved> {
    let refusal: string
    try {
      const response = await this.gh.request('POST', `${this.repoPath}/git/refs`, {
        body: { ref: `refs/heads/${this.target.branch}`, sha: commitSha }, allowStatus: [422], retry: false, signal,
      })
      if (response.status === 201 || response.status === 200) return { kind: 'ok' }
      refusal = (response.data as { message?: string } | undefined)?.message ?? 'HTTP 422'
    } catch (error) {
      if (signal?.aborted === true) throw error
      if (error instanceof GitHubApiError && error.status < 500) throw new BranchRejectedError(`GitHub refused to create the ${this.branchLabel}: ${error.apiMessage}${permissionHint(error)}`)
      const head = await this.currentHead(signal)
      if (head === commitSha) return { kind: 'ok' }
      return { kind: 'retry', reason: error instanceof Error ? error.message : String(error) }
    }
    const head = await this.currentHead(signal)
    if (head === commitSha) return { kind: 'ok' }
    if (head === undefined) throw new BranchRejectedError(`GitHub refused to create the ${this.branchLabel}: ${refusal}`)
    return { kind: 'retry', reason: 'the branch was created concurrently' }
  }

  private async currentHead(signal?: AbortSignal): Promise<string | undefined> {
    const ref = await this.gh.request<RefResponse>('GET', this.refReadPath, { allowStatus: [404, 409], signal })
    return ref.status === 200 ? ref.data.object.sha : undefined
  }

  private async assertRepositoryVisible(signal?: AbortSignal): Promise<void> {
    const repo = await this.gh.request<{ permissions?: { push?: boolean } }>('GET', this.repoPath, { allowStatus: [404], signal })
    if (repo.status === 404) {
      throw new RepositoryNotFoundError(`Repository ${this.target.owner}/${this.target.repo} was not found, or the token cannot access it. Ask the user to create it and give the token Contents read/write access (see the dsh-gh-pages-artifacts README); do not run setup commands yourself.`)
    }
  }

  /** Give an empty repository its first commit so the Git Data API accepts it. */
  private async initializeEmptyRepository(signal?: AbortSignal): Promise<void> {
    const path = joinPath(this.target.siteDir, NOJEKYLL)
    const response = await this.gh.request<{ message?: string }>('PUT', `${this.repoPath}/contents/${encodePath(path)}`, {
      body: {
        message: 'Initialize repository for dsh artifacts',
        content: Buffer.from(NOJEKYLL_TEXT).toString('base64'),
        ...this.options.author === undefined ? {} : { author: { ...this.options.author }, committer: { ...this.options.author } },
      },
      allowStatus: [409, 422], retry: false, signal,
    })
    if (response.status === 201 || response.status === 200) return
    const message = response.data?.message ?? `HTTP ${response.status}`
    // Another writer initialized it first; the next snapshot sees its commit.
    if (response.status === 422 && /sha|already exists/i.test(message)) return
    if (response.status === 409) return
    throw new Error(`Could not initialize the empty repository ${this.target.owner}/${this.target.repo}: ${message}`)
  }
}

function emptySnapshot(state: 'missing-branch' | 'empty-repository'): Snapshot {
  return {
    state, headSha: undefined, treeSha: undefined, manifest: emptyManifest(),
    listFiles: () => Promise.resolve([]),
    readFile: () => Promise.resolve(undefined),
    jekyll: () => Promise.resolve('add-nojekyll'),
  }
}

/**
 * @param target - repository target.
 * @returns the error for a site root that is an existing Jekyll site.
 */
export function jekyllSiteError(target: RepoTarget): JekyllSiteError {
  const where = `${target.owner}/${target.repo} ${target.branch}:/${target.siteDir}`
  return new JekyllSiteError(`${where} is an existing Jekyll site (it has Jekyll configuration and no .nojekyll). Publishing artifacts there would change how the site builds, so the plugin will not write to it. Ask the user to use a dedicated repository or branch for artifacts.`)
}

function permissionHint(error: GitHubApiError): string {
  return error.acceptedPermissions === undefined ? '' : ` (the token needs: ${error.acceptedPermissions})`
}

/** Lazily walks trees of one commit, caching every listing. */
class TreeReader {
  private readonly listings = new Map<string, Promise<TreeItem[]>>()

  constructor(
    private readonly gh: GitHubClient,
    private readonly repoPath: string,
    private readonly rootTree: string,
    private readonly signal: AbortSignal | undefined,
  ) {}

  private list(treeSha: string): Promise<TreeItem[]> {
    let listing = this.listings.get(treeSha)
    if (listing === undefined) {
      listing = this.gh.request<TreeResponse>('GET', `${this.repoPath}/git/trees/${treeSha}`, { signal: this.signal })
        .then(response => response.data.tree)
      listing.catch(() => this.listings.delete(treeSha))
      this.listings.set(treeSha, listing)
    }
    return listing
  }

  private async entry(path: string): Promise<TreeItem | undefined> {
    if (path === '') return { path: '', mode: '040000', type: 'tree', sha: this.rootTree }
    let tree = this.rootTree
    const segments = path.split('/')
    for (let index = 0; index < segments.length; index++) {
      const found = (await this.list(tree)).find(item => item.path === segments[index])
      if (found === undefined) return undefined
      if (index === segments.length - 1) return found
      if (found.type !== 'tree') return undefined
      tree = found.sha
    }
    return undefined
  }

  async readFile(path: string): Promise<Uint8Array | undefined> {
    const found = await this.entry(path)
    if (found === undefined || found.type !== 'blob') return undefined
    const blob = await this.gh.request<BlobResponse>('GET', `${this.repoPath}/git/blobs/${found.sha}`, { signal: this.signal })
    if (blob.data.encoding !== 'base64') return new TextEncoder().encode(blob.data.content)
    return new Uint8Array(Buffer.from(blob.data.content, 'base64'))
  }

  async listNames(dir: string): Promise<string[]> {
    const found = await this.entry(dir)
    if (found === undefined || found.type !== 'tree') return []
    return (await this.list(found.sha)).map(item => item.path)
  }

  async listFiles(dir: string): Promise<string[]> {
    const found = await this.entry(dir)
    if (found === undefined || found.type !== 'tree') return []
    const tree = await this.gh.request<TreeResponse>('GET', `${this.repoPath}/git/trees/${found.sha}?recursive=1`, { signal: this.signal })
    if (tree.data.truncated) throw new Error(`Folder ${dir} has too many files to list`)
    return tree.data.tree
      .filter(item => item.type === 'blob')
      .map(item => joinPath(dir, item.path))
      .sort()
  }
}

/**
 * Join path segments with '/', skipping empty ones.
 * @param parts - segments or partial paths.
 */
export function joinPath(...parts: string[]): string {
  return parts.filter(part => part !== '').join('/')
}

/**
 * Decode strict UTF-8.
 * @param bytes - encoded text.
 * @param label - name used in the error.
 */
export function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${label} is not UTF-8 text`)
  }
}
