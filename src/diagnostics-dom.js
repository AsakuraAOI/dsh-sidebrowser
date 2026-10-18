// Helpers are serialized into the existing guest, alongside pageResolve.
function pageDiagnosticState() {
  const key = '__dshSidebrowserDiagnosticsV1__'
  if (window[key]) return window[key]
  const d = { documentId: `${Date.now()}-${Math.random().toString(36).slice(2)}`, serial: 0,
    patches: new Map(), watches: new Map(), sources: new Map(), cacheEntries: new Map() }
  d.cap = pageBoundInt
  d.text = pageClip
  d.sensitive = { test: pageSensitiveName }
  d.url = value => {
    try {
      return pageClip(pageRedactURL(value, location.href), 4096)
    } catch { return d.text(value) }
  }
  d.element = pageElementIdentity
  d.rect = pageElementRect
  d.resolve = input => {
    const found = input.ref || input.selector ? pageResolve(input.ref, input.selector) : { el: document.documentElement }
    if (!found.el) throw new Error(`Inspection target unavailable: ${found.reason}`)
    return found.el
  }
  d.preview = (value, depth = 0) => {
    if (value === undefined) return '[undefined]'
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return Number.isFinite(value) || typeof value !== 'number' ? value : String(value)
    if (typeof value !== 'object') return d.text(value, 1000)
    if (depth >= 2) return '[object: expand with a targeted read]'
    try {
      const output = Array.isArray(value) ? [] : {}
      const keys = Reflect.ownKeys(value).filter(k => typeof k === 'string').slice(0, 30)
      for (const k of keys) {
        if (Array.isArray(output) && k === 'length') continue
        const prop = Object.getOwnPropertyDescriptor(value, k)
        const item = d.sensitive.test(k) ? '[redacted]' : !prop || !('value' in prop) ? '[accessor: not evaluated]' : d.preview(prop.value, depth + 1)
        Object.defineProperty(output, k, { value: item, enumerable: true, configurable: true, writable: true })
      }
      return output
    } catch { return '[unavailable object]' }
  }
  d.finish = (value, input = {}) => {
    const result = { documentId: d.documentId, ...value }, budget = d.cap(input.maxChars, 12000, 30000, 1000)
    const json = JSON.stringify(result)
    if (json.length <= budget) return result
    const ids = {}
    for (const key of ['patchId','watchId','sourceId']) if (result[key]) ids[key] = result[key]
    return { documentId: d.documentId, ...ids, truncated: true, totalChars: json.length, preview: json.slice(0, budget - 250) }
  }
  d.restorePatch = patch => {
    const restored = [], conflicts = []
    for (const item of patch.items) {
      if (patch.el.style.getPropertyValue(item.name) !== item.applied || patch.el.style.getPropertyPriority(item.name) !== item.appliedPriority) { conflicts.push(item.name); continue }
      if (item.before === '') patch.el.style.removeProperty(item.name)
      else patch.el.style.setProperty(item.name, item.before, item.beforePriority)
      restored.push(item.name)
    }
    d.patches.delete(patch.id)
    return { patchId: patch.id, restored, conflicts, detached: !patch.el.isConnected }
  }
  d.dispose = () => {
    for (const patch of [...d.patches.values()].reverse()) d.restorePatch(patch)
    for (const watch of d.watches.values()) watch.stop()
    d.watches.clear(); d.performance?.stop(); d.sources.clear(); d.cacheEntries.clear()
    delete window[key]
  }
  Object.defineProperty(window, key, { value: d, configurable: true })
  return d
}

function pageInspect(input = {}) {
  const d = pageDiagnosticState(), el = d.resolve(input), geometry = pageElementGeometry(el), rect = geometry.rect
  const properties = input.properties?.length ? input.properties.slice(0, 60) : [
    'display','position','box-sizing','width','height','min-width','min-height','max-width','max-height',
    'margin','padding','border','overflow','overflow-x','overflow-y','transform','transform-origin',
    'flex','flex-direction','flex-wrap','align-items','align-self','justify-content','gap','grid-template-columns','grid-template-rows',
    'font-size','line-height','color','background-color','visibility','opacity','z-index',
  ]
  const readStyle = (node, pseudo) => {
    try { const css = getComputedStyle(node, pseudo); return Object.fromEntries((pseudo ? [...properties, 'content'] : properties).map(k => [k, css.getPropertyValue(k).slice(0, 600)])) }
    catch (error) { return { unavailable: d.text(error.message) } }
  }
  const credentials = pageCredentialElement(el)
  const attributes = [...el.attributes].slice(0, 40).map(attr => ({ name: attr.name,
    value: d.sensitive.test(attr.name) || credentials && attr.name === 'value' ? '[redacted]' : d.text(attr.value, 500) }))
  const ancestors = []
  for (let p = el.parentElement; p && ancestors.length < 8; p = p.parentElement) ancestors.push({ ...d.element(p), rect: d.rect(p), styles: readStyle(p) })
  const { x, y } = pageTargetPoint(geometry, 'clamped-center'), hitTest = pageHitTest(el, { x, y })
  return d.finish({ source: 'current-main-document', element: d.element(el), attributes, rect,
    dimensions: pageElementDimensions(el),
    state: { visible: pageVisible(el), disabled: pageElementDisabled(el), sensitive: credentials, inViewport: geometry.inViewport },
    styles: readStyle(el), pseudo: { before: readStyle(el, '::before'), after: readStyle(el, '::after') }, ancestors,
    hitTest: { x, y, hit: d.element(hitTest.hit), targetContainsHit: hitTest.targetContainsHit },
    viewport: { ...geometry.viewport, devicePixelRatio, scrollX, scrollY,
      documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight },
    openShadowRoot: !!el.shadowRoot, children: [...el.children].slice(0, 30).map(d.element),
    scope: 'Main-document selector/ref. Computed geometry is current; offscreen center hit tests are clamped. Cross-origin frames and closed shadow roots are not traversed.' }, input)
}

function pageStyles(input = {}) {
  const d = pageDiagnosticState(), action = input.action || 'read'
  if (action === 'restore') {
    const patch = d.patches.get(input.patchId)
    if (!patch) throw new Error('Unknown or expired patchId in this document')
    return d.finish(d.restorePatch(patch), input)
  }
  const el = d.resolve(input)
  if (action === 'set') {
    if (d.patches.size >= 20) throw new Error('Restore existing style patches before creating more (limit 20)')
    const changes = Object.entries(input.styles || {})
    if (!changes.length || changes.length > 30) throw new Error('styles needs 1–30 CSS property/value pairs')
    for (const [name, value] of changes) if (!/^--[\w-]+$|^[a-z][a-z-]*$/.test(name) || typeof value !== 'string' || value.length > 2000) throw new Error('Invalid CSS property or value')
    const patch = { id: `${d.documentId}:patch:${++d.serial}`, el, items: [] }
    for (const [name, value] of changes) {
      const item = { name, before: el.style.getPropertyValue(name), beforePriority: el.style.getPropertyPriority(name) }
      el.style.setProperty(name, value, input.important ? 'important' : '')
      item.applied = el.style.getPropertyValue(name); item.appliedPriority = el.style.getPropertyPriority(name)
      patch.items.push(item)
    }
    d.patches.set(patch.id, patch)
    return d.finish({ patchId: patch.id, element: d.element(el), properties: patch.items.map(item => ({ name: item.name, value: item.applied, priority: item.appliedPriority })) }, input)
  }
  const matchedRules = [], inaccessibleSheets = [], limit = d.cap(input.limit, 30, 100)
  let scanned = 0, truncated = false
  const scan = (rules, sheet, conditions = []) => {
    for (const rule of rules) {
      if (++scanned > 5000 || matchedRules.length >= limit) { truncated = true; return }
      if (rule.selectorText && rule.style) {
        let matches = false
        try { matches = el.matches(rule.selectorText) } catch {}
        if (matches) matchedRules.push({ selector: rule.selectorText.slice(0, 500), css: rule.style.cssText.slice(0, 2000), sheet, conditions })
      } else if (rule.styleSheet) {
        try { scan(rule.styleSheet.cssRules, d.url(rule.href), [...conditions, 'import']) } catch { inaccessibleSheets.push(d.url(rule.href)) }
      } else if (rule.cssRules) {
        const condition = rule.conditionText || rule.name || rule.constructor?.name || 'group'
        let active = null
        if (rule.media) { try { active = matchMedia(rule.conditionText).matches } catch {} }
        else if (rule.constructor?.name === 'CSSSupportsRule') { try { active = CSS.supports(rule.conditionText) } catch {} }
        scan(rule.cssRules, sheet, [...conditions, { text: d.text(condition), active }])
      }
    }
  }
  const sheets = [...document.styleSheets, ...(document.adoptedStyleSheets || [])]
  for (const [index, sheet] of sheets.slice(0, 100).entries()) {
    const name = sheet.href ? d.url(sheet.href) : `inline/adopted:${index}`
    try { scan(sheet.cssRules, name, [{ sheetDisabled: !!sheet.disabled }]) } catch { inaccessibleSheets.push(name) }
  }
  return d.finish({ element: d.element(el), inline: el.style.cssText.slice(0, 5000), matchedRules, inaccessibleSheets, scanned, truncated,
    scope: 'Readable author CSSOM; grouped conditions reported, not a complete cascade/source-order/specificity resolver. Inherited rules, pseudo-selector matches and cross-origin sheet rules may be missing; use browser_dev_inspect for final computed values.' }, input)
}

function pageDiagnosticDispose() {
  window.__dshSidebrowserDiagnosticsV1__?.dispose()
  return { disposed: true }
}
