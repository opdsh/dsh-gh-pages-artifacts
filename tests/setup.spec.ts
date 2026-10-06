/**
 * Runs the real bin/setup.mjs against a fake `gh` executable that forwards `gh api -i` calls to
 * the in-memory GitHub over loopback HTTP, so the whole setup flow is exercised offline.
 */
import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeGitHub } from './fake-github.js'

const SETUP = fileURLToPath(new URL('../bin/setup.mjs', import.meta.url))
const AUTHOR = { name: 'VibOtaku', email: 'vibotaku@example.com' }

const FAKE_GH = `#!/usr/bin/env node
// Minimal stand-in for "gh api -X <method> -H ... -i <path> [--input -]".
const args = process.argv.slice(2)
if (args[0] !== 'api') { console.error('fake gh: only "api" is supported'); process.exit(2) }
let method = 'GET', path, input = false
for (let i = 1; i < args.length; i++) {
  if (args[i] === '-X') method = args[++i]
  else if (args[i] === '-H') i++
  else if (args[i] === '--input') { input = true; i++ }
  else if (args[i] === '-i') {}
  else path = args[i]
}
const chunks = []
const send = async () => {
  const body = input ? Buffer.concat(chunks).toString('utf8') : undefined
  const res = await fetch(process.env.FAKE_GH_BASE + (path.startsWith('/') ? path : '/' + path), {
    method, body, headers: { authorization: 'Bearer ' + process.env.FAKE_GH_TOKEN, 'user-agent': 'fake-gh', 'content-type': 'application/json' },
  })
  const text = await res.text()
  process.stdout.write('HTTP/2.0 ' + res.status + ' ' + res.statusText + '\\r\\nContent-Type: application/json\\r\\n\\r\\n' + text)
  process.exit(res.status >= 400 ? 1 : 0)
}
if (input) { process.stdin.on('data', c => chunks.push(c)); process.stdin.on('end', send) } else send()
`

let server: Server | undefined

afterEach(async () => {
  await new Promise<void>(resolve => server === undefined ? resolve() : server.close(() => resolve()))
  server = undefined
})

async function start(fake: FakeGitHub): Promise<{ run: (args: string[], options?: { stdin?: string }) => Promise<{ code: number; out: string }> }> {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = chunks.length === 0 ? undefined : Buffer.concat(chunks).toString('utf8')
    const response = await fake.fetch(`${fake.apiBase}${req.url}`, {
      method: req.method!, headers: req.headers as Record<string, string>, ...body === undefined || body === '' ? {} : { body },
    })
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const port = (server!.address() as { port: number }).port
  fake.apiBase = `http://127.0.0.1:${port}`
  const bin = mkdtempSync(join(tmpdir(), 'fake-gh-'))
  writeFileSync(join(bin, 'gh'), FAKE_GH)
  chmodSync(join(bin, 'gh'), 0o755)
  const run = (args: string[]) => new Promise<{ code: number; out: string }>((resolve) => {
    const child = execFile(process.execPath, [SETUP, 'setup', ...args], {
      env: { ...process.env, PATH: `${bin}:${process.env['PATH']}`, FAKE_GH_BASE: fake.apiBase, FAKE_GH_TOKEN: fake.token, CLICOLOR_FORCE: '1' },
      timeout: 60_000,
    }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : (error as { code?: number }).code ?? 1, out: `${stdout}${stderr}` }))
    child.stdin?.end()
  })
  return { run }
}

describe('bin/setup.mjs', () => {
  it('creates the repository, an orphan Pages branch, and the Pages site with explicit authors', async () => {
    const fake = new FakeGitHub()
    const { run } = await start(fake)
    const { code, out } = await run(['--repo', 'arts', '--author', `${AUTHOR.name} <${AUTHOR.email}>`, '--yes'])
    expect(out).toContain('created https://github.com/octo/arts')
    expect(code).toBe(0)
    const repo = fake.repos.get('octo/arts')!
    expect(repo.private).toBe(false)
    expect(repo.pages).toMatchObject({ branch: 'gh-pages', path: '/' })
    expect([...fake.filesOf(repo, 'gh-pages').keys()]).toEqual(['.nojekyll'])
    expect(fake.filesOf(repo, 'main').has('README.md')).toBe(true)
    for (const branch of ['main', 'gh-pages']) expect(fake.authorOf(repo.refs.get(branch)!)).toEqual(AUTHOR)
    expect(out).toContain('owner: octo')
    expect(out).toContain('repo: arts')
    expect(out).toContain('email: vibotaku@example.com')
  })

  it('is idempotent on a repository that is already set up', async () => {
    const fake = new FakeGitHub()
    const { run } = await start(fake)
    expect((await run(['--repo', 'arts', '--yes'])).code).toBe(0)
    const second = await run(['--repo', 'arts', '--yes'])
    expect(second.code).toBe(0)
    expect(second.out).toContain('repository octo/arts exists')
    expect(second.out).toContain('GitHub Pages is enabled')
  })

  it('seeds an existing empty repository before creating the branch', async () => {
    const fake = new FakeGitHub()
    const repo = fake.addRepo('blank', { empty: true, pages: null })
    const { run } = await start(fake)
    const { code, out } = await run(['--repo', 'blank', '--yes'])
    expect(out).not.toMatch(/error/)
    expect(code).toBe(0)
    expect(repo.empty).toBe(false)
    expect(repo.refs.has('gh-pages')).toBe(true)
    expect(repo.pages?.branch).toBe('gh-pages')
  })

  it('publishes from /docs for private repositories', async () => {
    const fake = new FakeGitHub()
    const { run } = await start(fake)
    const { code, out } = await run(['--repo', 'secret-arts', '--private', '--yes'])
    expect(code).toBe(0)
    const repo = fake.repos.get('octo/secret-arts')!
    expect(repo.private).toBe(true)
    expect(repo.pages).toMatchObject({ branch: 'gh-pages', path: '/docs' })
    expect(fake.filesOf(repo, 'gh-pages').has('docs/.nojekyll')).toBe(true)
    expect(out).toContain('siteDir: docs')
  })

  it('creates repositories only under the user or an organization', async () => {
    const fake = new FakeGitHub()
    fake.orgs.add('acme')
    const { run } = await start(fake)
    const someone = await run(['--owner', 'someone-else', '--repo', 'x', '--yes'])
    expect(someone.code).not.toBe(0)
    expect(someone.out).toMatch(/only create repositories under your own account/)
    const org = await run(['--owner', 'acme', '--repo', 'x', '--yes'])
    expect(org.code).toBe(0)
    expect(fake.repos.has('acme/x')).toBe(true)
    const caseInsensitive = await run(['--owner', 'OCTO', '--repo', 'y', '--yes'])
    expect(caseInsensitive.code).toBe(0)
    expect(fake.repos.has('octo/y')).toBe(true)
  })

  it('refuses to change anything without a terminal unless --yes is given', async () => {
    const fake = new FakeGitHub()
    const { run } = await start(fake)
    const { code, out } = await run(['--repo', 'arts'])
    expect(code).not.toBe(0)
    expect(out).toMatch(/must be run by a person in an interactive terminal/)
    expect(out).not.toMatch(/--yes/)
    expect(fake.repos.has('octo/arts')).toBe(false)
  })

  it('refuses the user site repository', async () => {
    const fake = new FakeGitHub()
    const { run } = await start(fake)
    const { code, out } = await run(['--repo', 'octo.github.io', '--yes'])
    expect(code).not.toBe(0)
    expect(out).toMatch(/dedicated repository/)
  })
})
