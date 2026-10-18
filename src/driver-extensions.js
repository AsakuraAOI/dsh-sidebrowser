// Embedded beside the reference driver. Host and Client use an explicit result
// envelope so a page-reported error settles the Inspect request immediately.
const referenceAct = BrowserDriver.prototype.act
PAGE_HELPERS.push(pageDiagnosticState, pageInspect, pageStyles, pagePerformance, pageWatch,
  pageStorage, pageSources, pageDiagnosticDispose, installDebugExtensions, pageDebug)

BrowserDriver.prototype.snapshot = async function (sessionId, input) {
  const deadline = beginCall()
  const { tabId, guest, carrier } = this.resolve(sessionId, input.tabId)
  this.requireDrivable(carrier, 'be observed')
  await this.settle(guest, budgetLeft(deadline))
  const result = await this.run(guest, pageSnapshot, [input.maxChars, input.maxElements], budgetLeft(deadline))
  return prune({ tabId, ...result, loading: this.isLoading(guest), failed: isErrorPage(result.url),
    capabilities: { nativeInput: typeof guest.sendInputEvent === 'function', nativeText: typeof guest.insertText === 'function',
      mainDocument: true, crossOriginFrameDOM: false, networkCapture: 'opt-in-document-probes', diagnostics: 'browser_dev_*', nativeCDP: false } })
}

BrowserDriver.prototype.extract = async function (sessionId, input) {
  const deadline = beginCall()
  const { tabId, guest, carrier } = this.resolve(sessionId, input.tabId)
  this.requireDrivable(carrier, 'be extracted')
  const result = await this.run(guest, pageExtract, [input.kind, input.selector || '', input.limit, input.maxChars], budgetLeft(deadline))
  return prune({ tabId, ...result, failed: isErrorPage(result.url), capturedAt: new Date().toISOString() })
}

BrowserDriver.prototype.act = async function (sessionId, input) {
  const deadline = beginCall()
  const { tabId, guest, carrier } = this.resolve(sessionId, input.tabId)
  this.requireDrivable(carrier, 'be interacted with')
  const mode = input.inputMode || 'auto'
  if (!['auto', 'native', 'dom'].includes(mode)) throw new Error('Unknown inputMode')
  const nativeAction = ['click', 'type', 'press', 'click_xy'].includes(input.action)
  const pointerAction = ['click', 'click_xy', 'press'].includes(input.action)
  let pointerHidden = document.visibilityState === 'hidden'
  if (pointerAction) for (let node = guest; node; node = node.parentElement) {
    const style = window.getComputedStyle(node)
    if (node.hidden || style.display === 'none' || style.visibility === 'hidden') pointerHidden = true
  }
  let paintFailure = pointerHidden ? 'page-not-drawn' : ''
  // Electron may report visibilityState=visible even for a hidden native
  // window. A cheap local capture verifies a compositor surface exists. No
  // screenshot bytes leave this method. Never retry the actual click.
  if (pointerAction && mode !== 'dom' && !pointerHidden && typeof guest.capturePage === 'function') {
    try {
      const frame = await raceBudget(guest.capturePage(), Math.min(1200, budgetLeft(deadline)), 'native pointer paint check')
      if (frame.isEmpty?.() || frame.getSize?.().width === 0) throw new Error('empty compositor frame')
    } catch (error) { pointerHidden = true; paintFailure = String(error?.message || error).slice(0, 300) }
  }
  const available = typeof guest.sendInputEvent === 'function' && (input.action !== 'type' || (typeof guest.insertText === 'function' && (input.text !== '' || typeof guest.delete === 'function')))
    && !(pointerAction && pointerHidden)
  if (pointerAction && mode === 'native' && pointerHidden) throw new Error(`Native event input requires a drawn compositor frame; show this Conversation and select its browser tab (${paintFailure})`)
  if (input.action === 'click_xy' && (mode === 'dom' || !available)) throw new Error('Coordinate clicks require native input support')
  if (nativeAction && mode === 'native' && !available) throw new Error('This webview does not expose the requested native input API')
  if (!nativeAction || mode === 'dom' || !available) {
    if (['click', 'type', 'press', 'select', 'scroll'].includes(input.action)) {
      try {
        const point = await this.run(guest, pageVisualTarget, [input.ref || null, input.selector || null], budgetLeft(deadline))
        await AGENT_VISUALS.get(this.ctx)?.move(sessionId, tabId, guest, point)
      } catch { /* The normal action path reports target errors. */ }
    }
    const result = await referenceAct.call(this, sessionId, input)
    if (input.action === 'click') AGENT_VISUALS.get(this.ctx)?.pulse(sessionId)
    return { ...result, backend: 'dom', ...(pointerAction && pointerHidden ? { nativeFallbackReason: 'pointer-paint-unavailable', nativeDiagnostic: paintFailure } : {}), actionDispatched: true, verificationRequired: input.action !== 'wait' }
  }
  let point
  if (input.action === 'click_xy') {
    point = await this.run(guest, pageCoordinatePoint, [input.x, input.y], budgetLeft(deadline))
  } else if (input.action === 'press' && !input.ref && !input.selector) {
    point = await this.run(guest, pageIdentity, [], budgetLeft(deadline))
    point.ok = true
  } else {
    point = await this.run(guest, pagePrepareNative, [input.ref || null, input.selector || null, input.action], budgetLeft(deadline))
  }
  if (!point?.ok) throw new Error(`Native input refused: ${point?.reason || 'target unavailable'}`)
  await AGENT_VISUALS.get(this.ctx)?.move(sessionId, tabId, guest, point)
  if (typeof guest.getURL === 'function' && guest.getURL() !== point.url) throw new Error('Page navigated before input; observe it again')
  // Cursor motion adds a short visual delay. Re-resolve after that delay so a
  // replaced/disabled/moved element is never clicked at its previous position.
  if (input.ref || input.selector) {
    const fresh = await this.run(guest, pagePrepareNative, [input.ref || null, input.selector || null, input.action], budgetLeft(deadline))
    if (!fresh?.ok) throw new Error(`Native input target changed: ${fresh?.reason || 'target unavailable'}`)
    point = fresh
    await AGENT_VISUALS.get(this.ctx)?.move(sessionId, tabId, guest, point, false)
  }
  const send = event => raceBudget(Promise.resolve(guest.sendInputEvent(event)), budgetLeft(deadline), 'native input')
  guest.focus?.()
  if (['click', 'click_xy'].includes(input.action)) {
    const x = Math.floor(point.x), y = Math.floor(point.y)
    await send({ type: 'mouseMove', x, y })
    await send({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    await send({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    AGENT_VISUALS.get(this.ctx)?.pulse(sessionId)
  } else if (input.action === 'type') {
    const text = input.text ?? ''
    if (text === '') {
      await raceBudget(Promise.resolve(guest.delete()), budgetLeft(deadline), 'native selection deletion')
    } else await raceBudget(Promise.resolve(guest.insertText(text)), budgetLeft(deadline), 'native text input')
  } else {
    const parsed = parseNativeKey(input.key || 'Enter')
    await send({ type: 'keyDown', ...parsed })
    if (!parsed.modifiers.some(value => ['control', 'meta', 'alt'].includes(value))) {
      if (parsed.keyCode === 'Enter') await send({ type: 'char', keyCode: '\r' })
      else if (parsed.keyCode === 'Space') await send({ type: 'char', keyCode: ' ' })
      else if (parsed.keyCode.length === 1) await send({ type: 'char', ...parsed })
    }
    await send({ type: 'keyUp', ...parsed })
  }
  await new Promise(resolve => setTimeout(resolve, Math.min(REACTION_PAUSE_MS, budgetLeft(deadline))))
  return prune({ tabId, action: input.action, ok: true, backend: 'native', actionDispatched: true,
    verificationRequired: true, ...(await this.describe(guest, budgetLeft(deadline))) })
}

function parseNativeKey(value) {
  const parts = String(value).split('+')
  const raw = parts.pop()
  const names = { Ctrl: 'control', Control: 'control', Meta: 'meta', Cmd: 'meta', Alt: 'alt', Shift: 'shift' }
  const modifiers = parts.map(part => {
    if (!names[part]) throw new Error(`Unsupported key modifier: ${part}`)
    return names[part]
  })
  const aliases = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Escape', Space: 'Space' }
  const keys = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right', 'Space']
  const keyCode = aliases[raw] || raw
  if (!keyCode || !(keyCode.length === 1 || keys.includes(keyCode) || /^F(?:[1-9]|1[0-2])$/.test(keyCode))) throw new Error('Unsupported native key')
  return { keyCode, modifiers }
}

function buildProvider(ctx, viewport) {
  const provider = buildReferenceProvider(ctx, viewport)
  const driver = new BrowserDriver(ctx, viewport)
  AGENT_VISUALS.get(ctx)?.dispose()
  const feedback = new AgentVisualFeedback(ctx, driver)
  const debug = new BrowserDebugRecorder(ctx, driver)
  AGENT_VISUALS.set(ctx, feedback)
  provider.dispose = () => { debug.dispose(); feedback.dispose() }
  provider.feedback = feedback
  provider.debug = debug
  const active = new Set()
  const TAB = { type: 'string' }
  provider.manifest.methods.push(
    ...DEBUG_TOOLS.map(([_name, name, description, properties]) => ({ name, description,
      inputSchema: { type: 'object', properties, additionalProperties: false } })),
    { name: 'snapshot', description: 'Read a bounded structured main-document snapshot.', inputSchema: { type: 'object', properties: { tabId: TAB, maxChars: { type: 'number' }, maxElements: { type: 'number' } }, additionalProperties: false } },
    { name: 'extract', description: 'Extract rendered table rows, links, headings or list items.', inputSchema: { type: 'object', properties: { tabId: TAB, kind: { type: 'string', enum: ['links','headings','tables','list'] }, selector: { type: 'string' }, limit: { type: 'number' }, maxChars: { type: 'number' } }, required: ['kind'], additionalProperties: false } },
  )
  const action = provider.manifest.methods.find(method => method.name === 'act')
  action.inputSchema.properties.inputMode = { type: 'string', enum: ['auto', 'native', 'dom'] }
  action.inputSchema.properties.x = { type: 'number' }
  action.inputSchema.properties.y = { type: 'number' }
  action.inputSchema.properties.action.enum.push('click_xy')
  for (const method of provider.manifest.methods) method.outputSchema = {
    type: 'object', properties: { transportVersion: { type: 'number' }, ok: { type: 'boolean' }, value: {}, error: { type: 'string' } },
    required: ['transportVersion', 'ok'], additionalProperties: false,
  }
  const query = provider.query.bind(provider)
  provider.query = async (method, input, context) => {
    const sessionId = context?.sessionId
    if (typeof sessionId !== 'string' || !sessionId) return { transportVersion: 1, ok: false, error: 'A DSH Session is required' }
    // Refuse concurrency instead of scheduling a write that might execute after
    // its calling tool has already timed out. The model should observe and retry.
    if (active.has(sessionId)) return { transportVersion: 1, ok: false, error: 'This Session already has a browser operation in progress; wait for its result' }
    active.add(sessionId)
    const visual = feedback.begin(sessionId, method, input || {})
    try {
      const value = DEBUG_TOOLS.some(row => row[1] === method) ? await debug.query(method, sessionId, input || {})
        : method === 'snapshot' ? await driver.snapshot(sessionId, input || {})
        : method === 'extract' ? await driver.extract(sessionId, input || {}) : await query(method, input, context)
      feedback.finish(visual, value, false)
      return { transportVersion: 1, ok: true, value: prune(value) }
    } catch (error) {
      feedback.finish(visual, null, true)
      return { transportVersion: 1, ok: false, error: String(error?.message || error).slice(0, 4000) }
    } finally { active.delete(sessionId) }
  }
  return provider
}
