// Renderer-owned recorder for the existing, Session-verified webview. No
// remote debugging ports, Electron main-process patches or DevTools windows.
class BrowserDebugRecorder {
  constructor(ctx, driver) {
    this.driver = driver
    this.states = new Map()
    this.diagnostics = new Map()
    this.unsubscribers = []
    const removed = ctx.remote?.$on?.('api-session/removed', sessionId => {
      for (const state of this.states.values()) if (state.sessionId === sessionId) void this.stop(state)
      for (const item of this.diagnostics.values()) if (item.sessionId === sessionId) void this.disposeDiagnostic(item)
    })
    if (typeof removed === 'function') this.unsubscribers.push(removed)
  }

  capabilities() {
    return { console: 'electron-text-and-page-argument-handles', errors: 'main-document-events',
      network: 'fetch-xhr-new-websocket-eventsource-beacon-resource-timing', nativeCDP: false,
      limitations: ['No history before start, except buffered Resource Timing metadata.',
        'Navigation reinstalls hooks at dom-ready; earlier Fetch/XHR may be missed.',
        'No worker, cross-origin frame, pre-existing connection, browser-added header or full redirect-chain capture.',
        'Fetch/XHR headers and bodies are only those accessible to page JavaScript; timing rows have no bodies.',
        'Console handles refer to bounded live page objects since start, not V8 debugger objects. Native Console remains text.',
        'Page instrumentation can be replaced or bypassed by site code. HTTP error status is not a transport failure.'] }
  }

  resolve(sessionId, input) {
    const resolved = this.driver.resolve(sessionId, input.tabId)
    this.driver.requireDrivable(resolved.carrier, 'be inspected')
    return resolved
  }

  key(sessionId, tabId) { return JSON.stringify([sessionId, tabId]) }

  safeUrl(value) {
    if (!value) return ''
    try { return pageClip(pageRedactURL(value), 4096) }
    catch { return pageClip(value, 4096) }
  }

  async disposeDiagnostic(item) {
    if (this.diagnostics.get(item.key) === item) this.diagnostics.delete(item.key)
    try { if (item.guest.isConnected) await this.driver.run(item.guest, pageDiagnosticDispose, [], 1500) } catch {}
  }

  async diagnostic(method, sessionId, input, resolved) {
    const key = this.key(sessionId, resolved.tabId), previous = this.diagnostics.get(key)
    if (previous && previous.guest !== resolved.guest) await this.disposeDiagnostic(previous)
    this.diagnostics.set(key, { key, sessionId, tabId: resolved.tabId, guest: resolved.guest })
    if (!this.sweep) this.sweep = setInterval(() => {
      for (const item of this.diagnostics.values()) if (!item.guest.isConnected || !this.driver.inventory(item.sessionId).some(tab => tab.tabId === item.tabId)) void this.disposeDiagnostic(item)
    }, 1000)
    const helpers = { inspect: pageInspect, styles: pageStyles, performance: pagePerformance, storage: pageStorage, watch: pageWatch, sources: pageSources }
    const result = await this.driver.run(resolved.guest, helpers[method], [input], 5000)
    if (method === 'inspect') {
      result.hostViewport = { guest: pageRendererBox(resolved.guest), container: resolved.guest.parentElement ? pageRendererBox(resolved.guest.parentElement) : null,
        preset: this.driver.viewport?.frameOf?.(resolved.tabId)?.preset || 'unknown', source: 'DSH renderer DOM; page viewport is reported separately' }
      try { if (typeof resolved.guest.getZoomFactor === 'function') result.hostViewport.zoomFactor = resolved.guest.getZoomFactor() } catch {}
    }
    return { tabId: resolved.tabId, ...result }
  }

  async start(sessionId, input, resolved) {
    const { guest, tabId } = resolved
    const key = this.key(sessionId, tabId)
    const existing = this.states.get(key)
    if (existing) {
      const cleanup = await this.stop(existing)
      if (cleanup?.pageHooksRestored === false) throw new Error(`Could not restart page recorder: ${cleanup.cleanupError}`)
    }
    const state = { key, sessionId, tabId, guest, active: true, captureBodies: input.captureBodies === true,
      maxEntries: Math.max(10, Math.min(200, Math.floor(input.maxEntries || 100))), startedAt: Date.now(),
      resourceSince: input.resourceSince || 0,
      eventTypes: (input.eventTypes || []).slice(0, 20),
      console: [], network: [], seq: 0, droppedConsole: 0, droppedNetwork: 0, pageDropped: {}, listeners: [], cursor: 0 }
    this.states.set(key, state)
    const listen = (name, handler) => { guest.addEventListener(name, handler); state.listeners.push(() => guest.removeEventListener(name, handler)) }
    listen('console-message', event => {
      if (!state.active) return
      const levels = { 0: 'debug', 1: 'info', 2: 'warning', 3: 'error' }
      this.appendConsole(state, { timestamp: Date.now(), source: 'electron-console',
        level: levels[event.level] || ({ log: 'info', warn: 'warning', verbose: 'debug' })[event.level] || String(event.level || 'info'),
        message: String(event.message || '').slice(0, 4096), url: this.safeUrl(event.sourceId), line: event.line || 0 })
    })
    listen('dom-ready', () => { if (state.active) void this.collect(state).catch(error => { state.lastError = String(error.message).slice(0, 500) }) })
    for (const type of ['did-start-navigation','did-redirect-navigation','did-navigate','did-fail-load']) listen(type, event => {
      if (!state.active) return
      const record = { id: `native:${++state.seq}`, source: 'electron-navigation', event: type, url: this.safeUrl(event.url || event.validatedURL),
        startedAt: Date.now(), state: type === 'did-fail-load' ? 'failed' : 'observed', isMainFrame: event.isMainFrame !== false }
      for (const name of ['httpResponseCode','httpStatusText','errorCode','errorDescription']) if (event[name] !== undefined) record[name] = event[name]
      state.network.push(record); if (state.network.length > state.maxEntries) { state.network.shift(); state.droppedNetwork++ }
    })
    listen('render-process-gone', () => { state.lastError = 'Guest renderer exited; recording stopped'; void this.stop(state) })
    state.timer = setInterval(() => {
      if (!guest.isConnected || !this.driver.inventory(sessionId).some(tab => tab.tabId === tabId)) { void this.stop(state); return }
      void this.collect(state).catch(error => { state.lastError = String(error.message).slice(0, 500) })
    }, 1000)
    try { await this.collect(state) }
    catch (error) { await this.stop(state); throw error }
    return state
  }

  appendConsole(state, row) {
    row.id = ++state.seq
    state.console.push(row)
    if (state.console.length > state.maxEntries) { state.console.shift(); state.droppedConsole++ }
  }

  collect(state) {
    if (!state.active) return Promise.resolve()
    if (state.task) return state.task
    state.task = (async () => {
      const value = await this.driver.run(state.guest, pageDebug, ['start', { captureBodies: state.captureBodies, maxEntries: state.maxEntries, resourceSince: state.resourceSince, eventTypes: state.eventTypes }, state.cursor], 3500)
      if (!state.active) return
      if (!value?.installed) throw new Error('Page recorder could not be installed')
      // A new document has an independent revision sequence. Its first pull
      // must start at zero even when the old document had a larger cursor.
      if (state.documentId && state.documentId !== value.documentId) {
        state.cursor = 0
        const fresh = await this.driver.run(state.guest, pageDebug, ['read', {}, 0], 3500)
        if (!state.active) return
        this.merge(state, fresh)
      } else this.merge(state, value)
      delete state.lastError
    })().finally(() => { state.task = null })
    return state.task
  }

  merge(state, value) {
    state.documentId = value.documentId; state.cursor = value.revision
    state.hooks = value.hooks; state.hookErrors = value.hookErrors
    state.pageDropped[value.documentId] = { network: value.droppedNetwork, errors: value.droppedErrors, console: value.droppedConsole }
    // Keep counters bounded across many navigations too.
    const docs = Object.keys(state.pageDropped)
    if (docs.length > 20) delete state.pageDropped[docs[0]]
    for (const row of value.errors || []) this.appendConsole(state, { ...row, documentId: value.documentId })
    for (const row of value.console || []) this.appendConsole(state, { ...row, documentId: value.documentId })
    for (const row of value.network || []) {
      const id = `${value.documentId}:${row.id}`
      const old = state.network.findIndex(record => record.id === id)
      const record = { ...row, id, documentId: value.documentId }
      if (old >= 0) state.network[old] = record
      else {
        state.network.push(record)
        if (state.network.length > state.maxEntries) { state.network.shift(); state.droppedNetwork++ }
      }
    }
  }

  status(state) {
    return { tabId: state.tabId, recording: state.active, startedAt: state.startedAt,
      captureBodies: state.captureBodies, maxEntries: state.maxEntries, consoleCount: state.console.length,
      requestCount: state.network.length, droppedConsole: state.droppedConsole, droppedNetwork: state.droppedNetwork,
      hooks: state.hooks, hookErrors: state.hookErrors,
      pageDropped: state.pageDropped, ...(state.lastError ? { collectionError: state.lastError } : {}), capabilities: this.capabilities() }
  }

  boundRows(rows, maxChars, preview) {
    const kept = []; let used = 0
    for (const row of rows) {
      const size = JSON.stringify(row).length
      if (used + size > maxChars) {
        // Still return a usable id and preview when a single entry exceeds the
        // budget; otherwise a console cursor could never get past that entry.
        if (!kept.length) kept.push({ ...preview(row), truncated: true })
        break
      }
      kept.push(row); used += size
    }
    return kept
  }

  async stop(state) {
    if (!state.active) return state.stopResult
    state.active = false; clearInterval(state.timer)
    for (const remove of state.listeners) remove()
    state.listeners = []
    if (this.states.get(state.key) === state) this.states.delete(state.key)
    try {
      await state.task?.catch(() => {})
      if (state.guest.isConnected) await this.driver.run(state.guest, pageDebug, ['stop'], 1500)
      state.stopResult = { pageHooksRestored: true }
    } catch (error) { state.stopResult = { pageHooksRestored: false, cleanupError: String(error.message).slice(0, 500) } }
    state.console.length = 0; state.network.length = 0
    return state.stopResult
  }

  async query(method, sessionId, input) {
    const resolved = this.resolve(sessionId, input)
    if (['inspect','styles','performance','storage','watch','sources'].includes(method)) return this.diagnostic(method, sessionId, input, resolved)
    const key = this.key(sessionId, resolved.tabId)
    let state = this.states.get(key)
    if (state && state.guest !== resolved.guest) { await this.stop(state); state = undefined }
    const action = input.action || 'status'
    if (method === 'debug' && action === 'stop') {
      const cleanup = state ? await this.stop(state) : {}
      return { tabId: resolved.tabId, recording: false, stopped: true, ...cleanup }
    }
    if (method === 'debug' && action === 'status' && !state) return { tabId: resolved.tabId, recording: false, capabilities: this.capabilities() }
    if (method === 'debug' && action === 'clear') {
      if (!state) return { tabId: resolved.tabId, recording: false, cleared: true }
      // Reset the document buffer as well; old entries must not reappear.
      const config = { captureBodies: state.captureBodies, maxEntries: state.maxEntries, eventTypes: state.eventTypes, resourceSince: Date.now() }
      const cleanup = await this.stop(state)
      if (cleanup?.pageHooksRestored === false) throw new Error(`Could not clear page recorder: ${cleanup.cleanupError}`)
      state = await this.start(sessionId, config, resolved)
      return { ...this.status(state), cleared: true }
    }
    let startedNow = false
    if (method === 'debug' && action === 'start' || !state) { state = await this.start(sessionId, input, resolved); startedNow = true }
    else await this.collect(state)
    const status = { ...this.status(state), startedNow }
    if (method === 'debug') return status
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit || 50)))
    const maxChars = Math.max(1000, Math.min(30000, Math.floor(input.maxChars || 12000)))
    if (method === 'console') {
      if (input.objectId) {
        const object = await this.driver.run(resolved.guest, pageDebug, ['object', input], 3500)
        const properties = this.boundRows(object.properties, maxChars, row => ({ name: row.name,
          ...(row.value?.objectId ? { value: { type: row.value.type, objectId: row.value.objectId } } : { preview: '[property preview exceeds budget]' }) }))
        return { ...status, ...object, properties, truncated: object.truncated || properties.length < object.properties.length || properties.some(row => row.truncated) }
      }
      let rows = state.console.filter(row => (input.sinceId == null || row.id > input.sinceId) && (!input.level || row.level === input.level)
        && (!input.source || input.source === 'all' || (input.source === 'structured' ? row.source === 'page-console' : row.source === 'electron-console')))
      const count = rows.length
      rows = input.sinceId == null ? rows.slice(-limit) : rows.slice(0, limit)
      rows = this.boundRows(rows, maxChars, row => ({ id: row.id, timestamp: row.timestamp, level: row.level,
        source: row.source, message: row.message.slice(0, maxChars - 600),
        ...(row.args ? { args: row.args.slice(0, 3).map(arg => ({ type: arg.type, ...(arg.objectId ? { objectId: arg.objectId } : {}) })) } : {}) }))
      return { ...status, entries: rows, truncated: rows.length < count || rows.some(row => row.truncated),
        nextSinceId: rows.at(-1)?.id ?? input.sinceId ?? 0 }
    }
    if (input.requestId) {
      const row = state.network.find(row => row.id === input.requestId)
      if (!row) throw new Error('Request not found in this tab recorder; it may have been cleared or evicted. List browser_dev_network again.')
      const json = JSON.stringify(row)
      return json.length <= maxChars ? { ...status, request: row, truncated: false }
        : { ...status, request: { id: row.id, url: row.url, method: row.method, state: row.state },
          detailPreview: json.slice(0, maxChars), truncated: true, totalChars: json.length }
    }
    let rows = state.network.filter(row => !input.urlContains || row.url.includes(input.urlContains))
      .map(({ requestBody, responseBody, requestHeaders, responseHeaders, events, ...row }) => row)
    const count = rows.length
    rows = rows.slice(-limit)
    rows = this.boundRows(rows, maxChars, row => ({ id: row.id, source: row.source, method: row.method,
      url: row.url.slice(0, 200), state: row.state, ...(row.status == null ? {} : { status: row.status }) }))
    return { ...status, requests: rows, truncated: rows.length < count || rows.some(row => row.truncated) }
  }

  dispose() {
    clearInterval(this.sweep)
    for (const item of this.diagnostics.values()) void this.disposeDiagnostic(item)
    for (const remove of this.unsubscribers) remove()
    for (const state of this.states.values()) void this.stop(state)
  }
}
