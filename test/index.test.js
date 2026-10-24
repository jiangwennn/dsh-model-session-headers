import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, describe, test } from 'node:test'

import {
  STATUS_ROUTE,
  apply,
  buildHeaders,
  createStatusHandler,
  createStatusStore,
  matchesAny,
  selectRule,
  uuidFrom,
} from '../index.js'

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function createCtx() {
  const listeners = new Map()
  const disposers = []
  const logs = []
  return {
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
    },
    effect(fn) {
      disposers.push(fn())
    },
    on(event, handler) {
      listeners.set(event, handler)
    },
    dispose() {
      while (disposers.length > 0) disposers.pop()?.()
    },
    listeners,
    logs,
  }
}

let server
let baseUrl
let lastRequest

before(async () => {
  server = http.createServer((req, res) => {
    lastRequest = { url: req.url, method: req.method, headers: req.headers }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}/v1/messages`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

const baseConfig = {
  mode: 'session-id',
  keepPrefix: false,
  overwrite: false,
  rules: [
    { models: ['claude-*'], flavor: 'claude-code', enabled: true },
    { models: ['deepseek-*'], providers: ['opencode-go'], flavor: 'opencode-go', enabled: true },
  ],
}

/** Run one fake llm/stream call on an applied ctx; returns what the server saw. */
async function streamOnce(ctx, options, init = {}) {
  const handler = ctx.listeners.get('llm/stream')
  assert.equal(typeof handler, 'function', 'llm/stream listener registered')

  lastRequest = undefined
  const stream = handler(options, async function* () {
    const response = await fetch(baseUrl, {
      method: 'POST',
      body: '{"hello":"world"}',
      ...init,
    })
    await response.text()
    yield { chunk: 1 }
  })

  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  assert.deepEqual(chunks, [{ chunk: 1 }])
  return lastRequest.headers
}

/** Drive one fake llm/stream call through the plugin and return the headers. */
async function callModel(config, options, init = {}) {
  const ctx = createCtx()
  const originalFetch = globalThis.fetch
  apply(ctx, config)
  try {
    return await streamOnce(ctx, options, init)
  } finally {
    ctx.dispose()
    assert.equal(globalThis.fetch, originalFetch, 'fetch restored on dispose')
  }
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

describe('matching', () => {
  test('globs match the full id and its basename', () => {
    assert.equal(matchesAny(['claude-*'], 'anthropic/claude-sonnet-4-6'), true)
    assert.equal(matchesAny(['claude-*'], 'claude-sonnet-4-6'), true)
    assert.equal(matchesAny(['claude-*'], 'openai/gpt-5'), false)
    assert.equal(matchesAny(['deepseek-v4.?'], 'deepseek-v4.1'), true)
    assert.equal(matchesAny([], undefined), true)
    assert.equal(matchesAny(['*'], undefined), false)
  })

  test('first matching rule wins, disabled and non-matching rules are skipped', () => {
    const config = {
      rules: [
        { models: ['claude-*'], flavor: 'generic', enabled: false },
        { models: ['claude-*'], providers: ['other'], flavor: 'generic' },
        { models: ['claude-*'], flavor: 'claude-code' },
        { models: ['*'], flavor: 'generic' },
      ],
    }
    const rule = selectRule(config, { provider: 'gw', model: 'claude-sonnet-4-6', sessionId: 's1' })
    assert.equal(rule.flavor, 'claude-code')
    assert.equal(selectRule(config, { provider: 'gw', model: 'gpt-5' }).flavor, 'generic')
    assert.equal(selectRule({ rules: [] }, { model: 'claude-sonnet-4-6' }), undefined)
  })

  test('absent rules fall back to the defaults; an explicit empty list stays idle', () => {
    const flavorOf = (config, model) => selectRule(config, { provider: 'gw', model })?.flavor
    // Absent: opencode-prefixed routes (bare or behind a gateway) and claude-*.
    assert.equal(flavorOf({}, 'opencode/deepseek-v4.1-flash'), 'opencode-go')
    assert.equal(flavorOf({}, 'aihub/opencode/deepseek-v4.1-flash'), 'opencode-go')
    assert.equal(flavorOf({}, 'claude-sonnet-4-6'), 'claude-code')
    assert.equal(flavorOf({}, 'anthropic/claude-sonnet-4-6'), 'claude-code')
    assert.equal(flavorOf({}, 'aihub/deepseek-v4.1-flash'), undefined)
    assert.equal(flavorOf({}, 'my-opencode-model'), undefined)
    // A live observable whose value is absent behaves the same.
    assert.equal(flavorOf({ rules: { get: () => undefined } }, 'claude-opus-4'), 'claude-code')
    // Explicit empty list: the operator opted out.
    assert.equal(flavorOf({ rules: [] }, 'opencode/deepseek-v4.1-flash'), undefined)
  })
})

describe('header building', () => {
  test('claude-code flavor emits x-claude-code-session-id without the prefix', () => {
    const headers = buildHeaders(baseConfig, { flavor: 'claude-code' }, {
      provider: 'gw',
      model: 'claude-sonnet-4-6',
      sessionId: 'session-abc-123',
    })
    assert.deepEqual(headers, [['x-claude-code-session-id', 'abc-123']])
  })

  test('opencode-go flavor emits x-opencode-session', () => {
    const headers = buildHeaders(baseConfig, { flavor: 'opencode-go' }, {
      provider: 'opencode-go',
      model: 'deepseek-v4.1',
      sessionId: 'session-xyz',
    })
    assert.deepEqual(headers, [['x-opencode-session', 'xyz']])
  })

  test('custom headers add to and override the preset, templates are rendered', () => {
    const headers = buildHeaders(baseConfig, {
      flavor: 'generic',
      headers: {
        'x-opencode-session': '{sessionId}',
        'x-routing-key': '{provider}/{model}',
        'x-tenant': 'acme',
      },
    }, {
      provider: 'gw',
      model: 'anthropic/claude-sonnet-4-6',
      sessionId: 'session-42',
    })
    assert.deepEqual(headers, [
      ['x-session-id', '42'],
      ['x-opencode-session', '42'],
      ['x-routing-key', 'gw/anthropic/claude-sonnet-4-6'],
      ['x-tenant', 'acme'],
    ])
  })

  test('fixed and uuid modes', () => {
    const options = { model: 'claude-sonnet-4-6', sessionId: 'session-abc' }
    assert.deepEqual(
      buildHeaders({ ...baseConfig, mode: 'fixed', value: 'pinned' }, { flavor: 'claude-code' }, options),
      [['x-claude-code-session-id', 'pinned']],
    )
    const first = buildHeaders({ ...baseConfig, mode: 'uuid' }, { flavor: 'claude-code' }, options)
    const second = buildHeaders({ ...baseConfig, mode: 'uuid' }, { flavor: 'claude-code' }, options)
    assert.deepEqual(first, second)
    assert.match(first[0][1], /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.notEqual(
      first[0][1],
      buildHeaders({ ...baseConfig, mode: 'uuid' }, { flavor: 'claude-code' }, { ...options, sessionId: 'session-other' })[0][1],
    )
    assert.equal(uuidFrom('abc').length, 36)
  })

  test('no session id means no header', () => {
    assert.deepEqual(buildHeaders(baseConfig, { flavor: 'claude-code' }, { model: 'claude-sonnet-4-6' }), [])
  })

  test('a template whose value is unavailable is skipped, not sent literally', () => {
    const headers = buildHeaders(baseConfig, {
      flavor: 'generic',
      headers: { 'x-routing-key': '{provider}/{model}' },
    }, { sessionId: 'session-a' })
    assert.deepEqual(headers, [['x-session-id', 'a']])
  })
})

/* ------------------------------------------------------------------ */
/* End-to-end through llm/stream + patched fetch                       */
/* ------------------------------------------------------------------ */

describe('llm/stream injection', () => {
  test('injects the Claude Code header for claude models only', async () => {
    const headers = await callModel(baseConfig, {
      provider: 'my-gateway',
      model: 'claude-sonnet-4-6',
      sessionId: 'session-abc-123',
    })
    assert.equal(headers['x-claude-code-session-id'], 'abc-123')
    assert.equal(headers['x-opencode-session'], undefined)
  })

  test('injects the OpenCode header for opencode-go deepseek models', async () => {
    const headers = await callModel(baseConfig, {
      provider: 'opencode-go',
      model: 'deepseek-v4.1',
      sessionId: 'session-xyz',
    })
    assert.equal(headers['x-opencode-session'], 'xyz')
    assert.equal(headers['x-claude-code-session-id'], undefined)
  })

  test('leaves unmatched models untouched', async () => {
    const headers = await callModel(baseConfig, {
      provider: 'my-gateway',
      model: 'gpt-5',
      sessionId: 'session-abc',
    })
    assert.equal(headers['x-claude-code-session-id'], undefined)
    assert.equal(headers['x-opencode-session'], undefined)
    assert.equal(headers['x-session-id'], undefined)
  })

  test('an existing header is preserved unless overwrite is on', async () => {
    const options = { provider: 'gw', model: 'claude-sonnet-4-6', sessionId: 'session-abc' }

    const kept = await callModel(baseConfig, options, {
      headers: { 'x-claude-code-session-id': 'from-caller' },
    })
    assert.equal(kept['x-claude-code-session-id'], 'from-caller')

    const replaced = await callModel(
      { ...baseConfig, overwrite: true },
      options,
      { headers: { 'x-claude-code-session-id': 'from-caller' } },
    )
    assert.equal(replaced['x-claude-code-session-id'], 'abc')
  })

  test('an existing but empty header is filled in', async () => {
    const headers = await callModel(
      baseConfig,
      { provider: 'gw', model: 'claude-sonnet-4-6', sessionId: 'session-abc' },
      { headers: { 'x-claude-code-session-id': '' } },
    )
    assert.equal(headers['x-claude-code-session-id'], 'abc')
  })

  test('a per-rule overwrite flag beats the global setting', async () => {
    const config = {
      ...baseConfig,
      overwrite: true,
      rules: [{ models: ['claude-*'], flavor: 'claude-code', overwrite: false }],
    }
    const headers = await callModel(config, {
      provider: 'gw',
      model: 'claude-sonnet-4-6',
      sessionId: 'session-abc',
    }, { headers: { 'x-claude-code-session-id': 'from-caller' } })
    assert.equal(headers['x-claude-code-session-id'], 'from-caller')
  })

  test('works when the model is an object', async () => {
    const headers = await callModel(baseConfig, {
      provider: { id: 'gw' },
      model: { id: 'claude-opus-4-6' },
      sessionId: 'session-obj',
    })
    assert.equal(headers['x-claude-code-session-id'], 'obj')
  })

  test('works with a Request object and keeps its method/body', async () => {
    const ctx = createCtx()
    apply(ctx, baseConfig)
    try {
      const handler = ctx.listeners.get('llm/stream')
      lastRequest = undefined
      const request = new Request(baseUrl, { method: 'POST', body: '{"a":1}' })
      const stream = handler(
        { provider: 'gw', model: 'claude-sonnet-4-6', sessionId: 'session-req' },
        async function* () {
          const response = await fetch(request)
          await response.text()
          yield 1
        },
      )
      for await (const _ of stream) { /* drain */ }
      assert.equal(lastRequest.method, 'POST')
      assert.equal(lastRequest.headers['x-claude-code-session-id'], 'req')
    } finally {
      ctx.dispose()
    }
  })

  test('calls without a session id pass through without headers', async () => {
    const headers = await callModel(baseConfig, {
      provider: 'gw',
      model: 'claude-sonnet-4-6',
    })
    assert.equal(headers['x-claude-code-session-id'], undefined)
  })
})

/* ------------------------------------------------------------------ */
/* Chat-header status                                                  */
/* ------------------------------------------------------------------ */

/** Fake res capturing one JSON reply. */
function fakeRes() {
  const res = {
    status: undefined,
    body: undefined,
    writeHead(status) {
      res.status = status
    },
    end(text) {
      res.body = JSON.parse(text)
    },
  }
  return res
}

/** createCtx plus the optional webServer/connection services; captures the route. */
function createStatusCtx({ trusted = true } = {}) {
  const ctx = createCtx()
  ctx.routes = []
  ctx.inject = (deps, fn) => {
    assert.deepEqual(deps, ['webServer', 'connection'])
    fn({
      effect: ctx.effect,
      webServer: {
        register(route) {
          ctx.routes.push(route)
          return () => {}
        },
      },
      connection: { requestRejection: () => (trusted ? undefined : { code: 'forbidden' }) },
    })
  }
  return ctx
}

/** GET the status route for one session. */
function readStatus(ctx, session) {
  const route = ctx.routes.find((candidate) => candidate.path === STATUS_ROUTE)
  assert.ok(route, 'status route registered')
  const res = fakeRes()
  route.handler({ method: 'GET', url: `${STATUS_ROUTE}?session=${encodeURIComponent(session)}` }, res)
  return res
}

describe('status store', () => {
  test('keeps the newest records per session, keyed by the bare id', () => {
    const store = createStatusStore({ perSession: 2, sessions: 2 })
    store.add('session-a', { n: 1 })
    store.add('a', { n: 2 })
    store.add('session-a', { n: 3 })
    assert.deepEqual(store.recent('a').map((entry) => entry.n), [3, 2])
    assert.deepEqual(store.recent('session-a').map((entry) => entry.n), [3, 2])
    store.add(undefined, { n: 9 })
    assert.deepEqual(store.recent(undefined), [])
  })

  test('evicts the least recently written session beyond the cap', () => {
    const store = createStatusStore({ perSession: 5, sessions: 2 })
    store.add('a', { n: 1 })
    store.add('b', { n: 2 })
    store.add('a', { n: 3 })
    store.add('c', { n: 4 })
    assert.deepEqual(store.recent('b'), [])
    assert.equal(store.recent('a').length, 2)
    assert.equal(store.recent('c').length, 1)
  })

  test('the handler fences, rejects non-GET and honours the toggle', () => {
    const store = createStatusStore()
    store.add('s1', { status: 'sent' })
    const get = (handler, method = 'GET') => {
      const res = fakeRes()
      handler({ method, url: `${STATUS_ROUTE}?session=session-s1` }, res)
      return res
    }
    assert.equal(get(createStatusHandler(store, () => true, () => false)).status, 403)
    assert.equal(get(createStatusHandler(store, () => true, () => true), 'POST').status, 405)
    const on = get(createStatusHandler(store, () => true, () => true))
    assert.equal(on.status, 200)
    assert.deepEqual(on.body.value, { enabled: true, session: 's1', records: [{ status: 'sent' }] })
    const off = get(createStatusHandler(store, () => false, () => true))
    assert.deepEqual(off.body.value, { enabled: false, session: 's1', records: [] })
  })
})

describe('status recording through llm/stream', () => {
  test('records sent, skipped and unmatched calls per conversation', async () => {
    const ctx = createStatusCtx()
    apply(ctx, baseConfig)
    try {
      await streamOnce(ctx, { provider: 'gw', model: 'claude-sonnet-4-6', sessionId: 'session-c1' })
      await streamOnce(
        ctx,
        { provider: 'gw', model: 'claude-sonnet-4-6', sessionId: 'session-c1' },
        { headers: { 'x-claude-code-session-id': 'adapter-value' } },
      )
      await streamOnce(ctx, { provider: 'gw', model: 'gpt-5', sessionId: 'session-c1' })
      await streamOnce(ctx, { provider: 'gw', model: 'claude-sonnet-4-6', sessionId: 'session-other' })

      const res = readStatus(ctx, 'session-c1')
      assert.equal(res.status, 200)
      assert.equal(res.body.value.enabled, true)
      const records = res.body.value.records
      // Newest first.
      assert.deepEqual(records.map((record) => record.status), ['unmatched', 'skipped', 'sent'])
      assert.deepEqual(records[2].headers, [['x-claude-code-session-id', 'c1']])
      assert.equal(records[2].model, 'claude-sonnet-4-6')
      assert.deepEqual(records[1].skipped, [['x-claude-code-session-id', 'adapter-value']])
      assert.deepEqual(records[0].headers, [])
      // Other conversations stay separate.
      assert.equal(readStatus(ctx, 'other').body.value.records.length, 1)
    } finally {
      ctx.dispose()
    }
  })

  test('the toggle is read live and an untrusted request is refused', async () => {
    let show = true
    const ctx = createStatusCtx()
    apply(ctx, { ...baseConfig, showStatus: { get: () => show } })
    try {
      await streamOnce(ctx, { provider: 'gw', model: 'claude-sonnet-4-6', sessionId: 'session-t1' })
      show = false
      await streamOnce(ctx, { provider: 'gw', model: 'claude-sonnet-4-6', sessionId: 'session-t1' })
      assert.deepEqual(readStatus(ctx, 't1').body.value, { enabled: false, session: 't1', records: [] })
      show = true
      // Only the call made while on was recorded.
      assert.equal(readStatus(ctx, 't1').body.value.records.length, 1)
    } finally {
      ctx.dispose()
    }

    const untrusted = createStatusCtx({ trusted: false })
    apply(untrusted, baseConfig)
    try {
      assert.equal(readStatus(untrusted, 't1').status, 403)
    } finally {
      untrusted.dispose()
    }
  })

  test('status defaults to on when showStatus is absent', async () => {
    const ctx = createStatusCtx()
    apply(ctx, { rules: baseConfig.rules })
    try {
      await streamOnce(ctx, { provider: 'gw', model: 'claude-sonnet-4-6', sessionId: 'session-d1' })
      assert.equal(readStatus(ctx, 'd1').body.value.records[0].status, 'sent')
    } finally {
      ctx.dispose()
    }
  })
})
