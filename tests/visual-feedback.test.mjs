import test from 'node:test'
import assert from 'node:assert/strict'
import { clientHarness } from './harness.mjs'

function layout(h, id = 'a', rect = { left: 100, top: 80, width: 400, height: 300 }) {
  const view = h.elements.get(id)
  const box = { ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }
  view.getClientRects = () => [box]; view.getBoundingClientRect = () => box
  const title = h.host.document.createElement('span'); title.dataset.sidebarRightTab = id; title.textContent = 'Page'
  title.getClientRects = () => [box]
  title.getBoundingClientRect = () => ({ left: 100, top: 30, right: 220, bottom: 52, width: 120, height: 22 })
  view.closest('[data-sidebar-right-session]').prepend(title)
  return view
}

test('activity glows only around the resolved page with no visible labels or interactive layer', async () => {
  const h = clientHarness('<button>Save</button>')
  try {
    layout(h)
    const state = h.provider.feedback.begin('A', 'act', { tabId: 'a', action: 'click' })
    assert.equal(state.root.hidden, false); assert.equal(state.tabId, 'a')
    assert.equal(h.host.document.querySelector('[data-sidebrowser-badge]'), null)
    assert.equal(state.root.querySelector('.dsb-agent-name'), null)
    assert.equal(h.host.getComputedStyle(state.root.querySelector('[role="status"]')).clipPath, 'inset(50%)')
    assert.match(h.host.getComputedStyle(state.root.querySelector('.dsb-agent-frame')).boxShadow, /inset/)
    assert.equal(h.host.getComputedStyle(state.root).pointerEvents, 'none')
    assert.equal(state.root.querySelector('[role="status"]').getAttribute('aria-live'), 'polite')
    assert.match(state.root.textContent, /Agent 正在操作此页面/)
    const other = h.provider.feedback.begin('B', 'read', { tabId: 'a' })
    assert.equal(other.root.hidden, true)
  } finally { await h.close() }
})

test('the simulated pointer maps page CSS coordinates through a scaled webview', async () => {
  const h = clientHarness()
  try {
    const view = layout(h)
    const feedback = h.provider.feedback; feedback.reducedMotion = true
    const state = feedback.begin('A', 'act', { tabId: 'a', action: 'click' })
    await feedback.move('A', 'a', view, { x: 400, y: 300, viewportWidth: 800, viewportHeight: 600 })
    assert.equal(state.cursor.style.transform, 'translate3d(200px, 150px, 0)')
    assert.equal(state.root.dataset.cursorVisible, 'true')
    feedback.pulse('A'); assert.equal(state.root.dataset.clicked, 'true')
    feedback.finish(state, { tabId: 'a' }, false)
    assert.equal(state.phase, 'active')
    h.emit('api-session/status', 'A', false)
    assert.equal(state.phase, 'idle')
  } finally { await h.close() }
})

test('hidden sessions hide their glow; disposal removes all presentation nodes', async () => {
  const h = clientHarness()
  try {
    const view = layout(h)
    const state = h.provider.feedback.begin('A', 'snapshot', {})
    view.closest('[data-sidebar-right-session]').hidden = true
    h.provider.feedback.render(state)
    assert.equal(state.root.hidden, true)
    h.provider.dispose()
    assert.equal(h.host.document.querySelectorAll('[data-sidebrowser-feedback],[data-sidebrowser-badge],[data-sidebrowser-feedback-style]').length, 0)
    assert.equal(h.provider.feedback.frame, 0)
  } finally { await h.close() }
})

test('failures show an unconfirmed state and do not display page text or typed values', async () => {
  const h = clientHarness()
  try {
    layout(h)
    const state = h.provider.feedback.begin('A', 'act', { tabId: 'a', action: 'type', text: 'private-typed-sentinel' })
    h.provider.feedback.finish(state, null, true)
    assert.equal(state.phase, 'active')
    assert.match(state.detail.textContent, /操作未确认/)
    assert.ok(!state.root.textContent.includes('private-typed-sentinel'))
    assert.ok(!h.guest.document.body.textContent.includes('Agent'))
  } finally { await h.close() }
})

test('an actual provider request displays activity while in flight and clears it on disposal', async () => {
  const h = clientHarness()
  try {
    layout(h)
    let release
    h.elements.get('a').executeJavaScript = () => new Promise(resolve => { release = resolve })
    const request = h.provider.query('read', {}, { sessionId: 'A' })
    await new Promise(resolve => setTimeout(resolve, 15))
    const state = h.provider.feedback.states.get('A')
    assert.equal(state.phase, 'active'); assert.equal(state.root.hidden, false)
    release({ url: 'https://fixture.invalid/', title: '', text: 'Ready', truncated: false })
    assert.equal((await request).ok, true)
    assert.equal(state.phase, 'active')
  } finally { await h.close() }
})

test('glow persists across tool gaps and ends only on this Agent session becoming idle', async () => {
  const h = clientHarness('<button>Save</button>')
  try {
    layout(h)
    await h.provider.query('snapshot', {}, { sessionId: 'A' })
    const state = h.provider.feedback.states.get('A'), root = state.root
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal(state.phase, 'active'); assert.equal(root.isConnected, true)
    await h.provider.query('read', {}, { sessionId: 'A' })
    assert.equal(h.provider.feedback.states.get('A').root, root)
    h.emit('api-session/status', 'B', false)
    assert.equal(state.phase, 'active')
    h.emit('api-session/status', 'A', false)
    assert.equal(state.phase, 'idle')
    await new Promise(resolve => setTimeout(resolve, 750))
    assert.equal(root.isConnected, false)
  } finally { await h.close() }
})

test('reduced motion keeps a static pointer and still exposes the click indication', async () => {
  const h = clientHarness()
  try {
    const view = layout(h), feedback = h.provider.feedback
    feedback.reducedMotion = true
    const state = feedback.begin('A', 'act', { tabId: 'a', action: 'click' })
    await feedback.move('A', 'a', view, { x: 50, y: 50, viewportWidth: 800, viewportHeight: 600 })
    assert.equal(state.cursor.style.transition, 'none')
    feedback.pulse('A')
    assert.equal(state.cursor.querySelector('.dsb-agent-ring').style.animation, 'none')
  } finally { await h.close() }
})

test('an element disabled during simulated cursor motion is not clicked', async () => {
  const h = clientHarness('<button id="save">Save</button>')
  try {
    let sent = 0
    h.elements.get('a').sendInputEvent = async () => sent++
    h.provider.feedback.move = async () => { h.guest.document.querySelector('#save').disabled = true }
    await assert.rejects(h.driver.act('A', { action: 'click', selector: '#save', inputMode: 'native' }), /target changed/)
    assert.equal(sent, 0)
  } finally { await h.close() }
})
