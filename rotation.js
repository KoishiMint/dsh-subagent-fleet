/**
 * Route rotation for a delegation child.
 *
 * The selected models form an ordered queue. A child starts on the first entry,
 * and when a request fails with a quota/rate-limit/credential fault the same
 * child moves to the next entry instead of failing the whole task. This is the
 * behaviour `dsh-our-free-model`'s leftover `combos` setting implies but never
 * implements, so it lives here.
 *
 * Why `agent/request` and not the tool call
 * ------------------------------------------
 * The delegation tool picks a route once, when it creates the child; the agent
 * loop then issues many model requests under that child. `agent/request` is a
 * waterfall that runs before *every* one of those requests and may replace the
 * frozen call config, so a rotation applied there survives across steps and
 * turns of the same child. The `agent.ctx`-scoped registration means rotation
 * state dies with the child.
 *
 * @module dsh-subagent-fleet/rotation
 */

/** Failure codes worth moving to another model for. */
const ROTATABLE_CODES = new Set([
  'QUOTA_EXCEEDED',
  'RATE_LIMIT',
  'RATE_LIMITED',
  'MISSING_CREDENTIAL',
  'AUTH',
  'PERMISSION_DENIED',
  'QUEUE',
])

/**
 * Whether a failure means "this route is exhausted", not "the task is wrong".
 * @param failure - the `LlmFailure` carried by a failed request.
 * @returns whether rotation should try the next route.
 */
export function isRotatableFailure(failure) {
  if (failure === undefined || failure === null) return false
  if (typeof failure.code === 'string' && ROTATABLE_CODES.has(failure.code)) return true
  if (failure.status === 401 || failure.status === 402 || failure.status === 403) return true
  if (failure.status === 429) return true
  return false
}

/**
 * Stable identity for one provider/model pair.
 * @param route - exact route.
 * @returns opaque key.
 */
function keyOf(route) {
  return `${route.provider}\u0000${route.model}`
}

/**
 * Track which route one child is currently on.
 *
 * A cursor per agent rather than a shared counter: two concurrent subagents must
 * not consume each other's place in the queue. Rotation is monotonic — the queue
 * is walked forward and never wrapped, so a badly-behaved provider cannot cause
 * an infinite rebound between two failing models.
 */
export class RouteCursor {
  /** @type {Map<string, number>} */
  #positions = new Map()

  /** @type {ReadonlyArray<{provider: string, model: string}>} */
  #routes

  /** @type {(message: string) => void} */
  #log

  /**
   * @param routes - the ordered queue.
   * @param log - diagnostic sink.
   */
  constructor(routes, log) {
    this.#routes = routes
    this.#log = log
  }

  /** Replace the queue, keeping each child's place when it is still valid. */
  replace(routes) {
    const previous = this.#routes
    this.#routes = routes
    const keys = new Set(routes.map(keyOf))
    for (const [agentId, position] of this.#positions) {
      const route = previous[position]
      if (route === undefined || !keys.has(keyOf(route))) this.#positions.delete(agentId)
    }
  }

  /** The queue in order. */
  get routes() {
    return this.#routes
  }

  /**
   * Route a child is currently on.
   * @param agentId - the child's session id.
   * @returns the current route, or undefined when the queue is empty.
   */
  current(agentId) {
    if (this.#routes.length === 0) return undefined
    const position = this.#positions.get(agentId) ?? 0
    return this.#routes[Math.min(position, this.#routes.length - 1)]
  }

  /**
   * Move a child to the next route.
   * @param agentId - the child's session id.
   * @param failedRoute - the route that just failed, if known.
   * @returns the next route, or undefined when the queue is exhausted.
   */
  advance(agentId, failedRoute) {
    if (this.#routes.length === 0) return undefined
    let position = this.#positions.get(agentId) ?? 0
    if (failedRoute !== undefined) {
      const failedKey = keyOf(failedRoute)
      const actual = this.#routes.findIndex(route => keyOf(route) === failedKey)
      if (actual >= 0) position = actual
    }
    const next = position + 1
    if (next >= this.#routes.length) {
      this.#log(`route queue exhausted for ${agentId} after ${this.#routes.length} attempt(s)`)
      return undefined
    }
    this.#positions.set(agentId, next)
    return this.#routes[next]
  }

  /** Forget one child. */
  forget(agentId) {
    this.#positions.delete(agentId)
  }
}
