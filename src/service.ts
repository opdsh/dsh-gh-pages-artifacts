/**
 * Artifact operations: token and site discovery, repository strategies, publish, list, read,
 * delete, status, and repository management. Every artifact is tracked in the local registry,
 * which records where it lives, so artifacts spread over many repositories stay reachable.
 */
import { createHash, randomInt } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { access } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { requireApproval } from './approval.js'
import { parseRepository, type RepoRef, type RepoStrategy, type Settings } from './config.js'
import { baseName, credentialPathProblem, findSecrets, formatBytes, isTextName, readWorkspaceFile } from './content.js'
import { GitHubApiError, GitHubClient } from './github.js'
import {
  assetNameProblem, idFromTitle, idProblem, PAGE_FILE, SOURCE_FILE,
  type ArtifactKind, type ArtifactRecord, type Manifest,
} from './manifest.js'
import { ALL_TOOLS, DELETE_TOOL, MUTATING_TOOLS, PUBLISH_TOOL } from './names.js'
import { Registry, repositoryName, type ArtifactLocation, type RegistryData, type RegistryEntry } from './registry.js'
import { prepareHtmlPage, renderMarkdownPage, stripInjected } from './render.js'
import { ArtifactStore, decodeUtf8, jekyllSiteError, joinPath, type FileWrite, type Plan, type Snapshot } from './store.js'
import { hiddenTools } from './visibility.js'

/** Package version, sent in the User-Agent. */
export const VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

/** Arguments of `artifact_publish`. */
export interface PublishArgs {
  readonly description: string
  readonly title?: string | undefined
  readonly id?: string | undefined
  readonly path?: string | undefined
  readonly kind?: ArtifactKind | undefined
  readonly slug?: string | undefined
  readonly assets?: ReadonlyArray<{ readonly path: string; readonly name?: string | undefined }> | undefined
  readonly removeAssets?: readonly string[] | undefined
  readonly baseRev?: number | undefined
  readonly content?: string | undefined
}

/** Result of `artifact_publish`. */
export interface PublishResult {
  id: string
  title: string
  kind: ArtifactKind
  url: string
  repository: string
  newRepository: boolean
  rev: number
  created: boolean
  commit: string
  files: string[]
  warnings: string[]
}

/** One row of `artifact_list`. */
export interface ListedArtifact {
  id: string
  title: string
  kind: ArtifactKind
  url: string
  repository: string
  rev: number
  updatedAt: string
  status: 'published' | 'deleted'
  description?: string
}

/** Result of `artifact_list`. */
export interface ListResult {
  total: number
  artifacts: ListedArtifact[]
  indexFile: string
  notes: string[]
  nextOffset?: number
}

/** Result of `artifact_read`. */
export interface ReadResult {
  id: string
  title: string
  kind: ArtifactKind
  url: string
  repository: string
  rev: number
  file: string
  files: string[]
  totalChars: number
  offset: number
  content: string
  nextOffset?: number
}

/** Result of `artifact_delete`. */
export interface DeleteResult {
  id: string
  url: string
  repository: string
  deleted: boolean
  commit: string
  notes: string[]
}

/** Result of `artifact_status`. */
export interface StatusResult {
  ready: boolean
  strategy: RepoStrategy
  repository: string
  branch: string
  siteUrl?: string
  token: { configured: boolean; source?: string }
  pages: string
  /** Head commit of the Pages branch. */
  headCommit?: string
  latestBuild?: { status: string; commit?: string; error?: string }
  /** Whether the head commit has been built and deployed; absent when builds are not visible to the token. */
  deployed?: boolean
  artifact?: { id: string; url: string; live: boolean; httpStatus?: number }
  registryFile: string
  problems: string[]
}

/** Arguments of `artifact_repository`. */
export interface RepositoryArgs {
  readonly action: 'show' | 'link' | 'unlink' | 'set_strategy'
  readonly repository?: string | undefined
  readonly strategy?: RepoStrategy | undefined
}

/** Result of `artifact_repository`. */
export interface RepositoryResult {
  strategy: RepoStrategy
  strategySource: 'config' | 'user'
  repository: string
  repositorySource: 'linked' | 'config' | 'token user'
  branch: string
  newRepositories: string
  siteUrl?: string
  pages?: string
  registryFile: string
  indexFile: string
  warnings: string[]
}

/** Pages site facts discovered from the API. */
interface SiteInfo {
  readonly url: string
  readonly private: boolean
  readonly pages: 'enabled' | 'disabled' | 'unknown'
  readonly sourceBranch?: string
  readonly sourcePath?: string
  readonly warnings: readonly string[]
}

/** An authenticated API client for one operation. */
interface Api {
  readonly gh: GitHubClient
  readonly token: string
  readonly tokenSource: string
}

interface PreparedFile {
  /** Workspace path the file comes from. */
  readonly source: string
  readonly name: string
  readonly write: (dir: string) => FileWrite
  readonly bytes: number
}

/** Everything a publish reads from the workspace, checked and screened. */
interface Sources {
  readonly kind: ArtifactKind | undefined
  readonly mainText: string | undefined
  readonly mainBytes: number
  readonly files: readonly PreparedFile[]
  readonly totalBytes: number
}

/** One write to the plugin's own settings, as the dsh settings service accepts it. */
type SettingsOp = { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }

/** The part of the dsh settings service (`ctx.settings`) this plugin uses. */
interface SettingsWriter {
  mutate(namespace: string, ops: readonly SettingsOp[], expectedRevision?: number): Promise<void>
}

/** Hooks replaceable in tests. */
export interface RuntimeHooks {
  readonly fetch?: typeof fetch
  readonly now?: () => Date
  readonly randomSuffix?: () => string
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

const SITE_CACHE_MS = 5 * 60 * 1000
const DEPLOY_WAIT_MS = 5 * 60 * 1000
const READ_DEFAULT_CHARS = 8000
const READ_MAX_CHARS = 20000
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
const MAX_TITLE = 200
const MAX_DESCRIPTION = 500
const GITHUB_API = 'https://api.github.com'
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/
/** Topic set on repositories created per artifact, so they are easy to find on GitHub. */
export const ARTIFACT_TOPIC = 'dsh-artifact'

/** Owns configuration-derived state shared by the tools. */
export class ArtifactsRuntime {
  /** Local record of everything published, and the user's runtime choices. */
  readonly registry: Registry
  private writeQueue: Promise<unknown> = Promise.resolve()
  private readonly logins = new Map<string, string>()
  private readonly sites = new Map<string, { at: number; info: SiteInfo }>()

  private readonly readSettings: () => Settings
  /** Loader entry id of this plugin row, which names its settings namespace. */
  private readonly namespace: string | undefined

  /**
   * @param ctx - plugin context.
   * @param settings - settings, or a reader that returns the current ones; options edited on the
   *   plugin's settings page change while the plugin runs, so they are read per operation.
   * @param hooks - test hooks.
   */
  constructor(
    private readonly ctx: Context,
    settings: Settings | (() => Settings),
    private readonly hooks: RuntimeHooks = {},
    namespace?: string,
  ) {
    this.readSettings = typeof settings === 'function' ? settings : () => settings
    this.namespace = namespace
    this.registry = new Registry(this.readSettings().registryDir, message => ctx.logger.warn(message))
  }

  /** The current settings. */
  get settings(): Settings {
    return this.readSettings()
  }

  private now(): Date {
    return this.hooks.now?.() ?? new Date()
  }

  private randomSuffix(): string {
    if (this.hooks.randomSuffix !== undefined) return this.hooks.randomSuffix()
    let suffix = ''
    for (let index = 0; index < 6; index++) suffix += BASE32[randomInt(BASE32.length)]
    return suffix
  }

  /**
   * Resolve the GitHub token for one operation; never cached.
   * @returns the token value, or undefined when not configured.
   */
  async resolveToken(): Promise<{ value: string; source: string } | undefined> {
    const ref = credentialRef(this.settings.tokenEnv)
    const credentials = this.ctx.get('credentials')
    if (credentials !== undefined) return await credentials.resolve(ref)
    const ambient = launchEnvironmentOf(this.ctx).get(ref)
    return ambient !== undefined && ambient.value.length > 0 ? { value: ambient.value, source: ambient.source } : undefined
  }

  private missingTokenError(): Error {
    return new Error(`No GitHub token is configured. Ask the user to create a GitHub token and provide it as the ${this.settings.tokenEnv} credential (environment variable, $DSH_HOME/.credentials.yaml, or $DSH_HOME/.env); see the dsh-gh-pages-artifacts README. Never ask the user to paste the token into the chat.`)
  }

  private async api(): Promise<Api> {
    const token = await this.resolveToken()
    if (token === undefined) throw this.missingTokenError()
    const gh = new GitHubClient({
      apiBaseUrl: this.settings.apiBaseUrl,
      token: token.value,
      userAgent: `dsh-gh-pages-artifacts/${VERSION}`,
      ...this.hooks.fetch === undefined ? {} : { fetch: this.hooks.fetch },
      ...this.hooks.sleep === undefined ? {} : { sleep: this.hooks.sleep },
    })
    return { gh, token: token.value, tokenSource: token.source }
  }

  private async login(api: Api, signal: AbortSignal): Promise<string> {
    const key = createHash('sha256').update(api.token).digest('hex').slice(0, 16)
    const known = this.logins.get(key)
    if (known !== undefined) return known
    const user = await api.gh.request<{ login: string }>('GET', '/user', { signal })
    this.logins.set(key, user.data.login)
    return user.data.login
  }

  /** The token's own account, refused when the token could come from an untrusted project .env. */
  private async tokenOwner(api: Api, signal: AbortSignal): Promise<string> {
    if (api.tokenSource === 'project-env') {
      // A .env in the launch directory could swap in someone else's token and, with it, the destination.
      throw new Error(`The ${this.settings.tokenEnv} token comes from the .env file of the directory dsh was launched from, so the plugin will not guess the repository owner from it. Ask the user to set the plugin option owner (or link a repository).`)
    }
    return await this.login(api, signal)
  }

  /** @returns the effective strategy and whether the user changed it at runtime. */
  private strategyOf(data: RegistryData): { strategy: RepoStrategy; source: 'config' | 'user' } {
    const chosen = data.settings.strategy
    return chosen === undefined ? { strategy: this.settings.repoStrategy, source: 'config' } : { strategy: chosen, source: 'user' }
  }

  /** The shared repository: a linked one, then the configured one, then `repo` under the token's user. */
  private async sharedRepository(api: Api | undefined, data: RegistryData, signal: AbortSignal): Promise<{ ref: RepoRef; source: RepositoryResult['repositorySource'] }> {
    const link = data.settings.link
    if (link !== undefined) return { ref: { owner: link.owner, repo: link.repo }, source: 'linked' }
    if (this.settings.repository !== undefined) return { ref: this.settings.repository, source: 'config' }
    if (this.settings.owner !== undefined) return { ref: { owner: this.settings.owner, repo: this.settings.repo }, source: 'config' }
    if (api === undefined) throw this.missingTokenError()
    return { ref: { owner: await this.tokenOwner(api, signal), repo: this.settings.repo }, source: 'token user' }
  }

  private sharedLocation(ref: RepoRef): ArtifactLocation {
    return { ...ref, branch: this.settings.branch, siteDir: this.settings.siteDir, pathPrefix: this.settings.pathPrefix, layout: 'folder' }
  }

  private ownLocation(owner: string, id: string): ArtifactLocation {
    return { owner, repo: `${this.settings.repoPrefix}${id}`, branch: this.settings.branch, siteDir: this.settings.siteDir, pathPrefix: '', layout: 'root' }
  }

  private store(api: Api, location: ArtifactLocation, signal: AbortSignal): ArtifactStore {
    return new ArtifactStore(api.gh, location, {
      author: this.settings.commitAuthor,
      ...this.hooks.sleep === undefined ? {} : { sleep: (ms: number) => this.hooks.sleep!(ms, signal) },
    })
  }

  /**
   * Find where an existing artifact lives: the registry first, then the shared repository's
   * manifest (for artifacts published from another machine).
   */
  private async locate(api: Api, data: RegistryData, id: string, signal: AbortSignal): Promise<{ location: ArtifactLocation; entry: RegistryEntry | undefined }> {
    const entry = data.artifacts[id]
    if (entry !== undefined) {
      if (entry.status === 'deleted') throw new Error(`Artifact ${id} was deleted`)
      return { location: entry.location, entry }
    }
    const shared = this.sharedLocation((await this.sharedRepository(api, data, signal)).ref)
    const snapshot = await this.store(api, shared, signal).snapshot(signal)
    if (snapshot.manifest.artifacts[id] !== undefined) return { location: shared, entry: undefined }
    if (snapshot.manifest.tombstones.includes(id)) throw new Error(`Artifact ${id} was deleted`)
    throw new Error(`No artifact with id "${id}"; use artifact_list to find ids, or omit id to create a new artifact`)
  }

  /**
   * Discover the public site URL and Pages state of one repository, cached for a few minutes.
   */
  private async siteInfo(api: Api, location: ArtifactLocation, signal: AbortSignal, fresh = false): Promise<SiteInfo> {
    const key = `${repositoryName(location)}@${location.branch}`
    const cached = this.sites.get(key)
    if (!fresh && cached !== undefined && this.now().getTime() - cached.at < SITE_CACHE_MS) return cached.info
    const name = repositoryName(location)
    const onGitHubCom = this.settings.apiBaseUrl === GITHUB_API
    // baseUrl describes the shared site; repositories created per artifact get their own URL.
    const configured = location.layout === 'folder' ? this.settings.baseUrl : undefined
    const fallback = configured ?? (onGitHubCom ? defaultSiteUrl(location.owner, location.repo) : undefined)
    const repoPath = `/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}`
    const repo = await api.gh.request<{ private?: boolean }>('GET', repoPath, { allowStatus: [404], signal })
    const isPrivate = repo.status === 200 && repo.data.private === true
    const privacy: string[] = isPrivate && location.layout === 'folder' && location.siteDir === ''
      ? [`${name} is private, but with siteDir '' its whole branch is served, including the artifact index .dsh-artifacts.json that lists every artifact. Set siteDir: docs (and publish Pages from /docs) to keep the index unlisted.`]
      : []
    const requireUrl = (url: string | undefined): string => {
      if (url !== undefined) return url
      throw new Error('Cannot determine the public URL of the Pages site on this GitHub Enterprise server; ask the user to set the plugin option baseUrl, or to grant the token Pages: read.')
    }
    const expectedPath = location.siteDir === '' ? '/' : `/${location.siteDir}`
    let info: SiteInfo
    try {
      const pages = await api.gh.request<{
        html_url?: string; source?: { branch?: string; path?: string }; build_type?: string
      }>('GET', `${repoPath}/pages`, { allowStatus: [404], signal })
      if (pages.status === 404) {
        info = {
          url: requireUrl(fallback), private: isPrivate, pages: 'disabled',
          warnings: [`GitHub Pages is not enabled for ${name}; the plugin tries to enable it on the next publish. If that is not permitted, the user can enable it in Settings → Pages → Deploy from a branch → ${location.branch} / ${expectedPath === '/' ? '(root)' : expectedPath}.`, ...privacy],
        }
      } else {
        const sourceBranch = pages.data.source?.branch
        const sourcePath = pages.data.source?.path
        const warnings: string[] = [...privacy]
        if (pages.data.build_type === 'workflow') {
          warnings.push(`GitHub Pages for ${name} is built by a GitHub Actions workflow, so commits to ${location.branch} may not be served. Switch Pages to "Deploy from a branch" (${location.branch}, ${expectedPath}).`)
        } else if (sourceBranch !== undefined && (sourceBranch !== location.branch || (sourcePath ?? '/') !== expectedPath)) {
          warnings.push(`GitHub Pages for ${name} publishes ${sourceBranch} ${sourcePath ?? '/'}, but this plugin writes to ${location.branch} ${expectedPath}. Change the Pages source or the plugin's branch/siteDir options.`)
        }
        const htmlUrl = pages.data.html_url
        info = {
          url: requireUrl(configured ?? (htmlUrl === undefined ? fallback : normalizeSiteUrl(htmlUrl))),
          private: isPrivate, pages: 'enabled', warnings,
          ...sourceBranch === undefined ? {} : { sourceBranch },
          ...sourcePath === undefined ? {} : { sourcePath },
        }
      }
    } catch (error) {
      if (!(error instanceof GitHubApiError) || (error.status !== 403 && error.status !== 401)) throw error
      info = { url: requireUrl(fallback), private: isPrivate, pages: 'unknown', warnings: privacy }
    }
    this.sites.set(key, { at: this.now().getTime(), info })
    return info
  }

  private artifactUrl(site: SiteInfo, location: ArtifactLocation, id: string): string {
    return location.layout === 'root' ? `${site.url}/` : `${joinUrl(site.url, joinPath(location.pathPrefix, id))}/`
  }

  /**
   * Turn GitHub Pages on for a repository when it is off. Pushing a gh-pages branch usually does
   * this by itself, so a brand-new repository first gets a few seconds to catch up; otherwise the
   * token needs Pages and Administration write. Never throws: the page is already committed, so a
   * problem here only becomes a warning for the user.
   * @returns warnings for the user when Pages could not be enabled.
   */
  private async ensurePages(api: Api, location: ArtifactLocation, signal: AbortSignal, newRepository: boolean): Promise<string[]> {
    const repoPath = `/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}`
    const how = `Settings → Pages → Deploy from a branch → ${location.branch} / ${location.siteDir === '' ? '(root)' : `/${location.siteDir}`}`
    const sleep = this.hooks.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
    const enabled = async (): Promise<boolean | undefined> => {
      try {
        return (await api.gh.request('GET', `${repoPath}/pages`, { allowStatus: [404], signal })).status === 200
      } catch (error) {
        if (signal.aborted) throw error
        return undefined
      }
    }
    try {
      let state = await enabled()
      for (let attempt = 0; newRepository && state === false && attempt < 5; attempt++) {
        await sleep(2000, signal)
        state = await enabled()
      }
      if (state === true) return []
      if (state === undefined) return [`Cannot check GitHub Pages for ${repositoryName(location)} (the token lacks Pages access); if the page does not appear, enable Pages in ${how}.`]
      let failure: string
      try {
        const created = await api.gh.request<{ message?: string }>('POST', `${repoPath}/pages`, {
          body: { build_type: 'legacy', source: { branch: location.branch, path: location.siteDir === '' ? '/' : `/${location.siteDir}` } },
          allowStatus: [403, 404, 409, 422], retry: false, signal,
        })
        if (created.status === 201 || created.status === 409) return []
        failure = created.data?.message ?? `HTTP ${created.status}`
      } catch (error) {
        if (signal.aborted) throw error
        failure = errorText(error)
      }
      // GitHub may have enabled Pages meanwhile (or answered 5xx while doing so).
      if (await enabled() === true) return []
      return [`Could not enable GitHub Pages for ${repositoryName(location)} (${failure}); the user can enable it in ${how}.`]
    } finally {
      this.sites.delete(`${repositoryName(location)}@${location.branch}`)
    }
  }

  /** Create the repository of a new per-artifact location. */
  private async createRepository(api: Api, location: ArtifactLocation, title: string, homepage: string | undefined, signal: AbortSignal): Promise<void> {
    const login = await this.login(api, signal)
    const ownAccount = location.owner.toLowerCase() === login.toLowerCase()
    if (!ownAccount) {
      const account = await api.gh.request<{ type?: string }>('GET', `/users/${encodeURIComponent(location.owner)}`, { allowStatus: [404], signal })
      if (account.status !== 200 || account.data.type !== 'Organization') {
        throw new Error(`Cannot create repositories under ${location.owner}: it is neither the token's account (${login}) nor an organization`)
      }
    }
    const body = {
      name: location.repo,
      description: oneLine(`${title} (published with dsh-gh-pages-artifacts)`, 300),
      ...homepage === undefined ? {} : { homepage },
      private: this.settings.repoVisibility === 'private',
      has_issues: false,
      has_projects: false,
      has_wiki: false,
      auto_init: false,
    }
    const path = ownAccount ? '/user/repos' : `/orgs/${encodeURIComponent(location.owner)}/repos`
    try {
      await api.gh.request('POST', path, { body, retry: false, signal })
    } catch (error) {
      if (error instanceof GitHubApiError && (error.status === 401 || error.status === 403 || error.status === 404)) {
        throw new Error(`The token cannot create repositories under ${location.owner} (${error.apiMessage}). The per-artifact strategy needs a token that may create repositories: a fine-grained token with "All repositories" plus Administration, Contents, and Pages write, or a classic token with the public_repo scope. Alternatively switch to the shared strategy.`)
      }
      throw error
    }
    // Best effort: a topic makes every artifact repository easy to find on GitHub.
    await api.gh.request('PUT', `/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}/topics`, {
      body: { names: [ARTIFACT_TOPIC] }, allowStatus: [403, 404, 422], retry: false, signal,
    }).catch(() => undefined)
  }

  /**
   * Enforce the visibility policy at execution time too, so a missed or failed per-Agent
   * restriction can never open a mutating tool to a subagent or a hidden preset.
   */
  private assertVisible(toolName: string, exec: ToolRunContext): void {
    const agent = exec.agent
    if (agent === undefined) return
    const preset = this.ctx.get('agentPresets')?.composedPreset(agent.ctx)
    const delegated = (agent.session.header.delegationDepth ?? 0) > 0 || agent.session.header.origin === 'subagent'
    const hidden = hiddenTools({
      allTools: ALL_TOOLS, mutatingTools: MUTATING_TOOLS,
      hideFromPresets: this.settings.hideFromPresets, subagentAccess: this.settings.subagentAccess,
    }, preset, delegated)
    if (hidden.includes(toolName)) {
      throw new Error(delegated
        ? `${toolName} is not available to delegated subagents; return the content to the parent agent so it can publish.`
        : `${toolName} is not available in this mode.`)
    }
  }

  private async serialized<T>(run: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(run)
    this.writeQueue = next.catch(() => undefined)
    return await next
  }

  /** Record a published or updated artifact in the registry. */
  private async track(entry: RegistryEntry): Promise<void> {
    await this.registry.update(data => {
      data.artifacts[entry.id] = entry
    })
  }

  /**
   * Create a new artifact or update one in place.
   * @param args - tool arguments.
   * @param exec - tool execution.
   */
  async publish(args: PublishArgs, exec: ToolRunContext): Promise<PublishResult> {
    const signal = exec.signal
    this.assertVisible(PUBLISH_TOOL, exec)
    const description = checkText('description', args.description, MAX_DESCRIPTION)
    if (description === '') throw new Error('description must not be empty')
    if (args.path !== undefined && args.content !== undefined) throw new Error('Pass either path or content, not both')
    const updating = args.id !== undefined
    if (!updating && args.path === undefined && args.content === undefined) throw new Error('A new artifact needs path or content')
    if (!updating && (args.title === undefined || args.title.trim() === '')) throw new Error('A new artifact needs a title')
    if (!updating && (args.removeAssets !== undefined || args.baseRev !== undefined)) {
      throw new Error('removeAssets and baseRev apply only when updating an existing artifact (pass its id)')
    }
    if (updating && args.slug !== undefined) throw new Error('slug applies only to new artifacts; the id of an existing artifact never changes')
    if (args.kind !== undefined && args.path === undefined && args.content === undefined) throw new Error('kind needs new content (path or content) to go with it')
    const title = args.title === undefined ? undefined : checkText('title', args.title, MAX_TITLE)

    const sources = await this.readSources(args, exec)
    const api = await this.api()
    const data = await this.registry.read()

    let id: string
    let location: ArtifactLocation
    let newRepository = false
    if (updating) {
      id = args.id!
      location = (await this.locate(api, data, id, signal)).location
    } else {
      id = args.slug ?? idFromTitle(title!, this.randomSuffix())
      const known = data.artifacts[id]
      if (known !== undefined) {
        throw new Error(known.status === 'deleted'
          ? `The id "${id}" belonged to a deleted artifact and is not reused; choose another slug`
          : `An artifact with id "${id}" already exists; pass id to update it, or choose another slug`)
      }
      if (this.strategyOf(data).strategy === 'per-artifact') {
        location = this.ownLocation(this.settings.owner ?? await this.tokenOwner(api, signal), id)
        newRepository = true
      } else {
        location = this.sharedLocation((await this.sharedRepository(api, data, signal)).ref)
      }
    }
    const problem = idProblem(id)
    if (problem !== undefined) throw new Error(problem)
    if (newRepository && !REPO_NAME.test(location.repo)) throw new Error(`"${location.repo}" is not a valid repository name; choose a shorter slug or repoPrefix`)
    if (this.settings.blockSecrets) {
      const labels = [title ?? '', description, args.slug ?? '', ...(args.assets ?? []).map(asset => asset.name ?? ''), ...args.removeAssets ?? []]
      const found = findSecrets(labels.join('\n'), [api.token])
      if (found.length > 0) throw new Error(`Refusing to publish: the title, description, slug, or asset names appear to contain ${found.join(', ')}. Published artifacts are public.`)
    }

    // Check preconditions before asking, so the user is not asked about a doomed change.
    const store = this.store(api, location, signal)
    const repoName = repositoryName(location)
    let existing: ArtifactRecord | undefined
    let site: SiteInfo | undefined
    let url: string
    if (newRepository) {
      const taken = await api.gh.request('GET', `/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}`, { allowStatus: [404], signal })
      if (taken.status !== 404) throw new Error(`The repository ${repoName} already exists; choose another slug`)
      url = this.settings.apiBaseUrl === GITHUB_API ? `${defaultSiteUrl(location.owner, location.repo)}/` : `the GitHub Pages site of ${repoName}`
    } else {
      site = await this.siteInfo(api, location, signal)
      const before = await store.snapshot(signal)
      existing = before.manifest.artifacts[id]
      if (updating) assertUpdatable(id, existing, args.baseRev)
      else assertCreatable(id, before.manifest)
      if (!updating && (await store.artifactFiles(before, id)).length > 0) {
        throw new Error(`The folder ${store.artifactDir(id)}/ already exists in ${repoName} but is not an artifact; choose another slug`)
      }
      if (before.state === 'ready' && await before.jekyll() === 'jekyll-site') throw jekyllSiteError(location)
      url = this.artifactUrl(site, location, id)
    }

    const shownTitle = title ?? existing?.title ?? id
    const where = newRepository
      ? `Creates the new ${this.settings.repoVisibility} repository ${repoName} and turns on GitHub Pages for it.`
      : `Repository: ${repoName}${site?.pages === 'disabled' ? ' (GitHub Pages gets turned on)' : ''}.`
    const facts = `${where} ${describePublish(sources, args, shownTitle)}`
    await requireApproval(this.ctx, this.settings.approval, exec, updating
      ? {
          toolName: PUBLISH_TOOL,
          reason: `update artifact ${id} (rev ${existing!.rev} -> ${existing!.rev + 1}) at ${url}: ${facts}`,
          display: `Update the public page ${url} (rev ${existing!.rev} -> ${existing!.rev + 1})? ${facts}`,
        }
      : {
          toolName: PUBLISH_TOOL,
          reason: `publish new artifact at ${url}: ${facts}`,
          display: `Publish a new public page at ${url}? ${facts} Anyone with the link can view it.`,
        })

    if (newRepository) await this.createRepository(api, location, shownTitle, url.startsWith('https://') ? url : undefined, signal)
    const now = this.now().toISOString()
    const committed = await this.serialized(() => store.mutate(async (snapshot): Promise<Plan<{ record: ArtifactRecord; created: boolean }>> => {
      const current = snapshot.manifest.artifacts[id]
      if (updating) assertUpdatable(id, current, args.baseRev)
      else assertCreatable(id, snapshot.manifest)
      const dir = store.artifactDir(id)
      const existingFiles = await store.artifactFiles(snapshot, id)
      if (current === undefined && existingFiles.length > 0) {
        throw new Error(`The folder ${dir}/ already exists in ${repoName} but is not an artifact; choose another slug`)
      }
      const kind = sources.kind ?? current?.kind ?? 'html'
      const recordTitle = title ?? current!.title
      const writes: FileWrite[] = []
      const deletes: string[] = []
      const finalFiles = new Set(existingFiles)
      const pageOptions = { noindex: this.settings.noindex, csp: this.settings.csp }

      if (sources.mainText !== undefined) {
        if (kind === 'markdown') {
          writes.push({ path: joinPath(dir, PAGE_FILE), text: renderMarkdownPage({ title: recordTitle, description, markdown: sources.mainText }, pageOptions) })
          writes.push({ path: joinPath(dir, SOURCE_FILE), text: sources.mainText })
          finalFiles.add(SOURCE_FILE)
        } else {
          writes.push({ path: joinPath(dir, PAGE_FILE), text: prepareHtmlPage({ title: recordTitle, html: sources.mainText }, pageOptions) })
          if (finalFiles.has(SOURCE_FILE)) {
            deletes.push(joinPath(dir, SOURCE_FILE))
            finalFiles.delete(SOURCE_FILE)
          }
        }
        finalFiles.add(PAGE_FILE)
      } else if (current !== undefined && current.kind === 'markdown' && (title !== undefined && title !== current.title || description !== current.description)) {
        // Title and description live in the rendered page; re-render from the stored source.
        const source = await snapshot.readFile(joinPath(dir, SOURCE_FILE))
        if (source !== undefined) {
          writes.push({ path: joinPath(dir, PAGE_FILE), text: renderMarkdownPage({ title: recordTitle, description, markdown: decodeUtf8(source, SOURCE_FILE) }, pageOptions) })
        }
      }
      for (const file of sources.files) {
        writes.push(file.write(dir))
        finalFiles.add(file.name)
      }
      for (const name of args.removeAssets ?? []) {
        if (!finalFiles.has(name) || name === PAGE_FILE || name === SOURCE_FILE) {
          throw new Error(`Cannot remove asset "${name}": it is not part of artifact ${id}`)
        }
        if (sources.files.some(file => file.name === name)) throw new Error(`Asset "${name}" is both added and removed`)
        deletes.push(joinPath(dir, name))
        finalFiles.delete(name)
      }
      const record: ArtifactRecord = {
        id, title: recordTitle, kind,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
        rev: (current?.rev ?? 0) + 1,
        files: [...finalFiles].sort(),
        description,
      }
      return {
        message: current === undefined ? `Publish artifact ${id}: ${oneLine(recordTitle)}` : `Update artifact ${id} to rev ${record.rev}: ${oneLine(recordTitle)}`,
        writes, deletes,
        manifest: { version: 1, artifacts: { ...snapshot.manifest.artifacts, [id]: record }, tombstones: snapshot.manifest.tombstones },
        result: { record, created: current === undefined },
      }
    }, signal))

    const { record, created } = committed.result
    const warnings: string[] = []
    // The page is committed now: everything below only adds warnings, and the artifact is always tracked.
    try {
      if (newRepository || site?.pages === 'disabled') {
        warnings.push(...await this.ensurePages(api, location, signal, newRepository))
        site = await this.siteInfo(api, location, signal, true)
        url = this.artifactUrl(site, location, id)
      }
      warnings.push(...site?.warnings.filter(warning => !warning.startsWith('GitHub Pages is not enabled')) ?? [])
    } catch (error) {
      if (signal.aborted) throw error
      warnings.push(`Published, but could not finish checking the Pages site: ${errorText(error)}`)
    }
    await this.track({
      id, title: record.title, kind: record.kind, description, url, location,
      createdAt: data.artifacts[id]?.createdAt ?? record.createdAt, updatedAt: record.updatedAt, rev: record.rev, status: 'published',
    })
    return {
      id, title: record.title, kind: record.kind, url, repository: repoName, newRepository, rev: record.rev, created,
      commit: committed.commitSha, files: record.files, warnings,
    }
  }

  private async readSources(args: PublishArgs, exec: ToolRunContext): Promise<Sources> {
    const limit = this.settings.maxPublishBytes
    const guard = this.settings.blockSecrets
    let used = 0
    const charge = (bytes: number, label: string): void => {
      used += bytes
      if (used > limit) throw new Error(`${label} brings this publish to ${formatBytes(used)}, above the ${formatBytes(limit)} limit`)
    }
    const refuseCredentialPath = (path: string): void => {
      const problem = guard ? credentialPathProblem(path) : undefined
      if (problem !== undefined) throw new Error(`Refusing to publish ${problem}. Published artifacts are public.`)
    }
    const files: PreparedFile[] = []
    const screened: Array<{ label: string; text: string }> = []
    let mainText: string | undefined
    let mainBytes = 0
    let kind = args.kind
    if (args.path !== undefined) {
      refuseCredentialPath(args.path)
      const fromName = kindFromName(args.path)
      if (fromName === 'unsupported') throw new Error(`${args.path} cannot be published as a page; use a .html, .htm, .md, .markdown, or .txt file`)
      kind ??= fromName
      if (kind === undefined) throw new Error(`${args.path} is a .txt file; pass kind (markdown or html)`)
      const bytes = await readWorkspaceFile(this.ctx, exec, args.path, limit)
      charge(bytes.length, args.path)
      mainText = decodeUtf8(bytes, args.path)
      mainBytes = bytes.length
    } else if (args.content !== undefined) {
      if (args.content.trim() === '') throw new Error('content must not be empty')
      mainText = args.content
      mainBytes = Buffer.byteLength(mainText)
      charge(mainBytes, 'content')
      kind ??= isHtmlDocument(mainText) ? 'html' : 'markdown'
    }
    if (mainText !== undefined) screened.push({ label: args.path ?? 'content', text: mainText })
    const names = new Set<string>()
    for (const asset of args.assets ?? []) {
      refuseCredentialPath(asset.path)
      const name = asset.name ?? baseName(asset.path)
      const problem = assetNameProblem(name)
      if (problem !== undefined) throw new Error(problem)
      if (guard && credentialPathProblem(name) !== undefined) throw new Error(`Refusing to publish an asset named "${name}": it looks like a credential file`)
      if (names.has(name)) throw new Error(`Asset name "${name}" is used twice`)
      names.add(name)
      const bytes = await readWorkspaceFile(this.ctx, exec, asset.path, limit)
      charge(bytes.length, asset.path)
      if (isTextName(name)) {
        const text = decodeUtf8(bytes, asset.path)
        screened.push({ label: asset.path, text })
        files.push({ source: asset.path, name, bytes: bytes.length, write: dir => ({ path: joinPath(dir, name), text }) })
      } else {
        // Binary files are screened too: PDFs, data files, and renamed text often carry plain text.
        screened.push({ label: asset.path, text: Buffer.from(bytes).toString('latin1') })
        files.push({ source: asset.path, name, bytes: bytes.length, write: dir => ({ path: joinPath(dir, name), bytes }) })
      }
    }
    if (guard) {
      const token = await this.resolveToken()
      for (const { label, text } of screened) {
        const found = findSecrets(text, token === undefined ? [] : [token.value])
        if (found.length > 0) {
          throw new Error(`Refusing to publish ${label}: it appears to contain ${found.join(', ')}. Published artifacts are public; remove the secret and retry.`)
        }
      }
    }
    return { kind, mainText, mainBytes, files, totalBytes: used }
  }

  /**
   * List tracked artifacts, newest first. Artifacts found in the shared repository but missing
   * from the local registry (published from another machine) are added to it.
   * @param args - filter and paging.
   * @param signal - cancellation.
   */
  async list(args: { query?: string | undefined; offset?: number | undefined; limit?: number | undefined; includeDeleted?: boolean | undefined }, signal: AbortSignal): Promise<ListResult> {
    const offset = args.offset ?? 0
    const limit = args.limit ?? 50
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be an integer from 1 to 200')
    const notes: string[] = []
    let data = await this.registry.read()
    try {
      const api = await this.api()
      const shared = this.sharedLocation((await this.sharedRepository(api, data, signal)).ref)
      const snapshot = await this.store(api, shared, signal).snapshot(signal)
      const missing = Object.values(snapshot.manifest.artifacts).filter(record => data.artifacts[record.id] === undefined)
      if (missing.length > 0) {
        const site = await this.siteInfo(api, shared, signal)
        data = await this.registry.update(next => {
          for (const record of missing) {
            next.artifacts[record.id] ??= {
              id: record.id, title: record.title, kind: record.kind, url: this.artifactUrl(site, shared, record.id), location: shared,
              createdAt: record.createdAt, updatedAt: record.updatedAt, rev: record.rev, status: 'published',
              ...record.description === undefined ? {} : { description: record.description },
            }
          }
        })
      }
    } catch (error) {
      notes.push(`Could not check the shared repository for artifacts published elsewhere: ${errorText(error)}`)
    }
    try {
      data = await this.discoverOwnRepositories(data, signal)
    } catch (error) {
      notes.push(`Could not look for per-artifact repositories on GitHub: ${errorText(error)}`)
    }
    if (!await exists(this.registry.indexFile)) data = await this.registry.update(() => undefined)
    const query = args.query?.trim().toLowerCase() ?? ''
    const entries = Object.values(data.artifacts)
      .filter(entry => args.includeDeleted === true || entry.status === 'published')
      .filter(entry => query === '' || entry.id.includes(query) || entry.title.toLowerCase().includes(query)
        || (entry.description?.toLowerCase().includes(query) ?? false) || repositoryName(entry.location).toLowerCase().includes(query))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    const page = entries.slice(offset, offset + limit).map((entry): ListedArtifact => ({
      id: entry.id, title: entry.title, kind: entry.kind, url: entry.url, repository: repositoryName(entry.location),
      rev: entry.rev, updatedAt: entry.updatedAt, status: entry.status,
      ...entry.description === undefined ? {} : { description: entry.description },
    }))
    return {
      total: entries.length, artifacts: page, indexFile: this.registry.indexFile, notes,
      ...offset + page.length < entries.length ? { nextOffset: offset + page.length } : {},
    }
  }

  /**
   * Find repositories created per artifact (tagged with the artifact topic) that the registry does
   * not know yet, for example ones published from another machine, and track their artifacts.
   */
  private async discoverOwnRepositories(data: RegistryData, signal: AbortSignal): Promise<RegistryData> {
    const api = await this.api()
    const owner = (this.settings.owner ?? await this.tokenOwner(api, signal)).toLowerCase()
    const known = new Set(Object.values(data.artifacts).map(entry => repositoryName(entry.location).toLowerCase()))
    const found: RegistryEntry[] = []
    for (let page = 1; page <= 5; page++) {
      const repos = await api.gh.request<Array<{ name: string; owner: { login: string }; topics?: string[] }>>(
        'GET', `/user/repos?per_page=100&page=${page}&sort=updated`, { signal })
      for (const repo of repos.data) {
        if (repo.owner.login.toLowerCase() !== owner || !(repo.topics ?? []).includes(ARTIFACT_TOPIC)) continue
        if (known.has(`${repo.owner.login}/${repo.name}`.toLowerCase())) continue
        const location: ArtifactLocation = {
          owner: repo.owner.login, repo: repo.name, branch: this.settings.branch, siteDir: this.settings.siteDir, pathPrefix: '', layout: 'root',
        }
        const snapshot = await this.store(api, location, signal).snapshot(signal).catch(() => undefined)
        if (snapshot === undefined) continue
        for (const record of Object.values(snapshot.manifest.artifacts)) {
          if (data.artifacts[record.id] !== undefined) continue
          const site = await this.siteInfo(api, location, signal)
          found.push({
            id: record.id, title: record.title, kind: record.kind, url: this.artifactUrl(site, location, record.id), location,
            createdAt: record.createdAt, updatedAt: record.updatedAt, rev: record.rev, status: 'published',
            ...record.description === undefined ? {} : { description: record.description },
          })
        }
      }
      if (repos.data.length < 100) break
    }
    if (found.length === 0) return data
    return await this.registry.update(next => {
      for (const entry of found) next.artifacts[entry.id] ??= entry
    })
  }

  /**
   * Read an artifact's source or one of its text files.
   * @param args - id, file, window.
   * @param signal - cancellation.
   */
  async read(args: { id: string; file?: string | undefined; offset?: number | undefined; limit?: number | undefined }, signal: AbortSignal): Promise<ReadResult> {
    const offset = args.offset ?? 0
    const limit = args.limit ?? READ_DEFAULT_CHARS
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > READ_MAX_CHARS) throw new Error(`limit must be an integer from 1 to ${READ_MAX_CHARS}`)
    const api = await this.api()
    const { location } = await this.locate(api, await this.registry.read(), args.id, signal)
    const site = await this.siteInfo(api, location, signal)
    const store = this.store(api, location, signal)
    const snapshot = await store.snapshot(signal)
    const record = requireRecord(snapshot.manifest, args.id)
    const file = args.file ?? (record.kind === 'markdown' ? SOURCE_FILE : PAGE_FILE)
    if (!record.files.includes(file)) throw new Error(`Artifact ${args.id} has no file "${file}"; its files are ${record.files.join(', ')}`)
    if (file !== PAGE_FILE && file !== SOURCE_FILE && !isTextName(file)) throw new Error(`"${file}" is a binary file and cannot be read as text`)
    const bytes = await snapshot.readFile(joinPath(store.artifactDir(args.id), file))
    if (bytes === undefined) throw new Error(`"${file}" is listed for artifact ${args.id} but missing on the branch`)
    const decoded = decodeUtf8(bytes, file)
    // The served page carries tags the plugin injected; give back the page as it was written.
    const text = file === PAGE_FILE && record.kind === 'html' ? stripInjected(decoded) : decoded
    const content = text.slice(offset, offset + limit)
    return {
      id: record.id, title: record.title, kind: record.kind, url: this.artifactUrl(site, location, record.id),
      repository: repositoryName(location), rev: record.rev,
      file, files: record.files, totalChars: text.length, offset, content,
      ...offset + content.length < text.length ? { nextOffset: offset + content.length } : {},
    }
  }

  /**
   * Delete an artifact for the agent; its id is never reused. Asks for approval per configuration.
   * @param args - id.
   * @param exec - tool execution.
   */
  async remove(args: { id: string }, exec: ToolRunContext): Promise<DeleteResult> {
    this.assertVisible(DELETE_TOOL, exec)
    return await this.deleteArtifact(args.id, exec.signal, async ({ url, repoName, record }) => {
      await requireApproval(this.ctx, this.settings.approval, exec, {
        toolName: DELETE_TOOL,
        reason: `delete artifact ${args.id} at ${url} from ${repoName} (title ${quote(record.title)})`,
        display: `Delete the public page ${url} (title ${quote(record.title)}, ${record.files.length} file${record.files.length === 1 ? '' : 's'}, repository ${repoName})? The link stops working; copies others saved and the repository history remain.`,
      })
    })
  }

  /**
   * Delete an artifact the user chose in the Artifacts panel. The click (after the panel's own
   * confirmation) is the user's decision, so the agent approval prompt does not apply.
   * @param id - artifact id.
   * @param signal - cancellation.
   */
  async removeByUser(id: string, signal: AbortSignal): Promise<DeleteResult> {
    const problem = idProblem(id)
    if (problem !== undefined) throw new Error(problem)
    return await this.deleteArtifact(id, signal, async () => undefined)
  }

  private async deleteArtifact(
    id: string,
    signal: AbortSignal,
    approve: (facts: { url: string; repoName: string; record: ArtifactRecord }) => Promise<void>,
  ): Promise<DeleteResult> {
    const api = await this.api()
    const { location } = await this.locate(api, await this.registry.read(), id, signal)
    const site = await this.siteInfo(api, location, signal)
    const store = this.store(api, location, signal)
    const before = await store.snapshot(signal)
    const record = requireRecord(before.manifest, id)
    const url = this.artifactUrl(site, location, id)
    const repoName = repositoryName(location)
    await approve({ url, repoName, record })
    const committed = await this.serialized(() => store.mutate(async (snapshot): Promise<Plan<null>> => {
      const current = requireRecord(snapshot.manifest, id)
      const dir = store.artifactDir(id)
      const deletes = (await store.artifactFiles(snapshot, id)).map(file => joinPath(dir, file))
      const artifacts = { ...snapshot.manifest.artifacts }
      delete artifacts[id]
      return {
        message: `Delete artifact ${id}: ${oneLine(current.title)}`,
        writes: [], deletes,
        manifest: { version: 1, artifacts, tombstones: [...snapshot.manifest.tombstones, id] },
        result: null,
      }
    }, signal))
    const deletedAt = this.now().toISOString()
    await this.registry.update(data => {
      const known = data.artifacts[id]
      data.artifacts[id] = {
        ...known ?? {
          id, title: record.title, kind: record.kind, url, location,
          createdAt: record.createdAt, rev: record.rev,
          ...record.description === undefined ? {} : { description: record.description },
        },
        updatedAt: deletedAt, status: 'deleted', deletedAt,
      } as RegistryEntry
    })
    const notes = location.layout === 'root'
      ? [`The repository ${repoName} still exists (now without the page); delete it on GitHub if it is no longer needed.`]
      : []
    return { id, url, repository: repoName, deleted: true, commit: committed.commitSha, notes }
  }

  /**
   * Show or change where new artifacts go.
   * @param args - action and its inputs.
   * @param exec - tool execution.
   */
  async repository(args: RepositoryArgs, exec: ToolRunContext): Promise<RepositoryResult> {
    const signal = exec.signal
    if (args.action !== 'show') this.assertVisible(PUBLISH_TOOL, exec)
    const warnings: string[] = []
    switch (args.action) {
      case 'show':
        break
      case 'link': {
        if (args.repository === undefined || args.repository.trim() === '') throw new Error('link needs repository (owner/name or a remote URL)')
        const ref = parseRepository(args.repository, this.settings.apiBaseUrl)
        const api = await this.api()
        const repo = await api.gh.request<{ permissions?: { push?: boolean }; archived?: boolean }>(
          'GET', `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`, { allowStatus: [404], signal })
        if (repo.status === 404) throw new Error(`Repository ${ref.owner}/${ref.repo} was not found, or the token cannot access it`)
        if (repo.data.permissions?.push === false) throw new Error(`The token's account cannot push to ${ref.owner}/${ref.repo}`)
        if (repo.data.archived === true) throw new Error(`${ref.owner}/${ref.repo} is archived and cannot receive new pages`)
        if (ref.repo.toLowerCase() === `${ref.owner.toLowerCase()}.github.io`) {
          warnings.push(`${ref.owner}/${ref.repo} is a user or organization site: artifacts will share its root and origin. A dedicated repository is safer.`)
        }
        await this.saveChoice(
          [{ op: 'set', path: ['repository'], value: `${ref.owner}/${ref.repo}` }, { op: 'set', path: ['repoStrategy'], value: 'shared' }],
          data => {
            data.settings.link = { owner: ref.owner, repo: ref.repo, linkedAt: this.now().toISOString() }
            data.settings.strategy = 'shared'
          },
          warnings,
        )
        break
      }
      case 'unlink':
        await this.saveChoice([{ op: 'unset', path: ['repository'] }], data => {
          delete data.settings.link
        }, warnings)
        break
      case 'set_strategy':
        if (args.strategy === undefined) throw new Error('set_strategy needs strategy (shared or per-artifact)')
        await this.saveChoice([{ op: 'set', path: ['repoStrategy'], value: args.strategy }], data => {
          data.settings.strategy = args.strategy!
        }, warnings)
        break
    }
    return await this.describeRepository(signal, warnings)
  }

  /**
   * Persist a choice made in chat. With the dsh settings service the plugin's own configuration is
   * updated, so the Plugins page and the profile file show it; without it (or when a higher layer
   * fixes the value) the choice is kept in the registry, which then overrides the configuration.
   */
  private async saveChoice(ops: SettingsOp[], fallback: (data: RegistryData) => void, warnings: string[]): Promise<void> {
    const settings = this.ctx.get('settings') as SettingsWriter | undefined
    if (settings !== undefined && typeof settings.mutate === 'function' && this.namespace !== undefined) {
      try {
        await settings.mutate(this.namespace, ops)
        // The configuration is authoritative now; drop overrides an earlier fallback stored.
        await this.registry.update(data => {
          delete data.settings.link
          delete data.settings.strategy
        })
        return
      } catch (error) {
        warnings.push(`Could not save this in the plugin settings (${errorText(error)}); it is kept in the plugin's registry instead and overrides the settings.`)
      }
    }
    await this.registry.update(fallback)
  }

  private async describeRepository(signal: AbortSignal, warnings: string[]): Promise<RepositoryResult> {
    const data = await this.registry.read()
    const { strategy, source } = this.strategyOf(data)
    let api: Api | undefined
    try {
      api = await this.api()
    } catch (error) {
      warnings.push(errorText(error))
    }
    let shared: { ref: RepoRef; source: RepositoryResult['repositorySource'] }
    try {
      shared = await this.sharedRepository(api, data, signal)
    } catch (error) {
      warnings.push(errorText(error))
      shared = { ref: { owner: this.settings.owner ?? '(token user)', repo: this.settings.repo }, source: 'token user' }
    }
    const newOwner = this.settings.owner ?? (api === undefined ? '(token user)' : await this.tokenOwner(api, signal).catch(() => '(token user)'))
    const result: RepositoryResult = {
      strategy, strategySource: source,
      repository: repositoryName(shared.ref), repositorySource: shared.source,
      branch: this.settings.branch,
      newRepositories: `${newOwner}/${this.settings.repoPrefix}<id> (${this.settings.repoVisibility})`,
      registryFile: this.registry.file, indexFile: this.registry.indexFile, warnings,
    }
    if (api !== undefined && strategy === 'shared' && !shared.ref.owner.startsWith('(')) {
      try {
        const site = await this.siteInfo(api, this.sharedLocation(shared.ref), signal, true)
        result.siteUrl = `${site.url}/`
        result.pages = site.pages
        warnings.push(...site.warnings)
      } catch (error) {
        warnings.push(errorText(error))
      }
    }
    if (strategy === 'per-artifact') {
      warnings.push('Each new artifact gets its own repository, which needs a token that may create repositories (fine-grained: all repositories with Administration, Contents, and Pages write; classic: public_repo). Existing artifacts stay where they are.')
    }
    return result
  }

  /**
   * Diagnose the setup and the deployment of the latest change.
   * @param args - optional artifact id and whether to wait for deployment.
   * @param signal - cancellation.
   */
  async status(args: { id?: string | undefined; wait?: boolean | undefined }, signal: AbortSignal): Promise<StatusResult> {
    // Setup problems make the result not ready; notes describe a deployment that is still under way.
    const problems: string[] = []
    const notes: string[] = []
    const settings = this.settings
    const data = await this.registry.read()
    const { strategy } = this.strategyOf(data)
    const token = await this.resolveToken()
    const result: StatusResult = {
      ready: false, strategy, repository: `${settings.owner ?? '(token user)'}/${settings.repo}`, branch: settings.branch,
      token: { configured: token !== undefined, ...token === undefined ? {} : { source: token.source } },
      pages: 'unknown', registryFile: this.registry.file, problems,
    }
    if (token === undefined) {
      problems.push(this.missingTokenError().message)
      return result
    }
    let api: Api
    let location: ArtifactLocation
    try {
      api = await this.api()
      location = args.id !== undefined
        ? (await this.locate(api, data, args.id, signal)).location
        : this.sharedLocation((await this.sharedRepository(api, data, signal)).ref)
    } catch (error) {
      problems.push(errorText(error))
      return result
    }
    const { gh } = api
    const repoPath = `/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}`
    result.repository = repositoryName(location)
    result.branch = location.branch
    if (strategy === 'per-artifact' && args.id === undefined) {
      notes.push(`New artifacts get their own repository (${settings.owner ?? 'token user'}/${settings.repoPrefix}<id>); the checks below are for the shared repository ${result.repository}.`)
    }
    const repo = await gh.request<{ permissions?: { push?: boolean }; private?: boolean }>('GET', repoPath, { allowStatus: [404], signal })
    if (repo.status === 404) {
      const message = `Repository ${result.repository} was not found or the token cannot access it. Ask the user to create or link a repository and grant the token access (see the dsh-gh-pages-artifacts README); do not run setup commands yourself.`
      if (strategy === 'per-artifact' && args.id === undefined) notes.push(message)
      else problems.push(message)
      result.ready = problems.length === 0
      problems.push(...notes)
      return result
    }
    if (repo.data.permissions?.push === false) problems.push(`The token's account cannot push to ${result.repository}; it needs write access to the repository.`)
    let site: SiteInfo
    try {
      site = await this.siteInfo(api, location, signal, true)
    } catch (error) {
      problems.push(errorText(error))
      return result
    }
    result.siteUrl = `${site.url}/`
    result.pages = site.pages
    problems.push(...site.warnings)
    if (site.pages === 'unknown') problems.push(`Cannot check the GitHub Pages settings because the token lacks Pages: read. Make sure Pages deploys ${location.branch} ${location.siteDir === '' ? '/' : `/${location.siteDir}`}, or grant Pages: read-only so this check can run.`)
    let snapshot: Snapshot | undefined
    try {
      snapshot = await this.store(api, location, signal).snapshot(signal)
      if (snapshot.state === 'missing-branch') notes.push(`Branch ${location.branch} does not exist yet; the first publish creates it.`)
    } catch (error) {
      problems.push(errorText(error))
    }
    const latestBuild = async (): Promise<StatusResult['latestBuild']> => {
      const build = await gh.request<{ status?: string; commit?: string | null; error?: { message?: string | null } | null }>(
        'GET', `${repoPath}/pages/builds/latest`, { allowStatus: [403, 404], signal })
      if (build.status !== 200 || build.data.status === undefined) return undefined
      const message = build.data.error?.message
      return {
        status: build.data.status,
        // GitHub reports a null commit for builds it has not attributed yet.
        ...typeof build.data.commit === 'string' ? { commit: build.data.commit } : {},
        ...typeof message === 'string' && message !== '' ? { error: message } : {},
      }
    }
    const headSha = snapshot?.headSha
    if (headSha !== undefined) result.headCommit = headSha
    // Real Pages deployments take one to several minutes; wait up to five.
    const deadline = this.now().getTime() + DEPLOY_WAIT_MS
    const sleep = this.hooks.sleep ?? ((ms: number, s?: AbortSignal) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      s?.addEventListener('abort', () => { clearTimeout(timer); reject(s.reason) }, { once: true })
    }))
    const settled = (current: StatusResult['latestBuild']): boolean => current === undefined || current.status === 'errored'
      || (current.status === 'built' && (headSha === undefined || current.commit === headSha))
    let build = site.pages === 'disabled' ? undefined : await latestBuild()
    while (args.wait === true && !settled(build) && this.now().getTime() < deadline) {
      await sleep(5000, signal)
      build = await latestBuild()
    }
    if (build !== undefined) {
      result.latestBuild = build
      if (headSha !== undefined) {
        result.deployed = build.status === 'built' && build.commit === headSha
        if (build.status === 'errored') problems.push(`The latest Pages build failed: ${build.error ?? 'no details'}`)
        else if (!result.deployed) notes.push(`The latest change (commit ${headSha.slice(0, 7)}) is not deployed yet (Pages build: ${build.status}${build.commit === undefined || build.commit === headSha ? '' : ` for ${build.commit.slice(0, 7)}`}); deployments usually take one to three minutes.`)
      } else if (build.status === 'errored') {
        problems.push(`The latest Pages build failed: ${build.error ?? 'no details'}`)
      }
    } else if (site.pages !== 'disabled' && (args.wait === true || args.id !== undefined)) {
      notes.push('Cannot see Pages builds (grant the token Pages: read-only), so "live" only means the URL responds; an update may still show the previous version for a few minutes.')
    }
    if (args.id !== undefined && snapshot !== undefined) {
      const record = snapshot.manifest.artifacts[args.id]
      if (record === undefined) {
        notes.push(`No artifact with id ${args.id}`)
      } else {
        const url = this.artifactUrl(site, location, args.id)
        let httpStatus = await this.probe(url, signal)
        while (args.wait === true && httpStatus !== 200 && this.now().getTime() < deadline) {
          await sleep(5000, signal)
          httpStatus = await this.probe(url, signal)
        }
        result.artifact = { id: args.id, url, live: httpStatus === 200, ...httpStatus === undefined ? {} : { httpStatus } }
        if (httpStatus !== 200) notes.push(`${url} does not respond with 200 yet${httpStatus === undefined ? '' : ` (HTTP ${httpStatus})`}; deployments usually take one to three minutes.`)
      }
    }
    result.ready = problems.length === 0
    problems.push(...notes)
    return result
  }

  private async probe(url: string, signal: AbortSignal): Promise<number | undefined> {
    try {
      const fetchImpl = this.hooks.fetch ?? ((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init))
      const response = await fetchImpl(url, {
        method: 'HEAD', redirect: 'follow', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        headers: { 'User-Agent': `dsh-gh-pages-artifacts/${VERSION}` },
      })
      return response.status
    } catch (error) {
      if (signal.aborted) throw error
      return undefined
    }
  }
}

function assertCreatable(id: string, manifest: Manifest): void {
  if (manifest.artifacts[id] !== undefined) throw new Error(`An artifact with id "${id}" already exists; pass id to update it, or choose another slug`)
  if (manifest.tombstones.includes(id)) throw new Error(`The id "${id}" belonged to a deleted artifact and is not reused; choose another slug`)
}

function assertUpdatable(id: string, record: ArtifactRecord | undefined, baseRev: number | undefined): asserts record is ArtifactRecord {
  if (record === undefined) throw new Error(`No artifact with id "${id}"; use artifact_list to find ids, or omit id to create a new artifact`)
  if (baseRev !== undefined && baseRev !== record.rev) {
    throw new Error(`Artifact ${id} changed since rev ${baseRev}; it is now rev ${record.rev}. Read it again with artifact_read and merge your changes.`)
  }
}

function requireRecord(manifest: Manifest, id: string): ArtifactRecord {
  const record = manifest.artifacts[id]
  if (record === undefined) {
    throw new Error(manifest.tombstones.includes(id) ? `Artifact ${id} was deleted` : `No artifact with id "${id}"; use artifact_list to find ids`)
  }
  return record
}

/** Kind implied by a page file name; undefined for .txt (kind must be given); 'unsupported' otherwise. */
function kindFromName(name: string): ArtifactKind | 'unsupported' | undefined {
  const lower = name.toLowerCase()
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html'
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdown')) return 'markdown'
  if (lower.endsWith('.txt')) return undefined
  return 'unsupported'
}

/** Inline content is HTML only when it is clearly a whole document; everything else is Markdown. */
function isHtmlDocument(text: string): boolean {
  return /^﻿?\s*(?:<!doctype html|<html[\s>])/i.test(text)
}

/**
 * Trusted facts for the approval prompt, built from validated arguments rather than free text, so
 * a crafted title cannot hide what is being published.
 */
function describePublish(sources: Sources, args: PublishArgs, title: string): string {
  const parts: string[] = [`Title: ${quote(title)}.`]
  if (sources.mainText !== undefined) {
    const origin = args.path !== undefined ? `workspace file ${quote(args.path)}` : `inline content (${sources.mainText.length} characters)`
    parts.push(`Page: ${origin} as ${sources.kind}, ${formatBytes(sources.mainBytes)}.`)
  } else {
    parts.push('Page content unchanged.')
  }
  if (sources.files.length > 0) {
    const shown = sources.files.slice(0, 8).map(file => `${quote(file.source)} as ${quote(file.name)}`)
    const more = sources.files.length > 8 ? ` and ${sources.files.length - 8} more` : ''
    parts.push(`Assets: ${shown.join(', ')}${more}.`)
  }
  if (args.removeAssets !== undefined && args.removeAssets.length > 0) parts.push(`Removes: ${args.removeAssets.map(quote).join(', ')}.`)
  parts.push(`Total ${formatBytes(sources.totalBytes)}.`)
  return parts.join(' ')
}

/**
 * Validate a free-text field shown to people: single line, no control or bidi characters, bounded.
 * @returns the trimmed text.
 */
function checkText(field: string, value: string, max: number): string {
  const text = value.trim()
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(text)) throw new Error(`${field} must be a single line without control or formatting characters`)
  if (text.length > max) throw new Error(`${field} must be at most ${max} characters`)
  return text
}

function quote(text: string): string {
  return JSON.stringify(text.length > 120 ? `${text.slice(0, 117)}...` : text)
}

function oneLine(text: string, max = 72): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 3)}...` : line
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * The default public URL of a project site, or of a user/organization site repository.
 * @param owner - repository owner.
 * @param repo - repository name.
 */
export function defaultSiteUrl(owner: string, repo: string): string {
  const host = `${owner.toLowerCase()}.github.io`
  return repo.toLowerCase() === host ? `https://${host}` : `https://${host}/${repo}`
}

function normalizeSiteUrl(url: string): string {
  const parsed = new URL(url)
  if (parsed.protocol === 'http:' && parsed.hostname.endsWith('.github.io')) parsed.protocol = 'https:'
  return parsed.href.replace(/\/+$/, '')
}

function joinUrl(base: string, path: string): string {
  return path === '' ? base : `${base}/${path.split('/').map(encodeURIComponent).join('/')}`
}
