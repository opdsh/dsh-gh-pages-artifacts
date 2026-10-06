/** Artifact manifest stored on the Pages branch, plus id and asset-name rules. */

/** Repository-root path of the manifest. It sits outside the artifact folders. */
export const MANIFEST_PATH = '.dsh-artifacts.json'

/** Kinds of artifact the plugin publishes. */
export type ArtifactKind = 'html' | 'markdown'

/** One published artifact. */
export interface ArtifactRecord {
  /** Stable id; the URL path segment. Never changes. */
  id: string
  /** Human title; may change without moving the URL. */
  title: string
  /** Page kind. */
  kind: ArtifactKind
  /** Optional one-line summary. */
  description?: string
  /** ISO timestamp of the first publish. */
  createdAt: string
  /** ISO timestamp of the latest publish. */
  updatedAt: string
  /** Revision, starting at 1 and incremented by every update. */
  rev: number
  /** Files published in the artifact folder, relative to it, sorted. */
  files: string[]
}

/** Manifest file shape. */
export interface Manifest {
  version: 1
  artifacts: Record<string, ArtifactRecord>
  /** Deleted ids, never reused, so an old link cannot show different content. */
  tombstones: string[]
}

/** File holding the served page. */
export const PAGE_FILE = 'index.html'
/** File holding the Markdown source of a markdown artifact. */
export const SOURCE_FILE = 'source.md'

/** Valid artifact id: lowercase letters, digits, and inner hyphens, 1-64 characters. */
export const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

/** Ids that would collide with site-level files or common folders. */
export const RESERVED_IDS: ReadonlySet<string> = new Set([
  '404', 'index', 'assets', 'static', 'api', 'robots', 'sitemap', 'favicon', 'cname',
])

const ASSET_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/** Error for a manifest that cannot be read safely. */
export class ManifestError extends Error {
  override readonly name = 'ManifestError'
}

/** @returns an empty manifest. */
export function emptyManifest(): Manifest {
  return { version: 1, artifacts: {}, tombstones: [] }
}

/**
 * Parse and validate manifest text. A malformed manifest is never overwritten silently.
 * @param text - file content.
 * @returns the manifest.
 * @throws ManifestError when the content is not a version-1 manifest.
 */
export function parseManifest(text: string): Manifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new ManifestError(`${MANIFEST_PATH} is not valid JSON (${(error as Error).message}); fix or remove it on the Pages branch`)
  }
  if (!isRecord(raw) || raw['version'] !== 1 || !isRecord(raw['artifacts'])) {
    throw new ManifestError(`${MANIFEST_PATH} is not a version 1 artifact manifest; fix or remove it on the Pages branch`)
  }
  const artifacts: Record<string, ArtifactRecord> = {}
  for (const [id, value] of Object.entries(raw['artifacts'])) {
    artifacts[id] = parseRecord(id, value)
  }
  const tombstonesRaw = raw['tombstones'] ?? []
  if (!Array.isArray(tombstonesRaw) || !tombstonesRaw.every(item => typeof item === 'string')) {
    throw new ManifestError(`${MANIFEST_PATH} has an invalid "tombstones" list`)
  }
  return { version: 1, artifacts, tombstones: [...new Set(tombstonesRaw as string[])] }
}

function parseRecord(id: string, value: unknown): ArtifactRecord {
  const fail = (what: string): never => {
    throw new ManifestError(`${MANIFEST_PATH} entry "${id}" has an invalid ${what}`)
  }
  if (!isRecord(value)) return fail('record')
  if (value['id'] !== id || !ID_PATTERN.test(id)) fail('id')
  if (typeof value['title'] !== 'string') fail('title')
  if (value['kind'] !== 'html' && value['kind'] !== 'markdown') fail('kind')
  if (typeof value['createdAt'] !== 'string' || typeof value['updatedAt'] !== 'string') fail('timestamp')
  if (typeof value['rev'] !== 'number' || !Number.isSafeInteger(value['rev']) || value['rev'] < 1) fail('rev')
  const files = value['files']
  if (!Array.isArray(files) || !files.every(file => typeof file === 'string' && isSafeRelativePath(file))) fail('files list')
  if (value['description'] !== undefined && typeof value['description'] !== 'string') fail('description')
  const record: ArtifactRecord = {
    id,
    title: value['title'] as string,
    kind: value['kind'] as ArtifactKind,
    createdAt: value['createdAt'] as string,
    updatedAt: value['updatedAt'] as string,
    rev: value['rev'] as number,
    files: [...(files as string[])].sort(),
  }
  if (typeof value['description'] === 'string') record.description = value['description']
  return record
}

/**
 * Serialize a manifest deterministically so diffs stay readable.
 * @param manifest - manifest to write.
 * @returns JSON text with a trailing newline.
 */
export function serializeManifest(manifest: Manifest): string {
  const artifacts: Record<string, ArtifactRecord> = {}
  for (const id of Object.keys(manifest.artifacts).sort()) {
    const record = manifest.artifacts[id]
    if (record === undefined) continue
    const ordered: ArtifactRecord = {
      id: record.id,
      title: record.title,
      kind: record.kind,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      rev: record.rev,
      files: [...record.files].sort(),
    }
    if (record.description !== undefined) ordered.description = record.description
    artifacts[id] = ordered
  }
  const tombstones = [...new Set(manifest.tombstones)].sort()
  return `${JSON.stringify({ version: 1, artifacts, tombstones }, null, 2)}\n`
}

/**
 * Turn a title into a URL slug: lowercase ASCII letters and digits joined by hyphens.
 * @param title - free text.
 * @param maxLength - longest result.
 * @returns the slug, or 'artifact' when nothing usable remains.
 */
export function slugify(title: string, maxLength = 40): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '')
  return slug === '' ? 'artifact' : slug
}

/**
 * Build a fresh id from a title plus a random suffix, so URLs are readable but not guessable.
 * @param title - artifact title.
 * @param suffix - random lowercase base32 text.
 */
export function idFromTitle(title: string, suffix: string): string {
  return `${slugify(title)}-${suffix}`
}

/**
 * Check a caller-chosen id.
 * @param id - candidate id.
 * @returns an error message, or undefined when valid.
 */
export function idProblem(id: string): string | undefined {
  if (!ID_PATTERN.test(id)) {
    return `"${id}" is not a valid artifact id: use 1-64 lowercase letters, digits, and inner hyphens`
  }
  if (RESERVED_IDS.has(id)) return `"${id}" is reserved; choose another id`
  return undefined
}

/**
 * Check an asset name, the path of an extra file relative to the artifact folder.
 * @param name - candidate name such as `chart.png` or `img/logo.svg`.
 * @returns an error message, or undefined when valid.
 */
export function assetNameProblem(name: string): string | undefined {
  if (!isSafeRelativePath(name)) {
    return `asset name "${name}" must be a relative path of segments made of letters, digits, '.', '_' or '-', each starting with a letter or digit (at most 4 levels)`
  }
  if (name === PAGE_FILE || name === SOURCE_FILE) return `asset name "${name}" is reserved for the page itself`
  return undefined
}

/**
 * @param path - candidate relative path.
 * @returns whether it is 1-4 safe segments with no dot-segments.
 */
export function isSafeRelativePath(path: string): boolean {
  const segments = path.split('/')
  return segments.length >= 1 && segments.length <= 4 && segments.every(segment => ASSET_SEGMENT.test(segment) && segment !== '.' && segment !== '..')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
