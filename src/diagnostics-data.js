async function pageStorage(input = {}) {
  const d = pageDiagnosticState(), area = input.area || 'local', action = input.action || 'list', limit = d.cap(input.limit, 30, 100)
  if (['local','session'].includes(area)) {
    const storage = area === 'local' ? localStorage : sessionStorage
    if (action === 'get') {
      if (typeof input.key !== 'string') throw new Error('A storage key is required')
      const value = storage.getItem(input.key)
      return d.finish({ area, key: input.key, value: d.sensitive.test(input.key) ? '[redacted]' : value === null ? null : value.slice(0, 16000),
        truncated: value !== null && value.length > 16000, scope: 'Current origin, read only' }, input)
    }
    const keys = []; for (let i = 0; i < Math.min(storage.length, limit); i++) keys.push(storage.key(i))
    return d.finish({ area, keys, total: storage.length, truncated: storage.length > limit, scope: 'Current origin, keys only; use get for a value' }, input)
  }
  if (area === 'indexeddb') {
    if (!window.indexedDB || typeof indexedDB.databases !== 'function') return { unavailable: 'IndexedDB database enumeration not supported', documentId: d.documentId }
    const databases = await indexedDB.databases()
    if (!input.database) return d.finish({ area, databases: databases.slice(0, limit), truncated: databases.length > limit }, input)
    if (!databases.some(db => db.name === input.database)) throw new Error('Database not found; refusing to create a database while inspecting')
    const db = await new Promise((resolve, reject) => {
      let settled = false
      const request = indexedDB.open(input.database)
      const fail = message => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(message)) } }
      const timer = setTimeout(() => fail('IndexedDB open timed out'), 1200)
      request.onupgradeneeded = () => { request.transaction.abort(); fail('Database changed or disappeared; creation/upgrade aborted') }
      request.onblocked = () => fail('IndexedDB open blocked')
      request.onerror = () => fail(request.error?.message || 'IndexedDB open failed')
      request.onsuccess = () => { if (settled) { request.result.close(); return }; settled = true; clearTimeout(timer); resolve(request.result) }
    })
    try {
      const stores = [...db.objectStoreNames]
      if (!input.store) return d.finish({ area, database: db.name, version: db.version, stores }, input)
      if (!stores.includes(input.store)) throw new Error('Object store not found')
      const transaction = db.transaction(input.store, 'readonly'), store = transaction.objectStore(input.store)
      const rows = await new Promise((resolve, reject) => {
        const rows = []; let truncated = false, settled = false
        const timer = setTimeout(() => { if (!settled) { settled = true; try { transaction.abort() } catch {}; reject(new Error('IndexedDB read timed out')) } }, 1200)
        const request = input.recordKey === undefined ? store.openCursor() : store.openCursor(IDBKeyRange.only(input.recordKey))
        request.onerror = () => { clearTimeout(timer); settled = true; reject(new Error(request.error?.message || 'Cursor failed')) }
        request.onsuccess = () => {
          if (settled) return
          const cursor = request.result
          if (!cursor || rows.length >= limit) { truncated = !!cursor; settled = true; clearTimeout(timer); resolve({ rows, truncated }); return }
          rows.push({ key: d.preview(cursor.key), value: d.sensitive.test(String(cursor.key)) ? '[redacted]' : d.preview(cursor.value) }); cursor.continue()
        }
      })
      return d.finish({ area, database: db.name, store: input.store, indexes: [...store.indexNames], keyPath: store.keyPath, ...rows, scope: 'Current origin, readonly transaction, bounded object previews' }, input)
    } finally { db.close() }
  }
  if (area === 'cache') {
    if (!window.caches) return { documentId: d.documentId, unavailable: 'Cache Storage not exposed' }
    const names = await caches.keys()
    if (!input.cacheName) return d.finish({ area, caches: names.slice(0, limit), truncated: names.length > limit }, input)
    if (!names.includes(input.cacheName)) throw new Error('Cache not found; refusing to create it')
    const cache = await caches.open(input.cacheName)
    if (action === 'get') {
      const entry = d.cacheEntries.get(input.entryId)
      if (!entry || entry.cacheName !== input.cacheName) throw new Error('Unknown/expired cache entryId; list this cache again')
      const response = await cache.match(entry.request)
      if (!response) return { documentId: d.documentId, unavailable: 'Entry no longer exists' }
      let body
      if (response.type === 'opaque' || response.type === 'opaqueredirect') body = { unavailable: 'Opaque response' }
      else body = await pageReadResponseText(response)
      return d.finish({ area, entryId: input.entryId, status: response.status, type: response.type, body }, input)
    }
    const requests = await cache.keys(), entries = []
    for (const request of requests.slice(0, limit)) {
      const id = `${d.documentId}:cache:${++d.serial}`
      d.cacheEntries.set(id, { cacheName: input.cacheName, request })
      if (d.cacheEntries.size > 100) d.cacheEntries.delete(d.cacheEntries.keys().next().value)
      entries.push({ entryId: id, url: d.url(request.url), method: request.method })
    }
    return d.finish({ area, cacheName: input.cacheName, entries, truncated: requests.length > limit }, input)
  }
  throw new Error('Unsupported storage area')
}

async function pageSources(input = {}) {
  const d = pageDiagnosticState(), action = input.action || 'list'
  const sourceMap = (text, base, declared) => {
    const matches = [...text.matchAll(/[#@]\s*sourceMappingURL\s*=\s*([^\s*]+)/g)]
    const name = declared || matches.at(-1)?.[1]
    if (!name) return { sourceMap: null }
    try {
      const address = new URL(name, base).href, id = `${d.documentId}:source:${++d.serial}`
      d.sources.set(id, { url: address, kind: 'source-map', inline: '' })
      if (d.sources.size > 100) d.sources.delete(d.sources.keys().next().value)
      return { sourceMap: d.url(address), sourceMapId: id, sourceMapDeclaration: declared ? 'response-header' : 'text-comment-candidate' }
    } catch { return { sourceMap: null, sourceMapUnavailable: 'Invalid declaration URL' } }
  }
  if (action === 'get') {
    const item = d.sources.get(input.sourceId)
    if (!item) throw new Error('Unknown/expired sourceId; list sources in this document again')
    if (!item.url) return d.finish({ sourceId: input.sourceId, kind: item.kind, text: item.inline.slice(0, 16000), truncated: item.inline.length > 16000,
      ...sourceMap(item.inline, location.href) }, input)
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2000)
    try {
      const response = await fetch(item.url, { signal: controller.signal })
      const body = await pageReadResponseText(response)
      return d.finish({ sourceId: input.sourceId, url: d.url(item.url), status: response.status,
        ...sourceMap(body.text || '', response.url || item.url, response.headers.get('sourcemap') || response.headers.get('x-sourcemap')), body,
        scope: 'Page fetch under its normal permissions; this issues a GET and may be visible in Network. No debugger source registry.' }, input)
    } finally { clearTimeout(timer) }
  }
  const nodes = [...document.querySelectorAll('script,link[rel="stylesheet"],style')], sources = []
  for (const node of nodes.slice(0, d.cap(input.limit, 50, 100))) {
    const id = `${d.documentId}:source:${++d.serial}`, url = node.src || node.href || ''
    const kind = node.localName === 'script' ? 'script' : 'stylesheet'
    d.sources.set(id, { url, kind, inline: url ? '' : (node.textContent || '').slice(0, 20000) })
    if (d.sources.size > 100) d.sources.delete(d.sources.keys().next().value)
    sources.push({ sourceId: id, kind, url: url ? d.url(url) : null, inlineChars: url ? 0 : node.textContent.length, type: node.getAttribute('type') || '' })
  }
  return d.finish({ sources, truncated: sources.length < nodes.length, scope: 'DOM-declared script/styles only; dynamically imported modules and unavailable source maps are not enumerated.' }, input)
}
