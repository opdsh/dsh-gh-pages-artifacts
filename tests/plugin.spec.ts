import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.js'
import { MANIFEST_PATH, parseManifest } from '../src/manifest.js'
import { Config, normalizeConfig } from '../src/config.js'
import { ArtifactsRuntime } from '../src/service.js'
import { FakeGitHub } from './fake-github.js'
import { harness, makeAgent, pagesFiles, resetCounter, text, TOKEN_ENV, value } from './harness.js'

beforeEach(() => {
  resetCounter()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('artifact_publish', () => {
  it('publishes a Markdown file from the workspace after approval', async () => {
    const h = await harness()
    writeFileSync(join(h.workspace, 'report.md'), '# Q3 report\n\nRevenue grew **12%**.\n')
    const result = await h.call('artifact_publish', { description: 'Quarterly report', title: 'Q3 Report', path: 'report.md' })
    const out = value(result)
    expect(out).toMatchObject({ title: 'Q3 Report', kind: 'markdown', rev: 1, created: true, files: ['index.html', 'source.md'], warnings: [] })
    expect(out['id']).toMatch(/^q3-report-[a-z2-7]{6}$/)
    expect(out['url']).toBe(`https://octo.github.io/dsh-artifacts/${out['id']}/`)
    expect(text(result)).toContain(`[Q3 Report](${out['url']})`)
    expect(result.isError === false && result.meta).toEqual({ url: out['url'], id: out['id'], kind: 'markdown', rev: 1, repository: 'octo/dsh-artifacts' })
    expect(h.asked).toHaveLength(1)
    expect(h.asked[0]!.displayReason?.en).toContain(out['url'])
    expect(h.asked[0]!.reason).toContain(`publish new artifact at ${out['url']}`)
    expect(h.asked[0]!.displayReason?.en).toContain('Title: "Q3 Report". Page: workspace file "report.md" as markdown')
    const files = pagesFiles(h)
    expect(files.get(`${out['id']}/index.html`)).toContain('<strong>12%</strong>')
    expect(files.get(`${out['id']}/source.md`)).toBe('# Q3 report\n\nRevenue grew **12%**.\n')
    const manifest = parseManifest(files.get(MANIFEST_PATH)!)
    expect(manifest.artifacts[out['id']]).toMatchObject({ title: 'Q3 Report', description: 'Quarterly report', rev: 1 })
    expect(h.fake.requests.every(request => !request.url.includes(h.fake.token))).toBe(true)
  })

  it('publishes inline HTML with assets and a chosen slug', async () => {
    const h = await harness()
    mkdirSync(join(h.workspace, 'out'))
    writeFileSync(join(h.workspace, 'out', 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
    writeFileSync(join(h.workspace, 'data.json'), '{"a":1}')
    const out = value(await h.call('artifact_publish', {
      description: 'Sales dashboard', title: 'Dashboard', slug: 'sales-dashboard',
      content: '<!doctype html><html><head><title>D</title></head><body><img src="chart.png"></body></html>',
      assets: [{ path: 'out/chart.png' }, { path: 'data.json', name: 'data/data.json' }],
    }))
    expect(out).toMatchObject({ id: 'sales-dashboard', kind: 'html', files: ['chart.png', 'data/data.json', 'index.html'] })
    const files = pagesFiles(h)
    expect(files.get('sales-dashboard/index.html')).toContain('<meta name="robots" content="noindex, nofollow" data-dsh-artifacts>')
    expect(files.get('sales-dashboard/data/data.json')).toBe('{"a":1}')
    expect(Buffer.from(files.get('sales-dashboard/chart.png')!, 'utf8').length).toBeGreaterThan(0)
  })

  it('updates in place, keeps unlisted assets, and removes requested ones', async () => {
    const h = await harness()
    writeFileSync(join(h.workspace, 'a.png'), 'A')
    writeFileSync(join(h.workspace, 'b.png'), 'B')
    writeFileSync(join(h.workspace, 'page.html'), '<p>v1</p>')
    const first = value(await h.call('artifact_publish', { description: 'demo', title: 'Demo', path: 'page.html', assets: [{ path: 'a.png' }, { path: 'b.png' }] }))
    writeFileSync(join(h.workspace, 'page.html'), '<p>v2</p>')
    const second = value(await h.call('artifact_publish', { description: 'demo v2', id: first['id'], path: 'page.html', removeAssets: ['b.png'], baseRev: 1 }))
    expect(second).toMatchObject({ id: first['id'], url: first['url'], rev: 2, created: false, title: 'Demo', files: ['a.png', 'index.html'] })
    const files = pagesFiles(h)
    expect(files.get(`${first['id']}/index.html`)).toContain('<p>v2</p>')
    expect(files.has(`${first['id']}/b.png`)).toBe(false)
    expect(h.asked[1]!.reason).toContain('rev 1 -> 2')
  })

  it('renames a Markdown artifact without new content by re-rendering its source', async () => {
    const h = await harness()
    const first = value(await h.call('artifact_publish', { description: 'notes', title: 'Old', content: '# Notes\n\ntext' }))
    const second = value(await h.call('artifact_publish', { description: 'notes', id: first['id'], title: 'New title' }))
    expect(second).toMatchObject({ rev: 2, title: 'New title', kind: 'markdown' })
    expect(pagesFiles(h).get(`${first['id']}/index.html`)).toContain('<title>New title</title>')
  })

  it('switches kind and drops the stale Markdown source', async () => {
    const h = await harness()
    const first = value(await h.call('artifact_publish', { description: 'x', title: 'Doc', content: '# Doc' }))
    const second = value(await h.call('artifact_publish', { description: 'x', id: first['id'], content: '<!doctype html><p>now html</p>' }))
    expect(second).toMatchObject({ kind: 'html', files: ['index.html'] })
    expect(pagesFiles(h).has(`${first['id']}/source.md`)).toBe(false)
  })

  it('refuses stale updates, unknown ids, duplicate slugs, and tombstoned ids', async () => {
    const h = await harness()
    const first = value(await h.call('artifact_publish', { description: 'x', title: 'One', slug: 'one', content: '<p>1</p>' }))
    expect(text(await h.call('artifact_publish', { description: 'x', id: 'one', content: '<p>2</p>', baseRev: 7 }))).toMatch(/changed since rev 7; it is now rev 1/)
    expect(text(await h.call('artifact_publish', { description: 'x', id: 'nope', content: '<p>2</p>' }))).toMatch(/No artifact with id "nope"/)
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'Again', slug: 'one', content: '<p>2</p>' }))).toMatch(/already exists/)
    value(await h.call('artifact_delete', { id: first['id'] }))
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'Again', slug: 'one', content: '<p>2</p>' }))).toMatch(/deleted artifact and is not reused/)
    expect(h.asked).toHaveLength(2)
  })

  it('never writes into a folder that is not an artifact', async () => {
    const h = await harness()
    h.fake.pushFiles(h.fake.repos.get('octo/dsh-artifacts')!, 'gh-pages', { 'blog/index.html': 'mine' })
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'Blog', slug: 'blog', content: '<p/>' }))).toMatch(/already exists .* but is not an artifact/)
    expect(pagesFiles(h).get('blog/index.html')).toBe('mine')
  })

  it('validates arguments before asking for approval', async () => {
    const h = await harness()
    expect(text(await h.call('artifact_publish', { description: 'x', content: '<p/>' }))).toMatch(/needs a title/)
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T' }))).toMatch(/needs path or content/)
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', path: 'a.md', content: 'b' }))).toMatch(/either path or content/)
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', slug: 'Bad Slug', content: 'b' }))).toMatch(/not a valid artifact id/)
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', content: 'b', assets: [{ path: 'x.png', name: '../x.png' }] }))).toMatch(/relative path/)
    expect(text(await h.call('artifact_publish', { description: ' ', title: 'T', content: 'b' }))).toMatch(/description must not be empty/)
    expect(h.asked).toHaveLength(0)
  })
})

describe('workspace confinement and secrets', () => {
  it('refuses files outside the workspace, symlinks, and missing files', async () => {
    const h = await harness()
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'artifacts-outside-')))
    writeFileSync(join(outside, 'secret.md'), '# secret')
    symlinkSync(join(outside, 'secret.md'), join(h.workspace, 'link.md'))
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', path: join(outside, 'secret.md') }))).toMatch(/outside the Session workspace/)
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', path: '../' + outside.split('/').pop() + '/secret.md' }))).toMatch(/outside the Session workspace/)
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', path: 'link.md' }))).toMatch(/not a regular file/)
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', path: 'missing.md' }))).toMatch(/does not exist/)
    expect(h.asked).toHaveLength(0)
  })

  it('blocks credential-looking content and the token itself', async () => {
    const h = await harness()
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', content: `<p>ghp_${'a'.repeat(36)}</p>` }))).toMatch(/appears to contain GitHub token/)
    writeFileSync(join(h.workspace, 'leak.js'), `const t = "${h.fake.token}"`)
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', content: '<p>ok</p>', assets: [{ path: 'leak.js' }] }))).toMatch(/Refusing to publish leak\.js/)
    expect(h.asked).toHaveLength(0)
  })

  it('enforces the size limit', async () => {
    const h = await harness({ config: { maxPublishBytes: 2048 } })
    writeFileSync(join(h.workspace, 'big.html'), 'x'.repeat(4096))
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', path: 'big.html' }))).toMatch(/above the 2\.0 KiB publish limit/)
  })
})

describe('approval modes', () => {
  it('reports a human rejection and writes nothing', async () => {
    const h = await harness()
    h.answer.outcome = 'rejected'
    const before = pagesFiles(h)
    const result = await h.call('artifact_publish', { description: 'x', title: 'T', content: '<p/>' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/The user declined/)
    expect(pagesFiles(h)).toEqual(before)
  })

  it('skips the prompt in full-access sessions (danger-full-access without approval prompts) by default', async () => {
    const h = await harness({ sandboxMode: 'danger-full-access', approvalPolicy: 'never' })
    value(await h.call('artifact_publish', { description: 'x', title: 'T', content: '<p/>' }))
    expect(h.asked).toHaveLength(0)
  })

  it('still asks in Auto-style sessions that keep approval prompts', async () => {
    const h = await harness({ sandboxMode: 'danger-full-access', approvalPolicy: 'ask' })
    value(await h.call('artifact_publish', { description: 'x', title: 'T', content: '<p/>' }))
    expect(h.asked).toHaveLength(1)
  })

  it('with approval: always, asks even with danger-full-access and fails where no one can be asked', async () => {
    const auto = await harness({ sandboxMode: 'danger-full-access', approvalPolicy: 'ask', config: { approval: 'always' } })
    value(await auto.call('artifact_publish', { description: 'x', title: 'T', content: '<p/>' }))
    expect(auto.asked).toHaveLength(1)
    vi.unstubAllGlobals()
    const full = await harness({ sandboxMode: 'danger-full-access', approvalPolicy: 'never', config: { approval: 'always' } })
    expect(text(await full.call('artifact_publish', { description: 'x', title: 'T', content: '<p/>' }))).toMatch(/rejects approval requests automatically/)
  })

  it('explains sessions that reject approval automatically', async () => {
    const h = await harness({ approvalPolicy: 'never' })
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', content: '<p/>' }))).toMatch(/rejects approval requests automatically/)
    const child = makeAgent(h.workspace, { delegationDepth: 1 })
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', content: '<p/>' }, child))).toMatch(/not available to delegated subagents/)
    const open = await harness({ approvalPolicy: 'never', config: { subagentAccess: 'full' } })
    const openChild = makeAgent(open.workspace, { delegationDepth: 1 })
    expect(text(await open.call('artifact_publish', { description: 'x', title: 'T', content: '<p/>' }, openChild))).toMatch(/delegated subagent cannot request/)
  })

  it('fails closed without an approval service, unless approval is off', async () => {
    const closed = await harness({ approval: false })
    expect(text(await closed.call('artifact_publish', { description: 'x', title: 'T', content: '<p/>' }))).toMatch(/no approval channel/)
    vi.unstubAllGlobals()
    const open = await harness({ approval: false, config: { approval: 'off' } })
    value(await open.call('artifact_publish', { description: 'x', title: 'T', content: '<p/>' }))
  })

  it('gates delete but not list, read, or status', async () => {
    const h = await harness()
    const out = value(await h.call('artifact_publish', { description: 'x', title: 'T', content: '# hi' }))
    value(await h.call('artifact_list', {}))
    value(await h.call('artifact_read', { id: out['id'] }))
    value(await h.call('artifact_status', {}))
    expect(h.asked).toHaveLength(1)
    h.answer.outcome = 'rejected'
    expect(text(await h.call('artifact_delete', { id: out['id'] }))).toMatch(/declined: delete artifact/)
    expect(pagesFiles(h).has(`${out['id']}/index.html`)).toBe(true)
  })
})

describe('artifact_list, artifact_read, artifact_delete', () => {
  it('lists newest first with filtering and paging', async () => {
    let tick = 0
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const h = await harness()
      for (const title of ['Alpha', 'Beta', 'Gamma']) {
        vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, ++tick)))
        value(await h.call('artifact_publish', { description: `${title} doc`, title, content: `# ${title}` }))
      }
      const all = value(await h.call('artifact_list', {}))
      expect(all['total']).toBe(3)
      expect(all['artifacts'].map((item: { title: string }) => item.title)).toEqual(['Gamma', 'Beta', 'Alpha'])
      expect(all['artifacts'][0].repository).toBe('octo/dsh-artifacts')
      const page = value(await h.call('artifact_list', { limit: 2 }))
      expect(page['nextOffset']).toBe(2)
      const filtered = value(await h.call('artifact_list', { query: 'beta' }))
      expect(filtered['artifacts']).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads sources in windows', async () => {
    const h = await harness()
    const body = `# Title\n\n${'word '.repeat(3000)}`
    const out = value(await h.call('artifact_publish', { description: 'x', title: 'Long', content: body }))
    const first = value(await h.call('artifact_read', { id: out['id'] }))
    expect(first).toMatchObject({ file: 'source.md', offset: 0, totalChars: body.length, nextOffset: 8000 })
    expect(first['content']).toBe(body.slice(0, 8000))
    const rest = value(await h.call('artifact_read', { id: out['id'], offset: 8000, limit: 20000 }))
    expect(rest['content']).toBe(body.slice(8000))
    expect(rest['nextOffset']).toBeUndefined()
    const page = value(await h.call('artifact_read', { id: out['id'], file: 'index.html', limit: 200 }))
    expect(page['content']).toMatch(/^<!doctype html>/)
    expect(text(await h.call('artifact_read', { id: out['id'], file: 'nope.txt' }))).toMatch(/has no file/)
  })

  it('deletes an artifact and tombstones its id', async () => {
    const h = await harness()
    const out = value(await h.call('artifact_publish', { description: 'x', title: 'Gone', content: '# bye' }))
    const deleted = value(await h.call('artifact_delete', { id: out['id'] }))
    expect(deleted).toMatchObject({ id: out['id'], deleted: true, url: out['url'] })
    const files = pagesFiles(h)
    expect([...files.keys()].some(path => path.startsWith(`${out['id']}/`))).toBe(false)
    expect(parseManifest(files.get(MANIFEST_PATH)!).tombstones).toEqual([out['id']])
    expect(text(await h.call('artifact_read', { id: out['id'] }))).toMatch(/was deleted/)
  })
})

describe('setup problems and status', () => {
  it('explains a missing token without leaking anything', async () => {
    const h = await harness()
    vi.stubEnv(TOKEN_ENV, '')
    const result = await h.call('artifact_list', {})
    expect(text(result)).toMatch(/No GitHub token is configured.*GH_PAGES_TOKEN_TEST/s)
    const status = value(await h.call('artifact_status', {}))
    expect(status).toMatchObject({ ready: false, token: { configured: false } })
  })

  it('turns GitHub Pages on when it is off, and warns when it cannot', async () => {
    const h = await harness({ pages: 'disabled' })
    expect(value(await h.call('artifact_status', {}))).toMatchObject({ ready: false, pages: 'disabled' })
    expect(h.fake.repos.get('octo/dsh-artifacts')!.pages).toBeUndefined()
    const out = value(await h.call('artifact_publish', { description: 'x', title: 'T', content: '<p/>' }))
    expect(h.asked[0]!.displayReason!.en).toContain('(GitHub Pages gets turned on)')
    expect(out['warnings']).toEqual([])
    expect(h.fake.repos.get('octo/dsh-artifacts')!.pages).toMatchObject({ branch: 'gh-pages', path: '/' })
    const blocked = await harness({ pages: 'disabled' })
    blocked.fake.interceptors.push(request => request.method === 'POST' && request.path.endsWith('/pages')
      ? new Response(JSON.stringify({ message: 'Resource not accessible by personal access token' }), { status: 403 })
      : undefined)
    const warned = value(await blocked.call('artifact_publish', { description: 'x', title: 'T', content: '<p/>' }))
    expect(warned['warnings'].join('\n')).toMatch(/Could not enable GitHub Pages/)
  })

  it('warns when Pages publishes a different branch', async () => {
    const h = await harness()
    h.fake.repos.get('octo/dsh-artifacts')!.pages = { branch: 'main', path: '/' }
    const status = value(await h.call('artifact_status', {}))
    expect(status['problems'].join('\n')).toMatch(/publishes main \//)
  })

  it('waits until the head commit is deployed, not just until the URL answers', async () => {
    const h = await harness()
    const out = value(await h.call('artifact_publish', { description: 'x', title: 'Lag', content: '<p>v1</p>' }))
    const repo = h.fake.repos.get('octo/dsh-artifacts')!
    repo.buildLag = 1
    const pending = value(await h.call('artifact_status', { id: out['id'] }))
    expect(pending).toMatchObject({ deployed: false, latestBuild: { status: 'building' }, artifact: { live: true } })
    expect(pending['problems'].join('\n')).toMatch(/is not deployed yet \(Pages build: building\)/)
    const runtime = new ArtifactsRuntime(h.ctx, normalizeConfig(Config({ tokenEnv: TOKEN_ENV, registryDir: realpathSync(mkdtempSync(join(tmpdir(), 'artifacts-registry-'))) })), {
      fetch: h.fake.fetch, sleep: () => Promise.resolve(),
    })
    repo.buildLag = 3
    const waited = await runtime.status({ id: out['id'], wait: true }, new AbortController().signal)
    expect(waited).toMatchObject({ deployed: true, headCommit: repo.refs.get('gh-pages'), latestBuild: { status: 'built' }, problems: [] })
    expect(repo.buildLag).toBe(0)
  })

  it('reports a ready setup and a live artifact', async () => {
    const h = await harness()
    const out = value(await h.call('artifact_publish', { description: 'x', title: 'Live', content: '<p>live</p>' }))
    const status = value(await h.call('artifact_status', { id: out['id'] }))
    expect(status).toMatchObject({
      ready: true, repository: 'octo/dsh-artifacts', pages: 'enabled', token: { configured: true },
      latestBuild: { status: 'built' }, deployed: true, artifact: { id: out['id'], live: true, httpStatus: 200 }, problems: [],
    })
  })
})

describe('integration with the harness', () => {
  it('registers five tools, the prompt section, and the bundled skill', async () => {
    const h = await harness()
    for (const name of plugin.ALL_TOOLS) expect(h.ctx.tools.get(name)).toBeDefined()
    const prompt = renderPrompt(await h.ctx.systemPrompt.assemble({}))
    expect(prompt).toContain('# Shareable artifacts')
    const skills = await h.ctx.skills.list({ cwd: h.workspace })
    expect(skills.map(skill => skill.name)).toContain('artifact-pages')
    const loaded = await h.ctx.skills.get('artifact-pages', { cwd: h.workspace })
    expect(loaded?.content).toContain('# Publishing artifacts on GitHub Pages')
  })

  it('can turn off the prompt section and the skill', async () => {
    const h = await harness({ config: { promptGuidance: false, bundledSkill: false } })
    expect(renderPrompt(await h.ctx.systemPrompt.assemble({}))).not.toContain('# Shareable artifacts')
    expect((await h.ctx.skills.list({ cwd: h.workspace })).map(skill => skill.name)).not.toContain('artifact-pages')
  })

  it('unregisters everything when the plugin is disposed', async () => {
    const fake = new FakeGitHub()
    vi.stubGlobal('fetch', fake.fetch)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = ctx.plugin(plugin, { tokenEnv: TOKEN_ENV })
    await fiber
    expect(ctx.tools.get('artifact_publish')).toBeDefined()
    await fiber.dispose()
    expect(ctx.tools.get('artifact_publish')).toBeUndefined()
  })
})

describe('hardening', () => {
  it('screens title, description, and asset names for secrets, including the token itself', async () => {
    const h = await harness()
    expect(text(await h.call('artifact_publish', { description: `key ${h.fake.token}`, title: 'T', content: '# x' }))).toMatch(/title, description, slug, or asset names appear to contain/)
    expect(text(await h.call('artifact_publish', { description: 'x', title: `sk-${'a'.repeat(40)}`, content: '# x' }))).toMatch(/API secret key/)
    expect(h.asked).toHaveLength(0)
  })

  it('screens binary assets and recognizes more credential formats', async () => {
    const h = await harness()
    writeFileSync(join(h.workspace, 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`-----BEGIN RSA PRIVATE KEY-----`)]))
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', content: '# x', assets: [{ path: 'blob.bin', name: 'data.dat' }] }))).toMatch(/private key/)
    const encoded = Buffer.from(h.fake.token).toString('base64')
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', content: `# x\n\n${encoded}` }))).toMatch(/the GitHub token this plugin uses/)
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', content: 'DATABASE_URL=postgres://admin:hunter2pw@db.internal:5432/app' }))).toMatch(/password in a URL/)
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', content: 'password: Sup3rSecretValue99' }))).toMatch(/password or secret assignment/)
  })

  it('refuses hidden and credential files as page or asset sources', async () => {
    const h = await harness()
    writeFileSync(join(h.workspace, '.env'), 'X=1')
    writeFileSync(join(h.workspace, 'id_ed25519'), 'k')
    mkdirSync(join(h.workspace, '.ssh'))
    writeFileSync(join(h.workspace, '.ssh', 'notes.md'), '# n')
    writeFileSync(join(h.workspace, 'page.md'), '# p')
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', path: '.env', kind: 'markdown' }))).toMatch(/Refusing to publish \.env looks like a credential/)
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', path: '.ssh/notes.md' }))).toMatch(/inside \.ssh\//)
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', path: 'page.md', assets: [{ path: 'id_ed25519', name: 'key.txt' }] }))).toMatch(/looks like a credential/)
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', path: 'page.md', assets: [{ path: 'page.md', name: 'server.pem' }] }))).toMatch(/named "server.pem"/)
    expect(h.asked).toHaveLength(0)
  })

  it('accepts only page-like files as the main source', async () => {
    const h = await harness()
    writeFileSync(join(h.workspace, 'data.json'), '{}')
    writeFileSync(join(h.workspace, 'notes.txt'), 'plain *text*')
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', path: 'data.json', kind: 'markdown' }))).toMatch(/cannot be published as a page/)
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', path: 'notes.txt' }))).toMatch(/pass kind/)
    value(await h.call('artifact_publish', { description: 'x', title: 'T', path: 'notes.txt', kind: 'markdown' }))
  })

  it('treats inline fragments as Markdown unless they are whole HTML documents', async () => {
    const h = await harness()
    const fragment = value(await h.call('artifact_publish', { description: 'x', title: 'Frag', content: '<!-- c --><p>hi</p><script>alert(1)</script>' }))
    expect(fragment['kind']).toBe('markdown')
    expect(pagesFiles(h).get(`${fragment['id']}/index.html`)).not.toContain('<script>alert(1)</script>')
    const page = value(await h.call('artifact_publish', { description: 'x', title: 'Doc', content: '<!DOCTYPE html><html><body><script>1</script></body></html>' }))
    expect(page['kind']).toBe('html')
  })

  it('rejects titles with control or bidi characters and overlong text', async () => {
    const h = await harness()
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'Safe\u202Etxt.exe', content: '# x' }))).toMatch(/single line without control/)
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'a\nb', content: '# x' }))).toMatch(/single line/)
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'a'.repeat(201), content: '# x' }))).toMatch(/at most 200/)
  })

  it('builds the approval text from trusted facts', async () => {
    const h = await harness()
    writeFileSync(join(h.workspace, 'a.png'), 'A')
    writeFileSync(join(h.workspace, 'page.html'), '<p>1</p>')
    const out = value(await h.call('artifact_publish', { description: 'x', title: 'Evil" at https://example.com/ (0 files)', path: 'page.html', assets: [{ path: 'a.png', name: 'img/a.png' }] }))
    const display = h.asked[0]!.displayReason!.en
    expect(display.startsWith(`Publish a new public page at ${out['url']}?`)).toBe(true)
    expect(display).toContain('Title: "Evil\\" at https://example.com/ (0 files)".')
    expect(display).toContain('Page: workspace file "page.html" as html')
    expect(display).toContain('Assets: "a.png" as "img/a.png".')
    value(await h.call('artifact_publish', { description: 'x', id: out['id'], removeAssets: ['img/a.png'] }))
    expect(h.asked[1]!.displayReason!.en).toContain('Page content unchanged. Removes: "img/a.png".')
  })

  it('reads HTML pages back without the injected tags', async () => {
    const h = await harness()
    const source = '<!doctype html><html><head><title>t</title></head><body>b</body></html>'
    const out = value(await h.call('artifact_publish', { description: 'x', title: 'T', content: source }))
    expect(pagesFiles(h).get(`${out['id']}/index.html`)).toContain('data-dsh-artifacts')
    expect(value(await h.call('artifact_read', { id: out['id'] }))['content']).toBe(source)
  })

  it('refuses to turn an existing Jekyll site into an artifact host', async () => {
    const h = await harness()
    const repo = h.fake.repos.get('octo/dsh-artifacts')!
    repo.refs.delete('gh-pages')
    h.fake.pushFiles(repo, 'gh-pages', { '_config.yml': 'theme: minima\n', 'index.md': '# Blog' })
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', content: '# x' }))).toMatch(/existing Jekyll site/)
    expect(h.asked).toHaveLength(0)
    expect(pagesFiles(h).has('.nojekyll')).toBe(false)
  })

  it('fails fast on a protected branch instead of retrying', async () => {
    const h = await harness()
    h.fake.repos.get('octo/dsh-artifacts')!.protectedBranch = true
    const before = h.fake.requests.length
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', content: '# x' }))).toMatch(/GitHub refused to update .*Protected branch update failed/s)
    const patches = h.fake.requests.slice(before).filter(request => request.method === 'PATCH')
    expect(patches).toHaveLength(1)
  })

  it('never writes to an empty repository from read-only tools, and initializes it on publish', async () => {
    const h = await harness({ config: { repo: 'empty-one' } })
    const repo = h.fake.addRepo('empty-one', { empty: true })
    value(await h.call('artifact_list', {}))
    value(await h.call('artifact_status', {}))
    expect(repo.empty).toBe(true)
    expect(h.fake.requests.some(request => request.method !== 'GET' && request.method !== 'HEAD')).toBe(false)
    h.answer.outcome = 'rejected'
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'First', content: '# first' }))).toMatch(/declined/)
    expect(repo.empty).toBe(true)
    h.answer.outcome = 'allowed-once'
    const out = value(await h.call('artifact_publish', { description: 'x', title: 'First', content: '# first' }))
    expect(repo.empty).toBe(false)
    expect(h.fake.filesOf(repo, 'gh-pages').get(`${out['id']}/source.md`)).toBe('# first')
  })

  it('requires baseUrl on GitHub Enterprise when the Pages URL cannot be discovered', async () => {
    const h = await harness({ config: { apiBaseUrl: 'https://ghe.example.com/api/v3' } })
    h.fake.apiBase = 'https://ghe.example.com/api/v3'
    h.fake.repos.get('octo/dsh-artifacts')!.pagesForbidden = true
    expect(text(await h.call('artifact_publish', { description: 'x', title: 'T', content: '# x' }))).toMatch(/set the plugin option baseUrl/)
    const configured = await harness({ config: { apiBaseUrl: 'https://ghe.example.com/api/v3', baseUrl: 'https://pages.ghe.example.com/octo/dsh-artifacts' } })
    configured.fake.apiBase = 'https://ghe.example.com/api/v3'
    configured.fake.repos.get('octo/dsh-artifacts')!.pagesForbidden = true
    const out = value(await configured.call('artifact_publish', { description: 'x', title: 'T', content: '# x' }))
    expect(out['url']).toMatch(/^https:\/\/pages\.ghe\.example\.com\/octo\/dsh-artifacts\//)
  })

  it('reports an unverifiable Pages setup as not ready', async () => {
    const h = await harness()
    h.fake.repos.get('octo/dsh-artifacts')!.pagesForbidden = true
    const status = value(await h.call('artifact_status', {}))
    expect(status).toMatchObject({ ready: false, pages: 'unknown' })
    expect(status['problems'].join('\n')).toMatch(/lacks Pages: read/)
  })

  it('warns that a private repository with siteDir root serves the artifact index', async () => {
    const h = await harness()
    h.fake.repos.get('octo/dsh-artifacts')!.private = true
    const out = value(await h.call('artifact_publish', { description: 'x', title: 'T', content: '# x' }))
    expect(out['warnings'].join('\n')).toMatch(/is private, but with siteDir '' its whole branch is served/)
  })

  it('does not guess the owner from a token found in a launch-directory .env', async () => {
    const h = await harness()
    h.ctx.provide('credentials', { resolve: async () => ({ value: h.fake.token, source: 'project-env' }) })
    expect(text(await h.call('artifact_list', {}))).toMatch(/will not guess the repository owner/)
    const pinned = await harness({ config: { owner: 'octo' } })
    pinned.ctx.provide('credentials', { resolve: async () => ({ value: pinned.fake.token, source: 'project-env' }) })
    value(await pinned.call('artifact_list', {}))
  })
})
