/**
 * Web routes the browser half reads: the artifact list for the sidebar's Artifacts panel. They are
 * exact Fetch routes on dsh's shared /api channel, so the Connection's cookie auth and Host/Origin
 * fence apply before these handlers run. Compositions without a web Connection (CLI, headless)
 * simply do not get them.
 */
import type { Context } from '@deepseek-ai/cordis'
import { repositoryName, type RegistryData } from './registry.js'
import type { ArtifactsRuntime, ListedArtifact } from './service.js'

/** Route keys on the Host; the browser uses the document-relative form without the leading slash. */
export const ARTIFACTS_LIST_PATH = '/api/gh-pages-artifacts/list'
export const ARTIFACTS_REFRESH_PATH = '/api/gh-pages-artifacts/refresh'
export const ARTIFACTS_DELETE_PATH = '/api/gh-pages-artifacts/delete'

/** Structural slice of the Host `ctx.connection` service (dsh-client-connection), type only. */
interface ConnectionFetchRegistry {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
      readonly requestBody: 'buffered' | 'streaming'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/** Body of both routes. */
export interface ArtifactsPayload {
  readonly artifacts: ListedArtifact[]
  readonly notes: string[]
}

/** An error the route answers with a 4xx status instead of a 500. */
class RequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * @param data - registry contents.
 * @returns published artifacts, newest first.
 */
export function publishedArtifacts(data: RegistryData): ListedArtifact[] {
  return Object.values(data.artifacts)
    .filter(entry => entry.status === 'published')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .map(entry => ({
      id: entry.id, title: entry.title, kind: entry.kind, url: entry.url,
      repository: repositoryName(entry.location), rev: entry.rev, updatedAt: entry.updatedAt, status: entry.status,
      ...entry.description === undefined ? {} : { description: entry.description },
    }))
}

/** The web server answers a thrown handler with a bare 400, so every failure becomes JSON here. */
function guarded(handler: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      return await handler(request)
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, error instanceof RequestError ? error.status : 500)
    }
  }
}

/**
 * Serve the artifact list while a web Connection exists.
 * @param ctx - plugin context.
 * @param runtime - artifact operations and registry.
 */
export function installWebRoutes(ctx: Context, runtime: ArtifactsRuntime): void {
  ctx.inject(['connection'], (webCtx) => {
    // Read structurally so the plugin needs no dependency on the connection package; the
    // registration is owned by this child context and goes away with it.
    const connection = Reflect.get(webCtx, 'connection') as ConnectionFetchRegistry
    try {
      connection.fetch.register({
        path: ARTIFACTS_LIST_PATH, methods: ['GET'], requestBody: 'buffered',
        // The local registry only: fast and needs no GitHub call.
        fetch: guarded(async () => json({ artifacts: publishedArtifacts(await runtime.registry.read()), notes: [] } satisfies ArtifactsPayload)),
      })
      connection.fetch.register({
        path: ARTIFACTS_REFRESH_PATH, methods: ['POST'], requestBody: 'buffered',
        // Reconcile with GitHub first (adds artifacts published from elsewhere).
        fetch: guarded(async (request) => {
          const result = await runtime.list({ limit: 200 }, request.signal)
          return json({ artifacts: result.artifacts, notes: result.notes } satisfies ArtifactsPayload)
        }),
      })
      connection.fetch.register({
        path: ARTIFACTS_DELETE_PATH, methods: ['POST'], requestBody: 'buffered',
        // A delete the user confirmed in the Artifacts panel. Connection only admits same-origin
        // requests from a signed-in browser, so other sites cannot trigger it.
        fetch: guarded(async (request) => {
          const body = await request.json().catch(() => undefined) as { id?: unknown } | undefined
          if (typeof body?.id !== 'string' || body.id === '') throw new RequestError('Missing artifact id', 400)
          const result = await runtime.removeByUser(body.id, request.signal)
          return json({ deleted: result, artifacts: publishedArtifacts(await runtime.registry.read()) })
        }),
      })
    } catch (error) {
      // A second running row of this plugin would register the same paths.
      webCtx.logger.warn(`gh-pages-artifacts: artifact list routes unavailable: ${String(error)}`)
    }
  })
}
