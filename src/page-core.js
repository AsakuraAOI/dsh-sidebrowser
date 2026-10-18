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

function pageResolve(ref, selector, unique = true) {
  if (ref) {
    const store = window.__dshSidebrowserRefs
    const el = store && store.get ? store.get(ref) : undefined
    if (!el) return { reason: 'unknown-ref' }
    if (!el.isConnected) return { reason: 'stale-ref' }
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
