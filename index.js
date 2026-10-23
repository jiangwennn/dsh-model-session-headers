/**
 * dsh-model-session-headers
 *
 * Per-model session-id headers for DeepSeek Harness (DSH).
 *
 * Some relays and gateways pin a conversation to one upstream backend (and
 * keep its prompt cache warm) only when every request carries a stable
 * session identifier. Different ecosystems spell that header differently:
 *
 *   - Claude Code gateways read `x-claude-code-session-id`
 *   - OpenCode / OpenCode Go read `x-opencode-session`
 *   - generic relays read `x-session-id`
 *
 * DSH itself has no per-request header seam: `GenerateOptions` has no headers
 * field and each adapter builds its own wire headers. This plugin composes the
 * two official interception points instead:
 *
 *   - the `llm/stream` waterfall identifies the LLM call and exposes
 *     `options.provider` / `options.model` / `options.sessionId`
 *   - a `globalThis.fetch` patch attaches headers to the outgoing request
 *
 * `AsyncLocalStorage` scopes the patch to one streamed call, so unrelated
 * fetches (web RPC, telemetry, tool traffic) are never touched.
 *
 * Unlike provider-level header plugins, the rule table here matches on MODEL
 * id, so two models behind the same provider route can carry different
 * headers — e.g. `claude-*` gets the Claude Code header while `deepseek-*`
 * gets the OpenCode one.
 *
 * @module dsh-model-session-headers
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-model-session-headers'

// Nothing to do until the llm runtime exists.
export const inject = ['llm']

/** Built-in header presets, one per ecosystem. */
export const FLAVORS = {
  'claude-code': { 'x-claude-code-session-id': '{sessionId}' },
  'opencode-go': { 'x-opencode-session': '{sessionId}' },
  generic: { 'x-session-id': '{sessionId}' },
}

export const Config = Schema.object({
  /**
   * How the header value is derived.
   * - `session-id`: the DSH session id of the call in flight (default)
   * - `uuid`: a UUIDv5-shaped hash of that id (opaque to the upstream)
   * - `fixed`: the literal `value`, identical for every call
   */
  mode: Schema.union([
    Schema.const('session-id'),
    Schema.const('uuid'),
    Schema.const('fixed'),
  ]).default('session-id').description('会话 ID 的取值方式'),
  /** Literal value used when `mode: fixed`. */
  value: Schema.string().description('mode 为 fixed 时的固定值'),
  /**
   * Keep the harness's `session-` branding prefix. Off by default: most
   * gateways expect a bare UUID and reject the branded form.
   */
  keepPrefix: Schema.boolean().default(false).description('是否保留 session- 前缀'),
  /** Overwrite a header the adapter (or another plugin) already set. */
  overwrite: Schema.boolean().default(false).description('已存在同名头时是否覆盖'),
  /**
   * Ordered rule table; the first matching rule wins. Empty = plugin idle.
   *
   * `volatile` is what makes this list writable from the settings page:
   * SettingsForms refuses any write path that is not volatile, and a volatile
   * *field* is legal (only volatile nodes INSIDE a list are rejected). DSH then
   * hands the plugin a live observable instead of a plain array, so every read
   * goes through `unwrapRules()`. Note the field loses its `.default([])` when
   * wrapped — `unwrapRules(undefined)` covers that.
   */
  rules: Schema.array(
    Schema.object({
      /** Glob patterns matched against the model id (`*`, `?`). Empty = any. */
      models: Schema.array(Schema.string()).default([]).description('模型 id 通配符，空表示不限'),
      /** Optional provider route keys (`opencode-go`, ...). Empty = any. */
      providers: Schema.array(Schema.string()).default([]).description('提供方路由键，空表示不限'),
      /** Built-in header preset. */
      flavor: Schema.union([
        Schema.const('claude-code'),
        Schema.const('opencode-go'),
        Schema.const('generic'),
      ]).default('generic').description('头信息预设'),
      /**
       * Extra/overriding headers. Values are templates supporting
       * `{sessionId}`, `{model}` and `{provider}`.
       */
      headers: Schema.dict(Schema.string()).default({}).description('附加或覆盖的请求头模板'),
      /** Per-rule overwrite switch; defaults to the global setting. */
      overwrite: Schema.boolean().description('该规则是否覆盖已存在的头'),
      enabled: Schema.boolean().default(true).description('是否启用该规则'),
    }),
  ).default([]).volatile().description('按模型匹配的规则表'),
  /** Log every injected call to the dsh console. */
  debug: Schema.boolean().default(false).description('输出调试日志'),
  /** Append one JSON line per injected call to this absolute path. */
  debugFile: Schema.string().description('调试日志文件（绝对路径）'),
})

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for tests)                                   */
/* ------------------------------------------------------------------ */

/** Escape a glob and turn `*` / `?` into wildcards. */
export function globToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^]*')
    .replace(/\?/g, '[^]')
  return new RegExp(`^${escaped}$`, 'i')
}

/** Accept a string model id or the adapter's `{ id }` / `{ model }` shape. */
export function resolveModelId(options) {
  const model = options?.model
  if (typeof model === 'string') return model
  if (model !== null && typeof model === 'object') {
    for (const key of ['id', 'model', 'name', 'slug']) {
      if (typeof model[key] === 'string' && model[key] !== '') return model[key]
    }
  }
  return undefined
}

export function resolveProvider(options) {
  const provider = options?.provider
  if (typeof provider === 'string') return provider
  if (provider !== null && typeof provider === 'object' && typeof provider.id === 'string') {
    return provider.id
  }
  return undefined
}

/**
 * Match a list of glob patterns against one value. Both the full id and its
 * basename (after the last `/`) are tried, so `claude-*` matches both
 * `claude-sonnet-4-6` and `anthropic/claude-sonnet-4-6`.
 */
export function matchesAny(patterns, value) {
  if (!patterns || patterns.length === 0) return true
  if (typeof value !== 'string' || value === '') return false
  const candidates = [value]
  const slash = value.lastIndexOf('/')
  if (slash >= 0 && slash < value.length - 1) candidates.push(value.slice(slash + 1))
  return patterns.some((pattern) => {
    if (typeof pattern !== 'string' || pattern === '') return false
    const re = globToRegExp(pattern)
    return candidates.some((candidate) => re.test(candidate))
  })
}

/**
 * Unwrap a rule list that DSH may hand over as a live observable (volatile
 * fields on 0.2.x are observables) and tolerate anything unusable.
 */
export function unwrapRules(value) {
  const raw = value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value
  return Array.isArray(raw) ? raw : []
}

/** First enabled rule whose provider + model patterns both match. */
export function selectRule(config, options) {
  const rules = unwrapRules(config?.rules)
  const provider = resolveProvider(options)
  const model = resolveModelId(options)
  for (const rule of rules) {
    if (rule?.enabled === false) continue
    if (!matchesAny(rule?.providers, provider)) continue
    if (!matchesAny(rule?.models, model)) continue
    return rule
  }
  return undefined
}

/** Strip the `session-` branding prefix unless explicitly kept. */
export function sessionIdOf(options, keepPrefix) {
  const raw = options?.sessionId
  if (raw === undefined || raw === null) return undefined
  const id = String(raw)
  if (id === '') return undefined
  return keepPrefix ? id : id.replace(/^session-/, '')
}

/** Stable, opaque UUIDv5-shaped identifier derived from the session id. */
export function uuidFrom(value) {
  const hex = createHash('sha256').update(String(value)).digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  const joined = hex.join('')
  return [
    joined.slice(0, 8),
    joined.slice(8, 12),
    joined.slice(12, 16),
    joined.slice(16, 20),
    joined.slice(20),
  ].join('-')
}

/** Replace `{sessionId}` / `{model}` / `{provider}`; unknown tokens stay as-is. */
export function renderTemplate(template, context) {
  return String(template).replace(/\{(sessionId|model|provider)\}/g, (match, key) => {
    const value = context[key]
    return value === undefined ? match : String(value)
  })
}

/**
 * Build the concrete header list for one call.
 * Returns `[]` when there is nothing to inject (no session id for a
 * session-derived template, or an empty rule).
 */
export function buildHeaders(config, rule, options) {
  const mode = config?.mode ?? 'session-id'
  const keepPrefix = config?.keepPrefix === true
  const base = sessionIdOf(options, keepPrefix)

  let sessionValue
  if (mode === 'fixed') {
    if (config?.value === undefined || config.value === '') return []
    sessionValue = String(config.value)
  } else if (mode === 'uuid') {
    if (base === undefined) return []
    sessionValue = uuidFrom(base)
  } else {
    if (base === undefined) return []
    sessionValue = base
  }

  const context = {
    sessionId: sessionValue,
    model: resolveModelId(options),
    provider: resolveProvider(options),
  }
  const preset = FLAVORS[rule?.flavor] ?? FLAVORS.generic
  const merged = { ...preset, ...(rule?.headers ?? {}) }

  const headers = []
  for (const [headerName, template] of Object.entries(merged)) {
    if (typeof headerName !== 'string' || headerName.trim() === '') continue
    const rendered = renderTemplate(template, context)
    // A template still holding a known placeholder means the value it needs
    // was unavailable (no model id, no provider, ...). Send nothing rather
    // than a literal "{model}" on the wire.
    if (/\{(sessionId|model|provider)\}/.test(rendered)) continue
    headers.push([headerName, rendered])
  }
  return headers
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

export function apply(ctx, config) {
  // `globalThis.fetch` may not exist in exotic hosts; fail loudly at load
  // rather than silently doing nothing on every request.
  const originalFetch = globalThis.fetch
  if (typeof originalFetch !== 'function') {
    ctx.logger?.warn?.('dsh-model-session-headers: global fetch is unavailable; plugin disabled')
    return
  }

  const als = new AsyncLocalStorage()
  const debug = config?.debug === true
  const debugFile = typeof config?.debugFile === 'string' && config.debugFile !== ''
    ? config.debugFile
    : undefined

  const record = (options, headers) => {
    if (!debug && debugFile === undefined) return
    const entry = {
      ts: new Date().toISOString(),
      provider: resolveProvider(options),
      model: resolveModelId(options),
      session: sessionIdOf(options, config?.keepPrefix === true),
      headers,
    }
    if (debug) {
      ctx.logger?.info?.(
        `[model-session-headers] ${entry.provider ?? '?'}/${entry.model ?? '?'} -> ${JSON.stringify(headers)}`,
      )
    }
    if (debugFile !== undefined) {
      appendFile(debugFile, `${JSON.stringify(entry)}\n`).catch((error) => {
        ctx.logger?.warn?.(`dsh-model-session-headers: cannot append ${debugFile}: ${error?.message}`)
      })
    }
  }

  /** Header collection for one call: lower-case name -> [wire name, value]. */
  const scopeFor = (options) => {
    const rule = selectRule(config, options)
    if (rule === undefined) return undefined
    const headers = buildHeaders(config, rule, options)
    if (headers.length === 0) return undefined
    const overwrite = rule.overwrite === undefined ? config?.overwrite === true : rule.overwrite === true
    return { headers, overwrite }
  }

  const patchedFetch = (input, init) => {
    const scope = als.getStore()
    if (scope === undefined) return originalFetch(input, init)

    // Collect headers from both fetch() spellings: a Request object carries
    // its own, and init.headers overrides them per the fetch standard.
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers !== undefined) {
      for (const [key, value] of new Headers(init.headers)) headers.set(key, value)
    }

    let injected = []
    for (const [headerName, value] of scope.headers) {
      if (!scope.overwrite && headers.has(headerName)) continue
      headers.set(headerName, value)
      injected.push([headerName, value])
    }
    if (injected.length === 0) return originalFetch(input, init)

    // A bare Request input owns its headers; rebuild it so the original —
    // which may be reused by the caller — keeps arriving providers without us.
    if (input instanceof Request && init === undefined) {
      return originalFetch(new Request(input, { headers }))
    }
    return originalFetch(input, { ...init, headers })
  }

  globalThis.fetch = patchedFetch
  // cordis `ctx.effect`: the callback runs immediately (setup); the returned
  // function is the disposer collected on fiber unload.
  ctx.effect(() => () => {
    if (globalThis.fetch === patchedFetch) {
      globalThis.fetch = originalFetch
    } else {
      // Someone else replaced fetch after we loaded; restoring ours would
      // silently drop their patch.
      ctx.logger?.warn?.('dsh-model-session-headers: global fetch changed after load; not restoring')
    }
  })

  ctx.on('llm/stream', async function* (options, next) {
    const scope = scopeFor(options)
    if (scope === undefined) {
      yield* next()
      return
    }
    record(options, scope.headers)

    const iterator = next()[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        // Each adapter step resumes inside the store, so its internal fetch
        // (whenever in the call it happens) sees this call's headers.
        const result = await als.run(scope, () => iterator.next())
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } finally {
      if (!exhausted) await iterator.return?.()
    }
  })

  // One line at boot so operators can tell "installed but idle" from
  // "installed and matching".
  const activeRules = unwrapRules(config?.rules).filter((rule) => rule?.enabled !== false).length
  ctx.logger?.info?.(
    `[model-session-headers] ${activeRules} active rule(s)` +
      (activeRules === 0 ? '; plugin idle until rules are configured' : ''),
  )
}
