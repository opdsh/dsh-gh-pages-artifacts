/** Smoke test of the browser half: load client.js the way dsh does and render its settings page. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const React = require('react') as typeof import('react')
const { renderToString } = require('react-dom/server') as typeof import('react-dom/server')

interface Registration { options: { name: string; key?: string; id?: string; label?: string; order?: number }; component: (props: Record<string, unknown>) => unknown }

function loadClient(snapshot: Record<string, unknown>) {
  let module: { inject: string[]; apply(ctx: unknown): void } | undefined
  const fakeWindow = { __ModuleLoader__: { load: ({ id, factory }: { id: string; factory: (req: (name: string) => unknown) => typeof module }) => {
    expect(id).toBe('dsh-gh-pages-artifacts')
    module = factory(name => {
      if (name === 'react') return React
      throw new Error(`unexpected require ${name}`)
    })
  } } }
  new Function('window', readFileSync(new URL('../client/client.js', import.meta.url), 'utf8'))(fakeWindow)
  const registrations: Registration[] = []
  const served: string[][] = []
  const ctx = {
    effect: (run: () => () => void) => run(),
    configForms: {
      whileServed: (namespaces: string[], run: () => () => void) => { served.push(namespaces); return run() },
      get: () => ({ getSnapshot: () => snapshot, subscribe: () => () => undefined, mutate: async () => true }),
    },
    slots: {
      inject: (_slot: string, run: () => () => void) => run(),
      register: (options: Registration['options'], component: Registration['component']) => { registrations.push({ options, component }); return () => undefined },
    },
    remote: { credentials: { describe: async () => ({ ok: true, value: {} }), set: async () => undefined }, $on: () => () => undefined },
    on: () => () => undefined,
  }
  module!.apply(ctx)
  return { module: module!, registrations, served }
}

describe('client settings page', () => {
  const snapshot = {
    status: 'ready', revision: 3, writable: true, mode: 'host', base: {}, user: { repoStrategy: 'per-artifact' },
    value: { repoStrategy: 'per-artifact', repo: 'dsh-artifacts', branch: 'gh-pages', repoPrefix: 'artifact-', repoVisibility: 'public', approval: 'unless-full-access', noindex: true, blockSecrets: true, tokenEnv: 'GH_PAGES_TOKEN' },
  }

  it('registers on the bundle page and as the row configuration while its settings are served', () => {
    const { module, registrations, served } = loadClient(snapshot)
    expect(module.inject).toEqual(['slots', 'configForms', 'remote', 'remote.credentials'])
    expect(served).toEqual([['gh-pages-artifacts']])
    expect(registrations.map(entry => `${entry.options.name}:${entry.options.key ?? entry.options.id}`)).toEqual([
      'plugins.bundle.config:dsh-gh-pages-artifacts', 'plugins.row.config:dsh-gh-pages-artifacts#gh-pages-artifacts',
      'main:dsh-gh-pages-artifacts', 'sidebar.panellist:dsh-gh-pages-artifacts',
    ])
    const entry = registrations.find(item => item.options.name === 'sidebar.panellist')!
    expect(entry.options).toMatchObject({ label: 'Artifacts', order: 20 })
  })

  it('renders the sidebar glyph and the Artifacts panel', () => {
    const { registrations } = loadClient(snapshot)
    const Icon = registrations.find(item => item.options.name === 'sidebar.panellist')!.component as import("react").FC<Record<string, unknown>>
    expect(renderToString(React.createElement(Icon, { size: 16, active: false }))).toMatch(/^<svg[^>]*width="16"/)
    const Panel = registrations.find(item => item.options.name === 'main')!.component as import("react").FC<Record<string, unknown>>
    const html = renderToString(React.createElement(Panel, {}))
    expect(html).toContain('<h1>Artifacts</h1>')
    expect(html).toContain('Loading…')
    expect(html).toContain('Refresh')
  })

  it('renders the summary and the full page', () => {
    const { registrations } = loadClient(snapshot)
    const Page = registrations[0]!.component as import("react").FC<Record<string, unknown>>
    expect(renderToString(React.createElement(Page, { view: 'summary' }))).toContain('Publish HTML pages and Markdown documents')
    const html = renderToString(React.createElement(Page, { view: 'page' }))
    for (const text of ['GitHub token', 'GH_PAGES_TOKEN', 'Repository strategy', 'A new repository for each artifact', 'Owner of new repositories', 'Repository name prefix', 'Author email', 'Ask before publishing and deleting', 'Save']) {
      expect(html).toContain(text)
    }
    expect(html).toContain('value="artifact-"')
  })

  it('explains when settings are unavailable', () => {
    const { registrations } = loadClient({ ...snapshot, status: 'unavailable', value: undefined })
    const Page = registrations[0]!.component as import("react").FC<Record<string, unknown>>
    expect(renderToString(React.createElement(Page, { view: 'page' }))).toContain('Settings are not available')
  })
})
