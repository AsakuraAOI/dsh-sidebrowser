import test from 'node:test'
import assert from 'node:assert/strict'
import { clientHarness, hostHarness } from './harness.mjs'

const call = async (h, method, input = {}, sessionId = 'A') => {
  const reply = await h.provider.query(method, input, { sessionId })
  assert.equal(reply.ok, true, reply.error)
  return reply.value
}

test('all diagnostic tools use browser_dev_* and old names are absent', () => {
  const h = hostHarness()
  try {
    const dev = [...h.tools.keys()].filter(name => name.startsWith('browser_dev_'))
    assert.equal(dev.length, 9)
    for (const name of ['browser_console','browser_network','browser_debug','browser_inspect','browser_styles']) assert.equal(h.tools.has(name), false)
  } finally { h.dispose() }
})

test('inspection reads two viewport layers, computed layout and credential-safe attributes without changing styles', async () => {
  const h = clientHarness('<style>#target{display:flex;width:180px;overflow:hidden}</style><div id="target"><input type="password" value="secret-sentinel"></div>')
  try {
    const before = h.elements.get('a').style.cssText
    const result = await call(h, 'inspect', { selector: '#target' })
    assert.equal(result.styles.display, 'flex')
    assert.equal(result.rect.width, 200)
    assert.equal(result.hostViewport.guest.transform, '')
    assert.equal(h.elements.get('a').style.cssText, before)
    const password = await call(h, 'inspect', { selector: 'input' })
    assert.ok(!JSON.stringify(password).includes('secret-sentinel'))
    const other = await h.provider.query('inspect', { tabId: 'a' }, { sessionId: 'B' })
    assert.equal(other.ok, false)
    const ambiguous = await h.provider.query('inspect', { selector: '*' }, { sessionId: 'A' })
    assert.match(ambiguous.error, /ambiguous/)
  } finally { await h.close() }
})

test('readable CSS rules, temporary patches, conflict-aware restore and plugin cleanup work', async () => {
  const h = clientHarness('<style>#target{color:rgb(255,0,0)}</style><div id="target"></div>')
  try {
    const rules = await call(h, 'styles', { selector: '#target' })
    assert.ok(rules.matchedRules.some(rule => rule.selector === '#target'))
    const patch = await call(h, 'styles', { action: 'set', selector: '#target', styles: { width: '120px', height: '40px' } })
    assert.equal(h.guest.document.querySelector('#target').style.width, '120px')
    h.guest.document.querySelector('#target').style.width = '200px'
    const restored = await call(h, 'styles', { action: 'restore', patchId: patch.patchId })
    assert.deepEqual([...restored.conflicts], ['width'])
    assert.equal(h.guest.document.querySelector('#target').style.width, '200px')
    assert.equal(h.guest.document.querySelector('#target').style.height, '')
    await call(h, 'styles', { action: 'set', selector: '#target', styles: { height: '70px' } })
    h.provider.dispose(); await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(h.guest.document.querySelector('#target').style.height, '')
  } finally { await h.close() }
})

test('structured Console supports cycles/live handles without executing getters and invalidates handles on stop', async () => {
  const h = clientHarness()
  try {
    await call(h, 'debug', { action: 'start' })
    h.guest.eval(`window.getterCalls=0;window.logged={answer:42,password:'private-sentinel'};logged.self=logged;Object.defineProperty(logged,'danger',{get(){getterCalls++;return 'bad'},enumerable:true});console.log('structured-fixture',logged)`)
    const logs = await call(h, 'console', { source: 'structured' })
    const entry = logs.entries.find(row => row.message.includes('structured-fixture'))
    const id = entry.args[1].objectId
    assert.ok(id)
    h.guest.logged.answer = 43
    const expanded = await call(h, 'console', { objectId: id })
    assert.equal(expanded.properties.find(p => p.name === 'answer').value.value, 43)
    assert.equal(expanded.properties.find(p => p.name === 'danger').accessor, true)
    assert.equal(expanded.properties.find(p => p.name === 'self').value.objectId, id)
    assert.equal(h.guest.getterCalls, 0)
    assert.ok(!JSON.stringify(logs).includes('private-sentinel'))
    await call(h, 'debug', { action: 'stop' })
    const stale = await h.provider.query('console', { objectId: id }, { sessionId: 'A' })
    assert.equal(stale.ok, false)
    assert.match(stale.error, /expired|another document/)
  } finally { await h.close() }
})

test('watch records events/mutations/registration calls, omits input values and restores event methods', async () => {
  const h = clientHarness('<div id="target"><input value="never-return-this"></div>')
  try {
    const before = h.guest.EventTarget.prototype.addEventListener
    const watch = await call(h, 'watch', { action: 'start', selector: '#target', trackListeners: true, events: ['input'] })
    // Happy DOM elements use an internal EventTarget base distinct from the
    // window export. Exercise that wrapper explicitly here; the Electron
    // fixture verifies ordinary element.addEventListener calls end to end.
    h.guest.eval(`EventTarget.prototype.addEventListener.call(document.querySelector('input'),'change',()=>{});document.querySelector('input').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#target').setAttribute('data-test','changed')`)
    await new Promise(resolve => setTimeout(resolve, 10))
    const result = await call(h, 'watch', { watchId: watch.watchId })
    assert.ok(result.entries.some(row => row.kind === 'event'))
    assert.ok(result.entries.some(row => row.kind === 'mutation'))
    assert.ok(result.entries.some(row => row.kind === 'listener-registration'))
    assert.ok(!JSON.stringify(result).includes('never-return-this'))
    await call(h, 'watch', { action: 'stop', watchId: watch.watchId })
    assert.equal(h.guest.EventTarget.prototype.addEventListener, before)
  } finally { await h.close() }
})

test('performance reports capability/visibility and storage and source reads remain bounded and read-only', async () => {
  const h = clientHarness('<script>window.inlineFixture=42;</script><h1>Data</h1>')
  try {
    const perf = await call(h, 'performance', { sampleMs: 10 })
    assert.ok(Array.isArray(perf.supportedEntryTypes))
    assert.ok(perf.scope.includes('No CPU profile'))
    assert.equal((await call(h, 'performance', { action: 'stop' })).recording, false)
    h.guest.localStorage.setItem('theme','dark')
    h.guest.localStorage.setItem('api_token','private-sentinel')
    const list = await call(h, 'storage')
    assert.ok(list.keys.includes('theme'))
    assert.equal((await call(h, 'storage', { action: 'get', key: 'theme' })).value, 'dark')
    assert.equal((await call(h, 'storage', { action: 'get', key: 'api_token' })).value, '[redacted]')
    assert.equal(h.guest.localStorage.getItem('api_token'), 'private-sentinel')
    const sources = await call(h, 'sources')
    const source = await call(h, 'sources', { action: 'get', sourceId: sources.sources[0].sourceId })
    assert.ok(source.text.includes('inlineFixture=42'))
  } finally { await h.close() }
})
