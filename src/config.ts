/** Plugin configuration schema and the normalized settings the runtime reads. */
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** How publishing, updating, and deleting artifacts is approved. */
export type ApprovalMode = 'unless-full-access' | 'always' | 'off'

/** Which artifact tools delegated subagents may see. */
export type SubagentAccess = 'read-only' | 'full' | 'none'

/**
 * Where new artifacts go: 'shared' puts every artifact in its own folder of one linked repository;
 * 'per-artifact' creates a new repository (and Pages site) for each new artifact.
 */
export type RepoStrategy = 'shared' | 'per-artifact'

/** A GitHub repository. */
export interface RepoRef {
  readonly owner: string
  readonly repo: string
}

/** Raw plugin configuration as validated by {@link Config}. */
export interface Config {
  /** GitHub user or organization that owns the Pages repository. Defaults to the token's user. */
  owner?: string | undefined
  /** Repository that hosts the artifacts. */
  repo: string
  /** The shared repository as `owner/name` or a remote URL; overrides owner and repo for the shared repository. */
  repository?: string | undefined
  /** Whether new artifacts share one repository or each get a new one. */
  repoStrategy: RepoStrategy
  /** Name prefix of repositories created by the per-artifact strategy. */
  repoPrefix: string
  /** Visibility of repositories created by the per-artifact strategy. */
  repoVisibility: 'public' | 'private'
  /** Folder for the local registry of published artifacts; defaults to $DSH_HOME/gh-pages-artifacts. */
  registryDir?: string | undefined
  /** Branch GitHub Pages publishes from. */
  branch: string
  /** Pages source folder inside the branch: '' for the root or 'docs'. */
  siteDir: '' | 'docs'
  /** Folder under the site root that holds artifacts; '' places them at the site root. */
  pathPrefix: string
  /** Public base URL of the site, for custom domains. Discovered from the Pages API when unset. */
  baseUrl?: string | undefined
  /** Name of the credential reference (environment variable) holding the GitHub token. */
  tokenEnv: string
  /** GitHub REST API base URL; change it only for GitHub Enterprise Server. */
  apiBaseUrl: string
  /** When publish, update, and delete ask the user first. */
  approval: ApprovalMode
  /** Agent presets (modes) that never see the artifact tools. */
  hideFromPresets: string[]
  /** Which artifact tools delegated subagents see. */
  subagentAccess: SubagentAccess
  /** Add `<meta name="robots" content="noindex, nofollow">` to published pages. */
  noindex: boolean
  /** Content-Security-Policy injected as a meta tag; '' disables injection. */
  csp: string
  /** Refuse to publish text that looks like a credential (tokens, private keys). */
  blockSecrets: boolean
  /** Maximum total bytes of one publish (page plus assets). */
  maxPublishBytes: number
  /** Optional author and committer identity for commits; defaults to the token's user. */
  commitAuthor?: { name?: string | undefined; email?: string | undefined } | undefined
  /** Add a short system-prompt section describing the artifact tools. */
  promptGuidance: boolean
  /** Register the bundled `artifact-pages` design skill. */
  bundledSkill: boolean
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/
const BRANCH_PATTERN = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*@\{)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._\/-]{1,200}$/
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Schema validated by Cordis before `apply`. */
export const Config = z.object({
  owner: z.string().pattern(OWNER_PATTERN)
    .description('GitHub user or organization owning the Pages repository. Defaults to the user the token belongs to.').volatile(),
  repo: z.string().pattern(REPO_PATTERN).default('dsh-artifacts')
    .description('Repository that hosts the artifacts. Use a dedicated repository, never your <owner>.github.io site.').volatile(),
  repository: z.string()
    .description('Shared repository as owner/name or a remote URL (https://github.com/owner/name.git or git@github.com:owner/name.git). Overrides owner and repo for the shared repository.').volatile(),
  repoStrategy: z.union(['shared', 'per-artifact'] as const).default('shared')
    .description('shared: every artifact gets a folder in one repository; per-artifact: each new artifact gets its own new repository and Pages site.').volatile(),
  repoPrefix: z.string().pattern(/^[A-Za-z0-9._-]{0,40}$/).default('artifact-')
    .description('Name prefix of repositories the per-artifact strategy creates.').volatile(),
  repoVisibility: z.union(['public', 'private'] as const).default('public')
    .description('Visibility of repositories the per-artifact strategy creates. Pages on private repositories needs a paid plan; the pages are public either way.').volatile(),
  registryDir: z.string()
    .description('Folder for the local registry and index page of published artifacts. Defaults to $DSH_HOME/gh-pages-artifacts.'),
  branch: z.string().pattern(BRANCH_PATTERN).default('gh-pages')
    .description('Branch GitHub Pages publishes from. It is created on first publish when missing.').volatile(),
  siteDir: z.union(['', 'docs'] as const).default('')
    .description("Pages source folder: '' for the branch root or 'docs'."),
  pathPrefix: z.string().default('')
    .description("Folder under the site root that holds artifacts, for example 'a'. '' puts each artifact at <site>/<id>/."),
  baseUrl: z.string()
    .description('Public site URL, e.g. https://pages.example.com. Discovered from the Pages API when unset.').volatile(),
  tokenEnv: z.string().role('credential-ref').default('GH_PAGES_TOKEN')
    .description('Credential reference (environment variable name) holding a GitHub token with Contents read/write on the repository.').volatile(),
  apiBaseUrl: z.string().default('https://api.github.com')
    .description('GitHub REST API base URL. Change it only for GitHub Enterprise Server.'),
  approval: z.union(['unless-full-access', 'always', 'off'] as const).default('unless-full-access')
    .description('unless-full-access: ask unless the session runs with danger-full-access; always: ask every time; off: never ask.').volatile(),
  hideFromPresets: z.array(z.string()).default(['minimal'])
    .description('Agent presets (modes) that never see the artifact tools.'),
  subagentAccess: z.union(['read-only', 'full', 'none'] as const).default('read-only')
    .description('read-only: subagents may list and read but not publish or delete; full: all tools; none: no artifact tools.'),
  noindex: z.boolean().default(true)
    .description('Ask search engines not to index published pages.').volatile(),
  csp: z.string().default("object-src 'none'; base-uri 'none'")
    .description("Content-Security-Policy meta tag injected into every page. '' disables it."),
  blockSecrets: z.boolean().default(true)
    .description('Refuse to publish text that looks like a credential.').volatile(),
  maxPublishBytes: z.natural().min(1024).default(10 * 1024 * 1024)
    .description('Maximum total bytes of one publish, page plus assets.').volatile(),
  commitAuthor: z.object({
    name: z.string().description('Author name.'),
    email: z.string().description('Author email.'),
  }).description('Commit author and committer (both name and email). Defaults to the token user.').volatile(),
  promptGuidance: z.boolean().default(true)
    .description('Add a short system-prompt section that explains the artifact tools.'),
  bundledSkill: z.boolean().default(true)
    .description('Register the bundled artifact-pages design skill.'),
})

/** Config as the Loader passes it: fields declared `.volatile()` arrive as live references. */
export type LiveConfig = { [K in keyof Config]: Config[K] | { get(): Config[K] } }

/**
 * Read the current values of a live config; volatile fields can change while the plugin runs
 * (for example from its settings page), so callers read them per operation.
 * @param config - config as passed to `apply`.
 * @returns plain values.
 */
export function unwrapConfig(config: Config | LiveConfig): Config {
  const plain: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    plain[key] = typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
      ? (value as { get(): unknown }).get()
      : value
  }
  return plain as unknown as Config
}

/** Validated, normalized settings shared by every module. */
export interface Settings {
  readonly owner: string | undefined
  readonly repo: string
  /** Shared repository parsed from `repository`, when set. */
  readonly repository: RepoRef | undefined
  readonly repoStrategy: RepoStrategy
  readonly repoPrefix: string
  readonly repoVisibility: 'public' | 'private'
  readonly registryDir: string
  readonly branch: string
  readonly siteDir: string
  readonly pathPrefix: string
  readonly baseUrl: string | undefined
  readonly tokenEnv: string
  readonly apiBaseUrl: string
  readonly approval: ApprovalMode
  readonly hideFromPresets: readonly string[]
  readonly subagentAccess: SubagentAccess
  readonly noindex: boolean
  readonly csp: string
  readonly blockSecrets: boolean
  readonly maxPublishBytes: number
  readonly commitAuthor: { readonly name: string; readonly email: string } | undefined
  readonly promptGuidance: boolean
  readonly bundledSkill: boolean
}

/**
 * Check the cross-field rules the schema cannot express and normalize paths and URLs.
 * @param config - schema-validated configuration.
 * @returns normalized settings.
 * @throws Error naming the offending option.
 */
export function normalizeConfig(input: Config | LiveConfig): Settings {
  const config = unwrapConfig(input)
  const pathPrefix = normalizeRelativeDir(config.pathPrefix, 'pathPrefix')
  const apiBaseUrl = normalizeUrl(config.apiBaseUrl, 'apiBaseUrl', true)
  const baseUrl = config.baseUrl === undefined || config.baseUrl.trim() === ''
    ? undefined
    : normalizeUrl(config.baseUrl, 'baseUrl', false)
  if (/[\s;]/.test(config.tokenEnv) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.tokenEnv)) {
    throw new Error(`gh-pages-artifacts: tokenEnv must be an environment variable name, got "${config.tokenEnv}"`)
  }
  const author = normalizeAuthor(config.commitAuthor)
  if (/[\r\n]/.test(config.csp)) throw new Error('gh-pages-artifacts: csp must be a single line')
  return {
    owner: config.owner === undefined || config.owner === '' ? undefined : config.owner,
    repo: config.repo,
    repository: config.repository === undefined || config.repository.trim() === '' ? undefined : parseRepository(config.repository, apiBaseUrl),
    repoStrategy: config.repoStrategy,
    repoPrefix: config.repoPrefix,
    repoVisibility: config.repoVisibility,
    registryDir: normalizeRegistryDir(config.registryDir),
    branch: config.branch,
    siteDir: config.siteDir,
    pathPrefix,
    baseUrl,
    tokenEnv: config.tokenEnv,
    apiBaseUrl,
    approval: config.approval,
    hideFromPresets: [...config.hideFromPresets],
    subagentAccess: config.subagentAccess,
    noindex: config.noindex,
    csp: config.csp.trim(),
    blockSecrets: config.blockSecrets,
    maxPublishBytes: config.maxPublishBytes,
    commitAuthor: author,
    promptGuidance: config.promptGuidance,
    bundledSkill: config.bundledSkill,
  }
}

function normalizeAuthor(author: Config['commitAuthor']): Settings['commitAuthor'] {
  const name = author?.name?.trim() ?? ''
  const email = author?.email?.trim() ?? ''
  if (name === '' && email === '') return undefined
  if (name === '' || !/^[^\s@<>]+@[^\s@<>]+$/.test(email)) {
    throw new Error('gh-pages-artifacts: commitAuthor needs both a non-empty name and a valid email')
  }
  return { name, email }
}

/**
 * Parse a repository reference: `owner/name`, `https://<host>/owner/name(.git)`,
 * `git@<host>:owner/name(.git)`, or `ssh://git@<host>/owner/name(.git)`. The host must be
 * github.com, or the GitHub Enterprise host behind `apiBaseUrl`.
 * @param input - user text.
 * @param apiBaseUrl - normalized API base URL.
 * @returns owner and repository name.
 * @throws Error explaining the accepted forms.
 */
export function parseRepository(input: string, apiBaseUrl: string): RepoRef {
  const text = input.trim()
  const fail = (why: string): never => {
    throw new Error(`gh-pages-artifacts: "${input}" is not a repository (${why}); use owner/name or a remote URL like https://github.com/owner/name.git`)
  }
  let host: string | undefined
  let path: string
  const scp = /^[\w.-]+@([^:/\s]+):(.+)$/.exec(text)
  if (scp !== null) {
    host = scp[1]!.toLowerCase()
    path = scp[2]!
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return fail('invalid URL')
    }
    host = url.hostname.toLowerCase()
    path = url.pathname
  } else if (/^[\w.-]+\.[a-z]{2,}\//i.test(text)) {
    const slash = text.indexOf('/')
    host = text.slice(0, slash).toLowerCase()
    path = text.slice(slash)
  } else {
    path = text
  }
  if (host !== undefined) {
    const apiHost = new URL(apiBaseUrl).hostname.toLowerCase()
    const allowed = apiHost === 'api.github.com' ? ['github.com', 'www.github.com'] : [apiHost, apiHost.replace(/^api\./, '')]
    if (!allowed.includes(host)) fail(`host ${host} does not match the configured GitHub (${allowed[0]})`)
  }
  const segments = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/')
  if (segments.length !== 2) fail('expected exactly owner/name')
  const [owner, repo] = segments as [string, string]
  if (!OWNER_PATTERN.test(owner)) fail(`invalid owner "${owner}"`)
  if (!REPO_PATTERN.test(repo) || repo === '.' || repo === '..') fail(`invalid repository name "${repo}"`)
  return { owner, repo }
}

function normalizeRegistryDir(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    const home = process.env['DSH_HOME'] !== undefined && process.env['DSH_HOME'] !== '' ? process.env['DSH_HOME'] : join(homedir(), '.dsh')
    return join(home, 'gh-pages-artifacts')
  }
  if (!isAbsolute(value)) throw new Error('gh-pages-artifacts: registryDir must be an absolute path')
  return value
}

/**
 * Normalize a relative directory option such as `a` or `pages/a` to slash-joined safe segments.
 * @param value - raw option value.
 * @param option - option name for error messages.
 * @returns the normalized path, '' for the root.
 */
export function normalizeRelativeDir(value: string, option: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '')
  if (trimmed === '') return ''
  const segments = trimmed.split('/')
  for (const segment of segments) {
    if (!SEGMENT_PATTERN.test(segment)) {
      throw new Error(`gh-pages-artifacts: ${option} segment "${segment}" must start with a letter or digit and contain only letters, digits, '.', '_' or '-'`)
    }
  }
  return segments.join('/')
}

/**
 * Validate an http(s) URL option and strip its trailing slash.
 * @param value - raw option value.
 * @param option - option name for error messages.
 * @param carriesToken - whether the token is sent to this URL, which then must be HTTPS unless loopback.
 * @returns the URL without a trailing slash.
 */
export function normalizeUrl(value: string, option: string, carriesToken: boolean): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error(`gh-pages-artifacts: ${option} is not a valid URL: "${value}"`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`gh-pages-artifacts: ${option} must be an http(s) URL`)
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error(`gh-pages-artifacts: ${option} must not contain credentials, a query, or a fragment`)
  }
  if (carriesToken && url.protocol === 'http:' && !isLoopback(url.hostname)) {
    throw new Error(`gh-pages-artifacts: ${option} must use https (plain http is allowed only for loopback test servers)`)
  }
  return url.href.replace(/\/+$/, '')
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}
