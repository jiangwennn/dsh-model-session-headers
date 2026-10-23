import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, describe, test } from 'node:test'

import {
  apply,
  buildHeaders,
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

/** Drive one fake llm/stream call through the plugin and return the headers. */
async function callModel(config, options, init = {}) {
  const ctx = createCtx()
  const originalFetch = globalThis.fetch
  apply(ctx, config)
  try {
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
