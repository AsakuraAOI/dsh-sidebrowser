import test from 'node:test'
import assert from 'node:assert/strict'
import { clientHarness, hostHarness } from './harness.mjs'

test('Host registers ten browser_* tools and an optional workflow skill', () => {
  const h = hostHarness()
  assert.equal(h.tools.size, 10)
  assert.ok([...h.tools.keys()].every(name => name.startsWith('browser_')))
  assert.equal(h.skills[0].name, 'dsh-sidebrowser')
  assert.ok(h.skills[0].content.includes('不等于业务任务成功'))
  h.dispose(); assert.equal(h.tools.size, 0)
})

test('snapshots redact credential values, include rendered structures and reject old ref generations', async () => {
  const h = clientHarness('<h1>Fixture</h1><input id="name" value="Mira"><input type="password" value="private-sentinel"><input name="api_key" value="private-key"><a href="/next">Next</a>')
  try {
    const first = await h.driver.snapshot('A', {})
    assert.equal(first.headings[0].text, 'Fixture')
    assert.equal(first.links[0].href, 'https://fixture.invalid/next')
    assert.ok(!JSON.stringify(first).includes('private-sentinel'))
    assert.ok(!JSON.stringify(first).includes('private-key'))
    assert.ok(first.elements.some(el => el.value === 'Mira'))
    const ref = first.elements[0].ref
    await h.driver.snapshot('A', {})
    await assert.rejects(h.driver.act('A', { action: 'click', ref, inputMode: 'dom' }), /latest|ref|read/i)
  } finally { await h.close() }
})

test('same-session inventory is required; foreign and orphan DOM are never targeted', async () => {
  const h = clientHarness('<button>Save</button>')
  try {
    assert.equal(h.driver.guests('A').size, 1)
    assert.throws(() => h.driver.resolve('A', 'b'), /no browser tab/)
    h.host.document.querySelector('[data-sidebar-right-session="A"]').removeAttribute('data-sidebar-right-session')
    assert.equal(h.driver.guests('A').size, 0)
  } finally { await h.close() }
})

test('DOM selectors refuse ambiguity and native requests refuse silent downgrade', async () => {
  const h = clientHarness('<button>One</button><button>Two</button>')
  try {
    await assert.rejects(h.driver.act('A', { action: 'click', selector: 'button', inputMode: 'dom' }), /multiple elements/)
    await assert.rejects(h.driver.act('A', { action: 'click', selector: 'button', inputMode: 'native' }), /native input API/)
  } finally { await h.close() }
})

test('native click dispatches browser events; type uses insertText and does not return its contents', async () => {
  const h = clientHarness('<input id="name" data-hit><button>Save</button>')
  try {
    const events = [], texts = [], deletions = []
    Object.assign(h.elements.get('a'), { sendInputEvent: async event => events.push(event), insertText: async text => texts.push(text), delete: async () => deletions.push(true) })
    const clicked = await h.driver.act('A', { action: 'click', selector: '#name' })
    assert.equal(clicked.backend, 'native')
    assert.deepEqual(events.map(event => event.type), ['mouseMove','mouseDown','mouseUp'])
    const typed = await h.driver.act('A', { action: 'type', selector: '#name', text: 'input-sentinel' })
    assert.deepEqual(texts, ['input-sentinel'])
    assert.ok(!JSON.stringify(typed).includes('input-sentinel'))
    assert.equal(typed.verificationRequired, true)
    await h.driver.act('A', { action: 'type', selector: '#name', text: '' })
    assert.equal(deletions.length, 1)
  } finally { await h.close() }
})

test('native click refuses covered, disabled and out-of-viewport targets', async () => {
  const h = clientHarness('<input id="target"><button data-hit>Overlay</button>')
  try {
    const events = []; h.elements.get('a').sendInputEvent = async value => events.push(value)
    await assert.rejects(h.driver.act('A', { action: 'click', selector: '#target' }), /covered-element/)
    h.guest.document.querySelector('#target').disabled = true
    await assert.rejects(h.driver.act('A', { action: 'click', selector: '#target' }), /disabled-element/)
    await assert.rejects(h.driver.act('A', { action: 'click_xy', x: -1, y: 10 }), /inside/)
    assert.equal(events.length, 0)
  } finally { await h.close() }
})

test('table extraction returns loaded cells with explicit truncation', async () => {
  const h = clientHarness('<table><tr><th>Name</th><th>Score</th></tr><tr><td>Mira</td><td>92</td></tr></table><ul><li>One</li><li>Two</li></ul>')
  try {
    const tables = await h.driver.extract('A', { kind: 'tables' })
    assert.deepEqual(JSON.parse(JSON.stringify(tables.items[0].rows)), [['Name','Score'],['Mira','92']])
    const list = await h.driver.extract('A', { kind: 'list', limit: 1 })
    assert.equal(list.items.length, 1); assert.equal(list.truncated, true)
  } finally { await h.close() }
})

test('a page failure returns a valid Inspect result immediately instead of timing out', async () => {
  const h = clientHarness('<button>Test</button>')
  try {
    const start = Date.now()
    const result = await h.provider.query('act', { action: 'click', selector: '#missing' }, { sessionId: 'A' })
    assert.equal(result.ok, false); assert.equal(result.transportVersion, 1)
    assert.match(result.error, /no element|target|no-match/)
    assert.ok(Date.now() - start < 1000)
  } finally { await h.close() }
})

test('eval awaits promises, limits large results and never retries runtime SyntaxError', async () => {
  const h = clientHarness()
  try {
    const evaluate = code => h.driver.evaluate('A', { code })
    assert.equal((await evaluate('Promise.resolve({answer:42})')).value.answer, 42)
    await assert.rejects(evaluate('(()=>{window.attempts=(window.attempts||0)+1;throw new SyntaxError("runtime");})()'), /runtime/)
    assert.equal(h.guest.attempts, 1)
    assert.equal((await evaluate('"x".repeat(60000)')).truncated, true)
  } finally { await h.close() }
})

test('action result includes an actual follow-up observation; empty input is preserved', async () => {
  const calls = []
  const h = hostHarness({}, async (_platform, _provider, method, input) => {
    calls.push({ method, input })
    return { transportVersion: 1, ok: true, value: method === 'act' ? { tabId: 'a', action: 'type', url: 'https://fixture.invalid/', title: '', loading: false } : { tabId: 'a', text: 'Updated' } }
  })
  const result = await h.tools.get('browser_act').execute({ action: 'type', text: '' }, { agent: {}, signal: new AbortController().signal })
  assert.equal(calls[0].input.text, '')
  assert.deepEqual(calls.map(call => call.method), ['act', 'snapshot'])
  assert.equal(result.observation.text, 'Updated')
})

test('eval-disabled deployment blocks the browser tool and the raw Inspect tool route', async () => {
  const h = hostHarness({ enableEval: false })
  await assert.rejects(h.tools.get('browser_eval').execute({ code: '1' }, { agent: {} }), /disabled/)
  assert.ok(h.guards.some(guard => guard({ name: 'cordis_inspect_query', arguments: { platform: 'client', provider: 'DSHSideBrowser', method: 'eval' } })))
})

test('a missing compositor frame is diagnosed before sending native input', async () => {
  const h = clientHarness('<button>Save</button>')
  try {
    let sent = 0
    Object.assign(h.elements.get('a'), { sendInputEvent: async () => sent++, capturePage: async () => { throw new Error('UnknownVizError') } })
    await assert.rejects(h.driver.act('A', { action: 'click', selector: 'button', inputMode: 'native' }), /drawn compositor frame/)
    assert.equal(sent, 0)
    const auto = await h.driver.act('A', { action: 'click', selector: 'button' })
    assert.equal(auto.backend, 'dom'); assert.equal(auto.nativeFallbackReason, 'pointer-paint-unavailable')
  } finally { await h.close() }
})

test('Web iframe is reported accurately and cannot be driven', async () => {
  const h = clientHarness()
  try {
    const view = h.elements.get('a'), iframe = h.host.document.createElement('iframe')
    iframe.dataset.sidebarBrowserFrame = 'iframe'; view.replaceWith(iframe)
    const result = await h.provider.query('snapshot', {}, { sessionId: 'A' })
    assert.equal(result.ok, false); assert.match(result.error, /Web profile|iframe/)
    const listed = await h.driver.listTabs('A')
    assert.equal(listed.tabs[0].carrier, 'iframe'); assert.equal(listed.tabs[0].mounted, true)
  } finally { await h.close() }
})

test('overlapping operations are refused rather than queued beyond their tool lifetime', async () => {
  const h = clientHarness('<button>Save</button>')
  try {
    let release
    h.elements.get('a').executeJavaScript = () => new Promise(resolve => { release = resolve })
    const first = h.provider.query('read', {}, { sessionId: 'A' })
    await new Promise(resolve => setTimeout(resolve, 10))
    const overlap = await h.provider.query('act', { action: 'click', selector: 'button' }, { sessionId: 'A' })
    assert.equal(overlap.ok, false); assert.match(overlap.error, /in progress/)
    release({ url: 'https://fixture.invalid/', title: '', text: 'Ready', truncated: false })
    assert.equal((await first).ok, true)
  } finally { await h.close() }
})

// Values are compared field by field, never with deepEqual: the store's objects
// are created inside the carrier's realm, so their prototype is not this file's
// `Object.prototype` and a strict deep comparison fails on two equal objects.
test('a per-tab viewport choice never rewrites the default new tabs inherit', async () => {
  const h = clientHarness()
  try {
    const { viewportStore } = h.api.__viewport
    const draft = { byTab: {}, custom: { width: 390, height: 844 }, lastPreset: 'auto' }
    viewportStore.actions.set(draft, 'a', 'desktop')
    assert.equal(draft.byTab.a.preset, 'desktop')
    // The regression: `set` used to write `lastPreset` too, so sizing one tab
    // silently rescaled every tab that had no record of its own.
    assert.equal(draft.lastPreset, 'auto')
    viewportStore.actions.setDefault(draft, 'phone')
    assert.equal(draft.lastPreset, 'phone')
    assert.equal(draft.byTab.a.preset, 'desktop')
    viewportStore.actions.restore(draft, { byTab: {}, custom: { width: 390, height: 844 }, lastPreset: 'auto' })
    assert.equal(draft.lastPreset, 'auto')
    assert.equal(Object.keys(draft.byTab).length, 0)
  } finally { await h.close() }
})

test('an open tab keeps its size when the default for new tabs changes', async () => {
  const h = clientHarness()
  try {
    const { ViewportController } = h.api.__viewport
    const state = { byTab: {}, custom: { width: 390, height: 844 }, lastPreset: 'auto' }
    const store = {
      getSnapshot: () => state,
      actions: {
        set: (tabId, preset) => { state.byTab[tabId] = { preset } },
        restore: (value) => { Object.assign(state, value) },
      },
    }
    const controller = new ViewportController(store)
    controller.apply('A', 'a')
    // A tab with no record of its own inherits the default once, then owns it.
    assert.equal(state.byTab.a.preset, 'auto')
    state.lastPreset = 'desktop'
    controller.apply('A', 'a')
    assert.equal(controller.frameOf('a').preset, 'auto')
    assert.equal(state.byTab.a.preset, 'auto')
  } finally { await h.close() }
})
