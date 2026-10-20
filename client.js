window.__ModuleLoader__.load({
  id: 'dsh-subagent-fleet',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useEffect, useCallback, useRef, useId } = React
    const h = React.createElement

    const NS = 'settings.subagentQueue'

    const en = {
      title: 'Subagent model queue',
      summary: 'Choose and order the models subagents may use. The first one is tried first; when it runs out of quota or gets rate limited, the next one takes over automatically.',
      loading: 'Loading…',
      loadFailed: 'The queue could not be loaded.',
      retry: 'Retry',
      saveFailed: 'The change was not saved. Your order has been kept so you can retry.',
      empty: 'No model selected yet. Add one from the list below.',
      queueTitle: 'Use order',
      queueHint: 'Drag to reorder. Position 1 is tried first.',
      availableTitle: 'Available models',
      availableHint: 'Click to add to the end of the queue.',
      enabledLabel: 'Let agents choose models for subagents',
      enabledHint: 'When on, subagents start on the first model in the queue instead of inheriting the parent model.',
      remove: 'Remove',
      moveUp: 'Move up',
      moveDown: 'Move down',
      dragHandle: 'Drag to reorder',
      rotationOn: 'Automatic switch-over is on: quota, auth and timeout failures move the child to the next model.',
      rotationOff: 'Automatic switch-over is off.',
      alreadyAdded: 'In queue',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      discard: 'Discard changes',
      dirty: 'Unsaved changes',
      stripTitle: 'Subagents',
      stripHeading: 'Subagents in this session',
      stripSummaryRunning: '{live} running of {total}',
      stripSummaryAll: '{total} total, none running',
      stripCountHint: 'running / total',
      stripNoRoute: 'no model yet',
      childLive: 'running',
      childFinished: 'finished',
      childNoRoute: 'model not chosen yet',
      childIn: 'in',
      childOut: 'out',
      childCache: 'cached',
      childTotalHint: 'Total tokens: input + output, with the ↑ input / ↓ output split',
      childCacheHint: 'Tokens served from the prompt cache',
      childCacheHit: 'hit',
      childCacheHitHint: 'Share of input tokens served from the prompt cache',
      childSpeedHint: 'Decode speed: output tokens per second of generation',
    }

    const zh = {
      title: '子智能体模型队列',
      summary: '选择并排序子智能体可用的模型。第 1 个优先尝试；额度用尽或被限流时，自动切换到下一个。',
      loading: '正在加载…',
      loadFailed: '无法加载队列。',
      retry: '重试',
      saveFailed: '保存失败，顺序已保留，可重试。',
      empty: '还没有选择模型。从下面的列表中添加。',
      queueTitle: '使用顺序',
      queueHint: '拖动调整顺序。第 1 位优先使用。',
      availableTitle: '可选模型',
      availableHint: '点击添加到队列末尾。',
      enabledLabel: '允许 Agent 为子智能体选择模型',
      enabledHint: '开启后，子智能体从队列第一个模型开始，而不是继承父 Agent 的模型。',
      remove: '移除',
      moveUp: '上移',
      moveDown: '下移',
      dragHandle: '拖动排序',
      rotationOn: '自动切换已开启：额度、鉴权、超时失败会切到下一个模型。',
      rotationOff: '自动切换已关闭。',
      alreadyAdded: '已在队列',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      discard: '放弃修改',
      dirty: '有未保存的修改',
      stripTitle: '子智能体',
      stripHeading: '本会话的子智能体',
      stripSummaryRunning: '运行中 {live} 个 / 共 {total} 个',
      stripSummaryAll: '共 {total} 个，当前无运行',
      stripCountHint: '运行中 / 总数',
      stripNoRoute: '尚未选择模型',
      childLive: '运行中',
      childFinished: '已结束',
      childNoRoute: '尚未分配模型',
      childIn: '输入',
      childOut: '输出',
      childCache: '缓存',
      childTotalHint: '总 token：输入 + 输出，括号内为 ↑输入 / ↓输出 明细',
      childCacheHint: '由提示缓存命中、未重新计费的 token',
      childCacheHit: '命中',
      childCacheHitHint: '输入 token 中由提示缓存命中的比例',
      childSpeedHint: '解码速度：每秒生成的输出 token 数',
    }

    const css = `
.sq-root { display: flex; flex-direction: column; gap: 20px; padding: 4px 0 24px; min-width: 0; }
.sq-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.sq-summary { margin: 6px 0 0; font-size: 12.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.sq-notice { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.sq-error { margin: 0; font-size: 12px; color: var(--dsw-alias-state-error-primary); display: flex; align-items: center; gap: 10px; }
.sq-error button { background: none; border: 0; padding: 0; cursor: pointer; color: var(--dsw-alias-brand-primary); font: inherit; }
.sq-section { display: grid; gap: 8px; min-width: 0; }
.sq-heading { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.sq-sub { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.sq-toggle { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 10px 0; }
.sq-toggleText { display: grid; gap: 3px; min-width: 0; }
.sq-toggleLabel { font-size: 13px; color: var(--dsw-alias-label-primary); }
.sq-switch { position: relative; flex: none; width: 40px; height: 22px; border-radius: 11px; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-overlay); cursor: pointer; transition: background 120ms ease; }
.sq-switch[data-on="true"] { background: var(--dsw-alias-brand-primary); border-color: transparent; }
.sq-switch span { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 120ms ease; }
.sq-switch[data-on="true"] span { transform: translateX(18px); }
.sq-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.sq-row { display: grid; grid-template-columns: 22px 26px minmax(0,1fr) auto; align-items: center; gap: 8px; padding: 7px 8px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
.sq-row[data-drag="true"] { border-color: var(--dsw-alias-brand-primary); opacity: 0.6; }
.sq-row[data-over="true"] { border-color: var(--dsw-alias-brand-primary); }
.sq-index { font-variant-numeric: tabular-nums; font-size: 11px; color: var(--dsw-alias-label-secondary); text-align: center; }
.sq-handle { cursor: grab; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1; user-select: none; text-align: center; }
.sq-handle:active { cursor: grabbing; }
.sq-body { min-width: 0; display: grid; gap: 2px; }
.sq-name { font-size: 13px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sq-route { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sq-actions { display: flex; align-items: center; gap: 2px; }
.sq-btn { background: none; border: 0; padding: 3px 6px; border-radius: 6px; cursor: pointer; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; }
.sq-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); }
.sq-btn:disabled { opacity: 0.35; cursor: default; }
.sq-btn[data-danger="true"]:hover { color: var(--dsw-alias-state-error-primary); }
.sq-avail { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; max-height: 300px; overflow: auto; }
.sq-add { width: 100%; display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 10px; padding: 6px 8px; border: 0; border-radius: 8px; background: none; cursor: pointer; text-align: left; font: inherit; }
.sq-add:hover:not(:disabled) { background: var(--dsw-alias-bg-overlay); }
.sq-add:disabled { opacity: 0.45; cursor: default; }
.sq-addTag { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.sq-provider { font-size: 11px; font-weight: 500; color: var(--dsw-alias-label-secondary); padding: 8px 6px 2px; }
.sq-footer { display: flex; align-items: center; gap: 10px; padding-top: 4px; }
.sq-primary { border: 0.5px solid transparent; border-radius: 8px; padding: 6px 14px; font: inherit; font-size: 12.5px; cursor: pointer; background: var(--dsw-alias-brand-primary); color: #fff; }
.sq-primary:disabled { opacity: 0.4; cursor: default; }
.sq-ghost { border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 6px 14px; font: inherit; font-size: 12.5px; cursor: pointer; background: none; color: var(--dsw-alias-label-primary); }
.sq-ghost:disabled { opacity: 0.4; cursor: default; }
.sq-dirty { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }

/* Composer strip: sits beside the model selector, same height as a pill. */
.sq-strip { position: relative; display: inline-flex; }
.sq-stripButton { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 8px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: none; cursor: pointer; font: inherit; font-size: 11.5px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.sq-stripButton:hover { background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); }
.sq-stripButton[data-live="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.sq-stripIcon { font-size: 10px; opacity: 0.8; }
.sq-stripCount { font-variant-numeric: tabular-nums; font-weight: 600; }
.sq-stripModel { max-width: 190px; overflow: hidden; text-overflow: ellipsis; }
.sq-stripTokens { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); }
.sq-popover { position: absolute; bottom: calc(100% + 6px); right: 0; z-index: 40; width: 400px; padding: 10px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-2); box-shadow: 0 6px 20px rgb(0 0 0 / 18%); }
.sq-popoverHead { font-size: 11.5px; font-weight: 600; color: var(--dsw-alias-label-secondary); padding: 0 2px 6px; }
.sq-childList { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; max-height: 260px; overflow: auto; }
.sq-child { padding: 6px 4px; border-radius: 6px; }
.sq-child + .sq-child { border-top: 0.5px solid var(--dsw-alias-border-l1); }
/* A running child is marked with a deep, explicit blue rather than the brand
   token: on the light theme the token resolves to a near-black accent, so the
   dot and label read as grey and the row never looked "blue". The literal
   colour is also what makes the highlight survive a token change. */
.sq-child[data-live="true"] { background: rgba(37, 99, 235, 0.08); }
.sq-childHead { display: flex; align-items: center; gap: 6px; min-width: 0; }
.sq-childDot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: #9ca3af; }
.sq-childDot[data-live="true"] { background: #1d4ed8; box-shadow: 0 0 0 3px rgba(29, 78, 216, 0.16); }
.sq-childState { flex: none; font-size: 10px; padding: 0 5px; line-height: 15px; border-radius: 8px; color: #1d4ed8; background: rgba(29, 78, 216, 0.12); font-weight: 500; }
.sq-childLabel { flex: 1; min-width: 0; font-size: 12px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sq-child[data-live="true"] .sq-childLabel { color: #1d4ed8; font-weight: 600; }
.sq-childRoute { flex: none; max-width: 175px; font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sq-child[data-live="true"] .sq-childRoute { color: #3b6fe0; }
.sq-childUsage { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding: 3px 0 0 12px; font-size: 10.5px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); }
/* The headline number of the row: total tokens with its ↑/↓ breakdown. */
.sq-metric { padding: 0 5px; border-radius: 4px; background: rgba(0, 0, 0, 0.045); white-space: nowrap; }
.sq-metricTotal { font-weight: 600; color: var(--dsw-alias-label-primary); }
.sq-child[data-live="true"] .sq-metric { background: rgba(29, 78, 216, 0.10); color: #1d4ed8; }
.sq-child[data-live="true"] .sq-metricTotal { color: #1d4ed8; }
.sq-child[data-live="true"] .sq-childUsage { color: #3b6fe0; }
`

    /** Stable identity for one route, matching the Host's own key. */
    const keyOf = route => `${route.provider}\u0000${route.model}`

    /**
     * One draggable row. HTML5 drag events are enough here: the list is short,
     * and it keeps the panel free of any drag library.
     * @param props - row data and callbacks.
     * @returns the row.
     */
    function QueueRow(props) {
      const { route, index, total, name, onMove, onRemove, dragState } = props
      const [dragging, setDragging] = useState(false)
      const [over, setOver] = useState(false)
      const key = keyOf(route)
      return h('li', {
        className: 'sq-row',
        draggable: true,
        'data-drag': String(dragging),
        'data-over': String(over),
        onDragStart: event => {
          setDragging(true)
          dragState.current = key
          event.dataTransfer.effectAllowed = 'move'
          // Firefox needs data set for the drag to start at all.
          event.dataTransfer.setData('text/plain', key)
        },
        onDragEnd: () => { setDragging(false); dragState.current = null },
        onDragOver: event => {
          if (dragState.current === null || dragState.current === key) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setOver(true)
        },
        onDragLeave: () => setOver(false),
        onDrop: event => {
          event.preventDefault()
          setOver(false)
          const from = dragState.current
          dragState.current = null
          if (from !== null && from !== key) onMove(from, key)
        },
      },
      h('span', { className: 'sq-index', children: index + 1 }),
      h('span', { className: 'sq-handle', title: props.t('dragHandle'), 'aria-hidden': 'true', children: '⠿' }),
      h('span', { className: 'sq-body' },
        h('span', { className: 'sq-name', title: name, children: name }),
        h('span', { className: 'sq-route', children: `${route.provider} / ${route.model}` }),
      ),
      h('span', { className: 'sq-actions' },
        h('button', {
          type: 'button',
          className: 'sq-btn',
          title: props.t('moveUp'),
          'aria-label': props.t('moveUp'),
          disabled: index === 0,
          onClick: () => onMove(key, keyOf({ provider: route.provider, model: route.model }), -1),
          children: '↑',
        }),
        h('button', {
          type: 'button',
          className: 'sq-btn',
          title: props.t('moveDown'),
          'aria-label': props.t('moveDown'),
          disabled: index === total - 1,
          onClick: () => onMove(key, key, 1),
          children: '↓',
        }),
        h('button', {
          type: 'button',
          className: 'sq-btn',
          'data-danger': 'true',
          title: props.t('remove'),
          'aria-label': props.t('remove'),
          onClick: () => onRemove(key),
          children: '✕',
        }),
      ))
    }

    /**
     * The settings page.
     * @param props - standard slot props; only the locale reader is used.
     * @returns the queue editor.
     */
    function SubagentQueuePage(props) {
      const t = props.t ?? (key => en[key] ?? key)
      const headingId = useId()
      const dragState = useRef(null)

      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [routes, setRoutes] = useState([])
      const [enabled, setEnabled] = useState(false)
      const [dirty, setDirty] = useState(false)
      const [saving, setSaving] = useState(false)
      const [saveError, setSaveError] = useState('')

      const load = useCallback(async () => {
        setError('')
        try {
          const response = await fetch('/api/subagent-queue/state', { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const value = await response.json()
          setState(value)
          setRoutes(value.routes ?? [])
          setEnabled(value.enabled === true)
          setDirty(false)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      useEffect(() => { void load() }, [load])

      /** Model display names, resolved from the live catalog when possible. */
      const nameOf = useCallback(route => {
        const info = state?.names?.[`${route.provider}\u0000${route.model}`]
        return info ?? route.model
      }, [state])

      const move = useCallback((fromKey, toKey, offset) => {
        setRoutes(current => {
          const next = [...current]
          const from = next.findIndex(route => keyOf(route) === fromKey)
          if (from < 0) return current
          let to
          if (typeof offset === 'number') {
            to = from + offset
          } else {
            to = next.findIndex(route => keyOf(route) === toKey)
          }
          if (to < 0 || to >= next.length) return current
          const [moved] = next.splice(from, 1)
          next.splice(to, 0, moved)
          return next
        })
        setDirty(true)
        setSaveError('')
      }, [])

      const remove = useCallback(key => {
        setRoutes(current => current.filter(route => keyOf(route) !== key))
        setDirty(true)
        setSaveError('')
      }, [])

      const add = useCallback(route => {
        setRoutes(current => current.some(entry => keyOf(entry) === keyOf(route)) ? current : [...current, route])
        setDirty(true)
        setSaveError('')
      }, [])

      const save = useCallback(async () => {
        setSaving(true)
        setSaveError('')
        try {
          const response = await fetch('/api/subagent-queue/queue', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ routes, enabled }),
          })
          const value = await response.json()
          if (!response.ok) throw new Error(value?.error ?? `HTTP ${response.status}`)
          setState(current => ({ ...current, ...value, providers: current?.providers ?? [] }))
          setDirty(false)
        } catch (failure) {
          setSaveError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setSaving(false)
        }
      }, [routes, enabled])

      const toggleEnabled = useCallback(() => {
        setEnabled(current => !current)
        setDirty(true)
        setSaveError('')
      }, [])

      if (error !== '') {
        return h('div', { className: 'sq-root' },
          h('p', { className: 'sq-error' },
            t('loadFailed'),
            h('button', { type: 'button', onClick: () => void load(), children: t('retry') }),
          ),
        )
      }

      if (state === null) {
        return h('div', { className: 'sq-root' }, h('p', { className: 'sq-notice', children: t('loading') }))
      }

      const inQueue = new Set(routes.map(keyOf))
      const providerNames = new Map((state.providers ?? []).map(provider => [provider.id, provider.name]))
      // Group the catalog by provider so the add list reads like the picker.
      const groups = new Map()
      for (const [key, modelName] of Object.entries(state.names ?? {})) {
        const [provider, model] = key.split('\u0000')
        if (inQueue.has(key)) continue
        if (!groups.has(provider)) groups.set(provider, [])
        groups.get(provider).push({ provider, model, name: modelName })
      }

      return h('div', { className: 'sq-root' },
        h('div', {},
          h('h2', { className: 'sq-title', id: headingId, children: t('title') }),
          h('p', { className: 'sq-summary', children: t('summary') }),
        ),

        h('div', { className: 'sq-toggle' },
          h('span', { className: 'sq-toggleText' },
            h('span', { className: 'sq-toggleLabel', children: t('enabledLabel') }),
            h('span', { className: 'sq-sub', children: t('enabledHint') }),
          ),
          h('button', {
            type: 'button',
            className: 'sq-switch',
            role: 'switch',
            'aria-checked': String(enabled),
            'data-on': String(enabled),
            disabled: saving,
            onClick: toggleEnabled,
            children: h('span'),
          }),
        ),

        h('p', { className: 'sq-notice', children: state.rotation === false ? t('rotationOff') : t('rotationOn') }),

        h('div', { className: 'sq-section' },
          h('h3', { className: 'sq-heading', children: t('queueTitle') }),
          h('p', { className: 'sq-sub', children: t('queueHint') }),
          routes.length === 0
            ? h('p', { className: 'sq-notice', children: t('empty') })
            : h('ul', { className: 'sq-list' },
              routes.map((route, index) => h(QueueRow, {
                key: keyOf(route),
                route,
                index,
                total: routes.length,
                name: nameOf(route),
                onMove: move,
                onRemove: remove,
                dragState,
                t,
              }))),
        ),

        h('div', { className: 'sq-section' },
          h('h3', { className: 'sq-heading', children: t('availableTitle') }),
          h('p', { className: 'sq-sub', children: t('availableHint') }),
          h('ul', { className: 'sq-avail' },
            [...groups].map(([provider, models]) => h('li', { key: provider },
              h('div', { className: 'sq-provider', children: providerNames.get(provider) ?? provider }),
              models.map(model => h('button', {
                key: `${provider}\u0000${model.model}`,
                type: 'button',
                className: 'sq-add',
                onClick: () => add({ provider: model.provider, model: model.model }),
                children: [
                  h('span', { className: 'sq-name', key: 'n', children: model.name }),
                  h('span', { className: 'sq-addTag', key: 'a', children: '+' }),
                ],
              })),
            )),
          ),
        ),

        saveError === ''
          ? null
          : h('p', { className: 'sq-error', children: `${t('saveFailed')} (${saveError})` }),

        h('div', { className: 'sq-footer' },
          h('button', {
            type: 'button',
            className: 'sq-primary',
            disabled: saving || !dirty,
            onClick: () => void save(),
            children: saving ? t('saving') : t('save'),
          }),
          h('button', {
            type: 'button',
            className: 'sq-ghost',
            disabled: saving || !dirty,
            onClick: () => { void load() },
            children: t('discard'),
          }),
          dirty ? h('span', { className: 'sq-dirty', children: t('dirty') }) : null,
        ),
      )
    }

    /**
     * Format a token count the way the composer's own usage meter does: plain
     * below a thousand, then one decimal with a K/M suffix.
     * @param value - raw token count.
     * @returns the compact label.
     */
    function tokens(value) {
      if (!Number.isFinite(value) || value <= 0) return '0'
      if (value < 1000) return String(Math.round(value))
      if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`
      return `${(value / 1_000_000).toFixed(2)}M`
    }

    /**
     * Strip label for a provider route: the model name without its provider
     * prefix, plus which channel it came from.
     * @param provider - provider route id.
     * @param model - model id.
     * @returns the compact label.
     */
    function routeLabel(provider, model) {
      const short = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
      return `${short} · ${provider}`
    }

    /**
     * Format a decode rate for the row.
     * @param value - tokens per second.
     * @returns the compact label, or null when unmeasurable.
     */
    function rate(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
      return value >= 100 ? `${Math.round(value)} tok/s` : `${value.toFixed(1)} tok/s`
    }

    /**
     * Format a cache-hit share as a percentage.
     * @param value - share in 0..1.
     * @returns the label, or null when there is no input to measure.
     */
    function hitRate(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
      return `${Math.round(value * 100)}%`
    }

    /**
     * Order children for display: running ones first, then finished ones.
     *
     * A running subagent must never be buried under finished siblings, which is
     * the usual case once a session has delegated a few times. The sort is
     * stable, so the host's own order survives inside each group.
     * @param children - rows from the host.
     * @returns a new array, running rows first.
     */
    function orderChildren(children) {
      const running = []
      const finished = []
      for (const child of children) {
        if (child?.live === true) running.push(child)
        else finished.push(child)
      }
      return [...running, ...finished]
    }

    /**
     * One row in the strip's popover.
     *
     * A running child is tinted deep blue across its label, route and counters,
     * so "still working" reads at a glance without relying on the small dot
     * alone. A finished child stays on the neutral label colour.
     * @param props - child row and locale reader.
     * @returns the row.
     */
    function ChildRow(props) {
      const { child, t } = props
      const running = child.live === true
      const tokensIn = child.usage?.inputTokens ?? 0
      const tokensOut = child.usage?.outputTokens ?? 0
      const cache = child.usage?.cacheReadTokens ?? 0
      // Total is what the row is judged on; the ↑/↓ split is the detail.
      const total = tokensIn + tokensOut
      const speed = rate(child.tokensPerSecond)
      const hit = hitRate(child.cacheHitRate)
      return h('li', { className: 'sq-child', 'data-live': String(running) },
        h('div', { className: 'sq-childHead' },
          h('span', {
            className: 'sq-childDot',
            'data-live': String(running),
            title: t(running ? 'childLive' : 'childFinished'),
          }),
          h('span', { className: 'sq-childLabel', children: child.label || child.id.slice(0, 8) }),
          running
            ? h('span', { className: 'sq-childState', children: t('childLive') })
            : null,
          child.provider === undefined
            ? h('span', { className: 'sq-childRoute', children: t('childNoRoute') })
            : h('span', {
              className: 'sq-childRoute',
              title: `${child.provider} / ${child.model}`,
              children: routeLabel(child.provider, child.model),
            }),
        ),
        // Order matters: total spend first (the headline), then speed, then the
        // cache figures — hit rate next to the total because it explains the
        // bill, and the raw cached volume last, as reference only.
        h('div', { className: 'sq-childUsage' },
          total > 0
            ? h('span', {
              className: 'sq-metric sq-metricTotal',
              title: t('childTotalHint'),
              children: `${tokens(total)} (↑${tokens(tokensIn)} ↓${tokens(tokensOut)})`,
            })
            : null,
          speed !== null
            ? h('span', { className: 'sq-metric', title: t('childSpeedHint'), children: speed })
            : null,
          hit !== null
            ? h('span', { className: 'sq-metric', title: t('childCacheHitHint'), children: `${t('childCacheHit')} ${hit}` })
            : null,
          cache > 0
            ? h('span', { className: 'sq-metric', title: t('childCacheHint'), children: `${t('childCache')} ${tokens(cache)}` })
            : null,
        ),
      )
    }

    /**
     * Composer strip: compact summary of live subagents, expanding to per-child
     * detail. Polls the host only while something is running.
     * @param props - slot props; `sessionId` names the parent session.
     * @returns the strip, or null when the session has no children.
     */
    function SubagentStrip(props) {
      const { t, sessionId } = props
      const [children, setChildren] = useState([])
      const [open, setOpen] = useState(false)
      const [failed, setFailed] = useState(false)
      const rootRef = useRef(null)
      const panelRef = useRef(null)

      useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
        let cancelled = false
        let timer
        let ticks = 0

        const load = async () => {
          try {
            const response = await fetch(
              `/api/subagent-queue/children?session=${encodeURIComponent(sessionId)}`,
              { headers: { accept: 'application/json' } },
            )
            if (!response.ok) throw new Error(String(response.status))
            const value = await response.json()
            if (cancelled) return
            setChildren(Array.isArray(value.children) ? value.children : [])
            setFailed(false)
          } catch {
            if (!cancelled) setFailed(true)
          }
          if (cancelled) return
          ticks += 1
          // Poll briskly while children run, then back off so an idle session
          // costs one request a minute instead of one every two seconds.
          const live = children.some(child => child.live === true)
          const delay = live || ticks < 3 ? 2000 : 60000
          timer = setTimeout(() => { void load() }, delay)
        }

        void load()
        return () => {
          cancelled = true
          if (timer !== undefined) clearTimeout(timer)
        }
      }, [sessionId])

      // Dismiss on any pointer press outside the panel, and on Escape. The
      // strip button is excluded because its own onClick owns the toggle —
      // closing here too would make one press close and reopen it.
      useEffect(() => {
        if (!open) return undefined
        const closes = target => {
          if (!(target instanceof Node)) return true
          if (panelRef.current?.contains(target) === true) return false
          if (rootRef.current?.contains(target) === true) return false
          return true
        }
        const onPointerDown = event => {
          if (closes(event.target)) setOpen(false)
        }
        const onKeyDown = event => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          setOpen(false)
        }
        // Capture phase, so a descendant that stops propagation cannot trap the
        // panel open, and `pointerdown` so it reacts before the page's own click
        // handlers run.
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])

      if (failed || children.length === 0) return null

      const live = children.filter(child => child.live === true)
      // Running children first, so an active subagent is never buried under a
      // finished one.
      const ordered = orderChildren(children)
      const totalIn = children.reduce((sum, child) => sum + (child.usage?.inputTokens ?? 0), 0)
      const totalOut = children.reduce((sum, child) => sum + (child.usage?.outputTokens ?? 0), 0)
      const active = live.length > 0 ? live[0] : children[children.length - 1]
      const summary = active.provider === undefined
        ? t('stripNoRoute')
        : routeLabel(active.provider, active.model)
      // Always "running/total", so the number can never be mistaken for the
      // total: a session with 21 finished delegations reads "0/21", and one
      // with 2 running out of 3 reads "2/3".
      const countLabel = `${live.length}/${children.length}`

      return h('div', { className: 'sq-strip', ref: rootRef },
        h('button', {
          type: 'button',
          className: 'sq-stripButton',
          'data-live': String(live.length > 0),
          title: `${t('stripTitle')} · ${t('stripCountHint')} ${countLabel}`,
          'aria-label': `${t('stripTitle')} ${countLabel}`,
          'aria-expanded': String(open),
          onClick: () => setOpen(current => !current),
        },
          h('span', { className: 'sq-stripIcon', 'aria-hidden': 'true', children: '⧉' }),
          h('span', { className: 'sq-stripCount', children: countLabel }),
          h('span', { className: 'sq-stripModel', children: summary }),
          h('span', { className: 'sq-stripTokens', children: `↑${tokens(totalIn)} ↓${tokens(totalOut)}` }),
        ),
        open
          ? h('div', {
            className: 'sq-popover',
            role: 'dialog',
            'aria-label': t('stripTitle'),
            ref: panelRef,
          },
            h('div', { className: 'sq-popoverHead' },
              h('span', { children: t('stripHeading') }),
              h('span', {
                className: 'sq-popoverCount',
                children: live.length > 0
                  ? t('stripSummaryRunning').replace('{live}', String(live.length)).replace('{total}', String(children.length))
                  : t('stripSummaryAll').replace('{total}', String(children.length)),
              }),
            ),
            h('ul', { className: 'sq-childList' },
              ordered.map(child => h(ChildRow, { key: child.id, child, t }))),
          )
          : null,
      )
    }

    /**
     * Mount the queue page.
     * @param ctx - browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'subagent-queue: dictionaries')
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        // Replace any style tag a previous generation left behind. Skipping
        // when one already exists is what made an edited stylesheet invisible
        // until the whole app restarted: the old tag stays, the new CSS never
        // lands, and the UI keeps rendering with stale rules.
        const selector = 'style[data-plugin="dsh-subagent-fleet"]'
        for (const stale of document.querySelectorAll(selector)) stale.remove()
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-subagent-fleet'
        tag.dataset.pluginCss = 'dsh-subagent-fleet/queue.css'
        tag.textContent = css
        document.head.appendChild(tag)
        return () => { tag.remove() }
      }, 'subagent-queue: styles')

      const Page = props => h(SubagentQueuePage, { ...props, t })

      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'subagent-queue',
        order: 25,
        label: () => t('title'),
        locale: NS,
      }, Page)), 'subagent-queue: settings page')

      // Composer strip: the slot hands the parent session id to the component,
      // so the row can name the model a child is actually running on.
      const Strip = props => h(SubagentStrip, {
        ...props,
        t,
        sessionId: props.sessionId,
      })
      ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'subagent-strip',
        order: 5,
        locale: NS,
      }, Strip)), 'subagent-queue: composer strip')
    }

    /** Required services; the fiber stays inactive until all of them exist. */
    const inject = ['slots', 'locale']

    exports.apply = apply
    exports.inject = inject
    exports.NS = NS
    exports.name = 'dsh-subagent-fleet'
    // Pure helpers, so the offline test exercises the real ordering and
    // formatting instead of a replica that can drift.
    exports.__test = { orderChildren, tokens, routeLabel, rate, hitRate }
    return module.exports
  },
})
