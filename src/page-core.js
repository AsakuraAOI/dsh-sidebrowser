// Shared primitives for ordinary browser actions and browser_dev diagnostics.
// Serialized into the guest without allocating a recorder, observer or store.
function pageClip(value, max = 1000) { return String(value ?? '').slice(0, max) }

function pageBoundInt(value, fallback, max, min = 1) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback
}

function pageSensitiveName(value) {
  return /password|passwd|secret|token|authorization|cookie|api[-_]?key/i.test(String(value ?? ''))
}

function pageCredentialElement(el) {
  return (el.getAttribute('type') || '').toLowerCase() === 'password'
    || pageSensitiveName([el.getAttribute('name'), el.getAttribute('autocomplete'), el.getAttribute('id')].join(' '))
    || /api.?key|otp|one-time-code/i.test([el.getAttribute('name'), el.getAttribute('autocomplete'), el.getAttribute('id')].join(' '))
}

function pageRedactURL(value, base, stripHash = false) {
  const url = base === undefined ? new URL(value) : new URL(value, base)
  url.username = ''; url.password = ''
  if (stripHash) url.hash = ''
  for (const name of [...url.searchParams.keys()]) if (pageSensitiveName(name)) url.searchParams.set(name, '[redacted]')
  return url.href
}

function pageRefState(create = false) {
  let state = window.__dshSidebrowserRefState
  if (state && (state.document !== document || state.root !== document.documentElement || state.url !== location.href)) {
    state.refs.clear(); state.signatures.clear()
    delete window.__dshSidebrowserRefState; delete window.__dshSidebrowserRefs
    state = undefined
  }
  if (!state && create) {
    state = { document, root: document.documentElement, url: location.href,
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 10), next: 0,
      refs: new Map(), ids: new WeakMap(), signatures: new Map(), capacity: 1000 }
    window.__dshSidebrowserRefState = state
    window.__dshSidebrowserRefs = state.refs
  }
  return state
}

function pageElementSignature(el) {
  return JSON.stringify([el.localName, ...['id','name','type','role','href','formaction','formmethod','aria-label'].map(name => el.getAttribute(name)),
    el.form?.getAttribute('action') || '', el.form?.getAttribute('method') || '',
    el.matches('button,a,[role=button],[role=link]') ? pageClip(el.textContent?.trim(), 200) : '',
    el.localName === 'input' && ['submit','button','reset'].includes(el.type) ? el.getAttribute('value') : ''])
}

function pageRememberElement(el) {
  const state = pageRefState(true), signature = pageElementSignature(el)
  let ref = state.ids.get(el)
  if (!ref || !state.refs.has(ref) || state.signatures.get(ref) !== signature) {
    if (ref) { state.refs.delete(ref); state.signatures.delete(ref) }
    ref = state.id + '-e' + ++state.next
    state.ids.set(el, ref)
  } else state.refs.delete(ref) // LRU: observations keep actively used targets.
  state.refs.set(ref, el); state.signatures.set(ref, signature)
  while (state.refs.size > state.capacity) { const old = state.refs.keys().next().value; state.refs.delete(old); state.signatures.delete(old) }
  return ref
}

function pageReadRoot(options = {}, preferBody = false) {
  if (options.root?.nodeType === 1 && options.root.ownerDocument === document) return { root: options.root, region: options.region, focus: options.focus }
  if (options.selector || options.ref) {
    const found = pageResolve(options.ref, options.selector)
    if (!found.el) throw new Error(`Read scope unavailable: ${found.reason}`)
    return { root: found.el, focus: found.el, region: { kind: options.selector ? 'selector' : 'ref', target: pageElementIdentity(found.el) } }
  }
  if (options.afterAction) {
    const found = options.focusRef || options.focusSelector ? pageResolve(options.focusRef, options.focusSelector) : {}
    const active = document.activeElement
    const candidate = found.el || (active && !['body','html'].includes(active.localName) ? active : null)
    const focus = candidate && pageVisible(candidate) ? candidate : null
    const main = document.querySelectorAll('main,[role="main"]')
    const root = focus?.closest('form') || focus?.closest('dialog,[role="dialog"]') || focus?.closest('main,[role="main"],section,article')
      || (main.length === 1 ? main[0] : document.body || document.documentElement)
    return { root, focus, region: { kind: 'after-action', target: pageElementIdentity(root), priorityTarget: pageElementIdentity(focus) } }
  }
  const root = preferBody ? document.body || document.documentElement : document.documentElement
  return { root, region: { kind: 'document', target: pageElementIdentity(root) } }
}

function pageScopedNodes(root, selector) {
  return [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)]
}

function pageResolve(ref, selector, unique = true) {
  if (ref) {
    const state = pageRefState(), el = state?.refs.get(ref)
    if (!el) return { reason: 'unknown-ref' }
    if (!el.isConnected || el.ownerDocument !== document) return { reason: 'stale-ref' }
    if (state.signatures.get(ref) !== pageElementSignature(el)) return { reason: 'changed-ref' }
    state.refs.delete(ref); state.refs.set(ref, el)
    return { el }
  }
  if (selector) {
    try {
      if (!unique) {
        const el = document.querySelector(selector)
        return el ? { el } : { reason: 'no-match' }
      }
      const matches = document.querySelectorAll(selector)
      if (matches.length > 1) return { reason: 'ambiguous-selector' }
      return matches[0] ? { el: matches[0] } : { reason: 'no-match' }
    } catch (error) { return { reason: 'invalid-selector', detail: String(error && error.message) } }
  }
  return { reason: 'missing-target' }
}

function pageVisible(el) {
  if (el.getClientRects().length === 0) return false
  const style = window.getComputedStyle(el)
  return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
}

function pageElementDisabled(el) { return !!el.disabled || el.getAttribute('aria-disabled') === 'true' }

function pageElementIdentity(el) {
  return el?.nodeType === 1 ? { tag: el.localName, id: pageClip(el.id, 120), class: pageClip(el.getAttribute('class'), 200) } : null
}

function pageElementRect(el) {
  const rect = el.getBoundingClientRect(), result = {}
  for (const name of ['x','y','top','left','right','bottom','width','height']) result[name] = Number.isFinite(rect[name]) ? rect[name] : null
  return result
}

function pageElementDimensions(el) {
  return { offsetWidth: el.offsetWidth, offsetHeight: el.offsetHeight, clientWidth: el.clientWidth, clientHeight: el.clientHeight,
    scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight }
}

function pageViewport() { return { width: innerWidth, height: innerHeight } }

function pageElementGeometry(el) {
  const rect = pageElementRect(el), viewport = pageViewport()
  const visibleRect = { left: Math.max(0, rect.left), top: Math.max(0, rect.top),
    right: Math.min(viewport.width, rect.right), bottom: Math.min(viewport.height, rect.bottom) }
  return { rect, viewport, visibleRect, inViewport: visibleRect.right > visibleRect.left && visibleRect.bottom > visibleRect.top }
}

function pageTargetPoint(geometry, policy = 'visible-center') {
  if (policy === 'visible-center') return { x: (geometry.visibleRect.left + geometry.visibleRect.right) / 2,
    y: (geometry.visibleRect.top + geometry.visibleRect.bottom) / 2 }
  // Inspection/cursor feedback can describe an offscreen target without
  // claiming it is clickable. Actions require the visible intersection.
  return { x: Math.max(0, Math.min(geometry.viewport.width - 1, geometry.rect.left + geometry.rect.width / 2)),
    y: Math.max(0, Math.min(geometry.viewport.height - 1, geometry.rect.top + geometry.rect.height / 2)) }
}

function pageHitTest(el, point) {
  const hit = document.elementFromPoint(point.x, point.y)
  return { hit, targetContainsHit: !!hit && (el === hit || el.contains(hit)) }
}

function pageRendererBox(el) {
  const rect = pageElementRect(el), sizes = pageElementDimensions(el), css = window.getComputedStyle(el)
  return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, clientWidth: sizes.clientWidth, clientHeight: sizes.clientHeight,
    layoutWidth: sizes.offsetWidth, layoutHeight: sizes.offsetHeight, transform: css.transform, transformOrigin: css.transformOrigin, display: css.display, overflow: css.overflow }
}

async function pageReadResponseText(response, options = {}) {
  const maxBytes = pageBoundInt(options.maxBytes, 16384, 16384), timeoutMs = pageBoundInt(options.timeoutMs, 1500, 3000)
  let reader, timer
  try {
    const type = response.headers.get('content-type') || ''
    if (!/text\/|json|xml|javascript|urlencoded/i.test(type) || /event-stream/i.test(type)) return { unavailable: 'Not a finite textual response' }
    if (options.isActive && !options.isActive()) return { unavailable: 'Recording stopped' }
    // Only inspect a clone: the original Response remains consumable by the app.
    reader = response.clone().body?.getReader()
    if (!reader) return { text: '', truncated: false }
    options.readers?.add(reader)
    const decoder = new TextDecoder(), parts = []; let size = 0
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Text read timed out')), timeoutMs) })
    while (!options.isActive || options.isActive()) {
      const { value, done } = await Promise.race([reader.read(), timeout])
      if (done) return { text: parts.join('') + decoder.decode(), truncated: false }
      parts.push(decoder.decode(value.subarray(0, maxBytes - size), { stream: true })); size += value.length
      // Do not flush a partial UTF-8 sequence at a truncated boundary.
      if (size >= maxBytes) return { text: parts.join(''), truncated: true }
    }
    return { unavailable: 'Recording stopped' }
  } catch (error) { return { unavailable: pageClip(error?.message || error, 500) } }
  finally {
    clearTimeout(timer)
    if (reader) { options.readers?.delete(reader); void reader.cancel().catch(() => {}) }
  }
}
