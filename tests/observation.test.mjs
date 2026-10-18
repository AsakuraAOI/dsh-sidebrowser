import test from 'node:test'
import assert from 'node:assert/strict'
import { clientHarness, hostHarness } from './harness.mjs'

const query = async (h, method, input = {}) => {
  const result = await h.provider.query(method, input, { sessionId: 'A' })
  assert.equal(result.ok, true, result.error)
  return result.value
}
const toolsFor = client => hostHarness({}, async (_platform, _provider, method, input) => client.provider.query(method, input, { sessionId: 'A' }))
const exec = () => ({ agent: {}, signal: new AbortController().signal })

test('HTS reproduction: native type + auto observation keeps the original submit ref and prioritizes its form', async () => {
  const nav = Array.from({ length: 75 }, (_, i) => `<a href="/nav/${i}">Navigation ${i}</a>`).join('')
  const h = clientHarness(nav + '<form id="mission"><section><label>Password <input id="password" name="password" type="password"></label></section><button id="submit">Submit</button></form>')
  const host = toolsFor(h)
  try {
    const list = await host.tools.get('browser_read').execute({ mode: 'elements' }, exec())
    assert.equal(list.elements.length, 77)
    const password = list.elements[75], submit = list.elements[76]
    const events = []
    h.guest.document.elementFromPoint = () => h.guest.document.querySelector('#password')
    Object.assign(h.elements.get('a'), { sendInputEvent: async event => events.push(event), insertText: async value => { h.guest.document.querySelector('#password').value = value } })
    const typed = await host.tools.get('browser_act').execute({ action: 'type', ref: password.ref, text: 'private-fixture-input', inputMode: 'native' }, exec())
    assert.equal(typed.backend, 'native')
    assert.equal(typed.observation.region.target.tag, 'form')
    assert.equal(typed.observation.elements.length, 2)
    assert.equal(typed.observation.elements.find(el => el.text === 'Submit').ref, submit.ref)
    assert.ok(!JSON.stringify(typed).includes('private-fixture-input'))
    h.guest.document.elementFromPoint = () => h.guest.document.querySelector('#submit')
    const clicked = await host.tools.get('browser_act').execute({ action: 'click', ref: submit.ref, inputMode: 'native' }, exec())
    assert.equal(clicked.backend, 'native')
    assert.equal(events.length, 3)
  } finally { host.dispose(); await h.close() }
})

test('scoped text/html/elements/snapshot exclude unrelated menus and honor the selected root and cap', async () => {
  const h = clientHarness('<nav><a href="/noise">MenuNoise</a></nav><main id="area"><h1>Mission</h1><form><input name="answer"><button>Check</button></form></main>')
  const host = toolsFor(h)
  try {
    const read = args => host.tools.get('browser_read').execute({ selector: '#area', ...args }, exec())
    assert.ok(!(await read({ mode: 'text' })).text.includes('MenuNoise'))
    assert.ok(!(await read({ mode: 'html' })).html.includes('MenuNoise'))
    assert.equal((await read({ mode: 'elements', maxElements: 1 })).elements.length, 1)
    assert.equal((await read({ mode: 'elements', maxElements: 1 })).truncated, true)
    const button = await host.tools.get('browser_read').execute({ mode: 'elements', selector: 'button' }, exec())
    assert.equal(button.elements.length, 1, 'scope includes the root itself')
    const scoped = await host.tools.get('browser_snapshot').execute({ selector: '#area' }, exec())
    assert.equal(scoped.elements.length, 2)
    assert.equal(scoped.links.length, 0)
    const byRef = await host.tools.get('browser_read').execute({ mode: 'html', ref: button.elements[0].ref }, exec())
    assert.ok(byRef.html.startsWith('<button'))
    await assert.rejects(read({ selector: 'not-found' }), /no-match/)
    assert.equal((await h.provider.query('snapshot', { selector: '*' }, { sessionId: 'A' })).ok, false)
  } finally { host.dispose(); await h.close() }
})

test('read truncation keeps valid refs, but URL/document/identity changes and foreign refs remain rejected', async () => {
  const h = clientHarness('<button id="first">First</button><button id="second">Second</button>')
  try {
    const first = await query(h, 'read', { mode: 'elements' }), secondRef = first.elements[1].ref
    await query(h, 'snapshot', { maxElements: 1 })
    assert.equal((await query(h, 'inspect', { ref: secondRef })).element.id, 'second')
    h.guest.document.querySelector('#second').textContent = 'Delete'
    assert.equal((await h.provider.query('inspect', { ref: secondRef }, { sessionId: 'A' })).ok, false)
    const changed = await query(h, 'read', { mode: 'elements' })
    assert.notEqual(changed.elements[1].ref, secondRef)
    const current = changed.elements[1].ref
    h.guest.document.querySelector('#second').outerHTML = '<button id="second">Delete</button>'
    assert.equal((await h.provider.query('inspect', { ref: current }, { sessionId: 'A' })).ok, false)
    const beforeRoute = (await query(h, 'read', { mode: 'elements' })).elements[0].ref
    h.guest.history.pushState({}, '', '/next')
    assert.equal((await h.provider.query('inspect', { ref: beforeRoute }, { sessionId: 'A' })).ok, false)
    const newRef = (await query(h, 'read', { mode: 'elements' })).elements[0].ref
    assert.notEqual(newRef, beforeRoute)
    const foreign = await h.provider.query('inspect', { tabId: 'a', ref: newRef }, { sessionId: 'B' })
    assert.equal(foreign.ok, false)
    h.guest.document.documentElement.innerHTML = '<head></head><body><button>Other document root</button></body>'
    // Replacing a node in the same root still refuses its old ref.
    assert.equal((await h.provider.query('inspect', { ref: newRef }, { sessionId: 'A' })).ok, false)
  } finally { await h.close() }
})

test('ref registry is bounded and does not silently retarget an evicted reference', async () => {
  const html = Array.from({ length: 4 }, (_, group) => `<section id="g${group}">${Array.from({ length: 300 }, (_, n) => `<button>${group}:${n}</button>`).join('')}</section>`).join('')
  const h = clientHarness(html)
  try {
    const old = (await query(h, 'read', { mode: 'elements', selector: '#g0' })).elements[0].ref
    for (let group = 1; group < 4; group++) await query(h, 'read', { mode: 'elements', selector: '#g' + group })
    assert.equal(h.guest.__dshSidebrowserRefs.size, 1000)
    assert.equal((await h.provider.query('inspect', { ref: old }, { sessionId: 'A' })).ok, false)
    const renewed = await query(h, 'read', { mode: 'elements', selector: '#g0' })
    assert.notEqual(renewed.elements[0].ref, old)
  } finally { await h.close() }
})

test('eval budget propagates and timeout reports possible ongoing side effects without replay', async () => {
  const calls = [], host = hostHarness({}, async (_platform, _provider, method, input) => { calls.push({ method, input }); return { transportVersion: 1, ok: true, value: {} } })
  try {
    await host.tools.get('browser_eval').execute({ code: '1', timeoutMs: 99999 }, exec())
    assert.equal(calls[0].input.timeoutMs, 30000)
  } finally { host.dispose() }
  const h = clientHarness()
  try {
    let executions = 0
    h.elements.get('a').executeJavaScript = () => { executions++; return new Promise(() => {}) }
    const result = await h.provider.query('eval', { code: 'pending()', timeoutMs: 1000 }, { sessionId: 'A' })
    assert.equal(result.ok, false)
    assert.match(result.error, /writes may already have happened|writes may/i)
    assert.match(result.error, /AbortController/)
    assert.equal(executions, 1)
  } finally { await h.close() }
})

test('eval does not dispatch a script when navigation waiting has already exhausted its budget', async () => {
  const h = clientHarness()
  try {
    let executions = 0
    h.elements.get('a').isLoading = () => true
    h.elements.get('a').executeJavaScript = async () => { executions++; return {} }
    const result = await h.provider.query('eval', { code: 'potentialWrite()', timeoutMs: 1000 }, { sessionId: 'A' })
    assert.equal(result.ok, false)
    assert.match(result.error, /before dispatch.*not started/)
    assert.equal(executions, 0)
  } finally { await h.close() }
})
