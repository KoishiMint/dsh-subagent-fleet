/**
 * `dsh-subagent-fleet` — give subagent delegation a usable model queue.
 *
 * Why this exists
 * ---------------
 * The shipped delegation tool (`@deepseek-ai/dsh-tool-subagent`) only puts
 * `provider` / `model` / `reasoning_effort` on its schema for a Session that
 * carries a `subagent/model-selection-policy` decision, and that decision is
 * written once, at composition time, from the `subagent-model-selection-settings`
 * row: `{ enabled, allowedModels }`. Nothing refreshes it afterwards, so the set
 * picked by hand in the Subagent settings page is the set every later Session
 * starts with — and a route that was not on that list (any of the third-party
 * channel models `dsh-our-free-model` mounts: buddy, workbuddy, codearts, qoder,
 * trae, …) can never be selected for a child, even while the parent Agent can
 * use that same route perfectly well.
 *
 * Two behaviours on top of that
 * -----------------------------
 * 1. **The selection is the user's.** The plugin never adds a route the user did
 *    not choose; it only prunes entries no provider serves any more, so a
 *    channel that disappears cannot leave a dead route behind.
 * 2. **The selection is an ordered queue.** A child starts on the first chosen
 *    model and, when a request fails because that route is exhausted (quota,
 *    rate limit, missing credential), moves to the next one instead of failing
 *    the task. See `./rotation.js`.
 *
 * What it deliberately does not do
 * --------------------------------
 * It never invents routes: only `llm.listProviders()` + `llm.listModels()`
 * output is considered. A provider that fails or times out is skipped rather
 * than guessed at. It also does not rewrite an already-composed Session — the
 * tool installs its parameter set during composition, so the change reaches
 * Sessions created *after* the write, exactly like the settings page's own
 * "applies only to new sessions" note.
 *
 * @module dsh-subagent-fleet
 */

import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createQueueApi } from './api.js'
import { RouteCursor, isRotatableFailure } from './rotation.js'
import { describeChildren } from './usage.js'

const name = 'dsh-subagent-fleet'

/** The settings row the delegation tool reads its route policy from. */
const SETTINGS_NS = 'subagent-model-selection-settings'

/** Defaults for every operator-supplied option; none of them is required. */
const DEFAULTS = {
  maxRoutes: 400,
  providerTimeoutMs: 8000,
  debounceMs: 1200,
  minPassIntervalMs: 15000,
  retryDelaysMs: [0, 2000, 6000],
  bootDelayMs: 1500,
}

/** Marker returned by a timed-out catalog read. */
const TIMED_OUT = Symbol('timed-out')

/**
 * Write failures that are a property of *when* the pass ran, not of what it
 * wanted to write: the config editor refuses to open a config transaction while
 * an HMR transaction is already open, and a concurrent editor may have bumped
 * the form revision. Both clear on their own, so the pass is retried.
 */
const RETRYABLE_WRITE = /HMR transactions cannot be nested|SETTINGS_CONFLICT|Config field .* is not volatile/

/**
 * Read the row config into a fully defaulted shape without a schema dependency.
 * @param raw - the loader row's `config` object.
 * @returns the effective options.
 */
function resolveOptions(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const strings = value =>
    Array.isArray(value) ? value.filter(entry => typeof entry === 'string' && entry.length > 0) : []
  const positive = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
  return {
    enabled: config.enabled !== false,
    // The person curating models owns the list; the plugin only prunes dead
    // routes. `expand: true` opts into the old mirror-the-catalog behaviour.
    expand: config.expand === true,
    includeProviders: strings(config.includeProviders),
    excludeProviders: strings(config.excludeProviders),
    maxRoutes: Math.max(1, Math.floor(positive(config.maxRoutes, DEFAULTS.maxRoutes))),
    providerTimeoutMs: Math.max(100, Math.floor(positive(config.providerTimeoutMs, DEFAULTS.providerTimeoutMs))),
    debounceMs: Math.max(0, Math.floor(positive(config.debounceMs, DEFAULTS.debounceMs))),
    minPassIntervalMs: Math.max(0, Math.floor(
      typeof config.minPassIntervalMs === 'number' && config.minPassIntervalMs >= 0
        ? config.minPassIntervalMs
        : DEFAULTS.minPassIntervalMs,
    )),
    retryDelaysMs: Array.isArray(config.retryDelaysMs)
      ? config.retryDelaysMs.filter(delay => typeof delay === 'number' && delay >= 0)
      : DEFAULTS.retryDelaysMs,
    respectSettingsEnabled: config.respectSettingsEnabled !== false,
    // 'first'  -> the first selected model becomes the subagent default
    // 'last'   -> the last selected model becomes the subagent default
    // 'inherit'-> leave children on the parent's route (upstream behaviour)
    defaultRoute: config.defaultRoute === 'inherit' || config.defaultRoute === 'last'
      ? config.defaultRoute
      : 'first',
    defaultRouteProvider: typeof config.defaultRouteProvider === 'string' && config.defaultRouteProvider.length > 0
      ? config.defaultRouteProvider
      : 'spawn',
    // When true, a child that exhausts its current route moves to the next
    // selected one instead of failing the task.
    rotation: config.rotation !== false,
    reportPath: typeof config.reportPath === 'string' ? config.reportPath : '',
  }
}

/** Stable identity for one provider/model pair, matching the tool's own key. */
function routeKey(route) {
  return `${route.provider}\u0000${route.model}`
}

/**
 * Keep a provider list in registry order while dropping excluded ids.
 * @param providers - live `llm.listProviders()` entries.
 * @param options - resolved plugin options.
 * @returns the providers this plugin may read models from.
 */
function eligibleProviders(providers, options) {
  const excluded = new Set(options.excludeProviders)
  const included = new Set(options.includeProviders)
  return providers.filter(provider =>
    typeof provider?.id === 'string'
    && provider.id.length > 0
    && !excluded.has(provider.id)
    && (included.size === 0 || included.has(provider.id)))
}

/**
 * Await one catalog read, giving up after `timeoutMs` so one slow adapter cannot
 * hold the whole pass. The abandoned promise is left to settle on its own; the
 * channel adapters cache their remote catalog, so a late answer still helps the
 * next pass.
 * @param operation - the pending model list.
 * @param timeoutMs - budget for this read.
 * @returns the models, or `TIMED_OUT`.
 */
async function withTimeout(operation, timeoutMs) {
  let timer
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Collect every exact route the Host currently advertises.
 *
 * Providers are read concurrently under one overall budget: adapters that
 * answer from a warm cache return immediately, and a channel still fetching its
 * remote catalog is skipped rather than serialising the whole pass behind it.
 * @param llm - live LLM registry.
 * @param options - resolved plugin options.
 * @returns exact routes in provider-registry order plus per-provider diagnostics.
 */
async function collectLiveRoutes(llm, options) {
  const providers = eligibleProviders(llm.listProviders(), options)
  const failures = []

  const reads = providers.map(provider =>
    withTimeout(Promise.resolve(llm.listModels(provider.id)), options.providerTimeoutMs)
      .then(models => ({ provider, models }))
      .catch(error => ({
        provider,
        failure: error instanceof Error ? error.message : String(error),
      })))

  const settled = await Promise.all(reads)
  const routes = []
  const names = {}
  const seen = new Set()
  for (const entry of settled) {
    if ('failure' in entry) {
      failures.push(`${entry.provider.id}: ${entry.failure}`)
      continue
    }
    if (entry.models === TIMED_OUT) {
      failures.push(`${entry.provider.id}: catalog read exceeded ${options.providerTimeoutMs}ms`)
      continue
    }
    if (!Array.isArray(entry.models)) {
      failures.push(`${entry.provider.id}: adapter returned no model list`)
      continue
    }
    if (entry.models.length === 0) {
      failures.push(`${entry.provider.id}: advertised no models (logged out, or filtered out)`)
      continue
    }
    for (const model of entry.models) {
      if (typeof model?.id !== 'string' || model.id.length === 0) continue
      const route = { provider: entry.provider.id, model: model.id }
      const key = routeKey(route)
      // The name is what the panel shows; keep it even for a duplicate id so the
      // last adapter to advertise a route wins the label.
      names[key] = typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id
      if (seen.has(key)) continue
      seen.add(key)
      routes.push(route)
      if (routes.length >= options.maxRoutes) break
    }
    if (routes.length >= options.maxRoutes) break
  }
  return { routes, failures, names, providers: providers.map(provider => provider.id) }
}

/**
 * Reproduce the settings page's view of the model catalog.
 *
 * The Subagent settings page renders `remote.session.modelCatalog()`, which for
 * every provider calls `llm.listModels()` and then `llm.resolveModelInfo()` on
 * *each* model, dropping the whole provider group when any single call throws.
 * A provider that lists fine but fails exact-model resolution therefore
 * disappears from that page while still being present in this plugin's
 * allowlist — the exact mismatch behind "the models are allowed but do not show
 * up". This probe records that divergence for the status report.
 * @param llm - live LLM registry.
 * @param options - resolved plugin options.
 * @returns per-provider catalog verdicts.
 */
async function probeCatalog(llm, options) {
  const providers = eligibleProviders(llm.listProviders(), options)
  const verdicts = await Promise.all(providers.map(async provider => {
    try {
      const models = await withTimeout(
        Promise.resolve(llm.listModels(provider.id)),
        options.providerTimeoutMs,
      )
      if (models === TIMED_OUT) return { provider: provider.id, listed: -1, resolved: 0, error: 'listModels timed out' }
      if (!Array.isArray(models)) return { provider: provider.id, listed: -1, resolved: 0, error: 'listModels returned no array' }
      if (models.length === 0) return { provider: provider.id, listed: 0, resolved: 0, error: 'advertised no models' }
      // Resolve sequentially and stop at the first failure: this mirrors
      // `buildModelCatalog`, which abandons the provider on the first throw.
      for (let index = 0; index < models.length; index += 1) {
        const model = models[index]
        try {
          await llm.resolveModelInfo(provider.id, model.id)
        } catch (error) {
          return {
            provider: provider.id,
            listed: models.length,
            resolved: index,
            error: `resolveModelInfo failed on model ${index + 1}/${models.length} "${model.id}": ${error instanceof Error ? error.message : String(error)}`,
          }
        }
      }
      return { provider: provider.id, listed: models.length, resolved: models.length, error: '' }
    } catch (error) {
      return {
        provider: provider.id,
        listed: -1,
        resolved: 0,
        error: `listModels failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }))
  return verdicts
}

/**
 * Read the route list the settings row currently holds, and resolve the exact
 * namespace id this profile serves it under.
 *
 * `user` is the profile-patch override layer, so `user.enabled === false` means
 * a human explicitly switched the feature off, which is distinguishable from
 * the schema default of `false` on a row nobody has edited yet.
 * @param settings - the live `settings` service.
 * @returns the namespace id, the stored routes, the effective flag, whether a
 * human turned it off, and the namespaces that were actually served; plus a
 * diagnostic when the row could not be found.
 */
function readStoredSelection(settings) {
  let descriptors
  try {
    descriptors = settings.describe()
  } catch (error) {
    return { error: `settings.describe() failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!Array.isArray(descriptors)) {
    return { error: 'settings.describe() returned a non-array' }
  }
  // The loader may expose the entry id with or without the root `include:`
  // prefix depending on where the row was inserted, so accept both spellings.
  const descriptor = descriptors.find(entry =>
    entry?.ns === SETTINGS_NS || entry?.ns === `include:${SETTINGS_NS}`)
  if (descriptor === undefined) {
    const served = descriptors.map(entry => entry?.ns).filter(ns => typeof ns === 'string')
    return {
      error: `no "${SETTINGS_NS}" row among ${served.length} settings namespace(s)`,
      served: served.slice(0, 30),
    }
  }
  const value = descriptor.value !== null && typeof descriptor.value === 'object' ? descriptor.value : {}
  const user = descriptor.user !== null && typeof descriptor.user === 'object' ? descriptor.user : {}
  const allowed = Array.isArray(value.allowedModels) ? value.allowedModels : []
  return {
    ns: descriptor.ns,
    enabled: value.enabled === true,
    explicitlyDisabled: user.enabled === false,
    routes: allowed
      .filter(route => typeof route?.provider === 'string' && typeof route?.model === 'string')
      .map(route => ({ provider: route.provider, model: route.model })),
  }
}

/**
 * Reconcile the operator's own selection against what the Host still serves.
 *
 * The person choosing models is the authority: whosever list is in the settings
 * row stays the list. This function never adds a route — it only drops entries
 * no provider advertises any more, so a channel that disappears cannot leave a
 * dead route behind, and it preserves the operator's ordering.
 *
 * `expand` exists for the opposite policy (the plugin owns the list and mirrors
 * the whole live catalog); it is off by default because overwriting a curated
 * selection is destructive.
 * @param stored - routes already in the settings row.
 * @param live - routes the registry advertises now.
 * @param options - resolved plugin options.
 * @returns the desired route list, deduplicated and capped.
 */
function desiredRoutes(stored, live, options) {
  const liveKeys = new Set(live.map(routeKey))
  if (options.expand) {
    const merged = []
    const seen = new Set()
    for (const route of [...stored.filter(entry => liveKeys.has(routeKey(entry))), ...live]) {
      const key = routeKey(route)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(route)
      if (merged.length >= options.maxRoutes) break
    }
    return merged
  }
  // Prune-only: keep the operator's selection and order, drop dead routes.
  const kept = []
  const seen = new Set()
  for (const route of stored) {
    const key = routeKey(route)
    if (seen.has(key) || !liveKeys.has(key)) continue
    seen.add(key)
    kept.push(route)
    if (kept.length >= options.maxRoutes) break
  }
  return kept
}

/** Whether two route lists already agree, order-insensitively. */
function sameRoutes(left, right) {
  if (left.length !== right.length) return false
  const keys = new Set(right.map(routeKey))
  return left.every(route => keys.has(routeKey(route)))
}

/**
 * Point the delegation provider's child defaults at the operator's selection.
 *
 * `dsh-tool-subagent` resolves a child's route, in order, from: the model-facing
 * call arguments, then its own `agentOptions` config, then the provider's
 * `agentRouteDefaults`, and finally the parent's route. Leaving
 * `agentRouteDefaults` unset is what makes a subagent silently inherit the
 * parent's model, no matter what the settings row allows.
 *
 * `SubagentProvider.agentRouteDefaults` is the declared extension point for
 * exactly this default, and the in-process spawn provider does not set it, so
 * the field is ours to provide. It is read when a delegation tool mounts (i.e.
 * per Session composition), so a change lands on the next new Session.
 * @param ctx - plugin context.
 * @param options - resolved plugin options.
 * @param routes - the operator's selected routes.
 * @returns the applied route, or undefined when nothing was applied.
 */
function applyDefaultRoute(ctx, options, routes) {
  if (options.defaultRoute === 'inherit' || routes.length === 0) return undefined
  const subagents = ctx.get('subagents')
  if (subagents === undefined) return undefined
  const provider = subagents.getProvider(options.defaultRouteProvider)
  if (provider === undefined) return undefined
  const route = options.defaultRoute === 'last' ? routes[routes.length - 1] : routes[0]
  const current = provider.agentRouteDefaults
  if (current !== undefined && current.provider === route.provider && current.model === route.model) return route
  // The provider object is the live registry entry; the field is optional on the
  // interface, so assigning it is the documented way to supply a default.
  provider.agentRouteDefaults = Object.freeze({ provider: route.provider, model: route.model })
  return route
}

/**
 * Report that a child has run out of model routes.
 *
 * `Agent` exposes only `id` and `ctx`; there is no plugin-side channel to push a
 * message into a child's inbox (that belongs to the subagent runtime). So the
 * honest report is the log line plus the `reason` the failure itself carries —
 * the child still fails, but with a message that names the whole queue instead
 * of a bare provider error, which is what lets the parent decide not to redo
 * identical work.
 * @param logger - plugin logger.
 * @param agentId - the exhausted child.
 * @param payload - the failed request.
 * @param tried - the queue as a display string.
 */
function reportRotationExhausted(logger, agentId, payload, tried) {
  logger.warn(
    `subagent-live-routes: ${agentId} ran out of model routes; every queued route failed. `
    + `Last failure ${payload.failure.code}: ${payload.failure.message}. Tried in order: ${tried}.`,
  )
}

/**
 * Run a config write outside any ambient HMR transaction.
 * `settings.update()` delegates to the config editor, which serialises the
 * profile-patch write through `hmr.runExclusive()`. That guard rejects a caller
 * which is *already* inside a transaction ("HMR transactions cannot be nested").
 * A timer registered while this plugin was being (re)loaded inherits the
 * installer's transaction through AsyncLocalStorage, so every pass it schedules
 * would be refused. Exiting the store for the duration of the write makes the
 * call indistinguishable from a settings-page edit, which is what it is.
 * @param ctx - plugin context carrying the optional `hmr` service.
 * @param write - the write to perform.
 * @returns the write's result.
 */
async function runOutsideHmr(ctx, write) {
  const hmr = ctx.get('hmr')
  const storage = hmr?.executing
  if (storage === undefined || typeof storage?.exit !== 'function' || typeof storage.getStore !== 'function') {
    return await write()
  }
  if (storage.getStore() === undefined) return await write()
  // `exit` disables the store while the callback runs, so the asynchronous
  // resources the write creates do not inherit the ambient transaction.
  return await storage.exit(write)
}
/**
 * Write a JSON status document so a Host running without an attached terminal
 * still leaves an inspectable trace. Reporting is best effort and never affects
 * the reconcile result.
 * @param path - absolute path, or an empty string to disable reporting.
 * @param report - detached status object.
 */
async function writeReport(path, report) {
  if (typeof path !== 'string' || path.length === 0) return
  try {
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  } catch {
    // A report is a convenience, not a requirement.
  }
}

/**
 * Mount the reconciler.
 * @param ctx - plugin context.
 * @param config - the loader row's `config` object, validated here rather than by a schema.
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  if (!options.enabled) {
    ctx.logger.info('subagent-live-routes: disabled by its config; the Subagent allowlist is left untouched')
    return
  }

  let disposed = false
  let timer
  let inFlight = false
  let pending = false
  let wroteOnce = false
  let attempts = 0
  let writeAttempts = 0
  let lastPassAt = 0
  let lastReport = { at: new Date().toISOString(), reason: 'not started yet' }
  // Model display names from the most recent catalog read, keyed by
  // `provider\0model`, so the queue panel can label routes without its own
  // adapter round-trip.
  let lastCatalogNames = {}

  // The queue the operator selected, shared by every child; each child keeps its
  // own place in it (see RouteCursor).
  const cursor = new RouteCursor([], message => ctx.logger.info(`subagent-live-routes: ${message}`))
  if (options.defaultRoute === 'inherit' && options.rotation === false) {
    ctx.logger.info('subagent-live-routes: defaultRoute=inherit and rotation off; only the allowlist is reconciled')
  }

  /** Debounced reconcile; repeated topology changes collapse into one pass. */
  const schedule = delay => {
    if (disposed) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void reconcile()
    }, delay)
    timer.unref?.()
  }

  /**
   * One reconcile pass: read the live catalog, then write the settings row when
   * its route set would actually change. Retries a few times at boot because the
   * settings row is only describable once the Loader has settled it.
   * @returns resolves after the pass, whether or not anything was written.
   */
  const reconcile = async () => {
    if (disposed || inFlight) {
      pending = true
      return
    }
    inFlight = true
    const report = {
      at: new Date().toISOString(),
      stage: 'start',
      wrote: false,
      reason: '',
      ns: '',
      stored: 0,
      live: 0,
      desired: 0,
      providers: [],
      skipped: [],
    }
    try {
      const llm = ctx.get('llm')
      const settings = ctx.get('settings')
      report.stage = 'services'
      if (llm === undefined || settings === undefined) {
        report.reason = `missing service(s): ${llm === undefined ? 'llm ' : ''}${settings === undefined ? 'settings' : ''}`.trim()
        if (!wroteOnce) ctx.logger.info(`subagent-live-routes: ${report.reason}; the Subagent allowlist is managed elsewhere`)
        return
      }

      report.stage = 'read-settings'
      const stored = readStoredSelection(settings)
      if (stored.ns === undefined) {
        report.reason = stored.error ?? 'the settings row could not be read'
        report.served = stored.served ?? []
        // The row is not composed yet; retry on the configured schedule, then
        // stop quietly instead of reacting to every LLM topology change.
        attempts += 1
        const delay = options.retryDelaysMs[attempts]
        if (delay !== undefined && !disposed) schedule(delay)
        else if (!wroteOnce) ctx.logger.info(`subagent-live-routes: ${report.reason}`)
        return
      }
      report.ns = stored.ns
      report.stored = stored.routes.length
      report.storedEnabled = stored.enabled

      if (options.respectSettingsEnabled && stored.explicitlyDisabled) {
        // A human switched the feature off. Stop reconciling the allowlist, but
        // keep the rotation queue in step with whatever is selected, and keep
        // listening: the settings page can switch it back on at any time and
        // this pass must notice without a restart.
        report.reason = 'switched off on the Subagent settings page'
        cursor.replace(stored.routes)
        wroteOnce = true
        return
      }

      report.stage = 'list-models'
      const live = await collectLiveRoutes(llm, options)
      if (disposed) return
      lastPassAt = Date.now()
      report.live = live.routes.length
      report.providers = [...new Set(live.routes.map(route => route.provider))]
      report.skipped = live.failures
      lastCatalogNames = live.names
      if (live.routes.length === 0) {
        report.reason = 'no provider advertises a model right now'
        ctx.logger.info(`subagent-live-routes: ${report.reason}; keeping the stored allowlist`)
        return
      }

      // Only pay for the (slower) exact-model probe once the allowlist is
      // already right, so the write path stays fast and the diagnostic is
      // always available in the status report.
      report.stage = 'probe-catalog'
      const catalog = await probeCatalog(llm, options)
      report.catalog = catalog
      const broken = catalog.filter(verdict => verdict.error !== '')
      if (broken.length > 0) {
        ctx.logger.info(
          `subagent-live-routes: ${broken.length} provider group(s) will not render on the Subagent settings page: `
          + broken.map(verdict => `${verdict.provider} (${verdict.error})`).join('; '),
        )
      }

      report.stage = 'diff'
      const desired = desiredRoutes(stored.routes, live.routes, options)
      report.desired = desired.length
      // Keep the rotation queue identical to the operator's selection, whatever
      // else this pass decides.
      cursor.replace(desired.length > 0 ? desired : stored.routes)
      // The subagent default follows whatever is selected now, whether or not
      // the allowlist itself needed pruning, so it is applied before the early
      // returns below.
      const defaulted = applyDefaultRoute(ctx, options, cursor.routes)
      if (defaulted !== undefined) report.defaultRoute = `${defaulted.provider}/${defaulted.model}`
      if (desired.length === 0) {
        // An empty result means the operator has not chosen anything yet (or
        // everything they chose has gone away). Writing it back would just
        // restate the emptiness, and it would also flip `enabled` on with no
        // selectable model — which the tool rejects. Leave the row alone.
        report.stage = 'done'
        report.reason = stored.routes.length === 0
          ? 'no models selected yet; waiting for a selection'
          : 'every selected route is gone; left the row untouched for review'
        return
      }
      if (stored.enabled && sameRoutes(stored.routes, desired)) {
        report.stage = 'done'
        report.reason = 'allowlist already current'
        wroteOnce = true
        return
      }

      report.stage = 'write'
      await runOutsideHmr(ctx, () => settings.update(stored.ns, { enabled: true, allowedModels: desired }))
      if (disposed) return
      wroteOnce = true
      writeAttempts = 0
      report.stage = 'done'
      report.wrote = true
      report.reason = 'allowlist updated'
      ctx.logger.info(
        `subagent-live-routes: allowlisted ${desired.length} route(s) (${live.routes.length} live) across `
        + `${report.providers.length} provider(s) for new Subagent delegations`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (report.stage === 'write' && RETRYABLE_WRITE.test(message) && writeAttempts < options.retryDelaysMs.length + 2) {
        // A config transaction could not open right now (an HMR reload or another
        // editor held it). The catalog read already succeeded, so retry the whole
        // pass shortly instead of discarding the result.
        writeAttempts += 1
        report.reason = `write deferred (${message}); retry ${writeAttempts}`
        report.willRetry = true
        if (!disposed) schedule(options.debounceMs * (writeAttempts + 1))
        return
      }
      report.reason = `failed at ${report.stage}: ${message}`
      report.stack = error instanceof Error ? error.stack : undefined
      ctx.logger.warn(`subagent-live-routes: ${report.reason}`)
    } finally {
      inFlight = false
      lastReport = report
      void writeReport(options.reportPath, report)
      if (pending && !disposed) {
        pending = false
        schedule(options.debounceMs)
      }
    }
  }

  // `settings/document-updated` fires whenever the row's form values or
  // revision change, which covers the Subagent settings page saving and this
  // plugin's own queue-panel write. Without it a pass that ended on
  // "switched off" would never notice the switch being turned back on until the
  // next restart.
  ctx.on('settings/document-updated', ns => {
    if (ns !== SETTINGS_NS && ns !== `include:${SETTINGS_NS}`) return
    attempts = 0
    // Short delay: this is a direct response to a user action, not a topology
    // storm, but collapsing an own-write echo still avoids a redundant pass.
    schedule(Math.max(200, options.debounceMs / 2))
  })

  // The adapter registry announces itself after every registration, every
  // `replace`, and every configurable-provider directory change, so this covers
  // plugin mount order, HMR, and a channel plugin activating a route later.
  // A burst of such events is collapsed by the debounce, and a pass is rate
  // limited so a channel that reloads its catalog in a loop cannot make this
  // plugin rewrite the profile patch in the same loop.
  ctx.on('llm/adapters-updated', () => {
    attempts = 0
    const sinceLast = Date.now() - lastPassAt
    const wait = Math.max(options.debounceMs, options.minPassIntervalMs - sinceLast)
    schedule(wait)
  })

  // First pass after boot: give the Loader time to settle the settings row and
  // the adapters time to finish their own mount-time registration.
  schedule(Math.max(options.retryDelaysMs[0] ?? 0, DEFAULTS.bootDelayMs))

  // ── route rotation for delegation children ─────────────────────────────────
  // Registered on each child's own context from `agent/created`, so the state
  // and listeners disappear with that child and the parent Agent is untouched.
  if (options.rotation) {
    const perAgentEffects = new Map()

    const installRotation = agent => {
      if (perAgentEffects.has(agent.id)) return
      // Children only: a top-level Agent keeps its own model selection.
      if (agent.session?.header?.origin !== 'subagent') return
      const scoped = agent.ctx
      if (scoped === undefined) return
      const disposeRequest = scoped.on('agent/request', async (_payload, next) => {
        const resolved = await next()
        const route = cursor.current(agent.id)
        if (route === undefined) return resolved
        if (resolved.provider === route.provider && resolved.model === route.model) return resolved
        // A route change must not carry the previous model's effort over; the
        // new adapter resolves its own default instead.
        const { reasoningEffort: _inherited, ...rest } = resolved
        return { ...rest, provider: route.provider, model: route.model }
      })
      const disposeError = scoped.on('agent/request-error', async (payload, next) => {
        if (!isRotatableFailure(payload.failure)) return next()
        const currentRoute = cursor.current(agent.id)
        const failed = currentRoute === undefined
          ? undefined
          : { provider: currentRoute.provider, model: currentRoute.model }
        const nextRoute = cursor.advance(agent.id, failed)
        if (nextRoute === undefined) {
          // Every selected model is exhausted. Fail with a message that names
          // the whole queue, so the parent Agent (and the human reading the
          // transcript) can see that retrying the same work on the same route
          // would be pointless rather than spending the turn on a blind redo.
          const tried = cursor.routes.map(route => `${route.provider}/${route.model}`).join(', ')
          reportRotationExhausted(ctx.logger, agent.id, payload, tried)
          return next()
        }
        ctx.logger.info(
          `subagent-live-routes: ${agent.id} exhausted ${payload.provider} `
          + `(${payload.failure.code}); rotating to ${nextRoute.provider}/${nextRoute.model}`,
        )
        // Owning recovery: report success so the loop re-issues the request,
        // which the `agent/request` listener above then routes onward.
        return { kind: 'retry' }
      })
      const dispose = () => {
        disposeRequest()
        disposeError()
        cursor.forget(agent.id)
      }
      // Two owners, as the plugin guidance requires: the child's own scope and
      // this plugin's effect both remove the registration.
      const scopedDispose = scoped.effect(() => dispose, 'subagent-live-routes: rotation')
      const pluginDispose = ctx.effect(() => () => scopedDispose(), 'subagent-live-routes: rotation (plugin)')
      perAgentEffects.set(agent.id, () => {
        pluginDispose()
        cursor.forget(agent.id)
      })
    }

    ctx.on('agent/created', payload => {
      try {
        installRotation(payload.agent)
      } catch (error) {
        ctx.logger.warn(`subagent-live-routes: rotation setup failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    ctx.on('agent/disposed', payload => {
      perAgentEffects.get(payload.agent.id)?.()
      perAgentEffects.delete(payload.agent.id)
    })
    // Agents composed before this plugin loaded (an HMR generation swap).
    const agents = ctx.get('agents')
    for (const agent of agents?.list?.() ?? []) {
      try {
        installRotation(agent)
      } catch {
        // A single malformed agent must not stop the rest.
      }
    }
  }

  // ── the queue panel's HTTP surface ─────────────────────────────────────────
  // Registered through `ctx.inject(['webServer'], …)` because plugins load
  // before the browser half publishes that service; reading it once at apply
  // time would answer `undefined` in the real web composition.
  const currentSelection = () => {
    const settings = ctx.get('settings')
    if (settings === undefined) return { enabled: false, routes: [] }
    try {
      const stored = readStoredSelection(settings)
      return { enabled: stored.enabled === true, routes: stored.routes ?? [] }
    } catch {
      return { enabled: false, routes: [] }
    }
  }

  // ── projection checkpoints for finished children ───────────────────────────
  // A child that has ended is gone from `ctx.sessions`, but the host checkpoints
  // its `tokenUsage` row to one file per session. That file is the only place
  // its spend survives, so a small cache reads it on demand and is refreshed
  // lazily. Reads are keyed by session id and bounded; a missing file simply
  // reports no usage instead of failing the request.
  const checkpointCache = new Map()
  const CHECKPOINT_TTL_MS = 15000

  /**
   * Resolve the projection-checkpoint directory from the Host home.
   *
   * Built with `path.join` rather than string concatenation: the cache lives
   * under `storages/session_projcache/sessions`, and hard-coded backslashes
   * would make this a Windows-only plugin.
   * @returns the directory path, or undefined when the home is unknown.
   */
  const checkpointDir = () => {
    const home = process.env.DSH_HOME
      ?? (process.env.USERPROFILE !== undefined
        ? join(process.env.USERPROFILE, '.dsh')
        : process.env.HOME !== undefined ? join(process.env.HOME, '.dsh') : undefined)
    if (home === undefined) return undefined
    return join(home, 'storages', 'session_projcache', 'sessions')
  }

  /**
   * Read one child's persisted checkpoint rows, with a short TTL cache.
   * @param sessionId - the child session id.
   * @returns its checkpoint rows, or undefined when none is on disk.
   */
  const checkpointOfChild = sessionId => {
    const cached = checkpointCache.get(sessionId)
    if (cached !== undefined && Date.now() - cached.at < CHECKPOINT_TTL_MS) return cached.rows
    const dir = checkpointDir()
    if (dir === undefined) return undefined
    // Synchronous by contract: `describeChildren` runs inside a request handler
    // that must answer in one tick, and these files are small.
    try {
      const parsed = JSON.parse(readFileSync(join(dir, `${sessionId}.json`), 'utf8'))
      const rows = parsed?.record?.rows
      checkpointCache.set(sessionId, { at: Date.now(), rows })
      return rows
    } catch {
      checkpointCache.set(sessionId, { at: Date.now(), rows: undefined })
      return undefined
    }
  }

  const queueApi = createQueueApi({
    logger: ctx.logger,
    // Late-bound: the connection service appears after plugins load.
    connection: () => ctx.get('connection'),
    routes: () => currentSelection().routes,
    enabled: () => currentSelection().enabled,
    // The composer strip asks for one parent's children; both services appear
    // after this plugin in some compositions, so they are read per request.
    children: parentId => describeChildren({
      sessions: ctx.get('sessions'),
      projections: ctx.get('sessionProjections'),
      checkpointOf: checkpointOfChild,
    }, parentId),
    state: () => {
      const selection = currentSelection()
      const llm = ctx.get('llm')
      let catalog = []
      if (llm !== undefined) {
        catalog = eligibleProviders(llm.listProviders(), options).map(provider => ({
          id: provider.id,
          name: provider.name,
        }))
      }
      return {
        enabled: selection.enabled,
        routes: selection.routes,
        providers: catalog,
        // Model display names, keyed by the same opaque id the panel uses.
        // Served from the last successful catalog read so the page does not pay
        // for another round of adapter calls on every open.
        names: lastCatalogNames,
        defaultRoute: options.defaultRoute,
        rotation: options.rotation,
        report: lastReport,
      }
    },
    write: async (routes, enabled) => {
      const settings = ctx.get('settings')
      if (settings === undefined) throw new Error('this profile serves no settings service')
      const stored = readStoredSelection(settings)
      if (stored.ns === undefined) throw new Error(stored.error ?? 'the settings row is unavailable')
      const nextEnabled = typeof enabled === 'boolean' ? enabled : stored.enabled
      await runOutsideHmr(ctx, () => settings.update(stored.ns, {
        enabled: nextEnabled,
        allowedModels: routes,
      }))
      cursor.replace(routes)
      const defaulted = applyDefaultRoute(ctx, options, routes)
      return {
        ok: true,
        enabled: nextEnabled,
        routes,
        defaultRoute: defaulted === undefined ? null : `${defaulted.provider}/${defaulted.model}`,
      }
    },
  })

  ctx.inject(['webServer'], scoped => {
    scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: '/api/subagent-queue', handler: queueApi }),
      'subagent-live-routes: queue API',
    )
    ctx.logger.info('subagent-live-routes: queue panel API mounted at /api/subagent-queue')
  })

  ctx.effect(() => () => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    void writeReport(options.reportPath, { ...lastReport, reason: `${lastReport.reason} (plugin disposed)` })
  }, 'subagent-live-routes: reconciler')
}

export { name }
