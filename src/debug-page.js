// Self-contained helper serialized into the guest. This is document-level
// instrumentation, not CDP: never claim coverage of workers or early scripts.
function pageDebug(action, options = {}, cursor = 0) {
  const key = '__dshSidebrowserDebugV1__'
  const previous = window[key]
  if (action === 'object') {
    if (!previous?.expandObject) throw new Error('No structured Console recorder in this document; start browser_dev_debug before logging')
    return previous.expandObject(options)
  }
  if (action === 'stop') {
    if (previous) { previous.stop(); delete window[key] }
    return { stopped: true }
  }
  if (action === 'start' && !previous) {
    const cap = Math.max(10, Math.min(200, options.maxEntries || 100))
    const bodyLimit = 16384
    const state = { documentId: `${Date.now()}-${Math.random().toString(36).slice(2)}`, revision: 0,
      network: [], errors: [], console: [], droppedNetwork: 0, droppedErrors: 0, droppedConsole: 0, active: true,
      startedAt: Date.now(), captureBodies: options.captureBodies === true,
      hooks: { fetch: false, xhr: false, resourceTiming: false }, hookErrors: [] }
    const clip = (v, n = 2048) => pageClip(v, n)
    const sensitive = { test: pageSensitiveName }
    const url = value => {
      try {
        return clip(pageRedactURL(value, location.href, true), 4096)
      } catch { return '[invalid URL]' }
    }
    const headers = value => {
      const result = {}
      try { let count = 0; new Headers(value).forEach((v, k) => { if (++count <= 40) result[clip(k, 128).toLowerCase()] = sensitive.test(k) ? '[redacted]' : clip(v, 512) }) } catch {}
      return result
    }
    const push = (kind, row) => {
      if (!state.active) return
      row.revision = ++state.revision
      const rows = state[kind]
      if (!rows.includes(row)) rows.push(row)
      if (rows.length > cap) { rows.shift(); state[{ network: 'droppedNetwork', errors: 'droppedErrors', console: 'droppedConsole' }[kind]]++ }
    }
    const update = row => { if (state.network.includes(row)) push('network', row) }
    const body = value => {
      if (!state.captureBodies) return { unavailable: 'body capture disabled' }
      if (value == null) return { text: '', truncated: false }
      if (typeof value !== 'string' && !(value instanceof URLSearchParams)) return { unavailable: 'binary, FormData or stream body not consumed' }
      const text = String(value)
      const bytes = new TextEncoder().encode(text.slice(0, bodyLimit))
      return { text: new TextDecoder().decode(bytes.subarray(0, bodyLimit), { stream: true }),
        truncated: text.length > bodyLimit || bytes.length > bodyLimit }
    }
    let serial = 0
    const request = (kind, address, method) => {
      const row = { id: String(++serial), source: kind, url: url(address), method: clip(method || 'GET', 32).toUpperCase(), startedAt: Date.now(), state: 'pending' }
      push('network', row); return row
    }
    const finish = row => { row.durationMs = Date.now() - row.startedAt; update(row) }
    const onError = e => {
      const resource = e.target?.nodeType === 1
      push('errors', { timestamp: Date.now(), level: 'error', source: resource ? 'resource-error' : 'page-error',
        message: clip(resource ? `Resource failed: ${url(e.target.src || e.target.href || '')}` : e.message),
        url: url(e.filename || location.href), line: e.lineno || 0, column: e.colno || 0,
        stack: clip(e.error?.stack, 4096) })
    }
    const onRejection = e => {
      let message
      try { message = e.reason?.stack || String(e.reason) } catch { message = '[unserializable rejection]' }
      push('errors', { timestamp: Date.now(), level: 'error', source: 'unhandled-rejection', message: clip(message, 4096), url: url(location.href) })
    }
    window.addEventListener('error', onError, true)
    window.addEventListener('unhandledrejection', onRejection)
    const restorers = [], readers = new Set(), xhrCleanup = new Map()
    const replace = (object, name, wrapper) => {
      try {
        const original = object[name], installed = wrapper(original)
        object[name] = installed
        if (object[name] !== installed) throw new Error('property is read-only')
        restorers.push(() => { if (object[name] === installed) object[name] = original })
        return true
      } catch (error) { state.hookErrors.push(`${name}: ${clip(error.message, 200)}`); return false }
    }
    const stopExtensions = installDebugExtensions(state, { clip, url, push, request, update, finish, body, replace }, options)
    if (typeof window.fetch === 'function') state.hooks.fetch = replace(window, 'fetch', original => function (...args) {
      // Call the native implementation with the original arguments. A probe
      // failure must never prevent or replay the application's request.
      const promise = Reflect.apply(original, this, args)
      if (!state.active) return promise
      let row
      try {
        const [input, init] = args
        row = request('fetch', typeof input === 'string' || input instanceof URL ? input : input.url, init?.method || input?.method)
        row.requestHeaders = headers(init?.headers ?? input?.headers)
        row.requestBody = input instanceof Request && init?.body === undefined
          ? { unavailable: 'Request body stream not consumed' } : body(init?.body)
      } catch { return promise }
      return promise.then(response => {
        try {
          row.status = response.status; row.statusText = clip(response.statusText); row.responseUrl = url(response.url || row.url)
          row.responseHeaders = headers(response.headers); row.state = 'complete'; row.redirected = response.redirected
          row.responseBody = { unavailable: state.captureBodies ? 'body pending' : 'body capture disabled' }
          finish(row)
          if (state.active && state.captureBodies) void readBody(response, row)
        } catch { /* Preserve the original response. */ }
        return response
      }, error => {
        try { row.state = 'failed'; row.error = clip(error?.message || error); finish(row) } catch {}
        throw error
      })
    })
    async function readBody(response, row) {
      row.responseBody = await pageReadResponseText(response, { maxBytes: bodyLimit, timeoutMs: 3000, readers, isActive: () => state.active })
      update(row)
    }
    if (typeof XMLHttpRequest !== 'undefined') {
      const records = new WeakMap(), proto = XMLHttpRequest.prototype
      replace(proto, 'open', original => function (method, address, ...rest) {
        const value = Reflect.apply(original, this, [method, address, ...rest])
        records.set(this, { method, address, requestHeaders: {} }); return value
      })
      replace(proto, 'setRequestHeader', original => function (name, value) {
        const result = Reflect.apply(original, this, [name, value])
        try {
          const meta = records.get(this)
          if (meta && Object.keys(meta.requestHeaders).length < 40) meta.requestHeaders[clip(name, 128).toLowerCase()] = sensitive.test(name) ? '[redacted]' : clip(value, 512)
        } catch {}
        return result
      })
      state.hooks.xhr = replace(proto, 'send', original => function (...args) {
        const meta = records.get(this); let row, end
        try {
          if (meta) {
            row = request('xhr', meta.address, meta.method); row.requestHeaders = { ...meta.requestHeaders }; row.requestBody = body(args[0])
            end = () => {
              xhrCleanup.get(this)?.(); xhrCleanup.delete(this)
              if (!state.active) return
              try {
                row.status = this.status; row.state = this.status === 0 ? 'failed' : 'complete'; row.responseUrl = url(this.responseURL || meta.address)
                row.responseHeaders = headers(this.getAllResponseHeaders().trim().split(/[\r\n]+/).filter(Boolean).map(line => { const i = line.indexOf(':'); return [line.slice(0, i), line.slice(i + 1).trim()] }))
                row.responseBody = !state.captureBodies ? { unavailable: 'body capture disabled' }
                  : this.responseType === '' || this.responseType === 'text' ? body(this.responseText)
                    : this.responseType === 'json' ? body(JSON.stringify(this.response)) : { unavailable: 'non-text response' }
                finish(row)
              } catch { row.state = 'failed'; row.error = 'XHR details unavailable'; finish(row) }
            }
            xhrCleanup.get(this)?.()
            this.addEventListener('loadend', end, { once: true })
            xhrCleanup.set(this, () => this.removeEventListener('loadend', end))
            if (xhrCleanup.size > cap) { const [old, cleanup] = xhrCleanup.entries().next().value; cleanup(); xhrCleanup.delete(old) }
          }
        } catch { /* Observing must not block send. */ }
        try { return Reflect.apply(original, this, args) }
        catch (error) {
          if (row) { row.state = 'failed'; row.error = clip(error?.message || error); finish(row); xhrCleanup.get(this)?.(); xhrCleanup.delete(this) }
          throw error
        }
      })
    }
    let observer
    try {
      observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          // fetch/XHR are captured above. Timing rows are explicitly metadata
          // only, and may include entries from before the recorder started.
          if (performance.timeOrigin + entry.startTime >= state.startedAt && (entry.initiatorType === 'fetch' && state.hooks.fetch || entry.initiatorType === 'xmlhttprequest' && state.hooks.xhr)) continue
          if (performance.timeOrigin + entry.startTime < (options.resourceSince || 0)) continue
          const row = request('resource-timing', entry.name, 'UNKNOWN')
          row.startedAt = Math.round(performance.timeOrigin + entry.startTime)
          row.preexisting = row.startedAt < state.startedAt
          row.initiatorType = entry.initiatorType; row.durationMs = entry.duration; row.transferSize = entry.transferSize
          if (entry.responseStatus > 0) row.status = entry.responseStatus
          row.state = 'observed'; row.responseBody = { unavailable: 'Resource Timing provides metadata only' }; update(row)
        }
      })
      observer.observe({ type: 'resource', buffered: true })
      state.hooks.resourceTiming = true
    } catch {}
    state.stop = () => {
      state.active = false; observer?.disconnect()
      stopExtensions()
      window.removeEventListener('error', onError, true); window.removeEventListener('unhandledrejection', onRejection)
      for (const restore of restorers.reverse()) { try { restore() } catch {} }
      for (const cleanup of xhrCleanup.values()) cleanup()
      xhrCleanup.clear()
      for (const reader of readers) void reader.cancel().catch(() => {})
    }
    Object.defineProperty(window, key, { value: state, configurable: true })
  }
  const state = window[key]
  if (!state) return { installed: false }
  return { installed: true, documentId: state.documentId, revision: state.revision, startedAt: state.startedAt,
    captureBodies: state.captureBodies, droppedNetwork: state.droppedNetwork, droppedErrors: state.droppedErrors,
    droppedConsole: state.droppedConsole, console: state.console.filter(row => row.revision > cursor),
    hooks: state.hooks, hookErrors: state.hookErrors,
    network: state.network.filter(row => row.revision > cursor), errors: state.errors.filter(row => row.revision > cursor) }
}
