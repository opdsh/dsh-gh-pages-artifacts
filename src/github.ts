/** Minimal GitHub REST client: JSON requests, bounded retries, rate-limit handling, token scrubbing. */

/** Options for one {@link GitHubClient}. */
export interface GitHubClientOptions {
  /** API base URL without trailing slash, e.g. https://api.github.com. */
  readonly apiBaseUrl: string
  /** Bearer token. Never logged, never placed in errors. */
  readonly token: string
  /** User-Agent header; GitHub rejects requests without one. */
  readonly userAgent: string
  /** Fetch implementation; defaults to the global fetch (which honours the harness proxy). */
  readonly fetch?: typeof fetch
  /** Per-request timeout in milliseconds. */
  readonly requestTimeoutMs?: number
  /** Retries for transient failures (network errors, 5xx, rate limits). */
  readonly maxRetries?: number
  /** Longest wait the client accepts for a rate-limit reset before failing. */
  readonly maxRateLimitWaitMs?: number
  /** Sleep implementation, replaceable in tests. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** Per-request options. */
export interface RequestOptions {
  /** JSON body. */
  readonly body?: unknown
  /** Statuses returned to the caller instead of thrown. */
  readonly allowStatus?: readonly number[]
  /** Whether transient failures may be retried; false for non-idempotent writes. */
  readonly retry?: boolean
  /** Caller cancellation. */
  readonly signal?: AbortSignal | undefined
}

/** A completed response. */
export interface GitHubResponse<T> {
  readonly status: number
  readonly data: T
  readonly headers: Headers
}

/** A GitHub API error with the HTTP status and GitHub's message. */
export class GitHubApiError extends Error {
  override readonly name = 'GitHubApiError'
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly apiMessage: string,
    readonly acceptedPermissions?: string,
  ) {
    super(`GitHub API ${method} ${path} failed with ${status}: ${apiMessage}`)
  }
}

const API_VERSION = '2022-11-28'

/** Thin JSON client for the GitHub REST API. */
export class GitHubClient {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly maxRateLimitWaitMs: number
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>

  constructor(private readonly options: GitHubClientOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.timeoutMs = options.requestTimeoutMs ?? 30_000
    this.maxRetries = options.maxRetries ?? 3
    this.maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? 60_000
    this.sleep = options.sleep ?? abortableSleep
  }

  /**
   * Send one request.
   * @param method - HTTP method.
   * @param path - path beginning with '/', relative to the API base URL.
   * @param options - body, allowed statuses, retry policy, cancellation.
   * @returns the parsed response.
   * @throws GitHubApiError for statuses outside 2xx and `allowStatus`.
   */
  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<GitHubResponse<T>> {
    const retry = options.retry ?? true
    let attempt = 0
    for (;;) {
      options.signal?.throwIfAborted()
      let response: Response
      try {
        response = await this.send(method, path, options)
      } catch (error) {
        if (options.signal?.aborted === true) throw options.signal.reason
        if (retry && attempt < this.maxRetries) {
          await this.sleep(backoff(attempt++), options.signal)
          continue
        }
        throw new Error(this.scrub(`GitHub API ${method} ${path} could not be reached: ${describeError(error)}`))
      }
      const status = response.status
      if (status >= 200 && status < 300 || options.allowStatus?.includes(status) === true) {
        return { status, data: await readBody<T>(response), headers: response.headers }
      }
      const body = await readBody<unknown>(response).catch(() => undefined)
      const apiMessage = this.scrub(messageOf(body) ?? response.statusText ?? 'request failed')
      const rateWait = rateLimitWait(response, apiMessage)
      if (rateWait !== undefined) {
        if (rateWait <= this.maxRateLimitWaitMs && attempt < this.maxRetries) {
          attempt++
          await this.sleep(rateWait, options.signal)
          continue
        }
        throw new GitHubApiError(status, method, path, `${apiMessage} (GitHub rate limit; retry in about ${Math.ceil(rateWait / 1000)} s)`)
      }
      if (status >= 500 && retry && attempt < this.maxRetries) {
        await this.sleep(backoff(attempt++), options.signal)
        continue
      }
      throw new GitHubApiError(status, method, path, apiMessage,
        response.headers.get('x-accepted-github-permissions') ?? undefined)
    }
  }

  private async send(method: string, path: string, options: RequestOptions): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${this.options.token}`,
      'User-Agent': this.options.userAgent,
      'X-GitHub-Api-Version': API_VERSION,
    }
    const init: RequestInit = { method, headers, signal, redirect: 'follow' }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(options.body)
    }
    return await this.fetchImpl(`${this.options.apiBaseUrl}${path}`, init)
  }

  /**
   * Remove the token from text that may reach the model or logs.
   * @param text - text to clean.
   * @returns the text with every token occurrence replaced.
   */
  scrub(text: string): string {
    const token = this.options.token
    return token.length >= 8 ? text.split(token).join('***') : text
  }
}

async function readBody<T>(response: Response): Promise<T> {
  if (response.status === 204 || response.status === 205) return undefined as T
  const text = await response.text()
  if (text === '') return undefined as T
  const type = response.headers.get('content-type') ?? ''
  if (type.includes('json')) return JSON.parse(text) as T
  try {
    return JSON.parse(text) as T
  } catch {
    return text as T
  }
}

function messageOf(body: unknown): string | undefined {
  if (typeof body === 'string') return body.slice(0, 300)
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as { message?: unknown; errors?: unknown }
  const message = typeof record.message === 'string' ? record.message : undefined
  const details = Array.isArray(record.errors)
    ? record.errors.map(item => typeof item === 'string' ? item : (item as { message?: unknown }).message)
      .filter((item): item is string => typeof item === 'string')
    : []
  return details.length > 0 ? `${message ?? 'error'} (${details.join('; ')})` : message
}

/**
 * Milliseconds to wait before retrying a rate-limited response, or undefined when it is not one.
 * @param response - the failed response.
 * @param message - GitHub's message.
 */
function rateLimitWait(response: Response, message: string): number | undefined {
  const status = response.status
  if (status !== 403 && status !== 429) return undefined
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter !== null && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000
  const remaining = response.headers.get('x-ratelimit-remaining')
  const reset = response.headers.get('x-ratelimit-reset')
  if (remaining === '0' && reset !== null && /^\d+$/.test(reset)) {
    return Math.max(1000, Number(reset) * 1000 - Date.now())
  }
  if (status === 429 || /secondary rate limit|abuse/i.test(message)) return 60_000
  return undefined
}

function backoff(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250)
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    return cause instanceof Error ? `${error.message} (${cause.message})` : error.message
  }
  return String(error)
}

async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Encode each segment of a repository path for use in a URL.
 * @param path - slash-separated path.
 */
export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}
