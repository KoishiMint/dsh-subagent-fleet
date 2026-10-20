# dsh-subagent-fleet

> Model queue, automatic failover, and live telemetry for **subagent delegation** in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

**English** · [简体中文](README.zh.md)

Subagents in DSH are powerful but opaque: you cannot see which model a child is
running on, how much it has spent, or what happens when its quota runs out. This
plugin fixes all three.

---

## Acknowledgements

**This plugin exists because of [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model).**

That plugin mounts thirteen account channels — CodeBuddy, WorkBuddy, CodeArts,
Qoder, TRAE, Cline, Loomy, Raccoon, MiniMax, ZCode, Gemini, LobsterAI, and the
anonymous free lane — and exposes dozens of genuinely usable models. Without
that catalog there would be nothing worth load-balancing across.

The problem this plugin solves only becomes visible once a Host serves *many*
routes: DSH's delegation tool will happily keep a subagent pinned to one model
until it dies of a quota error, and the parent agent then silently redoes the
child's work itself. dsh-our-free-model made the supply large; dsh-subagent-fleet
makes the demand side survive it.

Thank you to that project and its maintainers.

---

## What it does

### 1. An ordered model queue with real failover

Pick the models a subagent may use, drag them into priority order, and each
child walks the queue: it starts on the first route and, when a request fails
because *this route* is exhausted, the **same child** continues on the next one —
same context, same tool calls, same progress.

Rotatable failures: quota (`QUOTA_EXCEEDED`), rate limits (`RATE_LIMIT`, HTTP
429), auth (`AUTH`, `MISSING_CREDENTIAL`, 401/402/403), provider queueing
(`QUEUE`), and timeouts.

The queue walks forward and never wraps, so two broken providers cannot bounce a
child between themselves forever. Each child keeps its own position, so
concurrent subagents never consume each other's place.

### 2. A composer strip showing what each child is doing

A compact pill beside the model selector:

```
⧉ 2/21  deepseek-v4.1-flash · buddy   ↑13.09M ↓2.09M
```

Expand it for one row per child, running ones first and tinted deep blue:

```
● 模拟器素材上公平跑分  运行中   deepseek-v4.1-flash · buddy
  515K (↑421K ↓94K)   226 tok/s   命中 97%   缓存 13.57M
```

- **`515K (↑421K ↓94K)`** — total tokens, with the input/output split. Total
  excludes cache reads: those dominate the raw count (often 97%+) and including
  them would hide the real spend.
- **`226 tok/s`** — decode speed, not wall-clock. Wall-clock folds in queueing
  and tool time and makes models incomparable.
- **`命中 97%`** — share of input served from the prompt cache.
- **`缓存 13.57M`** — raw cached volume, reference only.

Finished children keep their numbers: the strip reads the host's projection
checkpoint from disk, so a child that has left memory still reports what it cost.

### 3. Live catalog reconciliation

The plugin keeps the Subagent allowlist equal to the routes the Host can actually
serve. It **never adds a route you did not choose** — it only prunes entries no
provider advertises any more, so a channel that disappears cannot leave a dead
route behind.

---

## Install

```bash
dsh plugin install /path/to/dsh-subagent-fleet
```

Or point `plugin_manager` at the directory. The bundle patch mounts one Host row;
the browser half is declared by `dsh.client`.

After installing, **start a new session**. The delegation tool reads its policy
when a session is composed, so an existing session keeps the parameters it was
built with.

---

## Configure

Edit the inserted row in your profile's `cordis.patch.yml`. A row's `config`
replaces the whole config object, so restate every key you want to keep.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `expand` | `false` | `false` prunes dead routes only; `true` mirrors the entire live catalog (destroys a curated selection) |
| `includeProviders` | `[]` | Read models from these providers only |
| `excludeProviders` | `[]` | Never read these providers |
| `maxRoutes` | `400` | Allowlist cap |
| `providerTimeoutMs` | `8000` | Per-provider catalog budget |
| `debounceMs` | `1200` | Collapse bursts of topology events |
| `minPassIntervalMs` | `15000` | Floor between passes |
| `retryDelaysMs` | `[0, 2000, 6000]` | Boot retries while the settings row settles |
| `respectSettingsEnabled` | `true` | Honour an explicit "off" from the settings page |
| `rotation` | `true` | Automatic failover |
| `defaultRoute` | `first` | `first` / `last` / `inherit` |
| `defaultRouteProvider` | `spawn` | Delegation provider whose child default is adjusted |
| `reportPath` | `''` | Optional JSON status file per pass |

---

## How it works

| Concern | Mechanism |
|---|---|
| Child default route | `SubagentProvider.agentRouteDefaults` on the `spawn` provider |
| Failover | `agent/request-error` returns `{kind:'retry'}`; `agent/request` rewrites the route |
| Route source | `llm.listProviders()` + `llm.listModels()` |
| Child spend | `tokenUsage` projection; checkpoint file for cold children |
| Cache hit | `cacheRead / (cacheRead + uncachedInput)` |
| Speed | `decodeTokens / decodeMs` |
| Panel | `conversation.input.right` slot → `/api/subagent-queue/*` |

Only agents with `origin === 'subagent'` are touched; the top-level Agent keeps
its own model selection.

---

## Tests

```bash
npm test
```

`rotation.test.mjs` covers the queue cursor and failure classification;
`selftest.mjs` drives the reconciler against a fake host context, including
idempotence, curated-selection preservation, dead-route pruning, and the HMR
transaction guard.

---

## Known limits

- **New sessions only.** The delegation tool installs its parameter set during
  composition, so queue changes reach sessions created afterwards.
- **Exhausting every route still fails the child.** The difference is that all
  chosen routes are tried first. A log line names the full attempt chain.
- **Direct children only.** Grandchildren are out of scope; they belong to the
  child's own `subagentCatalog`.
- The composer strip polls every 2s while children run, then backs off to 60s.

---

## License

MIT. See [LICENSE](LICENSE).
