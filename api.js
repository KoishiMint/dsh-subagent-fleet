/**
 * HTTP surface for the route-queue panel.
 *
 * The panel needs two things the settings form cannot give it: the live model
 * catalog (so the queue can show names and availability) and an ordered write
 * (so dragging is a single atomic edit). Both live here.
 *
 * Admission follows the same fence the other in-app plugins use: the browser
 * connection service decides whether a request came from the local app or an
 * admitted remote peer. Without that service the routes refuse rather than
 * silently trusting the network.
 *
 * @module dsh-subagent-fleet/api
 */

/** Namespace the queue is persisted in, matching the delegation tool's row. */
export const SETTINGS_NS = 'subagent-model-selection-settings'

/** Guard against an unbounded body. */
const MAX_BODY_BYTES = 256 * 1024

/**
 * Read a whole request body with a byte ceiling.
 * @param req - incoming request.
 * @returns the decoded body.
 */
async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (total === 0) return ''
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Parse a JSON body, tolerating an empty one.
 * @param req - incoming request.
 * @returns the parsed value, or undefined when the body is empty.
 */
async function readJson(req) {
  const text = await readBody(req)
  if (text.trim() === '') return undefined
  const value = JSON.parse(text)
  if (value === null || typeof value !== 'object') throw new Error('request body must be a JSON object')
  return value
}

/**
 * Validate one incoming route.
 * @param value - untrusted candidate.
 * @returns a clean `{provider, model}` pair.
 */
function parseRoute(value) {
  if (value === null || typeof value !== 'object') throw new Error('each route must be an object')
  const provider = value.provider
  const model = value.model
  if (typeof provider !== 'string' || provider.length === 0) throw new Error('each route needs a non-empty provider')
  if (typeof model !== 'string' || model.length === 0) throw new Error('each route needs a non-empty model')
  return { provider, model }
}

/**
 * Decide whether a request may use this API.
 *
 * The composition may publish the `connection` service after plugins load, so
 * the caller passes a thunk and this reads it per request. Both the current
 * `admit` spelling and the older `requestRejection` one are accepted; a service
 * that throws is treated as a refusal rather than an open door.
 * @param req - incoming request.
 * @param connection - the `connection` service, or a thunk resolving it.
 * @returns an HTTP status when the request must be refused, else undefined.
 */
function rejectionFor(req, connection) {
  const service = typeof connection === 'function' ? connection() : connection
  if (service === undefined) {
    // No admission service at all: this Host is not serving a browser, so the
    // routes have no legitimate caller.
    return 503
  }
  try {
    if (typeof service.admit === 'function') {
      const admission = service.admit.call(service, req)
      return admission !== null && typeof admission === 'object' ? admission.rejection : undefined
    }
    if (typeof service.requestRejection === 'function') {
      return service.requestRejection.call(service, req)
    }
    return 503
  } catch {
    return 503
  }
}

/**
 * Build the HTTP handler.
 * @param deps - live Host services and the shared queue state.
 * @returns a node request handler.
 */
export function createQueueApi(deps) {
  return async function handler(req, res) {
    const send = (status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    const routePath = url.pathname.replace(/^\/api\/subagent-queue/, '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()

    const rejection = rejectionFor(req, deps.connection)
    if (rejection !== undefined) {
      return send(rejection, { error: rejection === 401 ? 'unauthorized' : 'admission unavailable' })
    }

    try {
      // The panel's one read: current queue, the live catalog, and the flags the
      // page needs to render itself consistently.
      if (method === 'GET' && routePath === '/state') {
        return send(200, deps.state())
      }

      // Replace the queue wholesale. Dragging produces one new order, so one
      // atomic write is both simpler and safer than a sequence of moves.
      if (method === 'PUT' && routePath === '/queue') {
        const body = await readJson(req)
        if (body === undefined || !Array.isArray(body.routes)) throw new Error('expected { routes: [...] }')
        const routes = body.routes.map(parseRoute)
        const result = await deps.write(routes, body.enabled)
        return send(200, result)
      }

      // Append one route from the catalog (the panel's "add" action).
      if (method === 'POST' && routePath === '/queue') {
        const body = await readJson(req)
        if (body === undefined) throw new Error('expected { provider, model }')
        const route = parseRoute(body)
        const current = deps.routes()
        const next = [...current, route]
        const result = await deps.write(next, deps.enabled())
        return send(200, result)
      }

      if (method === 'POST' && routePath === '/enabled') {
        const body = await readJson(req)
        if (body === undefined || typeof body.enabled !== 'boolean') throw new Error('expected { enabled: boolean }')
        const result = await deps.write(deps.routes(), body.enabled)
        return send(200, result)
      }

      // Per-session subagent activity for the composer strip: which route each
      // child is on, and what it has spent. Cheap enough to poll — it reads
      // projections the host already maintains, not the session logs.
      if (method === 'GET' && routePath === '/children') {
        const parentId = url.searchParams.get('session') ?? ''
        if (parentId.length === 0) throw new Error('`session` query parameter is required')
        return send(200, { session: parentId, children: deps.children(parentId) })
      }

      return send(404, { error: `unknown route ${method} ${routePath}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.logger?.warn?.(`subagent-live-routes: queue API rejected a request: ${message}`)
      return send(400, { error: message })
    }
  }
}
