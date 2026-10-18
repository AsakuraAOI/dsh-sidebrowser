// Optional document instrumentation; all observers are released on stop.
function installDebugExtensions(state, api, options) {
  const { clip, url, push, request, update, finish, body, replace } = api
  const objects = new Map(), objectIds = new WeakMap(), cleanup = [], connections = new Map()
  let serial = 0, depth = 0
  const timers = new Map(), counts = new Map()
  const summarize = value => {
    const type = typeof value
    if (value === null) return { type: 'null', value: null }
    if (type === 'undefined') return { type }
    if (!['object','function'].includes(type)) return { type, value: type === 'string' ? clip(value, 2000) : type === 'number' && Number.isFinite(value) || type === 'boolean' ? value : String(value) }
    let id = objectIds.get(value)
    if (!id || !objects.has(id)) {
      id = `${state.documentId}:object:${++serial}`; objects.set(id, value); objectIds.set(value, id)
      if (objects.size > 200) objects.delete(objects.keys().next().value)
    }
    const result = { type, objectId: id, preview: [] }
    try {
      result.subtype = Array.isArray(value) ? 'array' : type === 'function' ? 'function' : value instanceof Error ? 'error' : 'object'
      const keys = Reflect.ownKeys(value).slice(0, 8)
      for (const key of keys) {
        const prop = Object.getOwnPropertyDescriptor(value, key)
        result.preview.push({ name: clip(key, 100), value: !prop || !('value' in prop) ? '[accessor: not evaluated]'
          : pageSensitiveName(key) ? '[redacted]'
            : prop.value === null ? 'null' : ['object','function'].includes(typeof prop.value) ? `[${typeof prop.value}]` : clip(prop.value, 200) })
      }
    } catch { result.unavailable = 'Object reflection failed (possibly a revoked proxy)' }
    return result
  }
  state.expandObject = input => {
    const value = objects.get(input.objectId)
    if (!objects.has(input.objectId)) throw new Error('Object handle expired, evicted or belongs to another document; record the value again')
    const offset = Math.max(0, Math.floor(input.offset || 0)), limit = Math.max(1, Math.min(50, Math.floor(input.limit || 20)))
    const keys = Reflect.ownKeys(value), properties = []
    for (const key of keys.slice(offset, offset + limit)) {
      const prop = Object.getOwnPropertyDescriptor(value, key)
      const item = { name: clip(key, 200), enumerable: !!prop?.enumerable, configurable: !!prop?.configurable }
      if (prop && 'value' in prop) item.value = pageSensitiveName(key) ? { type: 'redacted' } : summarize(prop.value)
      else { item.accessor = true; item.getter = !!prop?.get; item.setter = !!prop?.set }
      properties.push(item)
    }
    return { documentId: state.documentId, objectId: input.objectId, properties, offset, total: keys.length,
      truncated: offset + limit < keys.length, observedAt: Date.now(), scope: 'Live own-property descriptors, not a log-time deep snapshot. Getters are not invoked; Proxy reflection traps may run.' }
  }
  state.hooks.console = []
  for (const method of ['log','debug','info','warn','error','dir','table','trace','assert','group','groupCollapsed','groupEnd','time','timeLog','timeEnd','count','countReset','clear']) {
    if (typeof console[method] !== 'function') continue
    const installed = replace(console, method, original => function (...args) {
      const result = Reflect.apply(original, this, args)
      if (!state.active) return result
      try {
        if (method === 'assert' && args[0]) return result
        const label = args.length && typeof args[0] === 'string' ? clip(args[0], 100) : 'default'
        if (method === 'time') { timers.set(label, performance.now()); if (timers.size > 100) timers.delete(timers.keys().next().value) }
        const elapsed = ['timeLog','timeEnd'].includes(method) && timers.has(label) ? performance.now() - timers.get(label) : null
        if (method === 'timeEnd') timers.delete(label)
        if (method === 'count') { counts.set(label, (counts.get(label) || 0) + 1); if (counts.size > 100) counts.delete(counts.keys().next().value) }
        if (method === 'countReset') counts.delete(label)
        if (method === 'groupEnd') depth = Math.max(0, depth - 1)
        push('console', { timestamp: Date.now(), source: 'page-console', method, level: method === 'warn' ? 'warning' : ['error','assert'].includes(method) ? 'error' : method === 'debug' ? 'debug' : 'info',
          message: args.slice(0, 8).map(value => ['object','function'].includes(typeof value) && value !== null ? `[${typeof value}]` : clip(value, 200)).join(' '),
          args: args.slice(0, 12).map(summarize), argumentsTruncated: args.length > 12, groupDepth: depth,
          elapsedMs: elapsed, count: counts.get(label) ?? null, stack: clip(new Error().stack, 4000) })
        if (['group','groupCollapsed'].includes(method)) depth = Math.min(30, depth + 1)
      } catch { /* Logging must retain the native call's behavior. */ }
      return result
    })
    if (installed) state.hooks.console.push(method)
  }
  const addEvent = (row, type, data) => {
    row.events ||= []; row.totalEvents = (row.totalEvents || 0) + 1
    row.events.push({ timestamp: Date.now(), type, data: body(data) })
    if (row.events.length > 20) { row.events.shift(); row.eventsTruncated = true }
    update(row)
  }
  const keep = (connection, dispose) => {
    connections.set(connection, dispose)
    if (connections.size > 100) { const [old, stop] = connections.entries().next().value; stop(); connections.delete(old) }
  }
  if (typeof WebSocket === 'function') state.hooks.webSocket = replace(window, 'WebSocket', original => new Proxy(original, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget)
      if (!state.active) return socket
      try {
        const row = request('websocket', args[0], 'WEBSOCKET'), listeners = []
        const listen = (type, fn) => { socket.addEventListener(type, fn); listeners.push(() => socket.removeEventListener(type, fn)) }
        listen('open', () => { row.state = 'open'; update(row) })
        listen('message', event => addEvent(row, 'received', event.data))
        listen('error', () => { row.state = 'failed'; row.error = 'WebSocket error event (no browser transport details)'; finish(row) })
        listen('close', event => { row.state = 'closed'; row.closeCode = event.code; row.wasClean = event.wasClean; finish(row); connections.get(socket)?.(); connections.delete(socket) })
        const before = socket.send
        const send = function (...values) { const result = Reflect.apply(before, this, values); if (this === socket && state.active) addEvent(row, 'sent', values[0]); return result }
        socket.send = send
        keep(socket, () => { for (const remove of listeners) remove(); if (socket.send === send) socket.send = before })
      } catch { /* Return the native connection even when probing fails. */ }
      return socket
    },
  }))
  if (typeof EventSource === 'function') state.hooks.eventSource = replace(window, 'EventSource', original => new Proxy(original, {
    construct(target, args, newTarget) {
      const stream = Reflect.construct(target, args, newTarget)
      if (!state.active) return stream
      try {
        const row = request('eventsource', args[0], 'GET'), listeners = [], subscribed = new Set(), add = stream.addEventListener
        const listen = (type, fn) => { Reflect.apply(add, stream, [type, fn]); listeners.push(() => stream.removeEventListener(type, fn)) }
        const named = type => { if (typeof type !== 'string' || subscribed.has(type) || ['open','error'].includes(type) || subscribed.size >= 20) return
          subscribed.add(type); listen(type, event => { addEvent(row, type, event.data); row.lastEventId = clip(event.lastEventId, 200) }) }
        listen('open', () => { row.state = 'open'; update(row) })
        listen('error', () => { row.state = stream.readyState === 2 ? 'closed' : 'reconnecting'; update(row) })
        named('message'); for (const type of (options.eventTypes || []).slice(0, 20)) named(type)
        // Install our observer before the application's listener: its handler
        // may synchronously close the stream and remove our subscriptions.
        const addWrapped = function (type, ...rest) { if (this === stream && state.active) named(type); return Reflect.apply(add, this, [type, ...rest]) }
        stream.addEventListener = addWrapped
        const close = stream.close
        const closeWrapped = function (...values) { const result = Reflect.apply(close, this, values); if (this === stream) { row.state = 'closed'; finish(row); connections.get(stream)?.(); connections.delete(stream) }; return result }
        stream.close = closeWrapped
        keep(stream, () => { for (const remove of listeners) remove(); if (stream.addEventListener === addWrapped) stream.addEventListener = add; if (stream.close === closeWrapped) stream.close = close })
      } catch {}
      return stream
    },
  }))
  if (typeof navigator.sendBeacon === 'function') state.hooks.beacon = replace(navigator, 'sendBeacon', original => function (...args) {
    const accepted = Reflect.apply(original, this, args)
    if (state.active) try { const row = request('beacon', args[0], 'POST'); row.state = accepted ? 'queued' : 'not-queued'; row.requestBody = body(args[1]); row.serverReceiptVerified = false; finish(row) } catch {}
    return accepted
  })
  return () => { for (const dispose of [...cleanup, ...connections.values()]) { try { dispose() } catch {} }; connections.clear(); objects.clear(); timers.clear(); counts.clear() }
}
