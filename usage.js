/**
 * Subagent activity snapshot for the composer strip.
 *
 * The delegation catalog records only `childId` / `label` / `mode`; it carries
 * neither the model a child is running on nor what it has spent. Both live on
 * the child's own session:
 *
 * - the route is `session.requestHeader().config`, the frozen configuration of
 *   the latest request — after a rotation it already names the model actually
 *   in use, which is exactly what the strip must show;
 * - the spend is the `tokenUsage` projection, which the host folds for every
 *   session and checkpoints to disk, so a child that has already finished (or
 *   was evicted from memory) still reports what it cost.
 *
 * @module dsh-subagent-fleet/usage
 */

/** The `subagent/catalog` projection key the delegation runtime publishes. */
const CATALOG_KEY = 'subagentCatalog'

/** The host's own token meter projection. */
const USAGE_KEY = 'tokenUsage'

/** The host's turn/step timing projection, which carries decode duration. */
const STATS_KEY = 'sessionStats'

/**
 * Fold one child's throughput and cache-hit figures.
 *
 * Written here rather than in the browser so the two halves cannot disagree
 * about the formula.
 *
 * - **tok/s** is decode speed, not wall-clock speed: `decodeTokens / decodeMs`
 *   is the rate the model produced output once it started streaming, which is
 *   what makes two models comparable. Wall-clock would fold in queueing and
 *   tool time and would make a slow-but-cheap model look worse than it is.
 * - **cache hit** is the share of *input* served from the prompt cache:
 *   `cacheRead / (cacheRead + uncachedInput)`. A high share means the child is
 *   cheap to keep running even though its raw token counts look large.
 * @param usage - normalized token totals, when metered.
 * @param stats - the `sessionStats` state, when present.
 * @returns the measured figures, omitting anything unmeasurable.
 */
function metricsOf(usage, stats) {
  const result = {}
  if (usage !== undefined) {
    const cacheRead = usage.cacheReadTokens
    const billed = cacheRead + usage.inputTokens
    if (billed > 0) result.cacheHitRate = cacheRead / billed
  }
  if (stats !== null && typeof stats === 'object') {
    const decodeMs = Number(stats.decodeMs)
    const decodeTokens = Number(stats.decodeTokens)
    // Guard the denominator: a turn with no streamed output has no meaningful
    // rate, and a near-zero duration would report an absurd number.
    if (Number.isFinite(decodeMs) && decodeMs >= 200 && Number.isFinite(decodeTokens) && decodeTokens > 0) {
      result.tokensPerSecond = decodeTokens / (decodeMs / 1000)
    }
  }
  return result
}

/**
 * Read one session's turn/step statistics.
 * @param projections - the session-projection registry.
 * @param session - the live session, when there is one.
 * @param cachedRows - persisted checkpoint rows, for a cold child.
 * @returns the stats state, or undefined when the unit is absent.
 */
function statsOf(projections, session, cachedRows) {
  if (session !== undefined) {
    try {
      const live = projections.stateOf(session, STATS_KEY)
      if (live !== undefined) return live
    } catch {
      // Fall through to the checkpoint.
    }
  }
  return cachedRows?.[STATS_KEY]?.val
}

/**
 * Read the direct children recorded on one parent session.
 * @param projections - the session-projection registry.
 * @param parent - the parent session.
 * @returns child ids with their display labels, in catalog order.
 */
export function childrenOf(projections, parent) {
  let state
  try {
    state = projections.stateOf(parent, CATALOG_KEY)
  } catch {
    return []
  }
  const values = state?.head?.values ?? state?.values
  if (!Array.isArray(values)) return []
  return values
    .filter(entry => typeof entry?.childId === 'string')
    .map(entry => ({
      id: entry.childId,
      label: typeof entry.label === 'string' ? entry.label : '',
      mode: typeof entry.mode === 'string' ? entry.mode : 'one-shot',
      createdAt: typeof entry.childCreatedAt === 'number' ? entry.childCreatedAt : 0,
    }))
}

/**
 * Read one session's metered usage.
 *
 * The `tokenUsage` unit is checkpointed to disk, so this reads the persisted
 * fold for a session that is no longer resident as well as the live one: a
 * finished child must still report what it cost.
 * @param projections - the session-projection registry.
 * @param session - the live session, when there is one.
 * @param cachedRows - persisted checkpoint rows keyed by unit, for a cold child.
 * @returns normalized totals, or undefined when nothing has been metered yet.
 */
function usageOf(projections, session, cachedRows) {
  let state
  if (session !== undefined) {
    try {
      state = projections.stateOf(session, USAGE_KEY)
    } catch {
      state = undefined
    }
  }
  if (state === undefined) state = cachedRows?.[USAGE_KEY]?.val
  const totals = state?.totals
  if (totals === null || typeof totals !== 'object') return undefined
  const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  const result = {
    inputTokens: number(totals.uncachedInputTokens) || number(totals.inputTokens),
    outputTokens: number(totals.outputTokens),
    cacheReadTokens: number(totals.cacheReadTokens),
    reasoningTokens: number(totals.reasoningTokens),
  }
  if (result.inputTokens + result.outputTokens + result.cacheReadTokens === 0) return undefined
  return result
}

/**
 * Describe every direct child of one parent session.
 *
 * A child that is no longer resident is still listed: its route may be gone but
 * its spend survives in the projection cache, and hiding the row would make a
 * finished delegation look like it never ran.
 * @param deps - live services plus the projection-checkpoint reader.
 * @param parentId - the parent session id.
 * @returns one flat row per child.
 */
export function describeChildren(deps, parentId) {
  const { sessions, projections, checkpointOf } = deps
  if (sessions === undefined || projections === undefined) return []
  const parent = sessions.get(parentId)
  if (parent === undefined) return []
  const rows = []
  for (const child of childrenOf(projections, parent)) {
    const live = sessions.get(child.id)
    let provider
    let model
    if (live !== undefined) {
      const config = live.requestHeader()?.config
      if (config !== undefined) {
        provider = config.provider
        model = config.model
      }
    }
    const cached = live === undefined && checkpointOf !== undefined ? checkpointOf(child.id) : undefined
    const usage = usageOf(projections, live, cached)
    const stats = statsOf(projections, live, cached)
    const metrics = metricsOf(usage, stats)
    rows.push({
      id: child.id,
      label: child.label,
      mode: child.mode,
      live: live !== undefined,
      ...provider === undefined ? {} : { provider, model },
      ...usage === undefined ? {} : { usage },
      ...metrics,
    })
  }
  return rows
}
