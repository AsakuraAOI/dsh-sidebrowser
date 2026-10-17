const { ipcRenderer } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const source = fs.readFileSync(path.join(process.env.DSH_SIDEBROWSER_PLUGIN_ROOT, 'client.js'), 'utf8')
let api
window.__ModuleLoader__ = { load({ factory }) { api = factory(name => name === '@deepseek-ai/dsh-client-store' ? { defineStore: value => value } : {}) } }
window.eval(source)
const view = document.querySelector('webview')
const records = [{ sessionId: 'fixture', tabId: 'tab1', kind: 'browser' }]
const events = new Map()
const remote = { $on(name, callback) {
  if (!events.has(name)) events.set(name, new Set())
  events.get(name).add(callback)
  return () => events.get(name).delete(callback)
} }
const emit = (name, ...args) => { for (const callback of events.get(name) || []) callback(...args) }
const ctx = { remote, sidebarRight: { openTabs: { getSnapshot: () => records }, commandTarget: () => ({ sessionId: 'fixture', tabId: 'tab1' }) } }
const provider = api.buildProvider(ctx, {})
emit('api-session/status', 'fixture', true)
const call = async (method, args = {}) => {
  const reply = await provider.query(method, args, { sessionId: 'fixture' })
  if (!reply.ok) throw new Error(reply.error)
  return reply.value
}
view.addEventListener('did-finish-load', async () => {
  try {
    const first = await call('snapshot')
    assert.ok(first.text.includes('Browser fixture'))
    assert.ok(!JSON.stringify(first).includes('private-fixture-sentinel'))
    assert.equal(first.capabilities.nativeInput, true)
    const type = await call('act', { action: 'type', selector: '#name', text: 'Mira', inputMode: 'native' })
    assert.equal(type.backend, 'native')
    await call('act', { action: 'type', selector: '#name', text: '', inputMode: 'native' })
    assert.equal((await call('eval', { code: 'document.querySelector("#name").value' })).value, '')
    await call('act', { action: 'type', selector: '#name', text: 'Mira', inputMode: 'native' })
    // The first document can finish loading before a compositor frame exists.
    // Wait only on the read-only paint prerequisite; never retry a sent action.
    const until = Date.now() + 2500
    while (true) {
      try { await view.capturePage(); break }
      catch (error) { if (Date.now() >= until) throw error; await new Promise(resolve => setTimeout(resolve, 100)) }
    }
    const click = await call('act', { action: 'click', selector: '#save', inputMode: 'native' })
    assert.equal(click.backend, 'native')
    const after = await call('snapshot')
    assert.ok(after.text.includes('Saved Mira'))
    const evidence = await call('eval', { code: '({events:window.events,node:typeof require})' })
    assert.equal(evidence.value.node, 'undefined')
    assert.ok(evidence.value.events.some(event => event.type === 'click' && event.trusted))
    assert.ok(evidence.value.events.some(event => event.type === 'input' && event.trusted))
    await call('eval', { code: 'document.querySelector("output").textContent="Waiting for key"' })
    await call('act', { action: 'press', selector: '#name', key: 'Enter', inputMode: 'native' })
    assert.ok((await call('snapshot')).text.includes('Saved Mira'))
    const keys = await call('eval', { code: 'window.events.filter(e=>e.type==="keydown")' })
    assert.ok(keys.value.some(event => event.key === 'Enter' && event.trusted))
    const tables = await call('extract', { kind: 'tables' })
    assert.deepEqual(tables.items[0].rows, [['Item','Count'],['Demo','2']])
    const foreign = await provider.query('snapshot', { tabId: 'tab1' }, { sessionId: 'other' })
    assert.equal(foreign.ok, false)
    const screenshot = await call('screenshot', { maxWidth: 640 })
    assert.ok(screenshot.width > 0 && screenshot.width <= 640 && screenshot.base64.length > 100)
    const feedbackCaptures = []
    provider.feedback.reducedMotion = true
    for (const [name, width] of [['wide',800], ['narrow',320]]) {
      view.style.width = width + 'px'
      await new Promise(resolve => setTimeout(resolve, 200))
      const visual = provider.feedback.begin('fixture', 'act', { tabId: 'tab1', action: 'click' })
      const point = await view.executeJavaScript(api.__testing.pageCall(api.__testing.PAGE_HELPERS.find(fn => fn.name === 'pageVisualTarget'), [null, '#save']))
      await provider.feedback.move('fixture', 'tab1', view, point)
      assert.equal(visual.root.hidden, false)
      assert.equal(document.querySelector('[data-sidebrowser-badge]'), null)
      assert.equal(visual.root.querySelector('.dsb-agent-name'), null)
      const glow = visual.root.getAnimations({ subtree: true }).find(animation => animation.animationName === 'dsb-agent-glow')
      if (glow) {
        glow.pause(); glow.currentTime = 0
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const low = Number(getComputedStyle(visual.root.querySelector('.dsb-agent-frame'), '::after').opacity)
        if (name === 'wide') feedbackCaptures.push(await ipcRenderer.invoke('fixture-host-capture', { name: 'wide-low', width: width + 16 }))
        glow.currentTime = glow.effect.getTiming().duration / 2
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const high = Number(getComputedStyle(visual.root.querySelector('.dsb-agent-frame'), '::after').opacity)
        assert.ok(high - low >= .75, `Breathing amplitude is too small: ${low} -> ${high}`)
      }
      provider.feedback.pulse('fixture')
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      feedbackCaptures.push(await ipcRenderer.invoke('fixture-host-capture', { name, width: width + 16 }))
      assert.ok(!(await call('eval', { code: 'document.body.innerText' })).value.includes('Agent 正在操作'))
    }
    const failed = provider.feedback.begin('fixture', 'act', { tabId: 'tab1', action: 'click' })
    provider.feedback.finish(failed, null, true)
    await new Promise(resolve => setTimeout(resolve, 50))
    feedbackCaptures.push(await ipcRenderer.invoke('fixture-host-capture', { name: 'error', width: 336 }))
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal(failed.phase, 'active')
    assert.equal(failed.root.isConnected, true)
    emit('api-session/status', 'fixture', false)
    assert.equal(failed.phase, 'idle')
    await new Promise(resolve => setTimeout(resolve, 750))
    assert.equal(document.querySelectorAll('[data-sidebrowser-feedback]').length, 0)
    provider.dispose()
    assert.equal(document.querySelectorAll('[data-sidebrowser-feedback],[data-sidebrowser-badge]').length, 0)
    ipcRenderer.send('fixture-done', { success: true, nativeTextBackend: type.backend, events: [...evidence.value.events, ...keys.value], pointerBackend: click.backend, enterSubmitVerified: true, selectionDeletionVerified: true, agentLifecycleGlowVerified: true, screenshot: { width: screenshot.width, height: screenshot.height }, screenshotPng: screenshot.base64, feedbackCaptures, extraction: tables.items[0].rows, guestNodeIntegration: evidence.value.node, crossSessionRefused: true })
  } catch (error) {
    let state
    try { state = await view.executeJavaScript('({value:document.querySelector("#name").value,events:window.events,result:document.querySelector("output").textContent,focused:document.hasFocus(),active:document.activeElement?.id})') } catch {}
    ipcRenderer.send('fixture-done', { success: false, error: error.stack, state })
  }
}, { once: true })
view.src = process.env.DSH_SIDEBROWSER_FIXTURE_URL
