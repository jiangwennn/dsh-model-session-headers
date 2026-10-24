/**
 * Client half of dsh-model-session-headers: the rule editor on the DSH
 * plugins page, and the per-conversation send-status badge in the chat header
 * (`conversation.session.header.actions`, polling the host's status route).
 *
 * Facts this file depends on (verified against dsh 0.2.1-rc.2 web):
 *   - the plugins page renders only what a plugin registers under
 *     `plugins.row.config`, keyed `<package>#<row id>`; there is no automatic
 *     form generated from Config;
 *   - shared forms live on `ctx.configForms.get(entryId)`; `mutate()` writes
 *     path ops through the Host's revision fence. `rules` is declared
 *     `volatile` in the host Config, which is what makes `['rules']` a legal
 *     write path;
 *   - the Host passes a live observable for that field, so a saved edit applies
 *     to the next model call without a restart;
 *   - the slot renderer calls a function component outside React's hook
 *     dispatcher (hooks silently render nothing), so this card is a class
 *     component and keeps its state in `this.state`.
 *
 * Loaded by the web client as a lazy CommonJS factory: no bundler needed.
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-session-headers',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    // The badge's popover is portalled to <body>: rendered inside the chat
    // header it is clipped by the sidebar, whose stacking context sits above
    // the conversation pane. Without react-dom it falls back to inline.
    let ReactDOM = null
    try {
      ReactDOM = require('react-dom')
    } catch {
      ReactDOM = null
    }

    const PACKAGE = 'dsh-model-session-headers'
    const ROW_ID = 'model-session-headers'
    const FLAVORS = ['claude-code', 'opencode-go', 'generic']
    const FLAVOR_LABEL = {
      'claude-code': 'claude-code · x-claude-code-session-id',
      'opencode-go': 'opencode-go · x-opencode-session',
      generic: 'generic · x-session-id',
    }
    // Mirror of DEFAULT_RULES in ../index.js (the host applies these when the
    // profile has no `rules`); keep both in sync.
    const DEFAULT_RULES = [
      { models: ['opencode/*', '*/opencode/*'], flavor: 'opencode-go', enabled: true },
      { models: ['claude-*'], flavor: 'claude-code', enabled: true },
    ]

    /** Form controller handed over by apply(); null when the service is absent. */
    let activeForm = null

    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '12px 14px',
        border: '1px solid color-mix(in srgb, currentColor 14%, transparent)',
        borderRadius: '10px',
        fontSize: '13px',
        lineHeight: '1.55',
      },
      header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
      title: { fontWeight: 600 },
      hint: { opacity: 0.72, fontSize: '12px' },
      row: {
        display: 'grid',
        gridTemplateColumns: 'minmax(180px, 1.5fr) minmax(210px, 1.2fr) auto auto',
        gap: '8px',
        alignItems: 'center',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '5px 8px',
        borderRadius: '7px',
        border: '1px solid color-mix(in srgb, currentColor 20%, transparent)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
      },
      select: {
        width: '100%',
        padding: '5px 8px',
        borderRadius: '7px',
        border: '1px solid color-mix(in srgb, currentColor 20%, transparent)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
      },
      button: {
        flex: 'none',
        padding: '4px 10px',
        borderRadius: '7px',
        border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
      },
      // Emphasis derived from the inherited text colour only. `currentColor`
      // resolves against the button's OWN `color`, so pairing it with an
      // inverted text colour (the old `var(--dsh-bg, #fff)`, a variable DSH
      // never defines) painted the button the page colour: invisible yet
      // clickable.
      primary: {
        background: 'color-mix(in srgb, currentColor 14%, transparent)',
        borderColor: 'color-mix(in srgb, currentColor 55%, transparent)',
        fontWeight: 600,
      },
      disabled: { opacity: 0.45, cursor: 'default' },
      danger: { background: 'transparent', border: 'none', color: 'inherit', opacity: 0.65, cursor: 'pointer', fontSize: '12px' },
      toggle: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', opacity: 0.85 },
      badgeRoot: { position: 'relative', display: 'inline-flex' },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '2px 9px',
        borderRadius: '999px',
        border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      },
      dot: { width: '7px', height: '7px', borderRadius: '50%', flex: 'none' },
      popover: {
        position: 'fixed',
        zIndex: 1000,
        width: '380px',
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: '60vh',
        overflowY: 'auto',
        padding: '10px 12px',
        borderRadius: '10px',
        border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
        // Canvas / CanvasText follow the page's color-scheme, so the panel is
        // opaque in both themes without guessing DSH's variable names.
        background: 'Canvas',
        color: 'CanvasText',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
        fontSize: '12px',
        lineHeight: '1.6',
        textAlign: 'left',
      },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' },
      record: { borderTop: '1px solid color-mix(in srgb, currentColor 12%, transparent)', padding: '6px 0' },
      recordTop: { display: 'flex', justifyContent: 'space-between', gap: '8px', opacity: 0.75 },
      tag: { flex: 'none', fontSize: '11px', padding: '0 6px', borderRadius: '4px' },
      meta: { opacity: 0.5, fontSize: '11px' },
      status: { fontSize: '12px', opacity: 0.75 },
      empty: { opacity: 0.65, fontSize: '12px' },
    }

    /** Host route serving the per-conversation status (see STATUS_ROUTE in ../index.js). */
    const STATUS_PATH = 'model-session-headers/api/status'
    const POLL_MS = 3000
    const STATUS_LABEL = { sent: '已发送', skipped: '跳过', unmatched: '未命中规则', empty: '无值' }
    const STATUS_COLOR = { sent: '#2ea043', skipped: '#d29922' }

    /**
     * Resolve the status route against the PAGE base, not the injected transport
     * origin: in the desktop shell the page is `dsh-app://app/` and only that
     * origin is forwarded to the Host same-origin; the Host's `127.0.0.1` origin
     * would be cross-origin and the browser would refuse the response. A relative
     * path also keeps a reverse-proxy directory prefix.
     */
    const statusUrl = (sessionId) => {
      const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : 'http://dsh.internal/'
      const url = new URL(STATUS_PATH, base)
      url.searchParams.set('session', String(sessionId))
      return url.href
    }

    const timeOf = (iso) => {
      const date = new Date(iso)
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour12: false })
    }

    const parseModels = (text) =>
      String(text)
        .split(/[,，\s]+/)
        .map((part) => part.trim())
        .filter(Boolean)

    class Card extends React.Component {
      constructor(props) {
        super(props)
        this.state = { snap: null, draft: null, status: 'idle', message: '' }
        this.read = this.read.bind(this)
        this.handleSave = this.handleSave.bind(this)
        this.handleToggleStatus = this.handleToggleStatus.bind(this)
      }

      /** Saved immediately and independently of the rule draft. */
      async handleToggleStatus(event) {
        if (!activeForm) return
        const checked = event.target.checked
        try {
          const ok = await activeForm.mutate([{ op: 'set', path: ['showStatus'], value: checked }])
          this.setState(ok
            ? { status: 'saved', message: checked ? '已开启对话右上角的发送状态' : '已关闭对话右上角的发送状态' }
            : { status: 'refused', message: 'Host 拒绝了这次写入' })
          if (ok) this.read()
        } catch (error) {
          this.setState({ status: 'error', message: String(error?.message ?? error) })
        }
      }

      componentDidMount() {
        if (!activeForm) return
        this.read()
        const off = activeForm.subscribe(this.read)
        this.off = typeof off === 'function' ? off : null
      }

      componentWillUnmount() {
        if (this.off) this.off()
      }

      read() {
        if (!activeForm) return
        this.setState({ snap: activeForm.getSnapshot() })
      }

      update(next) {
        this.setState({ draft: next, status: 'idle', message: '' })
      }

      patchRule(index, patch) {
        const rules = this.rules()
        this.update(rules.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)))
      }

      removeRule(index) {
        this.update(this.rules().filter((_, at) => at !== index))
      }

      addRule() {
        this.update([...this.rules(), { models: [], flavor: 'generic', enabled: true }])
      }

      rules() {
        if (Array.isArray(this.state.draft)) return this.state.draft
        const rules = this.state.snap?.value?.rules
        // Absent = the host is running DEFAULT_RULES; show them so the card
        // matches what is actually injected.
        if (rules === undefined) return DEFAULT_RULES
        return Array.isArray(rules) ? rules : []
      }

      async handleSave() {
        const draft = this.state.draft
        if (!activeForm || !Array.isArray(draft)) return
        this.setState({ status: 'saving', message: '' })
        try {
          const clean = draft.map((rule) => ({
            ...rule,
            models: Array.isArray(rule.models) ? rule.models : parseModels(rule.models),
            flavor: FLAVORS.includes(rule.flavor) ? rule.flavor : 'generic',
            enabled: rule.enabled !== false,
          }))
          const ok = await activeForm.mutate([{ op: 'set', path: ['rules'], value: clean }])
          if (ok) {
            this.setState({ draft: null, status: 'saved', message: '已保存，下一次模型调用即生效' })
            this.read()
          } else {
            this.setState({ status: 'refused', message: 'Host 拒绝了这次写入，请检查规则是否有效' })
          }
        } catch (error) {
          this.setState({ status: 'error', message: String(error?.message ?? error) })
        }
      }

      renderFallback() {
        return h(
          'div',
          { style: styles.root },
          h('div', { style: styles.header }, h('div', { style: styles.title }, '按模型注入会话 ID 头')),
          h('div', { style: styles.hint }, '设置服务不可用（未加载 dsh-settings 客户端），规则请改 profile 的 cordis.patch.yml。'),
        )
      }

      render() {
        if (!activeForm) return this.renderFallback()
        const { snap, draft, status, message } = this.state
        if (snap === null) return h('div', { style: styles.root }, '正在读取配置…')

        const rules = this.rules()
        const dirty = Array.isArray(draft)
        const writable = snap.writable !== false && snap.status === 'ready'
        const busy = status === 'saving'

        const header = h(
          'div',
          { style: styles.header },
          h('div', { style: styles.title }, '按模型注入会话 ID 头'),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            dirty
              ? h(
                  'button',
                  {
                    type: 'button',
                    style: styles.button,
                    onClick: () => this.setState({ draft: null, status: 'idle', message: '' }),
                  },
                  '撤销',
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                style: {
                  ...styles.button,
                  ...(dirty && writable ? styles.primary : {}),
                  ...(!dirty || busy || !writable ? styles.disabled : {}),
                },
                disabled: !dirty || busy || !writable,
                onClick: this.handleSave,
              },
              busy ? '保存中…' : '保存',
            ),
          ),
        )

        const hint = h(
          'div',
          { style: styles.hint },
          '规则自上而下匹配，首条命中生效；模型 id 支持 ',
          h('code', null, '*'),
          ' / ',
          h('code', null, '?'),
          ' 通配（',
          h('code', null, 'claude-*'),
          ' 也能命中 ',
          h('code', null, 'anthropic/claude-sonnet-4-6'),
          '）。未命中任何规则时不注入头。',
        )

        const rows = rules.length === 0
          ? h('div', { style: styles.empty }, '还没有规则。点「添加规则」开始。')
          : rules.map((rule, index) =>
              h(
                'div',
                { style: styles.row, key: index },
                h('input', {
                  style: styles.input,
                  value: Array.isArray(rule.models) ? rule.models.join(', ') : String(rule.models ?? ''),
                  placeholder: 'claude-*, anthropic/claude-*',
                  spellCheck: false,
                  onChange: (event) => this.patchRule(index, { models: parseModels(event.target.value) }),
                }),
                h(
                  'select',
                  {
                    style: styles.select,
                    value: FLAVORS.includes(rule.flavor) ? rule.flavor : 'generic',
                    onChange: (event) => this.patchRule(index, { flavor: event.target.value }),
                  },
                  FLAVORS.map((flavor) => h('option', { key: flavor, value: flavor }, FLAVOR_LABEL[flavor])),
                ),
                h(
                  'label',
                  { style: { display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px', opacity: 0.8 } },
                  h('input', {
                    type: 'checkbox',
                    checked: rule.enabled !== false,
                    onChange: (event) => this.patchRule(index, { enabled: event.target.checked }),
                  }),
                  '启用',
                ),
                h('button', { type: 'button', style: styles.danger, onClick: () => this.removeRule(index) }, '删除'),
              ),
            )

        const footer = h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '14px' } },
            h('button', { type: 'button', style: styles.button, disabled: !writable, onClick: () => this.addRule() }, '添加规则'),
            h(
              'label',
              { style: styles.toggle },
              h('input', {
                type: 'checkbox',
                // Absent = the schema default (on).
                checked: snap.value?.showStatus !== false,
                disabled: !writable,
                onChange: this.handleToggleStatus,
              }),
              '在对话右上角显示发送状态',
            ),
          ),
          h(
            'div',
            { style: { ...styles.status, color: status === 'refused' || status === 'error' ? '#d4380d' : undefined } },
            message || (snap.status === 'loading' ? '正在同步配置…' : ''),
          ),
        )

        return h(
          'div',
          { style: styles.root, 'data-dsh-model-session-headers': 'card' },
          header,
          hint,
          rows,
          footer,
          h('div', { style: styles.meta }, `${PACKAGE}#${ROW_ID}`),
        )
      }
    }

    /**
     * Chat-header badge: a status dot plus the header name of the latest call,
     * opening a list of the conversation's recent calls. Class component for the
     * same hook-dispatcher reason as Card. `sessionId` comes from the slot's
     * session scope.
     */
    class StatusBadge extends React.Component {
      constructor(props) {
        super(props)
        this.state = { enabled: false, records: [], open: false, error: '', anchor: null }
        this.rootRef = React.createRef()
        this.popoverRef = React.createRef()
        this.poll = this.poll.bind(this)
        this.handleOutside = this.handleOutside.bind(this)
        this.place = this.place.bind(this)
      }

      componentDidMount() {
        this.alive = true
        this.poll()
        this.timer = setInterval(this.poll, POLL_MS)
        document.addEventListener('pointerdown', this.handleOutside, true)
        // Fixed positioning does not follow layout changes on its own.
        window.addEventListener('resize', this.place)
        window.addEventListener('scroll', this.place, true)
      }

      /**
       * Pin the popover under the chip, right edges aligned, then clamp it into
       * the viewport so a narrow window never pushes it off the left edge.
       */
      place() {
        if (!this.state.open) return
        const chip = this.rootRef.current
        if (!chip) return
        const rect = chip.getBoundingClientRect()
        const margin = 8
        const width = Math.min(380, window.innerWidth - margin * 2)
        const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin))
        this.setState({ anchor: { top: rect.bottom + 6, left, width } })
      }

      toggleOpen() {
        if (this.state.open) {
          this.setState({ open: false })
          return
        }
        this.setState({ open: true }, this.place)
      }

      componentDidUpdate(prev) {
        if (prev.sessionId === this.props.sessionId) return
        // Another conversation: drop the old list instead of showing it under
        // the new header until the next poll lands.
        this.controller?.abort()
        this.setState({ records: [], open: false, error: '' })
        this.poll()
      }

      componentWillUnmount() {
        this.alive = false
        clearInterval(this.timer)
        this.controller?.abort()
        document.removeEventListener('pointerdown', this.handleOutside, true)
        window.removeEventListener('resize', this.place)
        window.removeEventListener('scroll', this.place, true)
      }

      handleOutside(event) {
        if (!this.state.open) return
        // The portalled popover is outside the chip's subtree; count it as inside.
        const inside = [this.rootRef.current, this.popoverRef.current].some((node) => node && node.contains(event.target))
        if (!inside) this.setState({ open: false })
      }

      async poll() {
        const sessionId = this.props.sessionId
        // Background tabs skip a beat; the interval picks up when visible.
        if (!sessionId || document.hidden || this.controller) return
        const controller = new AbortController()
        this.controller = controller
        try {
          const response = await fetch(statusUrl(sessionId), {
            headers: { accept: 'application/json' },
            signal: controller.signal,
          })
          const body = await response.json().catch(() => null)
          if (!this.alive || sessionId !== this.props.sessionId) return
          if (response.ok && body?.ok === true) {
            const value = body.value ?? {}
            this.setState({
              enabled: value.enabled === true,
              records: Array.isArray(value.records) ? value.records : [],
              error: '',
            })
          } else if (response.status === 404) {
            // Host half older than this client (route absent): stay hidden.
            this.setState({ enabled: false })
          } else {
            this.setState({ error: body?.error?.message ?? `HTTP ${response.status}` })
          }
        } catch (error) {
          if (controller.signal.aborted || !this.alive) return
          this.setState({ error: String(error?.message ?? error) })
        } finally {
          if (this.controller === controller) this.controller = null
        }
      }

      /** Fixed coordinates from place(); hidden until measured to avoid a jump. */
      popoverStyle() {
        const anchor = this.state.anchor
        if (!anchor) return { ...styles.popover, visibility: 'hidden', top: 0, left: 0 }
        return { ...styles.popover, top: `${anchor.top}px`, left: `${anchor.left}px`, width: `${anchor.width}px` }
      }

      /** Mount on <body> when react-dom is available, else inline. */
      portal(node) {
        if (ReactDOM && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined' && document.body) {
          return ReactDOM.createPortal(node, document.body)
        }
        return node
      }

      renderRecord(record, index) {
        const status = STATUS_LABEL[record.status] ? record.status : 'unmatched'
        const color = STATUS_COLOR[status]
        const tagStyle = {
          ...styles.tag,
          background: color ? `color-mix(in srgb, ${color} 16%, transparent)` : 'color-mix(in srgb, currentColor 10%, transparent)',
          color: color ?? 'inherit',
        }
        const target = [record.provider, record.model].filter(Boolean).join(' / ') || '未知模型'
        const lines = []
        for (const [name, value] of record.headers ?? []) {
          lines.push(h('div', { key: `h-${name}`, style: styles.mono }, `${name}: ${value}`))
        }
        for (const [name, value] of record.skipped ?? []) {
          lines.push(
            h('div', { key: `s-${name}`, style: { ...styles.mono, opacity: 0.8 } }, `${name}: 已存在 ${value}（未覆盖）`),
          )
        }
        if (lines.length === 0) {
          lines.push(
            h('div', { key: 'none', style: { opacity: 0.7 } }, status === 'empty' ? '命中规则，但没有可发送的值' : '没有命中规则，未加任何头'),
          )
        }
        return h(
          'div',
          { key: `${record.ts}-${index}`, style: styles.record },
          h('div', { style: styles.recordTop }, h('span', null, `${timeOf(record.ts)} · ${target}`), h('span', { style: tagStyle }, STATUS_LABEL[status])),
          lines,
        )
      }

      render() {
        const { enabled, records, open, error } = this.state
        if (!enabled) return null
        const latest = records[0]
        const dotColor = STATUS_COLOR[latest?.status] ?? 'color-mix(in srgb, currentColor 40%, transparent)'
        const label = latest?.headers?.[0]?.[0] ?? latest?.skipped?.[0]?.[0] ?? '会话头'
        const title = latest ? `最近一次：${STATUS_LABEL[latest.status] ?? latest.status}` : '还没有请求记录'
        const session = String(this.props.sessionId ?? '').replace(/^session-/, '')

        return h(
          'div',
          { ref: this.rootRef, style: styles.badgeRoot, 'data-dsh-model-session-headers': 'badge' },
          h(
            'button',
            { type: 'button', style: styles.chip, title, 'aria-expanded': open, onClick: () => this.toggleOpen() },
            h('span', { style: { ...styles.dot, background: dotColor } }),
            label,
          ),
          open
            ? this.portal(h(
                'div',
                { ref: this.popoverRef, style: this.popoverStyle(), role: 'dialog' },
                h('div', { style: { ...styles.mono, opacity: 0.8, marginBottom: '4px' } }, `会话 ${session}`),
                records.length === 0
                  ? h('div', { style: { opacity: 0.7, padding: '6px 0' } }, '这个对话还没有模型请求记录（DSH 重启后会清空）。')
                  : records.map((record, index) => this.renderRecord(record, index)),
                error ? h('div', { style: { color: '#d4380d', marginTop: '4px' } }, `刷新失败：${error}`) : null,
                h(
                  'div',
                  { style: { opacity: 0.55, fontSize: '11px', marginTop: '6px' } },
                  '只代表 DSH 已带上这个头发出去；中间网关（如 magpie）是否转发，这里看不到。',
                ),
              ))
            : null,
        )
      }
    }

    function apply(ctx) {
      const configForms = ctx.configForms
      if (configForms) {
        try {
          activeForm = configForms.get(ROW_ID)
        } catch {
          activeForm = null
        }
      }
      ctx.slots.inject('plugins.row.config', () =>
        ctx.slots.register({ name: 'plugins.row.config', key: `${PACKAGE}#${ROW_ID}` }, Card),
      )
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE }, Card),
      )
      // Session-scoped list slot: the renderer hands each entry `sessionId`.
      // order 15 sits between the subagent catalog (10) and the job list (20): the job
      // list only renders while jobs exist, so placing the badge after it made it jump.
      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'model-session-headers-status', order: 15 },
          StatusBadge,
        ),
      )
    }

    const exports = {}
    exports.apply = apply
    exports.inject = ['slots', 'configForms']
    return exports
  },
})
