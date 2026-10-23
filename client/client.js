/**
 * Client half of dsh-model-session-headers.
 *
 * The settings page renders a plugin's configuration from slots, not from the
 * exported Config schema: a row's card is whatever the plugin registers under
 * `plugins.row.config` with key `<package>#<row id>`.
 *
 * The card is deliberately read-only. DSH 0.2 projects settings forms through
 * SettingsForms, which only accepts `volatile` scalar fields; a list of rules
 * (our `rules`) cannot be declared editable — `validateVolatileSchema` rejects
 * volatile nodes inside arrays, and `SettingsForms.write` refuses any path that
 * is not volatile. So the card documents the YAML instead of pretending to
 * edit it.
 *
 * Loaded by the DSH web client as a lazy CommonJS factory: no bundler needed.
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-session-headers',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PACKAGE = 'dsh-model-session-headers'
    const ROW_ID = 'model-session-headers'

    const SAMPLE = [
      '- insert:',
      '    - id: model-session-headers',
      '      config:',
      '        rules:',
      '          - models: ["claude-*"]',
      '            flavor: claude-code',
      '          - models: ["deepseek-v4*"]',
      '            providers: [opencode-go]',
      '            flavor: opencode-go',
    ].join('\n')

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
      hint: { opacity: 0.72 },
      pre: {
        margin: 0,
        padding: '10px 12px',
        borderRadius: '8px',
        background: 'color-mix(in srgb, currentColor 6%, transparent)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '12px',
        lineHeight: '1.5',
        overflowX: 'auto',
        whiteSpace: 'pre',
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
      meta: { opacity: 0.5, fontSize: '12px' },
    }

    function Card() {
      const [copied, setCopied] = React.useState(false)
      const copy = () => {
        const done = () => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(SAMPLE).then(done, () => {})
        }
      }
      return h(
        'div',
        { style: styles.root, 'data-dsh-model-session-headers': 'card' },
        h(
          'div',
          { style: styles.header },
          h('div', { style: styles.title }, '按模型注入会话 ID 头'),
          h('button', { type: 'button', style: styles.button, onClick: copy }, copied ? '已复制' : '复制示例'),
        ),
        h(
          'div',
          { style: styles.hint },
          '规则写在 profile 的 ',
          h('code', null, 'cordis.patch.yml'),
          '（行 id：',
          h('code', null, ROW_ID),
          '）。DSH 0.2 的设置表单只接受标量字段，列表型规则目前只能改 YAML。',
        ),
        h('pre', { style: styles.pre }, SAMPLE),
        h('div', { style: styles.meta }, `${PACKAGE}#${ROW_ID}`),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('plugins.row.config', () =>
        ctx.slots.register({ name: 'plugins.row.config', key: `${PACKAGE}#${ROW_ID}` }, Card),
      )
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE }, Card),
      )
    }

    const exports = {}
    exports.apply = apply
    exports.inject = ['slots']
    return exports
  },
})
