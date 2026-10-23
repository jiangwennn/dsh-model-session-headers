/**
 * Client half of dsh-model-session-headers: the rule editor on the DSH
 * plugins page.
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

    const PACKAGE = 'dsh-model-session-headers'
    const ROW_ID = 'model-session-headers'
    const FLAVORS = ['claude-code', 'opencode-go', 'generic']
    const FLAVOR_LABEL = {
      'claude-code': 'claude-code · x-claude-code-session-id',
      'opencode-go': 'opencode-go · x-opencode-session',
      generic: 'generic · x-session-id',
    }

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
      primary: {
        background: 'color-mix(in srgb, currentColor 86%, transparent)',
        color: 'var(--dsh-bg, #fff)',
        borderColor: 'transparent',
      },
      danger: { background: 'transparent', border: 'none', color: 'inherit', opacity: 0.65, cursor: 'pointer', fontSize: '12px' },
      meta: { opacity: 0.5, fontSize: '11px' },
      status: { fontSize: '12px', opacity: 0.75 },
      empty: { opacity: 0.65, fontSize: '12px' },
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
                style: { ...styles.button, ...(dirty && writable ? styles.primary : {}) },
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
          h('button', { type: 'button', style: styles.button, disabled: !writable, onClick: () => this.addRule() }, '添加规则'),
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
    }

    const exports = {}
    exports.apply = apply
    exports.inject = ['slots', 'configForms']
    return exports
  },
})
