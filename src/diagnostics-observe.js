function pagePerformance(input = {}) {
  const d = pageDiagnosticState(), action = input.action || 'read'
  if (action === 'stop') {
    d.performance?.stop(); d.performance = null
    return { documentId: d.documentId, recording: false }
  }
  if (action === 'clear' || action === 'start') { d.performance?.stop(); d.performance = null }
  let p = d.performance
  if (!p) {
    const supported = typeof PerformanceObserver === 'function' ? [...(PerformanceObserver.supportedEntryTypes || [])] : []
    p = { startedAt: Date.now(), startedPerformanceTime: performance.now(), observers: [], entries: [], dropped: 0, frames: [], active: true,
      supported, observed: [], errors: [], totalLongTaskMs: 0, cls: 0, clsSession: 0, clsStart: 0, clsLast: 0, lcpMs: null,
      maxObservedInteractionMs: 0, visibilityAtStart: document.visibilityState }
    const cutoff = action === 'clear' ? p.startedPerformanceTime : 0
    const onEntries = list => {
      if (!p.active) return
      for (const entry of list.getEntries()) {
        if (entry.startTime < cutoff) continue
        const row = { type: entry.entryType, name: d.text(entry.name, 200), startTime: entry.startTime, duration: entry.duration }
        for (const k of ['value','hadRecentInput','interactionId','processingStart','processingEnd','renderTime','loadTime','size']) if (entry[k] !== undefined) row[k] = entry[k]
        if (entry.entryType === 'layout-shift' && !entry.hadRecentInput) {
          if (entry.startTime - p.clsLast > 1000 || entry.startTime - p.clsStart > 5000) { p.clsSession = 0; p.clsStart = entry.startTime }
          p.clsSession += entry.value; p.clsLast = entry.startTime; p.cls = Math.max(p.cls, p.clsSession)
        }
        if (entry.entryType === 'largest-contentful-paint') p.lcpMs = entry.startTime
        if (entry.entryType === 'longtask') p.totalLongTaskMs += entry.duration
        if (entry.entryType === 'event' && entry.interactionId) p.maxObservedInteractionMs = Math.max(p.maxObservedInteractionMs, entry.duration)
        p.entries.push(row)
        if (p.entries.length > 200) { p.entries.shift(); p.dropped++ }
      }
    }
    for (const type of ['paint','longtask','event','first-input','largest-contentful-paint','layout-shift','long-animation-frame']) {
      if (!supported.includes(type)) continue
      try {
        const observer = new PerformanceObserver(onEntries)
        observer.observe({ type, buffered: true, ...(type === 'event' ? { durationThreshold: 16 } : {}) })
        p.observers.push(observer); p.observed.push(type)
      } catch (error) { p.errors.push({ type, error: d.text(error.message) }) }
    }
    const frame = now => {
      if (!p.active) return
      if (p.lastFrame !== undefined) { p.frames.push(now - p.lastFrame); if (p.frames.length > 120) p.frames.shift() }
      p.lastFrame = now; p.raf = requestAnimationFrame(frame)
    }
    if (typeof requestAnimationFrame === 'function') p.raf = requestAnimationFrame(frame)
    p.stop = () => { p.active = false; for (const observer of p.observers) observer.disconnect(); if (p.raf) cancelAnimationFrame(p.raf) }
    d.performance = p
  }
  const read = () => {
    const fields = ['name','entryType','startTime','duration','initiatorType','transferSize','encodedBodySize','decodedBodySize',
      'domainLookupStart','domainLookupEnd','connectStart','connectEnd','secureConnectionStart','requestStart','responseStart','responseEnd',
      'domInteractive','domContentLoadedEventEnd','loadEventEnd','redirectCount','type']
    const entries = kind => performance.getEntriesByType(kind).slice(-d.cap(input.limit, 30, 100)).map(entry => {
      const row = {}; for (const key of fields) if (entry[key] !== undefined) row[key] = key === 'name' ? d.url(entry[key]) : entry[key]
      return row
    })
    const memory = performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize,
      jsHeapSizeLimit: performance.memory.jsHeapSizeLimit, source: 'non-standard aggregate, not a heap snapshot' } : { unavailable: 'performance.memory not exposed' }
    return d.finish({ recording: p.active, startedAt: p.startedAt, sampledUntil: Date.now(), visibility: document.visibilityState,
      visibilityAtStart: p.visibilityAtStart, supportedEntryTypes: p.supported, observedEntryTypes: p.observed, errors: p.errors,
      navigation: entries('navigation'), resources: entries('resource'), entries: p.entries.slice(-d.cap(input.limit, 30, 100)), dropped: p.dropped,
      metrics: { observedCLS: p.cls, observedLCPMs: p.lcpMs, observedLongTaskMs: p.totalLongTaskMs,
        maxObservedInteractionMs: p.maxObservedInteractionMs, frameSamples: p.frames.length,
        meanFrameIntervalMs: p.frames.length ? p.frames.reduce((sum, n) => sum + n, 0) / p.frames.length : null,
        maxFrameIntervalMs: p.frames.length ? Math.max(...p.frames) : null }, memory,
      scope: 'Page Performance APIs. Observed metrics depend on recording interval, visibility and buffered API support. maxObservedInteractionMs is not an INP calculation. No CPU profile, heap graph or browser Trace.' }, input)
  }
  return input.sampleMs ? new Promise(resolve => setTimeout(() => resolve(read()), d.cap(input.sampleMs, 0, 2000, 0))) : read()
}

function pageWatch(input = {}) {
  const d = pageDiagnosticState(), action = input.action || 'read'
  if (action === 'list') return d.finish({ watches: [...d.watches.values()].map(w => ({ watchId: w.id, target: w.target, startedAt: w.startedAt })) }, input)
  if (action !== 'start') {
    const w = d.watches.get(input.watchId)
    if (!w) throw new Error('Unknown or expired watchId; use browser_dev_watch action=list')
    if (action === 'stop') { w.stop(); d.watches.delete(w.id); return { documentId: d.documentId, stopped: true, watchId: w.id } }
    if (action === 'clear') { w.entries.length = 0; w.dropped = 0 }
    const rows = w.entries.filter(row => input.sinceId == null || row.id > input.sinceId).slice(0, d.cap(input.limit, 50, 100))
    return d.finish({ watchId: w.id, target: w.target, startedAt: w.startedAt, entries: rows, dropped: w.dropped,
      truncated: w.entries.filter(row => input.sinceId == null || row.id > input.sinceId).length > rows.length,
      nextSinceId: rows.at(-1)?.id ?? input.sinceId ?? 0, scope: 'Observed events/DOM changes since start. Listener registration tracking covers only subsequent calls; no event input values are collected.' }, input)
  }
  if (d.watches.size >= 10) throw new Error('Stop an existing watch first (limit 10)')
  if (input.trackListeners && [...d.watches.values()].some(w => w.trackListeners)) throw new Error('Only one listener-tracking watch can run in this document')
  const types = (input.events || ['click','change','input','submit','keydown']).slice(0, 20)
  if (types.some(type => typeof type !== 'string' || type.length > 80)) throw new Error('Invalid event type')
  const el = d.resolve(input), w = { id: `${d.documentId}:watch:${++d.serial}`, target: d.element(el), startedAt: Date.now(), entries: [], serial: 0, dropped: 0, cleanup: [], active: true, trackListeners: !!input.trackListeners }
  const push = row => { w.entries.push({ id: ++w.serial, timestamp: Date.now(), ...row }); if (w.entries.length > 200) { w.entries.shift(); w.dropped++ } }
  for (const type of types) {
    if (typeof type !== 'string' || type.length > 80) throw new Error('Invalid event type')
    const listener = event => push({ kind: 'event', type, target: d.element(event.target), trusted: event.isTrusted,
      defaultPrevented: event.defaultPrevented, ...(type === 'keydown' ? { keyClass: ['Enter','Tab','Escape','Backspace','Delete'].includes(event.key) ? event.key : '[character/modifier]' } : {}) })
    el.addEventListener(type, listener, true); w.cleanup.push(() => el.removeEventListener(type, listener, true))
  }
  if (input.mutations !== false && typeof MutationObserver === 'function') {
    const observer = new MutationObserver(records => {
      for (const record of records.slice(0, 200)) push({ kind: 'mutation', type: record.type, target: d.element(record.target),
        attribute: record.attributeName, added: record.addedNodes.length, removed: record.removedNodes.length })
      if (records.length > 200) w.dropped += records.length - 200
    })
    observer.observe(el, { subtree: true, childList: true, attributes: true, characterData: true }); w.cleanup.push(() => observer.disconnect())
  }
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => push({ kind: 'resize', rect: d.rect(el) }))
    observer.observe(el); w.cleanup.push(() => observer.disconnect())
  }
  if (input.trackListeners === true && typeof EventTarget !== 'undefined') {
    // This is a bounded registration history, not an authoritative inventory:
    // once/AbortSignal removals and pre-existing handlers cannot be reconstructed.
    for (const name of ['addEventListener','removeEventListener']) {
      const proto = EventTarget.prototype, before = proto[name]
      const installed = function (type, handler, options) {
        const result = Reflect.apply(before, this, arguments)
        try { if (w.active && (this === el || this?.nodeType === 1 && el.contains(this))) push({ kind: 'listener-registration', operation: name,
          type: d.text(type, 80), target: d.element(this), capture: typeof options === 'boolean' ? options : !!options?.capture,
          scope: 'Registration call only; once/signal/duplicate effects not resolved' }) } catch {}
        return result
      }
      try { proto[name] = installed; if (proto[name] === installed) w.cleanup.push(() => { if (proto[name] === installed) proto[name] = before }) }
      catch (error) { push({ kind: 'unavailable', feature: name, error: d.text(error.message) }) }
    }
  }
  w.stop = () => { w.active = false; for (const fn of w.cleanup.reverse()) { try { fn() } catch {} }; w.entries.length = 0 }
  d.watches.set(w.id, w)
  return { documentId: d.documentId, watchId: w.id, target: w.target, startedAt: w.startedAt,
    trackListeners: input.trackListeners === true, scope: 'Main-document target and subtree; no input values, historical events or V8 listener inventory.' }
}
