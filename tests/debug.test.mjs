import test from 'node:test'
import assert from 'node:assert/strict'
import { clientHarness, hostHarness } from './harness.mjs'

const call = async (h, method, input = {}, sessionId = 'A') => {
  const result = await h.provider.query(method, input, { sessionId })
  assert.equal(result.ok, true, result.error)
  return result.value
}
const nativeConsole = (h, message, level = 'info') => {
  const event = new h.host.Event('console-message')
  Object.assign(event, { message, level, sourceId: 'https://fixture.invalid/app.js', line: 3 })
  h.elements.get('a').dispatchEvent(event)
}
const fakeFetch = h => h.guest.eval(`window.originalFetch = window.fetch = function(input) {
  window.fetchCount = (window.fetchCount || 0) + 1;
  if (String(input).includes('fail')) return Promise.reject(new TypeError('fixture offline'));
  return Promise.resolve(new Response(String(input).includes('large') ? 'x'.repeat(40000) : '{"ok":true}',
    {status: String(input).includes('http-error') ? 503 : 200, headers:{'content-type':'application/json','x-fixture':'yes'}}));
}`)

test('debug tools route through the validated Session Inspect provider, even with arbitrary eval disabled', async () => {
  const calls = []
  const h = hostHarness({ enableEval: false }, async (...args) => { calls.push(args); return { transportVersion: 1, ok: true, value: { recording: true } } })
  const agent = {}, signal = new AbortController().signal
  for (const [name, method] of [['browser_dev_debug', 'debug'], ['browser_dev_console', 'console'], ['browser_dev_network', 'network']]) {
    await h.tools.get(name).execute({ tabId: 'a' }, { agent, signal })
    assert.equal(calls.at(-1)[2], method)
    assert.equal(calls.at(-1)[4], agent)
    assert.equal(calls.at(-1)[5], signal)
    await assert.rejects(h.tools.get(name).execute({}, {}), /Agent/)
  }
  h.dispose()
})

test('console native events, uncaught errors and rejections have bounded, pageable history', async () => {
  const h = clientHarness()
  try {
    assert.equal((await call(h, 'debug')).recording, false)
    nativeConsole(h, 'before start')
    const start = await call(h, 'debug', { action: 'start', maxEntries: 10 })
    assert.equal(start.capabilities.nativeCDP, false)
    for (let i = 0; i < 15; i++) nativeConsole(h, `log ${i}`, i === 14 ? 'warning' : 'log')
    h.guest.dispatchEvent(new h.guest.ErrorEvent('error', { message: 'uncaught fixture', filename: 'https://fixture.invalid/app.js', lineno: 9 }))
    const rejection = new h.guest.Event('unhandledrejection')
    rejection.reason = new Error('rejection fixture')
    h.guest.dispatchEvent(rejection)
    const logs = await call(h, 'console', { sinceId: 0, limit: 2 })
    assert.equal(logs.entries.length, 2)
    assert.equal(logs.truncated, true)
    assert.ok(logs.droppedConsole >= 7)
    const next = await call(h, 'console', { sinceId: logs.nextSinceId })
    assert.ok(next.entries.every(row => row.id > logs.nextSinceId))
    assert.ok(next.entries.some(row => row.source === 'page-error' && row.message === 'uncaught fixture'))
    assert.ok(next.entries.some(row => row.source === 'unhandled-rejection' && row.message.includes('rejection fixture')))
    assert.ok(!JSON.stringify(next.entries).includes('before start'))
    assert.equal((await call(h, 'console', { level: 'warning' })).entries[0].message, 'log 14')
    assert.equal((await call(h, 'console')).entries.length, 10, 'pulling again must not duplicate errors')
  } finally { await h.close() }
})

test('Fetch records page-visible details and failure without replay, truncates body previews and restores native functions', async () => {
  const h = clientHarness()
  try {
    fakeFetch(h)
    await call(h, 'debug', { action: 'start', captureBodies: true })
    await h.guest.eval(`fetch('/api?token=private-query', {method:'POST', headers:{Authorization:'private-auth', 'X-Test':'value'}, body:'request fixture'})`)
    await h.guest.eval(`fetch('/large')`)
    await h.guest.eval(`fetch('/http-error')`)
    await assert.rejects(h.guest.eval(`fetch('/fail')`), /fixture offline/)
    await new Promise(resolve => setTimeout(resolve, 20))
    const list = await call(h, 'network')
    assert.equal(list.requests.length, 4)
    assert.equal(h.guest.fetchCount, 4)
    assert.ok(!JSON.stringify(list).includes('private-query'))
    const first = await call(h, 'network', { requestId: list.requests[0].id })
    assert.equal(first.request.requestHeaders.authorization, '[redacted]')
    assert.equal(first.request.requestBody.text, 'request fixture')
    assert.equal(first.request.responseBody.text, '{"ok":true}')
    const large = await call(h, 'network', { requestId: list.requests[1].id, maxChars: 30000 })
    assert.equal(large.request.responseBody.text.length, 16384)
    assert.equal(large.request.responseBody.truncated, true)
    assert.equal(list.requests[2].status, 503)
    assert.equal(list.requests[2].state, 'complete')
    assert.equal(list.requests[3].state, 'failed')
    const clipped = await call(h, 'network', { requestId: list.requests[1].id, maxChars: 1000 })
    assert.equal(clipped.truncated, true)
    assert.ok(clipped.detailPreview.length <= 1000)
    const stopped = await call(h, 'debug', { action: 'stop' })
    assert.equal(stopped.pageHooksRestored, true)
    assert.equal(h.guest.fetch, h.guest.originalFetch)
    assert.equal(h.provider.debug.states.size, 0)
  } finally { await h.close() }
})

test('default recording omits bodies; foreign Session and request ids cannot read another tab', async () => {
  const h = clientHarness()
  try {
    fakeFetch(h)
    // Give B a separate document realm, as actual webviews have. The base
    // harness deliberately shares A's fake guest for unrelated input tests.
    h.elements.get('b').executeJavaScript = code => Promise.resolve(h.host.eval(code))
    assert.equal((await call(h, 'network')).startedNow, true)
    await h.guest.eval(`fetch('/api', {method:'POST',body:'body sentinel'})`)
    const rows = await call(h, 'network')
    const detail = await call(h, 'network', { requestId: rows.requests[0].id })
    assert.match(detail.request.requestBody.unavailable, /disabled/)
    assert.ok(!JSON.stringify(detail).includes('body sentinel'))
    const denied = await h.provider.query('network', { tabId: 'a' }, { sessionId: 'B' })
    assert.equal(denied.ok, false)
    assert.match(denied.error, /no browser tab/)
    const missing = await h.provider.query('network', { requestId: rows.requests[0].id }, { sessionId: 'B' })
    assert.equal(missing.ok, false)
    assert.match(missing.error, /not found/)
  } finally { await h.close() }
})

test('clear and navigation reset revision cursors, bound request history and clean up removed Sessions', async () => {
  const h = clientHarness()
  try {
    fakeFetch(h)
    await call(h, 'debug', { action: 'start', maxEntries: 10 })
    for (let i = 0; i < 14; i++) await h.guest.eval(`fetch('/api/${i}')`)
    assert.equal((await call(h, 'network')).requests.length, 10)
    await call(h, 'debug', { action: 'clear' })
    assert.equal((await call(h, 'network')).requests.length, 0)
    nativeConsole(h, 'cleared')
    // Simulate replacing the document realm's recorder with a new document.
    h.guest.eval(`window.__dshSidebrowserDebugV1__.stop(); delete window.__dshSidebrowserDebugV1__`)
    h.elements.get('a').dispatchEvent(new h.host.Event('dom-ready'))
    await call(h, 'debug')
    await h.guest.eval(`fetch('/after-navigation')`)
    const rows = await call(h, 'network')
    assert.ok(rows.requests.some(row => row.url.endsWith('/after-navigation')))
    h.emit('api-session/removed', 'A')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(h.provider.debug.states.size, 0)
    assert.equal(h.guest.fetch, h.guest.originalFetch)
  } finally { await h.close() }
})

test('stopping does not overwrite site replacements installed after recording began', async () => {
  const h = clientHarness()
  try {
    fakeFetch(h)
    await call(h, 'debug', { action: 'start' })
    h.guest.eval(`window.siteFetch = window.fetch = function(){return Promise.resolve('site replacement')}`)
    await call(h, 'debug', { action: 'stop' })
    assert.equal(h.guest.fetch, h.guest.siteFetch)
  } finally { await h.close() }
})

test('small output budgets retain a usable cursor and read-only hooks are reported honestly', async () => {
  const h = clientHarness()
  try {
    fakeFetch(h)
    h.guest.eval(`Object.defineProperty(window,'fetch',{value:fetch,writable:false,configurable:true})`)
    const start = await call(h, 'debug', { action: 'start' })
    assert.equal(start.hooks.fetch, false)
    assert.ok(start.hookErrors.some(error => error.includes('fetch')))
    nativeConsole(h, 'x'.repeat(6000))
    nativeConsole(h, 'next entry')
    const logs = await call(h, 'console', { sinceId: 0, maxChars: 1000 })
    assert.equal(logs.entries.length, 1)
    assert.equal(logs.entries[0].truncated, true)
    assert.equal(logs.truncated, true)
    assert.equal((await call(h, 'console', { sinceId: logs.nextSinceId })).entries[0].message, 'next entry')
    assert.equal((await call(h, 'debug', { action: 'stop' })).pageHooksRestored, true)
  } finally { await h.close() }
})
