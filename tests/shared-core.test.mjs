import test from 'node:test'
import assert from 'node:assert/strict'
import { clientHarness } from './harness.mjs'

const query = async (h, method, input = {}) => {
  const reply = await h.provider.query(method, input, { sessionId: 'A' })
  assert.equal(reply.ok, true, reply.error)
  return reply.value
}

test('ordinary reads/waits and native actions share visibility/disabled decisions with inspection', async () => {
  const h = clientHarness('<button id="target" data-hit aria-disabled="true">Save</button>')
  try {
    const listed = await query(h, 'read', { mode: 'elements' })
    assert.equal(listed.elements[0].disabled, true)
    assert.equal(h.guest.__dshSidebrowserDiagnosticsV1__, undefined)
    assert.equal(h.guest.__dshSidebrowserDebugV1__, undefined)
    h.elements.get('a').sendInputEvent = async () => { throw new Error('A blocked action must not dispatch') }
    const blocked = await h.provider.query('act', { action: 'click', selector: '#target', inputMode: 'native' }, { sessionId: 'A' })
    assert.match(blocked.error, /disabled-element/)
    assert.equal(h.guest.__dshSidebrowserDiagnosticsV1__, undefined)
    const state = await query(h, 'inspect', { selector: '#target' })
    assert.equal(state.state.disabled, listed.elements[0].disabled)
    assert.equal(state.state.visible, true)
    h.guest.document.querySelector('#target').style.opacity = '0'
    assert.equal((await query(h, 'read', { mode: 'elements' })).elements.length, 0)
    assert.equal((await query(h, 'inspect', { selector: '#target' })).state.visible, false)
    assert.equal((await query(h, 'act', { action: 'wait', selector: '#target', state: 'hidden', timeoutMs: 100 })).matched, true)
  } finally { await h.close() }
})

test('native clicks and inspection use the same hit test without mutating the inspection target', async () => {
  const h = clientHarness('<button id="target">Save</button><button id="overlay" data-hit>Overlay</button>')
  try {
    const before = h.guest.document.querySelector('#target').style.cssText
    const inspected = await query(h, 'inspect', { selector: '#target' })
    assert.equal(inspected.hitTest.targetContainsHit, false)
    assert.equal(inspected.hitTest.hit.id, 'overlay')
    let sent = 0
    h.elements.get('a').sendInputEvent = async () => { sent++ }
    const refused = await h.provider.query('act', { action: 'click', selector: '#target', inputMode: 'native' }, { sessionId: 'A' })
    assert.match(refused.error, /covered-element/)
    assert.equal(sent, 0)
    assert.equal(h.guest.document.querySelector('#target').style.cssText, before)
    h.guest.document.querySelector('#overlay').removeAttribute('data-hit')
    h.guest.document.querySelector('#target').setAttribute('data-hit', '')
    assert.equal((await query(h, 'inspect', { selector: '#target' })).hitTest.targetContainsHit, true)
    assert.equal((await query(h, 'act', { action: 'click', selector: '#target', inputMode: 'native' })).backend, 'native')
    assert.equal(sent, 3)
  } finally { await h.close() }
})

test('partial viewport clipping retains distinct action and inspection point policies over shared geometry', async () => {
  const h = clientHarness('<button id="target" data-hit>Save</button>')
  try {
    const el = h.guest.document.querySelector('#target')
    el.getBoundingClientRect = () => ({ x: -190, y: 10, left: -190, top: 10, right: 10, bottom: 50, width: 200, height: 40 })
    const inspected = await query(h, 'inspect', { selector: '#target' })
    assert.equal(inspected.state.inViewport, true)
    assert.equal(inspected.hitTest.x, 0, 'inspection clamps the element center and does not scroll')
    const events = []; h.elements.get('a').sendInputEvent = async event => events.push(event)
    await query(h, 'act', { action: 'click', selector: '#target', inputMode: 'native' })
    assert.equal(events[0].x, 5, 'native input uses the center of the visible intersection')
  } finally { await h.close() }
})

test('credential fields are consistently masked in ordinary reads and developer inspection', async () => {
  const h = clientHarness('<input id="api_key" value="private-key-sentinel"><input autocomplete="one-time-code" value="private-otp-sentinel">')
  try {
    const ordinary = await query(h, 'read', { mode: 'elements' })
    const developer = await query(h, 'inspect', { selector: '#api_key' })
    const otp = await query(h, 'inspect', { selector: 'input[autocomplete]' })
    assert.ok(!JSON.stringify([ordinary, developer, otp]).includes('private-'))
    assert.equal(developer.state.sensitive, true)
    assert.equal(otp.state.sensitive, true)
  } finally { await h.close() }
})

test('waiting preserves first-match selection while actions and inspection still reject ambiguity', async () => {
  const h = clientHarness('<button>One</button><button>Two</button>')
  try {
    assert.equal((await query(h, 'act', { action: 'wait', selector: 'button', state: 'attached', timeoutMs: 100 })).matched, true)
    for (const [method, input] of [['act', { action: 'click', selector: 'button', inputMode: 'dom' }], ['inspect', { selector: 'button' }]]) {
      const result = await h.provider.query(method, input, { sessionId: 'A' })
      assert.equal(result.ok, false)
      assert.match(result.error, /multiple elements|ambiguous/)
    }
  } finally { await h.close() }
})

test('network and source previews share UTF-8 byte limits without consuming the application response', async () => {
  const h = clientHarness('<script type="application/x-dsh-fixture" src="/unicode-source"></script>')
  try {
    h.guest.eval(`window.fetch=async function(){return new Response('汉'.repeat(6000),{headers:{'content-type':'text/plain'}})}`)
    await query(h, 'debug', { action: 'start', captureBodies: true })
    const body = await h.guest.eval(`fetch('/unicode-network').then(response=>response.text())`)
    assert.equal(body.length, 6000)
    const sources = await query(h, 'sources')
    const source = await query(h, 'sources', { action: 'get', sourceId: sources.sources[0].sourceId, maxChars: 30000 })
    let detail
    for (let i = 0; i < 20; i++) {
      const rows = await query(h, 'network', { urlContains: '/unicode-network' })
      detail = await query(h, 'network', { requestId: rows.requests[0].id, maxChars: 30000 })
      if (detail.request.responseBody?.text) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(detail.request.responseBody.text, source.body.text)
    assert.equal(source.body.truncated, true)
    assert.ok(Buffer.byteLength(source.body.text, 'utf8') <= 16384)
    assert.ok(!source.body.text.includes('\ufffd'))
  } finally { await h.close() }
})
