import { describe, expect, it } from 'vitest'
import { Config, normalizeConfig, normalizeRelativeDir, normalizeUrl } from '../src/config.js'
import { findSecrets, isTextName } from '../src/content.js'
import {
  assetNameProblem, emptyManifest, idFromTitle, idProblem, ManifestError, parseManifest, serializeManifest, slugify,
} from '../src/manifest.js'
import { prepareHtmlPage, renderMarkdownPage, stripInjected } from '../src/render.js'
import { defaultSiteUrl } from '../src/service.js'
import { parseSkill } from '../src/skill.js'
import { hiddenTools } from '../src/visibility.js'
import { readFileSync } from 'node:fs'

const PAGE = { noindex: true, csp: "object-src 'none'; base-uri 'none'" }

describe('manifest ids and names', () => {
  it('slugifies titles to readable ASCII', () => {
    expect(slugify('Q3 Revenue — Report!')).toBe('q3-revenue-report')
    expect(slugify('Café déjà vu')).toBe('cafe-deja-vu')
    expect(slugify('日本語')).toBe('artifact')
    expect(slugify('a'.repeat(100)).length).toBe(40)
    expect(slugify(`${'a'.repeat(39)}-b`)).toBe('a'.repeat(39))
  })

  it('builds ids that pass validation', () => {
    const id = idFromTitle('Weekly Update', 'k3x9ab')
    expect(id).toBe('weekly-update-k3x9ab')
    expect(idProblem(id)).toBeUndefined()
  })

  it('rejects invalid and reserved ids', () => {
    expect(idProblem('Upper')).toMatch(/not a valid artifact id/)
    expect(idProblem('-lead')).toMatch(/not a valid/)
    expect(idProblem('trail-')).toMatch(/not a valid/)
    expect(idProblem('a'.repeat(65))).toMatch(/not a valid/)
    expect(idProblem('../x')).toMatch(/not a valid/)
    expect(idProblem('404')).toMatch(/reserved/)
    expect(idProblem('ok-1')).toBeUndefined()
  })

  it('validates asset names', () => {
    expect(assetNameProblem('chart.png')).toBeUndefined()
    expect(assetNameProblem('img/logo.svg')).toBeUndefined()
    expect(assetNameProblem('../secret')).toMatch(/relative path/)
    expect(assetNameProblem('/abs.png')).toMatch(/relative path/)
    expect(assetNameProblem('.env')).toMatch(/relative path/)
    expect(assetNameProblem('a/.git/config')).toMatch(/relative path/)
    expect(assetNameProblem('a/b/c/d/e.png')).toMatch(/relative path/)
    expect(assetNameProblem('index.html')).toMatch(/reserved/)
    expect(assetNameProblem('source.md')).toMatch(/reserved/)
  })
})

describe('manifest file', () => {
  it('round-trips deterministically', () => {
    const manifest = emptyManifest()
    manifest.artifacts['b-1'] = { id: 'b-1', title: 'B', kind: 'html', createdAt: 't1', updatedAt: 't2', rev: 2, files: ['z.png', 'index.html'] }
    manifest.artifacts['a-1'] = { id: 'a-1', title: 'A', kind: 'markdown', createdAt: 't1', updatedAt: 't1', rev: 1, files: ['index.html', 'source.md'], description: 'd' }
    manifest.tombstones.push('old', 'old')
    const text = serializeManifest(manifest)
    expect(Object.keys(JSON.parse(text).artifacts)).toEqual(['a-1', 'b-1'])
    const parsed = parseManifest(text)
    expect(parsed.artifacts['b-1']!.files).toEqual(['index.html', 'z.png'])
    expect(parsed.tombstones).toEqual(['old'])
    expect(serializeManifest(parsed)).toBe(text)
  })

  it('refuses malformed manifests instead of overwriting them', () => {
    expect(() => parseManifest('{')).toThrow(ManifestError)
    expect(() => parseManifest('{"version":2,"artifacts":{}}')).toThrow(/version 1/)
    expect(() => parseManifest('{"version":1,"artifacts":{"x":{"id":"y"}}}')).toThrow(/invalid id/)
    expect(() => parseManifest('{"version":1,"artifacts":{"x":{"id":"x","title":"t","kind":"pdf","createdAt":"a","updatedAt":"b","rev":1,"files":[]}}}')).toThrow(/kind/)
    expect(() => parseManifest('{"version":1,"artifacts":{"x":{"id":"x","title":"t","kind":"html","createdAt":"a","updatedAt":"b","rev":1,"files":["../x"]}}}')).toThrow(/files/)
    expect(() => parseManifest('{"version":1,"artifacts":{},"tombstones":[1]}')).toThrow(/tombstones/)
  })
})

describe('rendering', () => {
  it('renders GFM Markdown into a styled document and escapes raw HTML', () => {
    const html = renderMarkdownPage({
      title: 'Report <1>',
      description: 'A "quoted" summary',
      markdown: '# Hello\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1)) ~~old~~',
    }, PAGE)
    expect(html).toMatch(/^<!doctype html>/)
    expect(html).toContain('<title>Report &lt;1&gt;</title>')
    expect(html).toContain('<meta name="description" content="A &quot;quoted&quot; summary">')
    expect(html).toContain('<table>')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('<del>old</del>')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toMatch(/href="javascript:/)
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" data-dsh-artifacts>')
    expect(html).toContain('http-equiv="Content-Security-Policy"')
    expect(html).toContain('prefers-color-scheme:dark')
  })

  it('injects marked meta tags right after an existing head', () => {
    const page = prepareHtmlPage({ title: 'x', html: '<!doctype html>\n<html><HEAD lang="en"><title>Mine</title></HEAD><body><header>h</header></body></html>' }, PAGE)
    expect(page).toContain(`<HEAD lang="en">\n<meta http-equiv="Content-Security-Policy" content="object-src 'none'; base-uri 'none'" data-dsh-artifacts>\n<meta name="robots" content="noindex, nofollow" data-dsh-artifacts><title>Mine</title>`)
    expect(page.match(/<head[\s>]/gi)).toHaveLength(1)
  })

  it('always enforces noindex, even when the page asks to be indexed', () => {
    const page = prepareHtmlPage({ title: 'x', html: '<html><head><meta name="robots" content="index, follow"></head></html>' }, PAGE)
    expect(page).toContain('<meta name="robots" content="noindex, nofollow" data-dsh-artifacts>')
  })

  it('does not pile up tags across read-modify-publish cycles', () => {
    const once = prepareHtmlPage({ title: 'x', html: '<html><head><title>t</title></head><body>b</body></html>' }, PAGE)
    const twice = prepareHtmlPage({ title: 'x', html: once }, PAGE)
    expect(twice).toBe(once)
    expect(stripInjected(once)).toBe('<html><head><title>t</title></head><body>b</body></html>')
    const relaxed = prepareHtmlPage({ title: 'x', html: once }, { noindex: false, csp: '' })
    expect(relaxed).not.toContain('data-dsh-artifacts')
  })

  it('ignores a <head> inside a comment', () => {
    const page = prepareHtmlPage({ title: 'x', html: '<!-- <head> --><html><head><title>t</title></head></html>' }, PAGE)
    expect(page.startsWith('<!-- <head> --><html><head>\n<meta http-equiv')).toBe(true)
  })

  it('adds a head when the document has none', () => {
    const page = prepareHtmlPage({ title: 'T & U', html: '<html><body>hi</body></html>' }, PAGE)
    expect(page).toContain('<html>\n<head>\n<meta charset="utf-8">')
    expect(page).toContain('<title>T &amp; U</title>')
  })

  it('wraps a fragment into a full document', () => {
    const page = prepareHtmlPage({ title: 'Frag', html: '<div>hello</div>' }, { noindex: false, csp: '' })
    expect(page).toMatch(/^<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">/)
    expect(page).toContain('<body>\n<div>hello</div>\n</body>')
    expect(page).not.toContain('robots')
    expect(page).not.toContain('Content-Security-Policy')
  })

  it('does not mistake <header> for <head>', () => {
    const page = prepareHtmlPage({ title: 'x', html: '<header>top</header><p>body</p>' }, PAGE)
    expect(page).toContain('<body>\n<header>top</header><p>body</p>\n</body>')
  })
})

describe('secret screening', () => {
  it('finds credential-like strings', () => {
    expect(findSecrets(`token ghp_${'a'.repeat(36)}`)).toEqual(['GitHub token'])
    expect(findSecrets(`github_pat_${'A1_'.repeat(25)}`)).toEqual(['GitHub token'])
    expect(findSecrets('-----BEGIN OPENSSH PRIVATE KEY-----')).toEqual(['private key'])
    expect(findSecrets('AKIAABCDEFGHIJKLMNOP')).toEqual(['AWS access key id'])
    expect(findSecrets(`sk-${'x'.repeat(40)}`)).toEqual(['API secret key (sk-...)'])
    expect(findSecrets('my secret value 12345', ['secret value 12345'])).toEqual(['the GitHub token this plugin uses'])
    expect(findSecrets('<p>Nothing to see; sk-short and AKIA123</p>')).toEqual([])
  })

  it('knows which names are text', () => {
    expect(isTextName('a.SVG')).toBe(true)
    expect(isTextName('a.png')).toBe(false)
    expect(isTextName('Makefile')).toBe(false)
  })
})

describe('configuration', () => {
  it('fills defaults from the schema', () => {
    const settings = normalizeConfig(Config({}))
    expect(settings).toMatchObject({
      owner: undefined, repo: 'dsh-artifacts', branch: 'gh-pages', siteDir: '', pathPrefix: '',
      tokenEnv: 'GH_PAGES_TOKEN', apiBaseUrl: 'https://api.github.com', approval: 'unless-full-access',
      hideFromPresets: ['minimal'], subagentAccess: 'read-only', noindex: true, blockSecrets: true,
      maxPublishBytes: 10 * 1024 * 1024, promptGuidance: true, bundledSkill: true, commitAuthor: undefined,
    })
  })

  it('rejects bad values', () => {
    expect(() => Config({ repo: 'bad repo' })).toThrow()
    expect(() => Config({ branch: '../x' })).toThrow()
    expect(() => Config({ siteDir: 'site' } as never)).toThrow()
    expect(() => Config({ approval: 'never' } as never)).toThrow()
    expect(() => normalizeConfig(Config({ tokenEnv: 'NOT VALID' }))).toThrow(/tokenEnv/)
    expect(() => normalizeConfig(Config({ apiBaseUrl: 'http://github.example.com' }))).toThrow(/https/)
    expect(() => normalizeConfig(Config({ pathPrefix: '../up' }))).toThrow(/pathPrefix/)
    expect(() => normalizeConfig(Config({ commitAuthor: { name: 'a', email: 'nope' } }))).toThrow(/commitAuthor/)
    expect(() => normalizeConfig(Config({ commitAuthor: { email: 'a@b.c' } }))).toThrow(/commitAuthor/)
    expect(normalizeConfig(Config({ commitAuthor: { name: ' VibOtaku ', email: 'v@example.com' } })).commitAuthor)
      .toEqual({ name: 'VibOtaku', email: 'v@example.com' })
  })

  it('normalizes paths and URLs', () => {
    expect(normalizeRelativeDir('/a/b/', 'x')).toBe('a/b')
    expect(normalizeUrl('https://pages.example.com/', 'x', false)).toBe('https://pages.example.com')
    expect(normalizeUrl('http://127.0.0.1:9000/api/', 'x', true)).toBe('http://127.0.0.1:9000/api')
    expect(() => normalizeUrl('https://user:pw@example.com', 'x', true)).toThrow(/credentials/)
  })

  it('derives default site URLs', () => {
    expect(defaultSiteUrl('VibOtaku', 'dsh-artifacts')).toBe('https://vibotaku.github.io/dsh-artifacts')
    expect(defaultSiteUrl('Octo', 'octo.github.io')).toBe('https://octo.github.io')
  })
})

describe('visibility', () => {
  const options = { allTools: ['p', 'l', 'd'], mutatingTools: ['p', 'd'], hideFromPresets: ['minimal'], subagentAccess: 'read-only' as const }
  it('hides everything from listed presets', () => {
    expect(hiddenTools(options, 'minimal', false)).toEqual(['d', 'l', 'p'])
    expect(hiddenTools(options, 'standard', false)).toEqual([])
  })
  it('limits subagents according to subagentAccess', () => {
    expect(hiddenTools(options, 'standard', true)).toEqual(['d', 'p'])
    expect(hiddenTools({ ...options, subagentAccess: 'none' }, undefined, true)).toEqual(['d', 'l', 'p'])
    expect(hiddenTools({ ...options, subagentAccess: 'full' }, undefined, true)).toEqual([])
  })
})

describe('bundled skill', () => {
  it('has valid frontmatter and stays under the pruner threshold', () => {
    const text = readFileSync(new URL('../assets/artifact-pages/SKILL.md', import.meta.url), 'utf8')
    const { description, body } = parseSkill(text)
    expect(/^name: artifact-pages$/m.test(text)).toBe(true)
    expect(description.length).toBeGreaterThan(50)
    expect(description.length).toBeLessThanOrEqual(500)
    expect(body.length).toBeLessThan(8192)
  })
})
