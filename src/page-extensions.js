// Fixed page-side readers. These functions are embedded into the Client bundle
// by scripts/build.mjs; they run in the selected guest, never in the DSH host.

export function pageExtract(kind, selector, limit, maxChars) {
  const result = { url: location.href, title: document.title || '', kind, items: [], truncated: false }
  let remaining = Math.max(128, Math.min(50000, maxChars || 10000))
  const count = Math.max(1, Math.min(kind === 'tables' ? 10 : 200, Math.floor(limit || 50)))
  let cellBudget = 2000
  const text = (value, cap = 500) => {
    const valueText = String(value || '').replace(/\s+/g, ' ').trim()
    const cut = valueText.slice(0, Math.min(cap, remaining))
    remaining -= cut.length
    if (cut.length < valueText.length) result.truncated = true
    return cut
  }
  const defaults = { links: 'a[href]', headings: 'h1,h2,h3,h4,h5,h6', tables: 'table', list: 'li' }
  if (!defaults[kind]) throw new Error('Unsupported extraction kind')
  let nodes
  try { nodes = document.querySelectorAll(selector || defaults[kind]) }
  catch { throw new Error('Invalid extraction selector') }
  for (const el of nodes) {
    if (!pageVisible(el)) continue
    if (result.items.length >= count || remaining <= 0) { result.truncated = true; break }
    if (kind === 'links') result.items.push({ text: text(el.innerText || el.textContent), href: text(el.href || el.getAttribute('href'), 2000) })
    else if (kind === 'headings') result.items.push({ level: Number(el.tagName.slice(1)) || 0, text: text(el.innerText || el.textContent) })
    else if (kind === 'list') result.items.push({ text: text(el.innerText || el.textContent) })
    else {
      const rows = []
      let rowTruncated = false
      for (const row of el.rows || el.querySelectorAll('tr')) {
        if (!pageVisible(row)) continue
        if (rows.length >= 100 || remaining <= 0 || cellBudget <= 0) { rowTruncated = true; break }
        const cells = [...(row.cells || row.querySelectorAll('th,td'))]
        if (cells.length > 30) rowTruncated = true
        const included = cells.slice(0, Math.min(30, cellBudget))
        if (included.length < cells.length) rowTruncated = true
        cellBudget -= included.length
        rows.push(included.map(cell => text(cell.innerText || cell.textContent, 1000)))
      }
      result.items.push({ rows, truncated: rowTruncated })
      if (rowTruncated) result.truncated = true
    }
  }
  return result
}

export function pageSnapshot(maxChars, maxElements) {
  const read = pageReadText(Math.max(128, Math.min(30000, maxChars || 8000)))
  const controls = pageReadElements(Math.max(1, Math.min(200, maxElements || 80)))
  const headings = pageExtract('headings', '', 40, 2000)
  const links = pageExtract('links', '', 40, 4000)
  const frames = [...document.querySelectorAll('iframe,frame')].slice(0, 30).map((el, index) => {
    let readable = false
    try { readable = !!el.contentDocument?.documentElement } catch {}
    return { index, title: (el.getAttribute('title') || '').slice(0, 200), src: (el.getAttribute('src') || '').slice(0, 2000), readable }
  })
  return {
    ...read, capturedAt: new Date().toISOString(), readyState: document.readyState,
    viewport: pageViewport(),
    headings: headings.items, links: links.items, elements: controls.elements, frames,
    snapshotId: controls.elements[0]?.ref.split('-e')[0] || '',
    truncated: read.truncated || controls.truncated || headings.truncated || links.truncated,
    scope: 'Current rendered main document. Virtualized content and cross-origin iframe DOM are not included.',
  }
}

export function pagePrepareNative(ref, selector, action) {
  const found = pageResolve(ref, selector)
  if (!found.el) return { ok: false, reason: found.reason }
  const el = found.el
  if (pageElementDisabled(el)) return { ok: false, reason: 'disabled-element' }
  if (!pageVisible(el)) return { ok: false, reason: 'hidden-element' }
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const geometry = pageElementGeometry(el)
  if (!geometry.inViewport) return { ok: false, reason: 'outside-viewport' }
  const { x, y } = pageTargetPoint(geometry)
  if (!pageHitTest(el, { x, y }).targetContainsHit) return { ok: false, reason: 'covered-element' }
  if (action === 'type') {
    const tag = el.tagName.toLowerCase()
    if (el.readOnly || !(['input', 'textarea'].includes(tag) || el.isContentEditable)) return { ok: false, reason: 'not-editable' }
    if (tag === 'input' && ['file','checkbox','radio','button','submit','reset','hidden'].includes((el.type || '').toLowerCase())) return { ok: false, reason: 'not-editable' }
    el.focus()
    if (el.isContentEditable) {
      const range = document.createRange()
      range.selectNodeContents(el)
      const selection = window.getSelection()
      selection.removeAllRanges(); selection.addRange(range)
    } else {
      try { el.select() } catch { return { ok: false, reason: 'selection-unavailable' } }
    }
  } else if (action === 'press') el.focus()
  return { ok: true, x, y, url: location.href, viewportWidth: geometry.viewport.width, viewportHeight: geometry.viewport.height }
}

export function pageCoordinatePoint(x, y) {
  const viewport = pageViewport()
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) throw new Error('Coordinates must be inside the current page CSS viewport')
  return { ok: true, x, y, url: location.href, viewportWidth: viewport.width, viewportHeight: viewport.height }
}

export function pageVisualTarget(ref, selector) {
  const found = ref || selector ? pageResolve(ref, selector) : { el: document.activeElement }
  const el = found.el
  if (!el || el === document.body || !pageVisible(el)) return null
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const geometry = pageElementGeometry(el), point = pageTargetPoint(geometry, 'clamped-center')
  return { ...point, viewportWidth: geometry.viewport.width, viewportHeight: geometry.viewport.height }
}
