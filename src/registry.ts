/**
 * Local registry of everything this plugin published, across every repository, plus the user's
 * runtime choices (strategy and linked repository). It lives in one JSON file next to a generated
 * index.html with clickable links to every page. Writes are atomic (temp file + rename) and
 * re-read the file first, so several dsh processes sharing a home do not lose each other's entries.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RepoRef, RepoStrategy } from './config.js'
import type { ArtifactKind } from './manifest.js'
import { escapeAttribute, escapeText } from './render.js'

/** Where one artifact lives. */
export interface ArtifactLocation {
  readonly owner: string
  readonly repo: string
  readonly branch: string
  readonly siteDir: string
  readonly pathPrefix: string
  readonly layout: 'folder' | 'root'
}

/** One tracked artifact. */
export interface RegistryEntry {
  id: string
  title: string
  kind: ArtifactKind
  description?: string
  url: string
  location: ArtifactLocation
  createdAt: string
  updatedAt: string
  rev: number
  status: 'published' | 'deleted'
  deletedAt?: string
}

/** A shared repository the user linked at runtime. */
export interface RepositoryLink extends RepoRef {
  readonly linkedAt: string
}

/** Registry file contents. */
export interface RegistryData {
  version: 1
  /** Runtime choices that override the plugin configuration. */
  settings: { strategy?: RepoStrategy; link?: RepositoryLink }
  artifacts: Record<string, RegistryEntry>
}

/** File names inside the registry folder. */
export const REGISTRY_FILE = 'registry.json'
export const INDEX_FILE = 'index.html'

/** Reads and updates the registry file. */
export class Registry {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(readonly dir: string, private readonly log?: (message: string) => void) {}

  /** Path of the registry JSON file. */
  get file(): string {
    return join(this.dir, REGISTRY_FILE)
  }

  /** Path of the generated index page. */
  get indexFile(): string {
    return join(this.dir, INDEX_FILE)
  }

  /** @returns the current registry contents (empty when the file does not exist yet). */
  async read(): Promise<RegistryData> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry()
      throw error
    }
    try {
      return parseRegistry(JSON.parse(text))
    } catch (error) {
      // Keep the unreadable file for the user instead of overwriting it.
      const aside = `${this.file}.unreadable-${Date.now()}`
      await rename(this.file, aside).catch(() => undefined)
      this.log?.(`gh-pages-artifacts: ${this.file} was unreadable (${(error as Error).message}); moved it to ${aside} and started a new registry`)
      return emptyRegistry()
    }
  }

  /**
   * Apply a change and write the file and the index page atomically.
   * @param change - mutates the freshly read data.
   * @returns the written data.
   */
  async update(change: (data: RegistryData) => void): Promise<RegistryData> {
    const run = this.queue.then(async () => {
      const data = await this.read()
      change(data)
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      await writeAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`)
      await writeAtomic(this.indexFile, renderIndex(data))
      return data
    })
    this.queue = run.catch(() => undefined)
    return await run
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, text, { mode: 0o600 })
  await rename(temp, path)
}

/** @returns an empty registry. */
export function emptyRegistry(): RegistryData {
  return { version: 1, settings: {}, artifacts: {} }
}

function parseRegistry(raw: unknown): RegistryData {
  if (typeof raw !== 'object' || raw === null || (raw as { version?: unknown }).version !== 1) throw new Error('not a version 1 registry')
  const data = raw as Partial<RegistryData>
  if (typeof data.artifacts !== 'object' || data.artifacts === null) throw new Error('missing artifacts')
  return { version: 1, settings: data.settings ?? {}, artifacts: data.artifacts }
}

/** @returns the `owner/name` label of a location. */
export function repositoryName(location: RepoRef): string {
  return `${location.owner}/${location.repo}`
}

/**
 * Render the index page: every tracked artifact with a clickable link, newest first.
 * @param data - registry contents.
 */
export function renderIndex(data: RegistryData): string {
  const entries = Object.values(data.artifacts).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const published = entries.filter(entry => entry.status === 'published')
  const rows = entries.map(entry => {
    const repo = repositoryName(entry.location)
    const title = entry.status === 'published'
      ? `<a href="${escapeAttribute(entry.url)}" target="_blank" rel="noopener">${escapeText(entry.title)}</a>`
      : `<s>${escapeText(entry.title)}</s>`
    return `<tr class="${entry.status}">
<td>${title}${entry.description === undefined ? '' : `<div class="desc">${escapeText(entry.description)}</div>`}</td>
<td>${entry.kind}</td>
<td><a href="https://github.com/${escapeAttribute(repo)}" target="_blank" rel="noopener">${escapeText(repo)}</a></td>
<td>${entry.rev}</td>
<td><time datetime="${escapeAttribute(entry.updatedAt)}">${escapeText(entry.updatedAt.slice(0, 16).replace('T', ' '))}</time></td>
<td>${entry.status === 'published' ? 'live' : 'deleted'}</td>
</tr>`
  })
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Published artifacts</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--link:#0969da;--head:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--border:#3d444d;--link:#4493f8;--head:#151b23}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:72rem;margin:0 auto;padding:2rem 1rem}
h1{font-size:1.6rem;margin:0 0 .25rem}
p{color:var(--muted);margin:0 0 1.5rem}
.wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:.5rem .75rem;border-bottom:1px solid var(--border);vertical-align:top}
th{background:var(--head);font-weight:600;white-space:nowrap}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
.desc{color:var(--muted);font-size:.875rem}
tr.deleted td{color:var(--muted)}
</style>
</head>
<body>
<main>
<h1>Published artifacts</h1>
<p>${published.length} live, ${entries.length - published.length} deleted. Generated by dsh-gh-pages-artifacts.</p>
<div class="wrap">
<table>
<thead><tr><th>Artifact</th><th>Kind</th><th>Repository</th><th>Rev</th><th>Updated (UTC)</th><th>Status</th></tr></thead>
<tbody>
${rows.length === 0 ? '<tr><td colspan="6">Nothing published yet.</td></tr>' : rows.join('\n')}
</tbody>
</table>
</div>
</main>
</body>
</html>
`
}
