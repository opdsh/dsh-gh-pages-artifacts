import { describe, expect, it } from 'vitest'
import { GitHubApiError, GitHubClient } from '../src/github.js'
import { MANIFEST_PATH, parseManifest, type Manifest } from '../src/manifest.js'
import { ArtifactStore, RepositoryNotFoundError, type Plan, type Snapshot } from '../src/store.js'
import { FakeGitHub, json } from './fake-github.js'

const noSleep = (): Promise<void> => Promise.resolve()

function setup(options: Parameters<FakeGitHub['addRepo']>[1] = { branch: 'gh-pages' }) {
  const fake = new FakeGitHub()
  const repo = fake.addRepo('dsh-artifacts', options)
  const gh = new GitHubClient({ apiBaseUrl: fake.apiBase, token: fake.token, userAgent: 'test', fetch: fake.fetch, sleep: noSleep })
  const store = new ArtifactStore(gh, { owner: 'octo', repo: 'dsh-artifacts', branch: 'gh-pages', siteDir: '', pathPrefix: '', layout: 'folder' }, { sleep: noSleep })
  return { fake, repo, gh, store }
}

function addPage(id: string, html: string) {
  return async (snapshot: Snapshot): Promise<Plan<string>> => {
    const manifest: Manifest = {
      version: 1,
      artifacts: { ...snapshot.manifest.artifacts, [id]: { id, title: id, kind: 'html', createdAt: 't', updatedAt: 't', rev: 1, files: ['index.html'] } },
      tombstones: snapshot.manifest.tombstones,
    }
    return { message: `add ${id}`, writes: [{ path: `${id}/index.html`, text: html }], deletes: [], manifest, result: id }
  }
}

describe('ArtifactStore', () => {
  it('commits files, manifest, and .nojekyll atomically', async () => {
    const { fake, repo, store } = setup()
    const before = repo.refs.get('gh-pages')
    const { result, commitSha } = await store.mutate(addPage('one', '<p>1</p>'))
    expect(result).toBe('one')
    expect(repo.refs.get('gh-pages')).toBe(commitSha)
    expect(fake.commits.get(commitSha)!.parents).toEqual([before])
    const files = fake.filesOf(repo, 'gh-pages')
    expect(files.get('one/index.html')).toBe('<p>1</p>')
    expect(files.has('.nojekyll')).toBe(true)
    expect(parseManifest(files.get(MANIFEST_PATH)!).artifacts['one']!.rev).toBe(1)
  })

  it('reads back through a fresh snapshot', async () => {
    const { store } = setup()
    await store.mutate(addPage('one', '<p>1</p>'))
    await store.mutate(addPage('two', '<p>2</p>'))
    const snapshot = await store.snapshot()
    expect(Object.keys(snapshot.manifest.artifacts).sort()).toEqual(['one', 'two'])
    expect(new TextDecoder().decode(await snapshot.readFile('two/index.html'))).toBe('<p>2</p>')
    expect(await snapshot.listFiles('one')).toEqual(['one/index.html'])
    expect(await snapshot.readFile('missing/index.html')).toBeUndefined()
  })

  it('creates a missing branch as an orphan', async () => {
    const { fake, repo, store } = setup({})
    expect(repo.refs.has('gh-pages')).toBe(false)
    const { commitSha } = await store.mutate(addPage('one', 'x'))
    expect(repo.refs.get('gh-pages')).toBe(commitSha)
    expect(fake.commits.get(commitSha)!.parents).toEqual([])
    expect([...fake.filesOf(repo, 'gh-pages').keys()].sort()).toEqual(['.dsh-artifacts.json', '.nojekyll', 'one/index.html'])
  })

  it('initializes an empty repository', async () => {
    const { repo, store } = setup({ empty: true })
    await store.mutate(addPage('one', 'x'))
    expect(repo.empty).toBe(false)
    expect(repo.refs.has('main')).toBe(true)
    expect(repo.refs.has('gh-pages')).toBe(true)
  })

  it('reports a repository the token cannot see', async () => {
    const { store } = setup()
    const other = new ArtifactStore((store as unknown as { gh: GitHubClient }).gh, { owner: 'octo', repo: 'nope', branch: 'gh-pages', siteDir: '', pathPrefix: '', layout: 'folder' })
    await expect(other.snapshot()).rejects.toBeInstanceOf(RepositoryNotFoundError)
  })

  it('rebuilds on a fresh snapshot when another writer moves the branch', async () => {
    const { fake, repo, store } = setup()
    let raced = false
    fake.interceptors.push(request => {
      if (!raced && request.method === 'PATCH') {
        raced = true
        fake.pushFiles(repo, 'gh-pages', { 'other/index.html': 'theirs' })
      }
      return undefined
    })
    let builds = 0
    await store.mutate(async snapshot => {
      builds++
      return await addPage('mine', 'ours')(snapshot)
    })
    expect(builds).toBe(2)
    const files = fake.filesOf(repo, 'gh-pages')
    expect(files.get('other/index.html')).toBe('theirs')
    expect(files.get('mine/index.html')).toBe('ours')
  })

  it('keeps a concurrent manifest change', async () => {
    const { fake, repo, store } = setup()
    await store.mutate(addPage('one', '1'))
    let raced = false
    fake.interceptors.push(async request => {
      if (!raced && request.method === 'PATCH') {
        raced = true
        // Another process publishes "two" between our snapshot and our ref update.
        const other = setup()
        void other
        const gh = new GitHubClient({ apiBaseUrl: fake.apiBase, token: fake.token, userAgent: 't', fetch: fake.fetch, sleep: noSleep })
        await new ArtifactStore(gh, store.target, { sleep: noSleep }).mutate(addPage('two', '2'))
      }
      return undefined
    })
    await store.mutate(addPage('three', '3'))
    const manifest = parseManifest(fake.filesOf(repo, 'gh-pages').get(MANIFEST_PATH)!)
    expect(Object.keys(manifest.artifacts).sort()).toEqual(['one', 'three', 'two'])
  })

  it('treats a lost ref-update response as success when the ref moved to our commit', async () => {
    const { fake, repo, store } = setup()
    let dropped = false
    fake.interceptors.push(async request => {
      if (!dropped && request.method === 'PATCH') {
        dropped = true
        const sha = (request.body as { sha: string }).sha
        repo.refs.set('gh-pages', sha)
        throw new TypeError('fetch failed: socket hang up')
      }
      return undefined
    })
    let builds = 0
    const { commitSha } = await store.mutate(async snapshot => {
      builds++
      return await addPage('one', 'x')(snapshot)
    })
    expect(builds).toBe(1)
    expect(repo.refs.get('gh-pages')).toBe(commitSha)
  })

  it('gives up after repeated conflicts', async () => {
    const { fake, repo, store } = setup()
    fake.interceptors.push(request => {
      if (request.method === 'PATCH') fake.pushFiles(repo, 'gh-pages', { [`noise-${fake.requests.length}`]: 'x' })
      return undefined
    })
    await expect(store.mutate(addPage('one', 'x'))).rejects.toThrow(/kept changing/)
  })

  it('deletes files with null tree entries and refuses unknown paths', async () => {
    const { fake, repo, store } = setup()
    await store.mutate(addPage('one', 'x'))
    await store.mutate(async snapshot => ({
      message: 'delete', writes: [], deletes: await snapshot.listFiles('one'),
      manifest: { version: 1, artifacts: {}, tombstones: ['one'] }, result: null,
    }))
    expect([...fake.filesOf(repo, 'gh-pages').keys()].some(path => path.startsWith('one/'))).toBe(false)
  })

  it('refuses to overwrite a corrupt manifest', async () => {
    const { fake, repo, store } = setup({ branch: 'gh-pages', files: { [MANIFEST_PATH]: '{not json' } })
    void fake
    void repo
    await expect(store.mutate(addPage('one', 'x'))).rejects.toThrow(/not valid JSON/)
  })

  it('writes binary files as base64 blobs', async () => {
    const { fake, repo, store } = setup()
    const bytes = new Uint8Array([0, 255, 1, 2, 128])
    await store.mutate(async snapshot => ({
      ...(await addPage('bin', 'x')(snapshot)),
      writes: [{ path: 'bin/index.html', text: 'x' }, { path: 'bin/a.bin', bytes }],
    }))
    const head = repo.refs.get('gh-pages')!
    void head
    const blobRequest = fake.requests.find(request => request.method === 'POST' && request.path.endsWith('/git/blobs'))
    expect((blobRequest!.body as { encoding: string }).encoding).toBe('base64')
    const snapshot = await store.snapshot()
    expect([...(await snapshot.readFile('bin/a.bin'))!]).toEqual([...bytes])
  })
})

describe('GitHubClient', () => {
  it('retries transient server errors', async () => {
    const fake = new FakeGitHub()
    let failures = 2
    fake.interceptors.push(() => failures-- > 0 ? json(502, { message: 'Bad gateway' }) : undefined)
    const gh = new GitHubClient({ apiBaseUrl: fake.apiBase, token: fake.token, userAgent: 't', fetch: fake.fetch, sleep: noSleep })
    expect((await gh.request<{ login: string }>('GET', '/user')).data.login).toBe('octo')
  })

  it('waits for a rate-limit reset and retries', async () => {
    const fake = new FakeGitHub()
    const waits: number[] = []
    let limited = true
    fake.interceptors.push(() => {
      if (!limited) return undefined
      limited = false
      return json(429, { message: 'slow down' }, { 'retry-after': '2' })
    })
    const gh = new GitHubClient({ apiBaseUrl: fake.apiBase, token: fake.token, userAgent: 't', fetch: fake.fetch, sleep: ms => { waits.push(ms); return Promise.resolve() } })
    await gh.request('GET', '/user')
    expect(waits).toEqual([2000])
  })

  it('fails with a scrubbed message and the accepted permissions', async () => {
    const fake = new FakeGitHub()
    fake.interceptors.push(() => json(403, { message: `Resource not accessible by personal access token ${fake.token}` }, { 'x-accepted-github-permissions': 'contents=write' }))
    const gh = new GitHubClient({ apiBaseUrl: fake.apiBase, token: fake.token, userAgent: 't', fetch: fake.fetch, sleep: noSleep })
    const error = await gh.request('POST', '/repos/octo/x/git/trees', { body: {} }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitHubApiError)
    expect((error as GitHubApiError).message).not.toContain(fake.token)
    expect((error as GitHubApiError).message).toContain('***')
    expect((error as GitHubApiError).acceptedPermissions).toBe('contents=write')
  })

  it('does not retry non-idempotent writes after a network failure', async () => {
    const fake = new FakeGitHub()
    let calls = 0
    fake.interceptors.push(() => {
      calls++
      throw new TypeError('fetch failed')
    })
    const gh = new GitHubClient({ apiBaseUrl: fake.apiBase, token: fake.token, userAgent: 't', fetch: fake.fetch, sleep: noSleep })
    await expect(gh.request('PATCH', '/repos/octo/x/git/refs/heads/main', { body: {}, retry: false })).rejects.toThrow(/could not be reached/)
    expect(calls).toBe(1)
  })

  it('honours cancellation', async () => {
    const fake = new FakeGitHub()
    const gh = new GitHubClient({ apiBaseUrl: fake.apiBase, token: fake.token, userAgent: 't', fetch: fake.fetch, sleep: noSleep })
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    await expect(gh.request('GET', '/user', { signal: controller.signal })).rejects.toThrow('stop')
  })
})
