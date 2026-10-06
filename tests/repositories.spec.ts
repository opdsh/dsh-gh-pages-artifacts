import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseRepository } from '../src/config.js'
import { MANIFEST_PATH, parseManifest } from '../src/manifest.js'
import { renderIndex, type RegistryData } from '../src/registry.js'
import { harness, pagesFiles, resetCounter, text, value } from './harness.js'

beforeEach(() => {
  resetCounter()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('repository references', () => {
  const api = 'https://api.github.com'
  it('accepts owner/name and the usual remote URL forms', () => {
    for (const input of [
      'octo/site', 'https://github.com/octo/site', 'https://github.com/octo/site.git', 'https://github.com/octo/site/',
      'git@github.com:octo/site.git', 'ssh://git@github.com/octo/site.git', 'github.com/octo/site',
    ]) {
      expect(parseRepository(input, api)).toEqual({ owner: 'octo', repo: 'site' })
    }
  })

  it('rejects other hosts and malformed paths', () => {
    expect(() => parseRepository('https://gitlab.com/octo/site', api)).toThrow(/does not match/)
    expect(() => parseRepository('octo', api)).toThrow(/owner\/name/)
    expect(() => parseRepository('octo/site/tree/main', api)).toThrow(/owner\/name/)
    expect(parseRepository('https://ghe.corp/octo/site.git', 'https://ghe.corp/api/v3')).toEqual({ owner: 'octo', repo: 'site' })
  })
})

describe('per-artifact strategy', () => {
  it('creates a repository and Pages site for each new artifact and tracks it', async () => {
    const h = await harness({ config: { repoStrategy: 'per-artifact', commitAuthor: { name: 'VibOtaku', email: 'v@example.com' } } })
    const out = value(await h.call('artifact_publish', { description: 'Quarterly numbers', title: 'Q3 Report', slug: 'q3-report', content: '# Q3\n\nUp 12%.' }))
    expect(out).toMatchObject({ id: 'q3-report', repository: 'octo/artifact-q3-report', newRepository: true, url: 'https://octo.github.io/artifact-q3-report/' })
    expect(h.asked[0]!.displayReason!.en).toContain('Creates the new public repository octo/artifact-q3-report')
    const repo = h.fake.repos.get('octo/artifact-q3-report')!
    expect(repo.pages).toMatchObject({ branch: 'gh-pages', path: '/' })
    const files = h.fake.filesOf(repo, 'gh-pages')
    expect(files.get('index.html')).toContain('Up 12%')
    expect(files.get('source.md')).toBe('# Q3\n\nUp 12%.')
    expect(parseManifest(files.get(MANIFEST_PATH)!).artifacts['q3-report']!.files).toEqual(['index.html', 'source.md'])
    expect(h.fake.authorOf(repo.refs.get('gh-pages')!)).toEqual({ name: 'VibOtaku', email: 'v@example.com' })
    expect(h.fake.requests.some(request => request.method === 'PUT' && request.path.endsWith('/artifact-q3-report/topics'))).toBe(true)

    const second = value(await h.call('artifact_publish', { description: 'Another', title: 'Other page', content: '# Other' }))
    expect(second['repository']).toMatch(/^octo\/artifact-other-page-[a-z2-7]{6}$/)

    const updated = value(await h.call('artifact_publish', { description: 'Quarterly numbers', id: 'q3-report', content: '# Q3\n\nUp 13%.' }))
    expect(updated).toMatchObject({ rev: 2, created: false, newRepository: false, repository: 'octo/artifact-q3-report', url: out['url'] })
    expect(value(await h.call('artifact_read', { id: 'q3-report' }))['content']).toBe('# Q3\n\nUp 13%.')

    const deleted = value(await h.call('artifact_delete', { id: 'q3-report' }))
    expect(deleted['notes'][0]).toMatch(/octo\/artifact-q3-report still exists/)
    const after = h.fake.filesOf(repo, 'gh-pages')
    expect(after.has('index.html')).toBe(false)
    expect(after.has('.nojekyll')).toBe(true)
  })

  it('survives GitHub answering 500 while it enables Pages by itself, and tracks the artifact', async () => {
    const h = await harness({ config: { repoStrategy: 'per-artifact' } })
    h.fake.interceptors.push(request => {
      if (request.method !== 'POST' || !request.path.endsWith('/pages')) return undefined
      const repo = h.fake.repos.get('octo/artifact-racy')!
      repo.pages = { branch: 'gh-pages', path: '/' }
      return new Response('', { status: 500 })
    })
    // Pretend the gh-pages push did not enable Pages, so the plugin has to ask for it.
    h.fake.interceptors.push(request => {
      if (request.method === 'POST' && request.path.endsWith('/git/refs')) {
        queueMicrotask(() => { delete h.fake.repos.get('octo/artifact-racy')!.pages })
      }
      return undefined
    })
    const out = value(await h.call('artifact_publish', { description: 'x', title: 'Racy', slug: 'racy', content: '# r' }))
    expect(out['warnings']).toEqual([])
    expect(value(await h.call('artifact_list', {}))['artifacts'][0].id).toBe('racy')
  })

  it('finds per-artifact repositories the registry does not know, by their topic', async () => {
    const first = await harness({ config: { repoStrategy: 'per-artifact' } })
    value(await first.call('artifact_publish', { description: 'made elsewhere', title: 'Elsewhere', slug: 'elsewhere', content: '# e' }))
    // A second machine: same GitHub, empty registry.
    const second = await harness({ config: { repoStrategy: 'per-artifact' } })
    second.fake.repos.set('octo/artifact-elsewhere', first.fake.repos.get('octo/artifact-elsewhere')!)
    for (const [key, val] of first.fake.blobs) second.fake.blobs.set(key, val)
    for (const [key, val] of first.fake.trees) second.fake.trees.set(key, val)
    for (const [key, val] of first.fake.commits) second.fake.commits.set(key, val)
    const listed = value(await second.call('artifact_list', {}))
    expect(listed['artifacts'].map((item: { id: string; repository: string }) => `${item.id}@${item.repository}`)).toEqual(['elsewhere@octo/artifact-elsewhere'])
    expect(value(await second.call('artifact_read', { id: 'elsewhere' }))['content']).toBe('# e')
  })

  it('refuses a slug whose repository already exists', async () => {
    const h = await harness({ config: { repoStrategy: 'per-artifact' } })
    h.fake.addRepo('artifact-taken')
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', slug: 'taken', content: '# x' }))).toMatch(/octo\/artifact-taken already exists/)
    expect(h.asked).toHaveLength(0)
  })
})

describe('linking a shared repository', () => {
  it('links a remote, publishes there, and can switch back or to per-artifact', async () => {
    const h = await harness()
    h.fake.addRepo('team-pages', { branch: 'gh-pages' })
    const shown = value(await h.call('artifact_repository', { action: 'show' }))
    expect(shown).toMatchObject({ strategy: 'shared', strategySource: 'config', repository: 'octo/dsh-artifacts', repositorySource: 'token user' })

    const linked = value(await h.call('artifact_repository', { action: 'link', repository: 'git@github.com:octo/team-pages.git' }))
    expect(linked).toMatchObject({ strategy: 'shared', repository: 'octo/team-pages', repositorySource: 'linked', siteUrl: 'https://octo.github.io/team-pages/' })
    const out = value(await h.call('artifact_publish', { description: 'x', title: 'Team doc', slug: 'team-doc', content: '# Team' }))
    expect(out).toMatchObject({ repository: 'octo/team-pages', url: 'https://octo.github.io/team-pages/team-doc/' })
    expect(h.fake.filesOf(h.fake.repos.get('octo/team-pages')!, 'gh-pages').has('team-doc/index.html')).toBe(true)

    // The artifact keeps living where it was published, even after unlinking.
    value(await h.call('artifact_repository', { action: 'unlink' }))
    const again = value(await h.call('artifact_publish', { description: 'x', id: 'team-doc', content: '# Team v2' }))
    expect(again['repository']).toBe('octo/team-pages')

    const switched = value(await h.call('artifact_repository', { action: 'set_strategy', strategy: 'per-artifact' }))
    expect(switched).toMatchObject({ strategy: 'per-artifact', strategySource: 'user' })
    const own = value(await h.call('artifact_publish', { description: 'x', title: 'Solo', slug: 'solo', content: '# Solo' }))
    expect(own['repository']).toBe('octo/artifact-solo')
  })

  it('refuses repositories that do not exist or cannot be written', async () => {
    const h = await harness()
    expect(text(await h.call('artifact_repository', { action: 'link', repository: 'octo/missing' }))).toMatch(/was not found/)
    h.fake.addRepo('readonly').push = false
    expect(text(await h.call('artifact_repository', { action: 'link', repository: 'https://github.com/octo/readonly' }))).toMatch(/cannot push/)
    expect(text(await h.call('artifact_repository', { action: 'link', repository: 'https://gitlab.com/octo/x' }))).toMatch(/does not match/)
  })
})

describe('web routes for the Artifacts panel', () => {
  it('serves the published artifacts once a web connection exists', async () => {
    const h = await harness()
    const routes: Array<{ path: string; methods: readonly string[]; fetch: (request: Request) => Promise<Response> }> = []
    h.ctx.provide('connection', { fetch: { register: (route: typeof routes[number]) => { routes.push(route); return async () => undefined } } })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(routes.map(route => `${route.methods.join(',')} ${route.path}`)).toEqual([
      'GET /api/gh-pages-artifacts/list', 'POST /api/gh-pages-artifacts/refresh', 'POST /api/gh-pages-artifacts/delete',
    ])
    value(await h.call('artifact_publish', { description: 'For the panel', title: 'Panel page', slug: 'panel-page', content: '# p' }))
    value(await h.call('artifact_publish', { description: 'gone', title: 'Gone', slug: 'gone', content: '# g' }))
    value(await h.call('artifact_delete', { id: 'gone' }))
    const list = await routes[0]!.fetch(new Request('http://dsh.internal/api/gh-pages-artifacts/list'))
    expect(list.status).toBe(200)
    expect(list.headers.get('cache-control')).toBe('no-store')
    const body = await list.json() as { artifacts: Array<{ id: string; url: string; repository: string }> }
    expect(body.artifacts).toEqual([expect.objectContaining({ id: 'panel-page', url: 'https://octo.github.io/dsh-artifacts/panel-page/', repository: 'octo/dsh-artifacts' })])
    const refreshed = await routes[1]!.fetch(new Request('http://dsh.internal/api/gh-pages-artifacts/refresh', { method: 'POST' }))
    expect(((await refreshed.json()) as { artifacts: unknown[] }).artifacts).toHaveLength(1)
    // Deleting from the panel: no approval prompt (the user clicked and confirmed), files removed, id tombstoned.
    const post = (body: unknown) => routes[2]!.fetch(new Request('http://dsh.internal/api/gh-pages-artifacts/delete', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))
    const asked = h.asked.length
    const deleted = await post({ id: 'panel-page' })
    expect(deleted.status).toBe(200)
    const deletedBody = await deleted.json() as { deleted: { id: string; deleted: boolean }; artifacts: unknown[] }
    expect(deletedBody.deleted).toMatchObject({ id: 'panel-page', deleted: true })
    expect(deletedBody.artifacts).toEqual([])
    expect(h.asked.length).toBe(asked)
    expect(pagesFiles(h).has('panel-page/index.html')).toBe(false)
    expect((await post({})).status).toBe(400)
    const unknown = await post({ id: 'no-such-page' })
    expect(unknown.status).toBe(500)
    expect(((await unknown.json()) as { error: string }).error).toMatch(/No artifact with id "no-such-page"/)
    expect(((await (await post({ id: 'panel-page' })).json()) as { error: string }).error).toMatch(/was deleted/)
    vi.stubEnv('GH_PAGES_TOKEN_TEST', '')
    const failed = await routes[1]!.fetch(new Request('http://dsh.internal/api/gh-pages-artifacts/refresh', { method: 'POST' }))
    expect(failed.status).toBe(200)
    expect(((await failed.json()) as { notes: string[] }).notes.join('\n')).toMatch(/No GitHub token/)
  })
})

describe('tracking', () => {
  it('lists every artifact across repositories with links and keeps a clickable index page', async () => {
    const h = await harness()
    value(await h.call('artifact_publish', { description: 'shared one', title: 'Shared page', slug: 'shared-page', content: '# s' }))
    value(await h.call('artifact_repository', { action: 'set_strategy', strategy: 'per-artifact' }))
    value(await h.call('artifact_publish', { description: 'own one', title: 'Own page', slug: 'own-page', content: '# o' }))
    // Published from another machine: only in the shared repository's manifest.
    const repo = h.fake.repos.get('octo/dsh-artifacts')!
    const manifest = parseManifest(h.fake.filesOf(repo, 'gh-pages').get(MANIFEST_PATH)!)
    manifest.artifacts['elsewhere'] = { id: 'elsewhere', title: 'From elsewhere', kind: 'html', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', rev: 1, files: ['index.html'] }
    h.fake.pushFiles(repo, 'gh-pages', { [MANIFEST_PATH]: JSON.stringify(manifest), 'elsewhere/index.html': '<p>e</p>' })

    const result = await h.call('artifact_list', {})
    const listed = value(result)
    expect(listed['total']).toBe(3)
    expect(listed['artifacts'].map((item: { id: string }) => item.id).sort()).toEqual(['elsewhere', 'own-page', 'shared-page'])
    expect(text(result)).toContain('- [Own page](https://octo.github.io/artifact-own-page/)')
    expect(text(result)).toContain('- [Shared page](https://octo.github.io/dsh-artifacts/shared-page/)')

    const index = readFileSync(listed['indexFile'], 'utf8')
    expect(index).toContain('<a href="https://octo.github.io/artifact-own-page/" target="_blank" rel="noopener">Own page</a>')
    expect(index).toContain('<a href="https://octo.github.io/dsh-artifacts/elsewhere/"')

    value(await h.call('artifact_delete', { id: 'shared-page' }))
    expect(value(await h.call('artifact_list', {}))['total']).toBe(2)
    const withDeleted = value(await h.call('artifact_list', { includeDeleted: true }))
    expect(withDeleted['artifacts'].find((item: { id: string }) => item.id === 'shared-page').status).toBe('deleted')
    expect(readFileSync(listed['indexFile'], 'utf8')).toContain('<s>Shared page</s>')
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'Again', slug: 'shared-page', content: '# x' }))).toMatch(/deleted artifact and is not reused/)
  })

  it('renders an empty index', () => {
    const empty: RegistryData = { version: 1, settings: {}, artifacts: {} }
    expect(renderIndex(empty)).toContain('Nothing published yet.')
  })
})
