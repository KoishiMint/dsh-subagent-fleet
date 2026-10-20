// Offline exercise of dsh-subagent-fleet with a fake host context.
import { apply } from './index.js'

const routes = []
const listeners = new Map()
const effects = []
const logs = []

const settingsRow = {
  ns: 'subagent-model-selection-settings',
  value: { enabled: false, allowedModels: [] },
  user: {},
}

const llmStub = {
  listProviders: () => [
    { id: 'buddy', name: 'CodeBuddy' },
    { id: 'workbuddy', name: 'WorkBuddy' },
    { id: 'broken', name: 'Broken' },
  ],
  listModels: async provider => {
    if (provider === 'broken') throw new Error('no account logged in')
    if (provider === 'buddy') return [{ id: 'deepseek-v4.1-flash' }, { id: 'kimi-k3' }]
    return [{ id: 'deepseek-v4.1-flash-sg' }]
  },
  // Mimics the catalog path: exact-model resolution is what the settings page
  // additionally requires, and what a provider can fail on per model.
  resolveModelInfo: async (provider, model) => {
    if (provider === 'workbuddy' && model === 'bad-model') throw new Error('adapter returned invalid exact model metadata')
    return { provider, id: model, name: model }
  },
}

const settingsStub = {
  describe: () => [settingsRow],
  update: async (ns, patch) => {
    if (ns !== settingsRow.ns) throw new Error(`unexpected ns ${ns}`)
    if (ambientStore.value) throw new Error('HMR transactions cannot be nested')
    settingsRow.value = { ...settingsRow.value, ...patch }
    settingsRow.user = { ...settingsRow.user, ...patch }
    logs.push(`write: ${patch.allowedModels.length} routes`)
  },
}

// Mimics dsh-hmr's AsyncLocalStorage guard: a write is refused while a
// transaction is ambient, allowed once the plugin steps out of it. The store
// starts set, which is the situation of a timer created during plugin load.
const ambientStore = { value: true }
const hmrStub = {
  executing: {
    getStore: () => ambientStore.value,
    exit: async callback => {
      const previous = ambientStore.value
      ambientStore.value = undefined
      try { return await callback() } finally { ambientStore.value = previous }
    },
  },
}

// The delegation provider's child default must follow the first selected model,
// which is what stops a subagent from silently inheriting the parent route.
const spawnProvider = { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true }, inheritsParentContext: false }
const subagentsStub = { getProvider: name => (name === 'spawn' ? spawnProvider : undefined) }

const ctx = {
  logger: {
    info: message => logs.push(`info: ${message}`),
    warn: message => logs.push(`warn: ${message}`),
  },
  get: service => {
    if (service === 'settings') return settingsStub
    if (service === 'llm') return llmStub
    if (service === 'hmr') return hmrStub
    if (service === 'subagents') return subagentsStub
    return undefined
  },
  on: (event, handler) => {
    listeners.set(event, handler)
    return () => listeners.delete(event)
  },
  effect: (factory, label) => {
    effects.push({ label, dispose: factory() })
    return () => {}
  },
  // The production Host provides `inject`; the queue API registers through it.
  inject: (services, callback) => {
    callback({ ...ctx, webServer: { register: () => () => {} } })
    return () => {}
  },
  get agents() {
    return { list: () => [] }
  },
}

apply(ctx, {
  enabled: true,
  debounceMs: 10,
  minPassIntervalMs: 0,
  retryDelaysMs: [0],
  providerTimeoutMs: 500,
  reportPath: process.env.REPORT_PATH ?? '',
})

async function settle(ms) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

await settle(1900)
console.log('--- first pass (boot) ---')
for (const line of logs) console.log(line)
console.log('stored:', JSON.stringify(settingsRow.value))

logs.length = 0
// A second topology announcement with the same catalog must not write again.
listeners.get('llm/adapters-updated')?.()
await settle(400)
console.log('--- second pass (idempotence) ---')
console.log(logs.filter(line => line.startsWith('write')).join('\n') || '(no write)')
console.log('routes:', settingsRow.value.allowedModels.map(route => `${route.provider}/${route.model}`).join(', '))

// A new route appears: the stored allowlist must grow to include it.
const original = llmStub.listModels
llmStub.listModels = async provider => {
  const base = await original(provider)
  return provider === 'workbuddy' ? [...base, { id: 'glm-5.3-flash' }] : base
}
logs.length = 0
listeners.get('llm/adapters-updated')?.()
await settle(400)
console.log('--- third pass (new route) ---')
console.log(logs.join('\n'))
console.log('routes:', settingsRow.value.allowedModels.map(route => `${route.provider}/${route.model}`).join(', '))

// A curated selection must survive a topology change untouched: the plugin
// prunes dead routes but never adds one the operator did not choose.
settingsRow.value = {
  enabled: true,
  allowedModels: [{ provider: 'buddy', model: 'kimi-k3' }],
}
settingsRow.user = { enabled: true }
logs.length = 0
listeners.get('llm/adapters-updated')?.()
await settle(400)
console.log('--- curated selection is preserved ---')
console.log(logs.join('\n') || '(no write)')
console.log('routes:', settingsRow.value.allowedModels.map(route => `${route.provider}/${route.model}`).join(', '))

// A route the operator chose that the Host no longer serves gets pruned.
settingsRow.value = {
  enabled: true,
  allowedModels: [
    { provider: 'buddy', model: 'kimi-k3' },
    { provider: 'gone', model: 'ghost-model' },
  ],
}
logs.length = 0
listeners.get('llm/adapters-updated')?.()
await settle(400)
console.log('--- dead route is pruned ---')
console.log(logs.join('\n') || '(no write)')
console.log('routes:', settingsRow.value.allowedModels.map(route => `${route.provider}/${route.model}`).join(', '))

console.log('--- subagent default route ---')
console.log('spawn.agentRouteDefaults =', JSON.stringify(spawnProvider.agentRouteDefaults))

for (const effect of effects) effect.dispose()
