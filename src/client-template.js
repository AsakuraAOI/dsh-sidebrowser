// Adapted from guanhaisen/dsh-agent-browser @ 063465a77aa7c7ca1a154bd487ccd165e3f90185 (MIT). See THIRD_PARTY_NOTICES.md.
/**
 * dsh-sidebrowser — browser half.
 *
 * Registers one Client Cordis Inspect provider (`DSHSideBrowser`) that drives the
 * right-Sidebar browser tabs. The page lives here, in the renderer, so this is
 * the half that actually touches the DOM.
 *
 * Why this works on Desktop only
 * ------------------------------
 * Desktop renders each browser tab as an Electron `<webview>` guest tagged
 * `data-sidebar-browser-frame="webview"`. The application window runs with
 * `webviewTag: true`, so the host renderer may call `executeJavaScript` and
 * `capturePage` on that element. Web profiles render a sandboxed cross-origin
 * `<iframe>` instead, which cannot be read at all, so every method answers with
 * an explicit reason rather than pretending to work.
 *
 * Locating a tab's guest
 * ----------------------
 * `ui-sidebar-right` wraps every tab body in
 * `<div data-sidebar-right-tab="{tabId}">` inside its
 * `[data-sidebar-right-session="{sessionId}"]` owner. Desktop browser tabs
 * declare `keepMounted`, so a visited tab keeps its DOM across tab switches,
 * Session switches, collapse and floating — which is what lets a tool call
 * reach a tab the user is not currently looking at.
 *
 * Viewport sizing
 * ---------------
 * This half also owns the phone / tablet / desktop / custom viewport switcher.
 * Its controls are additive: a `sidebar.right.tab.menu.item` entry, a
 * `settings.general.item` row, and the `sidebrowser.viewport.cycle` shortcut. The
 * guest element's box is the page's viewport, so sizing means setting a real
 * pixel width on that element and scaling the result down for display.
 *
 * The inspected page is untrusted data. Everything this file returns is data
 * for the model to reason about; none of it is executed as an instruction.
 *
 * Bundled by hand: no build step, no dependency beyond what the shell provides.
 */
window.__ModuleLoader__.load({
  id: 'dsh-sidebrowser',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { defineStore } = require('@deepseek-ai/dsh-client-store')

    /** Inspect provider id the Host half queries. */
    const PROVIDER = 'DSHSideBrowser'

    /** Maximum interactive elements returned by one read. */
    const MAX_ELEMENTS = 300

    /**
     * Wall-clock budgets, in milliseconds.
     *
     * Held in one mutable object so the checks can shrink them: a suite that had
     * to wait out a real 15 s screenshot budget would take minutes to prove the
     * bound exists. Production never touches these; the values are the defaults
     * and are documented per field below.
     *
     * `call` is deliberately below the Inspect channel's client-query timeout
     * (10 s by default, raisable through `cordis-host-runner.clientInspectTimeoutMs`):
     * waiting longer than the caller's deadline only turns a clean "still
     * loading" answer into an opaque transport timeout.
     *
     * `call` is a budget for the WHOLE call, not for one step of it. Every wait a
     * call performs — settling after a navigation, sleeping for `wait`, settling
     * again — is charged against one deadline started when the call arrived, so
     * a single call can no longer accumulate past the caller's timeout. An
     * earlier build capped each step at 8 s independently, which let
     * `act { action: 'wait' }` spend 16 s and outlive a default 10 s timeout.
     *
     * `screenshot` is larger because capturing forces a paint of the whole
     * guest, and a genuinely heavy page — several iframes each running canvas
     * work — legitimately needs longer than a DOM read. It is still far below the
     * 60 s channel default, so a stalled renderer fails in 15 s with an
     * actionable message instead of burning a whole minute per attempt.
     *
     * `identity` bounds the small "who are you?" probe (`location.href` and
     * `document.title`). Every method wants an identity, so a long budget here
     * would tax every call; a document that cannot answer this quickly is not
     * going to answer a read either.
     *
     * `confirm` bounds how long a viewport change may spend proving the page
     * actually reflowed. A real reflow lands within a frame or two; anything
     * slower means the page is not going to agree, and reporting the
     * disagreement is more useful than waiting longer for it. `confirmReserve`
     * is kept back from a viewport change so a capture that follows it still has
     * time to size, settle and capture.
     */
    const BUDGETS = {
      call: 6_000,
      screenshot: 15_000,
      identity: 1_000,
      // Upper bound on the patience a screenshot spends confirming the page can
      // be inspected at all. Higher than the shared identity probe because a
      // heavy page may be briefly busy, and lower than the screenshot budget so
      // a real capture still has time afterwards.
      identityCeiling: 4_000,
      confirm: 2_000,
      confirmReserve: 2_000,
    }

    /**
     * Whether an address is Chrome's network-error page.
     *
     * A failed load leaves the guest on `chrome-error://chromewebdata/`. This is
     * distinct from an HTTP error status: a 404 is a real document the site
     * rendered, and stays fully readable. Only a transport-level failure lands
     * here, so treating it as "this tab has no page" is safe.
     * @param url - an address from either the page or Electron.
     * @returns true when it is the error page.
     */
    function isErrorPage(url) {
      return typeof url === 'string' && url.startsWith('chrome-error://')
    }

    /**
     * Share of the call budget a mid-call "let the page react" pause may use.
     * The rest is reserved for the settle and describe steps that follow it.
     */
    const REACTION_PAUSE_MS = 150

    /**
     * Start a per-call budget.
     * @param budgetMs - total budget for this call; defaults to the shared one.
     * @returns an absolute deadline in `Date.now()` terms.
     */
    function beginCall(budgetMs = BUDGETS.call) {
      return Date.now() + budgetMs
    }

    /**
     * Settle a promise within a budget, or fail with an actionable message.
     *
     * The Electron guest APIs this plugin calls — `executeJavaScript`,
     * `capturePage`, `loadURL` — take no abort signal and no timeout: an
     * unresponsive renderer simply never resolves. Awaiting one bare is what
     * turned a stalled page into a fixed 60 s stall, because the only remaining
     * bound was the Inspect channel's own client-query timeout. Racing a timer
     * gives the call a bound it actually controls.
     *
     * The timer is always cleared, and a rejection arriving after the race is
     * swallowed: the underlying operation is NOT cancelled (Electron offers no
     * way to), so it may still complete later. Reporting a timeout is therefore
     * a statement about how long we waited, never a claim that the work stopped.
     * @param promise - the operation to bound.
     * @param ms - how long to wait, in milliseconds.
     * @param what - short description of the operation, for the error.
     * @returns the promise's value.
     */
    async function raceBudget(promise, ms, what) {
      const budget = Math.max(0, ms)
      let timer
      // Mark the original as handled: if the timer wins, this promise rejects
      // later with nobody awaiting it, which would surface as an unhandled
      // rejection. Attaching a swallower does not change what the race observes.
      promise.catch(() => {})
      try {
        return await Promise.race([
          promise,
          new Promise((_resolve, reject) => {
            timer = setTimeout(
              () => {
                const error = new Error(
                  `${what} did not answer within ${Math.round(budget / 1000)}s. The page may be busy, ` +
                    'or its renderer may have stalled.',
                )
                // Tagged so callers can tell "we ran out of time" apart from
                // "the page threw", and report the former un-wrapped.
                error.budgetExceeded = true
                reject(error)
              },
              budget,
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * Time left inside a call budget, never below zero.
     * @param deadline - from {@link beginCall}.
     * @returns milliseconds remaining.
     */
    function budgetLeft(deadline) {
      return Math.max(0, deadline - Date.now())
    }

    // -----------------------------------------------------------------------
    // Page-side helpers.
    //
    // Each is a self-contained function with no reference to module scope: they
    // are serialized with toString() and evaluated inside the guest, wrapped in
    // one IIFE so they neither need nor pollute the page's global namespace.
    // -----------------------------------------------------------------------

    /**
     * Resolve a ref or selector to an element inside the page.
     * @param ref - ref from a previous elements read.
     * @param selector - explicit CSS selector.
     * @returns the element, or a reason it could not be resolved.
     */
    function pageResolve(ref, selector) {
      if (ref) {
        const store = window.__dshSidebrowserRefs
        const el = store && store.get ? store.get(ref) : undefined
        if (!el) return { reason: 'unknown-ref' }
        if (!el.isConnected) return { reason: 'stale-ref' }
        return { el }
      }
      if (selector) {
        let el
        try {
          const matches = document.querySelectorAll(selector)
          if (matches.length > 1) return { reason: 'ambiguous-selector' }
          el = matches[0]
        } catch (error) {
          return { reason: 'invalid-selector', detail: String(error && error.message) }
        }
        if (!el) return { reason: 'no-match' }
        return { el }
      }
      return { reason: 'missing-target' }
    }

    /**
     * Report the page's own identity.
     * @returns url, title and readyState.
     */
    function pageIdentity() {
      return {
        url: location.href,
        title: document.title || '',
        readyState: document.readyState,
      }
    }

    /**
     * Return the page's visible text, normalized and bounded.
     * @param maxChars - character budget.
     * @returns URL, title, text, and whether the text was cut.
     */
    function pageReadText(maxChars) {
      const text = document.body ? document.body.innerText || '' : ''
      const normalized = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
      const truncated = normalized.length > maxChars
      return {
        url: location.href,
        title: document.title || '',
        text: truncated ? normalized.slice(0, maxChars) : normalized,
        truncated,
      }
    }

    /**
     * Return the page's HTML, bounded.
     * @param maxChars - character budget.
     * @returns URL, title, html, and whether the html was cut.
     */
    function pageReadHtml(maxChars) {
      const html = document.documentElement ? document.documentElement.outerHTML : ''
      const truncated = html.length > maxChars
      return {
        url: location.href,
        title: document.title || '',
        html: truncated ? html.slice(0, maxChars) : html,
        truncated,
      }
    }

    /**
     * Whether an element is actually being drawn.
     *
     * Shared deliberately: `pageReadElements` filters its list by this, and
     * `pageWaitFor` decides `state: 'visible'` by it. Two copies of this rule
     * would drift, and the failure mode of drift here is silent — a `wait` that
     * reports "visible" for an element the element list would have skipped (or
     * the reverse) is exactly the kind of disagreement that costs a debugging
     * round. A report already hit the related trap by hand: it counted
     * `display:none` rows as present and concluded a layout had no overflow.
     *
     * Note this is not the same question as "does the selector match": an element
     * can be attached and invisible, which is why `state` distinguishes them.
     * @param el - the element to test.
     * @returns true when the element occupies layout boxes and is not hidden.
     */
    function pageVisible(el) {
      if (el.getClientRects().length === 0) return false
      const style = window.getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') return false
      if (style.opacity === '0') return false
      return true
    }

    /**
     * A short human label for an interactive element.
     * @param el - the element to describe.
     * @returns its accessible-ish name, bounded.
     */
    function pageLabelFor(el) {
      const tag = el.tagName.toLowerCase()
      const own =
        el.getAttribute('aria-label') ||
        (el.labels && el.labels.length > 0 ? el.labels[0].innerText : '') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        ''
      if (own.trim() !== '') return own.trim().slice(0, 200)
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return ''
      return (el.innerText || el.textContent || '').trim().slice(0, 200)
    }

    /**
     * Collect visible interactive elements, register each under a fresh `eN` ref,
     * and return their descriptors.
     *
     * `truncated` means the element CAP was reached — the list is incomplete and
     * reading again will not help. It deliberately does not count the matches
     * that were skipped for being invisible: almost every real page carries a
     * hidden input or a collapsed menu, so reporting those as truncation made
     * the flag permanently true and therefore useless.
     * @param max - element budget.
     * @returns element descriptors with the refs `act` accepts.
     */
    function pageReadElements(max) {
      const store = new Map()
      const generation = Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
      window.__dshSidebrowserRefs = store

      const out = []
      let cut = false
      const nodes = document.querySelectorAll(
        'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[contenteditable="true"]',
      )
      for (const el of nodes) {
        if (!pageVisible(el)) continue
        if (out.length >= max) {
          cut = true
          break
        }
        const ref = generation + '-e' + (out.length + 1)
        store.set(ref, el)
        const tag = el.tagName.toLowerCase()
        const type = tag === 'input' ? el.getAttribute('type') || 'text' : ''
        const secret = type === 'password' || /password|secret|token|api.?key|otp|one-time-code/i.test([el.getAttribute('name'), el.getAttribute('autocomplete'), el.getAttribute('id')].join(' '))
        const rawValue = secret ? '[redacted]' : tag === 'input' || tag === 'textarea' || tag === 'select' ? el.value : ''
        out.push({
          ref,
          tag,
          type,
          text: pageLabelFor(el),
          name: el.getAttribute('name') || '',
          value: typeof rawValue === 'string' ? rawValue.slice(0, 200) : '',
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
        })
      }
      return {
        url: location.href,
        title: document.title || '',
        elements: out,
        truncated: cut,
      }
    }

    /**
     * Click an element after scrolling it into view.
     * @param ref - ref from a previous elements read.
     * @param selector - explicit CSS selector.
     * @returns outcome.
     */
    function pageClick(ref, selector) {
      const found = pageResolve(ref, selector)
      if (!found.el) return { ok: false, reason: found.reason, detail: found.detail }
      const el = found.el
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'disabled-element' }
      if (!pageVisible(el)) return { ok: false, reason: 'hidden-element' }
      el.scrollIntoView({ block: 'center', inline: 'center' })
      if (typeof el.focus === 'function') el.focus()
      el.click()
      return { ok: true, tag: el.tagName.toLowerCase(), text: (el.innerText || '').trim().slice(0, 120) }
    }

    /**
     * Focus an element and set its value through the native setter so frameworks
     * observing the property descriptor (React and friends) see the change.
     * @param ref - ref from a previous elements read.
     * @param selector - explicit CSS selector.
     * @param text - text to enter.
     * @returns outcome.
     */
    function pageType(ref, selector, text) {
      const found = pageResolve(ref, selector)
      if (!found.el) return { ok: false, reason: found.reason, detail: found.detail }
      const el = found.el
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'disabled-element' }
      if (!pageVisible(el)) return { ok: false, reason: 'hidden-element' }
      if (el.readOnly) return { ok: false, reason: 'not-editable' }
      el.scrollIntoView({ block: 'center', inline: 'center' })
      if (typeof el.focus === 'function') el.focus()
      const tag = el.tagName.toLowerCase()

      if (tag === 'input' || tag === 'textarea') {
        const proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
        if (descriptor && descriptor.set) descriptor.set.call(el, text)
        else el.value = text
      } else if (el.isContentEditable) {
        el.textContent = text
      } else {
        return { ok: false, reason: 'not-editable', detail: tag }
      }

      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true, tag }
    }

    /**
     * Dispatch one key press on an element (or the active element).
     * @param ref - ref from a previous elements read.
     * @param selector - explicit CSS selector.
     * @param key - key name, such as Enter or ArrowDown.
     * @returns outcome.
     */
    function pagePress(ref, selector, key) {
      let target
      if (ref || selector) {
        const found = pageResolve(ref, selector)
        if (!found.el) return { ok: false, reason: found.reason, detail: found.detail }
        target = found.el
      } else {
        target = document.activeElement || document.body
      }
      if (target && typeof target.focus === 'function') target.focus()
      const init = { key, code: key, bubbles: true, cancelable: true }
      const down = new KeyboardEvent('keydown', init)
      target.dispatchEvent(down)
      target.dispatchEvent(new KeyboardEvent('keypress', init))
      target.dispatchEvent(new KeyboardEvent('keyup', init))
      // A native click for Enter/Space mirrors what a user's activation does on
      // buttons and links, which synthetic keyboard events alone do not trigger.
      if ((key === 'Enter' || key === ' ') && target && typeof target.click === 'function') {
        const tag = target.tagName.toLowerCase()
        if (tag === 'button' || tag === 'a' || target.getAttribute('role') === 'button') target.click()
      }
      return { ok: true, key, defaultPrevented: down.defaultPrevented }
    }

    /**
     * Scroll the window or an element.
     * @param ref - ref from a previous elements read.
     * @param selector - explicit CSS selector.
     * @param deltaX - horizontal pixels.
     * @param deltaY - vertical pixels.
     * @returns outcome.
     */
    function pageScroll(ref, selector, deltaX, deltaY) {
      if (ref || selector) {
        const found = pageResolve(ref, selector)
        if (!found.el) return { ok: false, reason: found.reason, detail: found.detail }
        found.el.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' })
        return { ok: true, scope: 'element' }
      }
      window.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' })
      return { ok: true, scope: 'window' }
    }

    /**
     * Choose an option in a `<select>`.
     * @param ref - ref from a previous elements read.
     * @param selector - explicit CSS selector.
     * @param value - option value or visible label.
     * @returns outcome.
     */
    function pageSelect(ref, selector, value) {
      const found = pageResolve(ref, selector)
      if (!found.el) return { ok: false, reason: found.reason, detail: found.detail }
      const el = found.el
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'disabled-element' }
      if (!pageVisible(el)) return { ok: false, reason: 'hidden-element' }
      if (el.tagName.toLowerCase() !== 'select') return { ok: false, reason: 'not-a-select' }
      const options = Array.from(el.options)
      const match =
        options.find((option) => option.value === value) || options.find((option) => option.text.trim() === value)
      if (!match) {
        return {
          ok: false,
          reason: 'no-such-option',
          detail: options
            .map((option) => option.value)
            .join(', ')
            .slice(0, 200),
        }
      }
      el.value = match.value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true }
    }

    /**
     * Evaluate caller-supplied JavaScript in the page.
     *
     * An expression is tried first, so `document.title` returns its value. Only a
     * genuine syntax error falls back to evaluating the source as a statement
     * body — never a runtime error, because re-running a body that already had a
     * side effect would repeat it. A statement body returns whatever it
     * explicitly `return`s, which is `undefined` (reported as `kind: 'undefined'`)
     * when it does not.
     * @param code - expression, or statements to evaluate.
     * @returns the JSON-serializable value, or a description of what came back.
     */
    async function pageEval(code) {
      let run
      try { run = new Function('"use strict";return (' + code + '\n)') }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        run = new Function('"use strict";' + code)
      }
      const value = await run()
      if (value === undefined) return { value: null, kind: 'undefined' }
      const kind = value === null ? 'null' : typeof value
      let serialized
      try { serialized = JSON.stringify(value) }
      catch { return { value: String(value).slice(0, 4000), kind: kind + ' (stringified)' } }
      if (serialized === undefined) return { value: String(value).slice(0, 4000), kind }
      if (serialized.length > 50000) return { value: serialized.slice(0, 50000), kind: 'truncated-json', truncated: true }
      return { value: JSON.parse(serialized), kind }
    }

    /**
     * Wait inside the page until a condition holds, or the budget runs out.
     *
     * This exists because nothing else could express "the app is ready". Every
     * wait the plugin had was a fixed sleep, and the reason is worth recording:
     * `settle` is driven by Electron's NAVIGATION loading state, which a
     * single-page app clears as soon as the HTML and its scripts arrive — long
     * before React (or any framework) has mounted and painted. So the only tool
     * available for "wait until the list is on screen" was guessing a duration,
     * and a report measured exactly how that fails in both directions: too short
     * on a slow machine, wasted time on a fast one.
     *
     * Polling lives in the page rather than in a loop of tool calls, so one call
     * can watch for the condition without spending N round trips and N tool
     * results to do it.
     *
     * `setTimeout` rather than `requestAnimationFrame`: rAF does not fire while a
     * document is hidden, and a hidden tab is precisely the state this plugin
     * already had to diagnose for screenshots. A wait that silently never
     * completes in a background tab would be a worse trap than a coarse poll.
     * @param selector - CSS selector to watch.
     * @param state - `'attached'`, `'visible'` or `'hidden'`.
     * @param timeoutMs - how long to keep checking.
     * @returns a promise for the outcome, including whether the condition was met.
     */
    function pageWaitFor(selector, state, timeoutMs) {
      const started = Date.now()
      const deadline = started + Math.max(0, timeoutMs)
      const poll = 50
      return new Promise((resolve) => {
        const settle = (matched) => {
          resolve({
            matched,
            state,
            selector,
            waitedMs: Date.now() - started,
            url: location.href,
            title: document.title || '',
          })
        }
        const satisfied = () => {
          let el
          try {
            el = document.querySelector(selector)
          } catch (error) {
            // An invalid selector is a caller mistake, not a timeout: report it
            // as such instead of polling for the full budget and then blaming
            // the page for not matching.
            return { invalid: String(error && error.message) }
          }
          if (state === 'attached') return { ok: el !== null }
          if (state === 'visible') return { ok: el !== null && pageVisible(el) }
          // 'hidden' is satisfied by absent as well as by invisible: both mean
          // "not on screen", and requiring presence would make the state useless
          // for waiting out a spinner that gets removed rather than hidden.
          return { ok: el === null || !pageVisible(el) }
        }
        const check = () => {
          const verdict = satisfied()
          if (verdict.invalid !== undefined) {
            resolve({
              matched: false,
              invalid: verdict.invalid,
              state,
              selector,
              waitedMs: Date.now() - started,
            })
            return
          }
          if (verdict.ok) {
            settle(true)
            return
          }
          if (Date.now() >= deadline) {
            settle(false)
            return
          }
          setTimeout(check, Math.min(poll, Math.max(0, deadline - Date.now())))
        }
        check()
      })
    }

    /**
     * Every page-side helper, in dependency order. `pageResolve` is referenced by
     * the interaction helpers, so it must be declared before them.
     */
    const PAGE_HELPERS = [
      pageResolve,
      pageVisible,
      pageLabelFor,
      pageIdentity,
      pageReadText,
      pageReadHtml,
      pageReadElements,
      pageClick,
      pageType,
      pagePress,
      pageScroll,
      pageSelect,
      pageWaitFor,
      pageEval,
      pageExtract,
      pageSnapshot,
      pagePrepareNative,
      pageCoordinatePoint,
      pageVisualTarget,
    ]

    /**
     * Build the source that runs one helper inside the guest.
     *
     * The helpers are serialized and wrapped in one IIFE, so they are available
     * to each other while leaving the page's global scope untouched.
     * @param helper - the function to call.
     * @param args - JSON-serializable arguments.
     * @returns source for `webview.executeJavaScript`.
     */
    function pageCall(helper, args) {
      const prelude = PAGE_HELPERS.map((fn) => fn.toString()).join('\n')
      const invocation = `(${helper.name})(${args.map((value) => JSON.stringify(value ?? null)).join(',')})`
      return `(() => {\n${prelude}\nreturn ${invocation}\n})()`
    }

    /** Drop keys whose value is undefined so the result stays lossless JSON. */
    function prune(value) {
      if (Array.isArray(value)) return value.map(prune)
      if (value === null || typeof value !== 'object') return value
      const out = {}
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue
        out[key] = prune(item)
      }
      return out
    }

    /** Human-readable reason for each refusal the page helpers report. */
    const REFUSAL_REASONS = {
      'unknown-ref': 'that ref is not from the latest browser_read; read the elements again.',
      'stale-ref': 'the element was replaced since the last read; read the elements again.',
      'no-match': 'no element matched that selector.',
      'ambiguous-selector': 'multiple elements match; use a fresh ref or a more precise selector.',
      'invalid-selector': 'that selector is not valid CSS.',
      'missing-target': 'pass either ref (from browser_read) or selector.',
      'not-editable': 'that element does not accept typed text; target an input, textarea or contenteditable.',
      'not-a-select': 'that element is not a <select>.',
      'no-such-option': 'that option does not exist in the select.',
    }

    /* PAGE_EXTENSIONS */

    // -----------------------------------------------------------------------
    // Viewport sizing
    //
    // The browser tab renders a <webview>, and that element's box IS the guest's
    // viewport: a 390px-wide element makes the page lay out at 390 CSS px, so the
    // site's own media queries take effect. To show a viewport wider than the
    // Sidebar column we scale the element down for display only, with a CSS
    // transform on a clipping wrapper.
    //
    // Deliberately NOT <webview>.setZoomFactor(): Chromium's zoom policy is
    // same-origin, so zooming one tab would also zoom another tab showing the
    // same site (tabs of one workspace share a storage partition). Element box +
    // CSS transform keeps every tab independent and leaves page layout truthful.
    // -----------------------------------------------------------------------

    /** Sizes a tab's viewport can take. */
    const VIEWPORT_PRESETS = [
      { id: 'auto', label: '自适应', description: '跟随侧栏宽度' },
      { id: 'phone', label: '手机', width: 390, height: 844, description: '390 × 844' },
      { id: 'tablet', label: '平板', width: 834, height: 1112, description: '834 × 1112' },
      { id: 'desktop', label: '电脑', width: 1280, height: 800, description: '1280 × 800' },
      { id: 'custom', label: '自定义…', description: '指定宽高' },
    ]

    /** Accepted custom viewport bounds, in CSS pixels. */
    const VIEWPORT_LIMITS = { minWidth: 240, maxWidth: 3840, minHeight: 320, maxHeight: 2160 }

    /** Below this display scale the result is too small to read, so we warn. */
    const MIN_COMFORTABLE_SCALE = 0.35

    /**
     * localStorage key holding per-tab viewport choices.
     *
     * v2 discards the v1 record on purpose. v1 could hold a `lastPreset` that a
     * per-tab change had overwritten (see `set` below), and that value is
     * indistinguishable from a deliberate default — so the only honest way to
     * un-poison an existing install is to stop reading it. Per-tab choices are
     * lost once; the alternative is a tab that stays at 1280×800 forever.
     */
    const VIEWPORT_PERSIST = 'dsh.sidebrowser.viewport.v2'

    /**
     * Clamp one numeric field to its allowed range.
     * @param value - candidate number.
     * @param min - inclusive lower bound.
     * @param max - inclusive upper bound.
     * @returns the rounded, clamped integer, or undefined when unusable.
     */
    function clampDimension(value, min, max) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
      const rounded = Math.round(value)
      if (rounded < min) return min
      if (rounded > max) return max
      return rounded
    }

    /**
     * Validate a custom viewport size.
     * @param size - candidate `{ width, height }`.
     * @returns normalized size, or a reason it was refused.
     */
    function normalizeViewportSize(size) {
      if (size === null || typeof size !== 'object') return { reason: 'not-an-object' }
      const width = clampDimension(size.width, VIEWPORT_LIMITS.minWidth, VIEWPORT_LIMITS.maxWidth)
      const height = clampDimension(size.height, VIEWPORT_LIMITS.minHeight, VIEWPORT_LIMITS.maxHeight)
      if (width === undefined) return { reason: 'bad-width' }
      if (height === undefined) return { reason: 'bad-height' }
      return { width, height }
    }

    /**
     * Resolve a stored selection into a concrete size request.
     * @param selection - `{ preset, custom }` from the store.
     * @returns `{ preset, width?, height? }`; width/height absent means "follow the column".
     */
    function resolveViewport(selection) {
      const preset = selection?.preset ?? 'auto'
      if (preset === 'auto') return { preset: 'auto' }
      if (preset === 'custom') {
        const custom = normalizeViewportSize(selection?.custom)
        if (custom.reason !== undefined) {
          return { preset: 'phone', width: 390, height: 844, fellBack: custom.reason }
        }
        return { preset: 'custom', width: custom.width, height: custom.height }
      }
      const found = VIEWPORT_PRESETS.find((entry) => entry.id === preset)
      if (found === undefined || found.width === undefined) return { preset: 'auto' }
      return { preset: found.id, width: found.width, height: found.height }
    }

    /**
     * Display scale that fits a target width into the available column.
     * @param targetWidth - the viewport width in CSS pixels.
     * @param availableWidth - the column's usable width in CSS pixels.
     * @returns a scale in (0, 1]; 1 means no shrink.
     */
    function computeScale(targetWidth, availableWidth) {
      if (!Number.isFinite(targetWidth) || targetWidth <= 0) return 1
      if (!Number.isFinite(availableWidth) || availableWidth <= 0) return 1
      if (availableWidth >= targetWidth) return 1
      return availableWidth / targetWidth
    }

    /**
     * Where to draw a scaled viewport inside the column.
     *
     * The page is centred rather than pinned to the top-left corner, which is
     * what "show me this at phone size" should look like. Centring is applied as
     * a translation *before* the scale in the CSS transform list
     * (`translate(...) scale(...)`), so the offsets are in unscaled column pixels
     * while the box itself is scaled about its top-left corner.
     *
     * Height is centred only when the scaled page actually fits. A tall preset
     * (say 390×844 in a shorter column) would otherwise be clipped at both ends,
     * hiding the top of the page; anchoring it to the top keeps the readable
     * start of the document visible.
     * @param targetWidth - the viewport width in CSS pixels.
     * @param targetHeight - the viewport height in CSS pixels.
     * @param availableWidth - the column's width in CSS pixels.
     * @param availableHeight - the column's height in CSS pixels.
     * @returns the scale, the scaled size, and the offsets to apply.
     */
    function computePlacement(targetWidth, targetHeight, availableWidth, availableHeight) {
      const scale = computeScale(targetWidth, availableWidth)
      const scaledWidth = targetWidth * scale
      const scaledHeight = targetHeight * scale
      const offsetX = Math.max(0, (availableWidth - scaledWidth) / 2)
      const fitsVertically =
        Number.isFinite(availableHeight) && availableHeight > 0 && scaledHeight <= availableHeight
      const offsetY = fitsVertically ? Math.max(0, (availableHeight - scaledHeight) / 2) : 0
      return { scale, scaledWidth, scaledHeight, offsetX, offsetY, verticallyCentered: fitsVertically }
    }

    /**
     * Remove any flex-centring left on a container by an earlier build.
     *
     * Centring is applied through the guest's transform, so flex centring on the
     * container would double-count and shove the page sideways. Clearing these on
     * every apply means an already-styled container is corrected in place rather
     * than needing a fresh page load.
     * @param container - the element wrapping the guest.
     */
    function clearCenteringStyles(container) {
      container.style.display = ''
      container.style.alignItems = ''
      container.style.justifyContent = ''
    }

    /**
     * The live store/controller pair, held in module scope.
     *
     * The menu component reads these from closure rather than from injected
     * props. That is deliberate: a prop that arrives `undefined` makes the
     * component throw during render, and a thrown slot entry disappears
     * silently — the menu simply shows the kit's own items and nothing else,
     * which is impossible to diagnose from the UI. One client half per page
     * means one runtime, so closure state is both correct and unbreakable.
     */
    let viewportRuntime

    /** Per-tab viewport choices, persisted so they survive a restart. */
    const viewportStore = defineStore({
      init: () => ({
        byTab: {},
        custom: { width: 390, height: 844 },
        lastPreset: 'auto',
      }),
      persist: VIEWPORT_PERSIST,
      actions: {
        /**
         * Record one tab's choice.
         *
         * This deliberately does NOT touch `lastPreset`. It used to, and that
         * made every per-tab change global: sizing one tab — or a
         * `browser_screenshot` that merely named a size — silently became the
         * default that every tab without a record of its own inherited, so a
         * page the user was reading rescaled itself for no visible reason. The
         * default for new tabs is `setDefault`'s job, and only the Settings row
         * calls it.
         */
        set: (draft, tabId, preset) => {
          draft.byTab[tabId] = { preset }
        },
        setCustom: (draft, size) => {
          draft.custom = { width: size.width, height: size.height }
        },
        /** Set the preset new tabs inherit, without touching any open tab. */
        setDefault: (draft, preset) => {
          draft.lastPreset = preset
        },
        /**
         * Put the whole preference state back, undoing a transient change.
         *
         * `browser_screenshot` sizes the page for one capture and then calls
         * this, so a screenshot never leaves a choice behind. The value comes
         * from `ViewportController.remember`, which copies the snapshot rather
         * than aliasing it — a draft may be mutated in place.
         */
        restore: (draft, state) => {
          draft.byTab = state.byTab
          draft.lastPreset = state.lastPreset
          draft.custom = state.custom
        },
        forget: (draft, tabId) => {
          if (Object.hasOwn(draft.byTab, tabId)) delete draft.byTab[tabId]
        },
      },
    })

    /**
     * Apply one tab's viewport choice to its guest element.
     *
     * Styling happens on the guest and on its existing parent container — the
     * builtin's own `viewport` element — rather than on a wrapper we insert.
     * That matters: the builtin's presentation calls `host.append(element)`
     * whenever it re-presents a guest, which would move the element straight
     * back out of any wrapper we added. Inline styles we set are not React-managed
     * props (the component sets className, never style), so React leaves them be.
     */
    class ViewportController {
      /**
       * @param store - the viewport preference store instance.
       */
      constructor(store) {
        this.store = store
        /** tabId -> { guest, container, observer, frame } */
        this.applied = new Map()
      }

      /**
       * Locate one tab's guest element.
       * @param sessionId - owning Session.
       * @param tabId - target tab.
       * @returns the webview, or undefined when it is not mounted.
       */
      findGuest(sessionId, tabId) {
        const escape = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape : (value) => value
        const root = document.querySelector(`[data-sidebar-right-session="${escape(sessionId)}"]`)
        if (root === null) return undefined
        for (const wrapper of root.querySelectorAll('[data-sidebar-right-tab]')) {
          if (wrapper.dataset.sidebarRightTab !== tabId) continue
          const guest = wrapper.querySelector('webview[data-sidebar-browser-frame="webview"]')
          if (guest) return guest
        }
        return undefined
      }

      /**
       * Apply the current choice for one tab.
       * @param sessionId - owning Session.
       * @param tabId - target tab.
       * @returns the applied state, or undefined when the guest is not mounted.
       */
      apply(sessionId, tabId) {
        // Cheap, and it keeps a closed tab's frame from being reported as the
        // current display state for this one.
        this.pruneDetached()
        const guest = this.findGuest(sessionId, tabId)
        if (guest === undefined) return undefined

        const container = guest.parentElement
        if (container === null) return undefined

        const entry = this.applied.get(tabId) ?? { guest, container }
        // A re-presented guest keeps the same container, but re-resolve anyway so
        // a stale reference never outlives the element it points at.
        entry.guest = guest
        entry.container = container
        this.applied.set(tabId, entry)

        const snapshot = this.store.getSnapshot()
        // A tab with no record of its own inherits the default ONCE, here, and
        // is then pinned to it. Reading the default on every apply — which is
        // what this used to do — turned the Settings row into a live control
        // over every open tab, contradicting its own contract ("the preset new
        // tabs inherit, without touching any open tab"): changing the default
        // rescaled pages the user was already reading, with nothing on screen
        // to connect the two events.
        let selection = snapshot.byTab[tabId]
        if (selection === undefined) {
          selection = { preset: snapshot.lastPreset }
          this.store.actions.set(tabId, selection.preset)
        }
        const target = resolveViewport({ preset: selection.preset, custom: snapshot.custom })

        const available =
          container.clientWidth ||
          container.getBoundingClientRect().width ||
          guest.getBoundingClientRect().width
        const availableHeight =
          container.clientHeight || container.getBoundingClientRect().height

        if (target.preset === 'auto') {
          container.style.overflow = ''
          container.style.position = ''
          clearCenteringStyles(container)
          guest.style.cssText = ''
          // No fixed target in auto: the page simply takes the column's width.
          entry.frame = {
            preset: 'auto',
            scale: 1,
            viewportWidth: Math.round(available) || undefined,
            columnWidth: Math.round(available) || undefined,
          }
        } else {
          const placement = computePlacement(target.width, target.height, available, availableHeight)
          const { scale, offsetX, offsetY } = placement
          // Clip inside the column so the oversized guest never widens the panel.
          //
          // Centring is done with the transform's translate, NOT with flexbox on
          // the container: flex centres the element's LAYOUT box, which here is
          // the full unscaled target (e.g. 1280px inside a 650px column), so it
          // would push the scaled result off to one side while the translate did
          // the same job again. One mechanism only — and any flex centring left
          // over from an earlier build is cleared here.
          container.style.overflow = 'hidden'
          container.style.position = 'relative'
          clearCenteringStyles(container)
          // The element's box IS the page's viewport, so its height must be the
          // real target height: dividing by the scale would stretch the viewport
          // (a "1280×800" preset would lay out at 1571px tall) and quietly break
          // `100vh` and any height-driven layout.
          //
          // `translate` comes BEFORE `scale` in the list, so the offsets are in
          // unscaled column pixels and the scale still happens about the
          // element's top-left corner.
          const translate =
            offsetX > 0.5 || offsetY > 0.5
              ? `translate(${offsetX.toFixed(2)}px, ${offsetY.toFixed(2)}px) `
              : ''
          guest.style.cssText = [
            'flex:none',
            `width:${target.width}px`,
            `height:${target.height}px`,
            'min-width:0',
            'min-height:0',
            `transform:${translate}scale(${scale})`,
            'transform-origin:top left',
          ].join(';')
          entry.frame = {
            preset: target.preset,
            scale,
            viewportWidth: target.width,
            viewportHeight: target.height,
            // What `scale` is a ratio OF. It is the Sidebar column's own width,
            // not the delivered image: `scale === columnWidth / viewportWidth`.
            // A report tried to use `scale × pageWidth` for pixel conversion and
            // got the same number (767) for two different viewports, because that
            // product is just the column width — which is only constant while the
            // column is. Stating it removes the guesswork.
            columnWidth: Math.round(available) || undefined,
            fellBack: target.fellBack,
            offsetX: Math.round(offsetX),
            offsetY: Math.round(offsetY),
            verticallyCentered: placement.verticallyCentered,
          }
        }

        if (entry.observer === undefined && typeof ResizeObserver === 'function') {
          entry.observer = new ResizeObserver(() => {
            // Column resized: recompute the display scale for this tab only.
            this.apply(sessionId, tabId)
          })
          entry.observer.observe(container)
        }
        return entry.frame
      }

      /**
       * Forget tabs whose guest has left the document.
       *
       * `forget` is the precise path, but nothing outside this class reliably
       * knows when a tab closes, so the map would otherwise hold a frame and a
       * live `ResizeObserver` per tab id for the whole page lifetime. Worse, a
       * closed tab's frame stayed readable, which let the menu quote a display
       * scale for a tab that no longer exists.
       *
       * A removed guest is the observable signal available here: the built-in
       * keeps a visited tab mounted, so a guest that is gone is a tab that is
       * gone. `isConnected` is checked by identity (`=== false`) so a carrier
       * that does not expose it at all is left alone rather than pruned.
       * @returns how many entries were dropped.
       */
      pruneDetached() {
        let dropped = 0
        for (const [tabId, entry] of this.applied) {
          if (entry.guest?.isConnected !== false) continue
          entry.observer?.disconnect()
          this.applied.delete(tabId)
          dropped++
        }
        return dropped
      }

      /**
       * Apply every mounted browser tab of a Session.
       * @param sessionId - owning Session.
       * @param tabIds - the Session's browser tab ids.
       */
      applyAll(sessionId, tabIds) {
        this.pruneDetached()
        for (const tabId of tabIds) this.apply(sessionId, tabId)
      }

      /**
       * Report the applied frame for one tab.
       * @param tabId - target tab.
       * @returns the frame, or undefined when nothing is applied.
       */
      frameOf(tabId) {
        return this.applied.get(tabId)?.frame
      }

      /**
       * Describe a tab's viewport choice and the size its page lays out at.
       *
       * The measured width is the guest's own `innerWidth`, which is the number
       * the page's media queries actually see — not the scaled box we draw.
       *
       * `custom` is reported only when the resolved preset IS `custom`. It used
       * to be echoed unconditionally from the store, so a read of a `desktop` tab
       * returned `preset: "desktop"` next to `custom: {width: 320, height: 700}`
       * — two fields describing different viewports in one answer, with no way to
       * tell which one the page was actually using.
       * @param sessionId - owning Session.
       * @param tabId - target tab.
       * @param budgetMs - how long the measurement probe may take.
       * @returns the preset, the page's CSS pixel size, and the display scale.
       */
      async describe(sessionId, tabId, budgetMs = BUDGETS.identity) {
        const frame = this.apply(sessionId, tabId)
        const guest = this.findGuest(sessionId, tabId)
        const snapshot = this.store.getSnapshot()
        const selection = snapshot.byTab[tabId] ?? { preset: snapshot.lastPreset }
        const preset = selection.preset ?? 'auto'

        let measured
        if (guest !== undefined) {
          try {
            measured = await raceBudget(
              guest.executeJavaScript('({ w: window.innerWidth, h: window.innerHeight })', true),
              budgetMs,
              'the viewport probe',
            )
          } catch {
            measured = undefined
          }
        }
        return prune({
          tabId,
          preset,
          // Only meaningful for the custom preset; see above.
          custom: preset === 'custom' ? snapshot.custom : undefined,
          // What the page believes its viewport is.
          pageWidth: measured?.w,
          pageHeight: measured?.h,
          // What we draw: the unscaled target and the shrink we applied.
          targetWidth: frame?.viewportWidth,
          targetHeight: frame?.viewportHeight,
          // `scale` is columnWidth / viewportWidth — the ratio the display is
          // shrunk by inside the Sidebar column, NOT a ratio against the
          // delivered image. Both are reported so pixel conversion does not have
          // to reverse-engineer either one.
          scale: frame?.scale,
          columnWidth: frame?.columnWidth,
          mounted: guest !== undefined,
        })
      }

      /**
       * Measure how the page is actually laying out right now.
       * @param guest - the webview element.
       * @param budgetMs - how long the probe may take.
       * @returns `{ w, h }`, or undefined when the page could not be asked.
       */
      async measure(guest, budgetMs = BUDGETS.identity) {
        try {
          const value = await raceBudget(
            guest.executeJavaScript('({ w: window.innerWidth, h: window.innerHeight })', true),
            budgetMs,
            'the viewport probe',
          )
          if (value === null || typeof value !== 'object') return undefined
          if (!Number.isFinite(value.w)) return undefined
          return { w: value.w, h: Number.isFinite(value.h) ? value.h : undefined }
        } catch {
          return undefined
        }
      }

      /**
       * Wait until the page has genuinely reflowed to the requested size.
       *
       * Resizing writes styles and then returns, but layout is not synchronous
       * with that write: measuring in the same turn reports the PREVIOUS size.
       * That is exactly how a `phone` request came back reporting
       * `pageWidth: 1280` — the number was real, it was just the old one. Poll
       * until the page agrees, or the budget runs out, so a stale measurement is
       * never presented as the result of the change.
       * @param guest - the webview element.
       * @param target - `{ width?, height? }`; a missing width means `auto`, which has no target.
       * @param budgetMs - shared budget for the whole confirmation.
       * @returns the last measurement and whether it matched.
       */
      async confirmSize(guest, target, budgetMs) {
        if (target.width === undefined) return { measured: undefined, confirmed: undefined }
        // Cap this below the caller's remaining budget: a screenshot still has to
        // capture after sizing, and letting confirmation consume everything would
        // turn "the size did not settle" into "the capture had no time at all".
        const allowance = Math.min(BUDGETS.confirm, Math.max(0, budgetMs - BUDGETS.confirmReserve))
        if (allowance <= 0) return { measured: undefined, confirmed: false }
        const deadline = Date.now() + allowance
        // The tolerance absorbs sub-pixel rounding, so a 390px request is
        // satisfied by a 389.5px layout rather than polling to no purpose.
        const close = (actual, wanted) => Math.abs(actual - wanted) <= 1
        let measured
        for (;;) {
          measured = await this.measure(guest, Math.max(0, deadline - Date.now()))
          if (measured !== undefined && close(measured.w, target.width)) {
            if (target.height === undefined || close(measured.h ?? 0, target.height)) {
              return { measured, confirmed: true }
            }
          }
          if (Date.now() >= deadline) return { measured, confirmed: false }
          await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())))
        }
      }

      /**
       * Change a tab's viewport preset.
       * @param sessionId - owning Session.
       * @param tabId - target tab.
       * @param input - `{ preset, width?, height? }`.
       * @param budgetMs - how long the change and its confirmation may take.
       * @returns the resulting description, plus `confirmed` when a size was requested.
       */
      async select(sessionId, tabId, input, budgetMs = BUDGETS.call) {
        const preset = input.preset
        const known = ['auto', 'phone', 'tablet', 'desktop', 'custom']
        if (!known.includes(preset)) {
          throw new Error(`unknown viewport preset "${preset}"; expected one of ${known.join(', ')}`)
        }
        if (preset === 'custom') {
          const normalized = normalizeViewportSize({ width: input.width, height: input.height })
          if (normalized.reason !== undefined) {
            throw new Error(
              `custom viewport needs width ${VIEWPORT_LIMITS.minWidth}-${VIEWPORT_LIMITS.maxWidth} ` +
                `and height ${VIEWPORT_LIMITS.minHeight}-${VIEWPORT_LIMITS.maxHeight}`,
            )
          }
          this.store.actions.setCustom(normalized)
        }
        this.store.actions.set(tabId, preset)
        this.apply(sessionId, tabId)

        // Confirm the page really reflowed before reporting a size. The stored
        // choice is a request, not an observation; `resolveViewport` can also
        // silently fall back (a broken custom size becomes `phone`), so trusting
        // the request is how a failure to reflow went unnoticed.
        //
        // `custom` MUST come from the store, exactly as `apply()` does it: the
        // per-tab selection records only the preset, so omitting it would resolve
        // a `custom` request against an undefined size and confirm against the
        // phone fallback instead of the size that was actually applied.
        const guest = this.findGuest(sessionId, tabId)
        const snapshot = this.store.getSnapshot()
        const target = resolveViewport({
          preset: snapshot.byTab[tabId]?.preset ?? preset,
          custom: snapshot.custom,
        })
        // One deadline for both steps: this call's contract is that the whole
        // thing fits in its budget, so confirmation and the measurement that
        // follows it draw from the same clock rather than starting two.
        const deadline = Date.now() + Math.max(0, budgetMs)
        let confirmation = { measured: undefined, confirmed: undefined }
        if (guest !== undefined) {
          confirmation = await this.confirmSize(guest, target, Math.max(0, deadline - Date.now()))
        }
        const described = await this.describe(sessionId, tabId, Math.max(0, deadline - Date.now()))
        return prune({
          ...described,
          // Echo the size the page was confirmed at, which for a fallback is not
          // the preset that was asked for.
          ...(confirmation.measured === undefined
            ? {}
            : { pageWidth: confirmation.measured.w, pageHeight: confirmation.measured.h }),
          ...(confirmation.confirmed === undefined ? {} : { confirmed: confirmation.confirmed }),
          ...(target.fellBack === undefined ? {} : { fellBack: target.fellBack }),
        })
      }

      /**
       * Snapshot the persisted choices, so a transient change can be undone.
       *
       * Copies the objects rather than holding the snapshot's references: a
       * store draft may be mutated in place, which would make the "before"
       * value change along with the state it is supposed to restore.
       * @returns the value `restore` needs.
       */
      remember() {
        const snapshot = this.store.getSnapshot()
        return {
          byTab: { ...snapshot.byTab },
          lastPreset: snapshot.lastPreset,
          custom: { ...snapshot.custom },
        }
      }

      /**
       * Put the stored choices back after a transient change, and redraw.
       * @param sessionId - owning Session.
       * @param tabId - target tab.
       * @param before - the value `remember` returned.
       */
      restore(sessionId, tabId, before) {
        this.store.actions.restore(before)
        this.apply(sessionId, tabId)
      }

      /** Drop observation state for a tab that closed. */
      forget(tabId) {
        const entry = this.applied.get(tabId)
        entry?.observer?.disconnect()
        this.applied.delete(tabId)
      }
    }

    // -----------------------------------------------------------------------
    // Driver
    // -----------------------------------------------------------------------

    /** One Session's browser tabs: how to find each guest and run code in it. */
    class BrowserDriver {
      /**
       * @param ctx - Client context owning the Sidebar services.
       * @param viewport - the shared viewport controller, so a screenshot can
       *   apply a size before capturing without a second tool call.
       */
      constructor(ctx, viewport) {
        this.ctx = ctx
        this.viewport = viewport
      }

      /**
       * Every open browser tab recorded for a Session, mounted or not.
       * @param sessionId - owning Session.
       * @returns tab records in Sidebar order.
       */
      inventory(sessionId) {
        const openTabs = this.ctx.sidebarRight?.openTabs
        const snapshot = openTabs?.getSnapshot?.() ?? []
        return snapshot.filter((tab) => tab.sessionId === sessionId && tab.kind === 'browser')
      }

      /**
       * Find the mounted guest for each browser tab of a Session.
       *
       * The body wrapper carries `data-sidebar-right-tab`; the title span carries
       * it too, so each candidate is checked for an actual guest inside.
       *
       * BOTH carriers are recognized, because both are mounted by the built-in:
       * Desktop attaches a `<webview>` and Web attaches a sandboxed
       * cross-origin `<iframe>` (each tagged `data-sidebar-browser-frame`). A
       * webview is drivable; an iframe is not readable at all, but finding it is
       * what lets the tools say *that* instead of claiming the tab is unmounted.
       * @param sessionId - owning Session.
       * @returns tabId -> `{ element, carrier }`, for tabs currently in the DOM.
       */
      guests(sessionId) {
        const found = new Map()
        const allowed = new Set(this.inventory(sessionId).map(tab => tab.tabId))
        const escape = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape : (value) => value
        const sessionRoot = document.querySelector(`[data-sidebar-right-session="${escape(sessionId)}"]`)
        const roots = sessionRoot ? [sessionRoot] : [document]
        for (const root of roots) {
          for (const wrapper of root.querySelectorAll('[data-sidebar-right-tab]')) {
            const owner = wrapper.closest('[data-sidebar-right-session]')
            if (!owner || owner.dataset.sidebarRightSession !== sessionId) continue
            const tabId = wrapper.dataset.sidebarRightTab
            if (!tabId || !allowed.has(tabId) || found.has(tabId)) continue
            const webview = wrapper.querySelector('webview[data-sidebar-browser-frame="webview"]')
            if (webview) {
              found.set(tabId, { element: webview, carrier: 'webview' })
              continue
            }
            const iframe = wrapper.querySelector('iframe[data-sidebar-browser-frame="iframe"]')
            if (iframe) found.set(tabId, { element: iframe, carrier: 'iframe' })
          }
        }
        return found
      }

      /**
       * Resolve the tab a call targets.
       *
       * An explicit tabId must exist and be mounted; otherwise a Session with
       * exactly one mounted browser tab is used implicitly.
       * @param sessionId - owning Session.
       * @param tabId - caller-named tab, if any.
       * @returns `{ tabId, guest, carrier }`.
       */
      resolve(sessionId, tabId) {
        const guests = this.guests(sessionId)
        const inventory = this.inventory(sessionId)

        if (typeof tabId === 'string' && tabId !== '') {
          const entry = guests.get(tabId)
          if (entry) return { tabId, guest: entry.element, carrier: entry.carrier }
          const known = inventory.some((tab) => tab.tabId === tabId)
          throw new Error(
            known
              ? `browser tab "${tabId}" is open but not mounted in the page, so it cannot be driven. ` +
                'Click that tab in the right Sidebar once to mount it, then retry.'
              : `no browser tab "${tabId}" in this Session. Call browser_tabs to list them.`,
          )
        }

        if (guests.size === 1) {
          const [only] = guests.entries()
          return { tabId: only[0], guest: only[1].element, carrier: only[1].carrier }
        }
        if (guests.size === 0) {
          throw new Error(
            inventory.length > 0
              ? 'Browser tabs are open but none is mounted; click one in the right Sidebar, then retry.'
              : 'No browser tab is open. Open one from the right Sidebar guide, or call browser_navigate.',
          )
        }
        throw new Error(
          `this Session has ${guests.size} mounted browser tabs, so tabId is required. ` +
            'Call browser_tabs to choose one.',
        )
      }

      /**
       * Report whether a tab is actually being rendered, from the host DOM.
       *
       * This exists because a screenshot can fail for a reason the model cannot
       * otherwise see. `keepMounted` keeps every visited browser tab in the DOM
       * so the tools can reach one the user is not looking at — but only the
       * SELECTED tab of the on-screen pane is displayed, and a hidden guest is
       * not composited. `findGuest` matches by attribute and cannot tell the
       * difference, so a capture aimed at a hidden tab waits for a frame that
       * never comes. From the outside that looks like "the browser is not
       * reachable", which is both wrong and unactionable: `browser_read` still
       * works against the same tab, and reloading does not change visibility.
       *
       * Every probe is best-effort. This runs while composing a FAILURE message,
       * so a diagnostic that threw would replace the real error with its own.
       * @param sessionId - owning Session.
       * @param tabId - target tab.
       * @returns a short description, or undefined when nothing can be told.
       */
      visibleDiagnosis(sessionId, tabId) {
        try {
          const escape = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape : (value) => value
          const root = document.querySelector(`[data-sidebar-right-session="${escape(sessionId)}"]`)
          if (root === null || root === undefined) {
            return 'the Sidebar for this Conversation is not in the page at all'
          }
          const wrapper = [...root.querySelectorAll('[data-sidebar-right-tab]')].find(
            (candidate) => candidate.dataset?.sidebarRightTab === tabId,
          )
          if (wrapper === undefined) {
            return 'this tab has no element in the page'
          }
          // Walk the real ancestor chain rather than assuming which element
          // carries which attribute. Two different elements carry
          // `data-sidebar-right-session` — the outer per-Conversation wrapper
          // (which goes `hidden` for a Conversation that is not on screen) and the
          // inner panel — so `querySelector` returning "the" session element is
          // not a safe assumption to build a diagnosis on.
          for (let node = wrapper; node !== null && node !== undefined; node = node.parentElement ?? null) {
            if (node.hasAttribute?.('hidden') === true) {
              return 'an ancestor of this tab is hidden, so it is not being drawn'
            }
          }
          const panel = wrapper.closest?.('[data-sidebar-right-panel]')
          if (panel !== null && panel !== undefined && panel.hasAttribute?.('data-sidebar-right-open') !== true) {
            return 'the right Sidebar is not expanded, so this tab is not being drawn'
          }
          // The selected tab is the one the pane shows; the rest keep their DOM
          // but are not on screen. `role=tab[aria-selected]` is what the docking
          // kit maintains, and it is the only reliable statement of "drawn".
          const pane = wrapper.closest?.('[data-dockkit-pane], [data-dockkit-float]')
          let sawSelection = false
          if (pane !== null && pane !== undefined) {
            const selected = pane.querySelector?.('[role="tab"][aria-selected="true"]')
            if (selected !== null && selected !== undefined) {
              sawSelection = true
              const selectedWrapper = selected.closest?.('[data-sidebar-right-tab]')
              const selectedId = selectedWrapper?.dataset?.sidebarRightTab
              if (typeof selectedId === 'string' && selectedId !== tabId) {
                return `this tab is not the one being shown (the pane is displaying "${selectedId}")`
              }
            }
          }
          // "Ruled out" is a claim, so it is only made from evidence: a caller
          // whose DOM exposes none of these signals (a stub, or a future shell
          // that renames them) gets no diagnosis rather than a false reassurance.
          if (panel !== null && panel !== undefined && sawSelection) {
            return 'this tab is the one being drawn and the Sidebar is open, so visibility does not explain it'
          }
          return undefined
        } catch {
          return undefined
        }
      }

      /**
       * Refuse an operation the calling carrier cannot support, with the real
       * reason instead of a message about mounting.
       *
       * In Web profiles the right-Sidebar browser is a sandboxed cross-origin
       * `<iframe>`: the element is found and mounted, but its document is
       * unreachable from the host renderer, so no read, click, screenshot or
       * script can be performed against it at all.
       * @param carrier - `'webview'` or `'iframe'`.
       * @param what - the operation being refused.
       */
      requireDrivable(carrier, what) {
        if (carrier === 'webview') return
        throw new Error(
          `this Session runs in a Web profile, where the right-Sidebar browser is a sandboxed ` +
            `cross-origin <iframe> whose document cannot be read, so it cannot ${what}. ` +
            'Open the Desktop app to use the browser tools.',
        )
      }

      /**
       * Run a page-side helper inside a guest, bounded by a budget.
       *
       * `executeJavaScript` never settles on an unresponsive renderer, so it is
       * raced against the remaining budget rather than awaited bare.
       * @param guest - the webview element.
       * @param helper - one of the page-side functions.
       * @param args - JSON-serializable arguments.
       * @param budgetMs - how long to allow, in milliseconds.
       * @returns the helper's JSON result.
       */
      async run(guest, helper, args = [], budgetMs = BUDGETS.call) {
        try {
          return await raceBudget(
            guest.executeJavaScript(pageCall(helper, args), true),
            budgetMs,
            'the page script',
          )
        } catch (error) {
          // A budget overrun is not the page refusing anything; say so directly
          // instead of prefixing it with a claim about the page.
          if (error?.budgetExceeded === true) throw error
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`the page refused to run the requested operation: ${message}`)
        }
      }

      /**
       * Wait until a guest has finished loading, or the budget runs out.
       * @param guest - the webview element.
       * @param timeoutMs - maximum wait.
       */
      async settle(guest, timeoutMs) {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          let loading = false
          try {
            loading = guest.isLoading()
          } catch {
            return
          }
          if (!loading) return
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }

      /**
       * Whether a guest is still loading, without asking the page.
       * @param guest - the webview element.
       * @returns Electron's observation, or false when it cannot report one.
       */
      isLoading(guest) {
        try {
          return guest.isLoading()
        } catch {
          return false
        }
      }

      /**
       * Describe a guest's current navigation state.
       *
       * The page's own answer wins whenever it can be given, because it is the
       * only source that reports a failed navigation truthfully. Electron's
       * `getURL()`/`getTitle()` keep reporting the REQUESTED address and the
       * previous document's title after a load failure, so preferring them — as
       * an earlier build did — made an error page indistinguishable from a
       * healthy one: `browser_tabs` said `http://localhost:3000/` while
       * `browser_read` said `chrome-error://chromewebdata/`. They are now a
       * fallback, and never override a page that answered.
       * @param guest - the webview element.
       * @param budgetMs - how long the identity probe may take.
       * @returns url, title, loading, whether the load failed, and whether the
       *   page could be asked at all.
       */
      async describe(guest, budgetMs = BUDGETS.identity) {
        let identity
        try {
          identity = await this.run(guest, pageIdentity, [], budgetMs)
        } catch {
          identity = undefined
        }
        const loading = this.isLoading(guest)

        let url = identity?.url ?? ''
        let title = identity?.title ?? ''
        if (identity === undefined) {
          try {
            if (guest.getURL()) url = guest.getURL()
          } catch {
            // nothing else can report an address
          }
          try {
            const observed = guest.getTitle()
            if (observed) title = observed
          } catch {
            // keep the page-reported title
          }
        }
        url = url || ''
        return {
          url,
          title: title || '',
          loading,
          // Chrome's network-error page. This is the fact `browser_tabs` had no
          // way to express before: `loading` is false and `mounted` is true for
          // a failed load, so both fields looked healthy.
          failed: isErrorPage(url),
          // The page could not be asked, so url/title describe the LAST
          // navigation rather than the document now on screen. Reported so a
          // caller never mistakes an inference for an observation.
          unverified: identity === undefined,
        }
      }

      /**
       * The tab the app itself considers active for a Session, if it can say.
       *
       * `sidebarRight.commandTarget()` is the app's own answer: the focused
       * pane's tab, or the on-screen Session's active dock pane's tab. It needs
       * an on-screen Session, and it is not a contract this plugin can assume —
       * so a missing or throwing implementation degrades to `undefined` and the
       * caller falls back to "mounted" rather than failing the whole listing.
       * @param sessionId - owning Session.
       * @returns the active tabId, or undefined when the app cannot report one.
       */
      activeTabId(sessionId) {
        try {
          const target = this.ctx.sidebarRight?.commandTarget?.()
          if (target === undefined || target.sessionId !== sessionId) return undefined
          return typeof target.tabId === 'string' && target.tabId !== '' ? target.tabId : undefined
        } catch {
          return undefined
        }
      }

      /**
       * List the Session's browser tabs, marking which are mounted and which is
       * active.
       *
       * One deadline covers the whole listing. Each tab needs its own identity
       * probe, and a probe costs up to the identity budget when a page is busy,
       * so giving every tab a fresh budget would let a Session full of stalled
       * tabs spend N × that — an unbounded answer to a question that is supposed
       * to be the cheap way to find out what is open. Every tab keeps its own
       * smaller share of what remains, and a tab that runs out is reported as
       * unverified rather than holding up the rest.
       * @param sessionId - owning Session.
       * @returns the tab list.
       */
      async listTabs(sessionId) {
        const deadline = beginCall()
        const guests = this.guests(sessionId)
        const inventory = this.inventory(sessionId)
        const activeTabId = this.activeTabId(sessionId)
        // A fair share, floored so a single tab is still given a real chance and
        // capped so a huge listing does not wait a full probe per tab.
        const share = Math.max(
          250,
          Math.min(BUDGETS.identity, Math.floor(budgetLeft(deadline) / Math.max(1, inventory.length))),
        )
        const tabs = []
        for (const record of inventory) {
          const entry = guests.get(record.tabId)
          let title = ''
          let url = ''
          let loading = false
          let failed = false
          let unverified = false
          // Only a webview can be asked anything; an iframe guest is mounted but
          // unreadable, and reporting it as unmounted would be a lie the user
          // cannot act on. `carrier` is how the model tells the two apart.
          if (entry !== undefined && entry.carrier === 'webview') {
            const allowance = Math.min(share, Math.max(0, budgetLeft(deadline)))
            const described = await this.describe(entry.element, allowance)
            title = described.title
            url = described.url
            loading = described.loading
            failed = described.failed
            unverified = described.unverified
          }
          tabs.push({
            tabId: record.tabId,
            title,
            url,
            loading,
            // `loading: false` + `mounted: true` also describes a FAILED load,
            // so neither field alone can be read as "this page is usable".
            // `failed` is the missing fact, and `unverified` warns that url and
            // title were inferred rather than read from the document.
            failed,
            unverified,
            mounted: entry !== undefined,
            // The app's own active tab when it can report one; otherwise the
            // best available approximation, which is "the one that is drawn".
            active: activeTabId === undefined ? entry !== undefined : record.tabId === activeTabId,
            ...(entry === undefined ? {} : { carrier: entry.carrier }),
          })
        }
        return { tabs }
      }

      /**
       * Read a tab's content.
       *
       * The page helpers already return `url` and `title` alongside the payload,
       * so identity comes from the one call that had to happen anyway; only
       * `loading` needs the Electron-observed state, which costs no page script.
       * @param sessionId - owning Session.
       * @param input - mode, tabId and character budget.
       * @returns the read result.
       */
      async read(sessionId, input) {
        const deadline = beginCall()
        const mode = input.mode ?? 'text'
        const maxChars = Math.max(128, Math.min(50000, Number.isFinite(input.maxChars) ? input.maxChars : 20_000))
        const { tabId, guest, carrier } = this.resolve(sessionId, input.tabId)
        this.requireDrivable(carrier, 'be read')
        await this.settle(guest, budgetLeft(deadline))

        const loading = this.isLoading(guest)
        if (mode === 'elements') {
          const result = await this.run(guest, pageReadElements, [MAX_ELEMENTS], budgetLeft(deadline))
          return prune({
            tabId,
            url: result.url,
            title: result.title,
            loading,
            failed: isErrorPage(result.url),
            elements: result.elements,
            truncated: result.truncated,
          })
        }
        if (mode === 'html') {
          const result = await this.run(guest, pageReadHtml, [maxChars], budgetLeft(deadline))
          return prune({
            tabId,
            url: result.url,
            title: result.title,
            loading,
            failed: isErrorPage(result.url),
            html: result.html,
            truncated: result.truncated,
          })
        }
        const result = await this.run(guest, pageReadText, [maxChars], budgetLeft(deadline))
        return prune({
          tabId,
          url: result.url,
          title: result.title,
          loading,
          failed: isErrorPage(result.url),
          text: result.text,
          truncated: result.truncated,
        })
      }

      /**
       * Perform one interaction on a tab.
       * @param sessionId - owning Session.
       * @param input - action and its arguments.
       * @returns the outcome plus the tab's resulting state.
       */
      async act(sessionId, input) {
        const deadline = beginCall()
        const { tabId, guest, carrier } = this.resolve(sessionId, input.tabId)
        this.requireDrivable(carrier, 'be interacted with')
        const ref = typeof input.ref === 'string' && input.ref !== '' ? input.ref : null
        const selector = typeof input.selector === 'string' && input.selector !== '' ? input.selector : null
        const action = input.action

        if (action === 'wait') {
          const requested = Number.isFinite(input.timeoutMs) ? input.timeoutMs : 1_000
          // Never outwait the caller's own deadline. The sleep and the settle
          // that follows it share ONE budget: capping each of them separately
          // (which an earlier build did) let a single call cost twice what it
          // promised and outlive the Inspect channel's timeout.
          const waitMs = Math.min(Math.max(0, requested), budgetLeft(deadline))

          // A named condition turns this from "sleep and hope" into an actual
          // wait. Everything else about the action is unchanged, so a caller that
          // only passes timeoutMs keeps the old behaviour.
          if (selector !== null) {
            const state = typeof input.state === 'string' && input.state !== '' ? input.state : 'visible'
            if (!['attached', 'visible', 'hidden'].includes(state)) {
              throw new Error(
                `unknown wait state "${state}"; expected 'attached', 'visible' or 'hidden'.`,
              )
            }
            // A named condition defaults to the REST of the call budget rather
            // than to the 1 s the bare sleep defaults to: naming a condition says
            // "wait for this", and answering after one second would usually mean
            // "not yet" for the very case the condition exists for. Still capped
            // by the remaining budget, so it cannot outlive the call.
            const conditionMs = Number.isFinite(input.timeoutMs) ? waitMs : budgetLeft(deadline)
            const outcome = await this.run(guest, pageWaitFor, [selector, state, conditionMs], budgetLeft(deadline))
            if (outcome && outcome.invalid !== undefined) {
              throw new Error(`that selector is not valid CSS: ${outcome.invalid}`)
            }
            // Report the miss instead of returning a success the caller would
            // read as "it is ready now". The whole point of naming a condition is
            // that the caller can trust the answer, and a wait that times out
            // while claiming ok: true is the same class of lie this plugin has
            // been fixing everywhere else.
            if (outcome === undefined || outcome.matched !== true) {
              const waited = Math.round((outcome?.waitedMs ?? conditionMs) / 1000)
              throw new Error(
                `the wait condition was not met within ${waited}s: no element matching "${selector}" ` +
                  `became ${state}. The page is still not in that state — check the selector, or wait ` +
                  'for something else that does change when it is ready.',
              )
            }
            return prune({
              tabId,
              action,
              ok: true,
              matched: true,
              state,
              selector,
              waitedMs: outcome.waitedMs,
              ...(await this.describe(guest, budgetLeft(deadline))),
            })
          }

          await new Promise((resolve) => setTimeout(resolve, waitMs))
          await this.settle(guest, budgetLeft(deadline))
          return prune({
            tabId,
            action,
            ok: true,
            ...(await this.describe(guest, budgetLeft(deadline))),
          })
        }

        if (action === 'reload') {
          return await this.reload(sessionId, tabId, guest, input, deadline)
        }

        let outcome
        if (action === 'click') {
          outcome = await this.run(guest, pageClick, [ref, selector], budgetLeft(deadline))
        } else if (action === 'type') {
          outcome = await this.run(guest, pageType, [ref, selector, input.text ?? ''], budgetLeft(deadline))
        } else if (action === 'press') {
          outcome = await this.run(guest, pagePress, [ref, selector, input.key ?? 'Enter'], budgetLeft(deadline))
        } else if (action === 'scroll') {
          outcome = await this.run(
            guest,
            pageScroll,
            [
              ref,
              selector,
              Number.isFinite(input.deltaX) ? input.deltaX : 0,
              Number.isFinite(input.deltaY) ? input.deltaY : 600,
            ],
            budgetLeft(deadline),
          )
        } else if (action === 'select') {
          outcome = await this.run(guest, pageSelect, [ref, selector, input.text ?? ''], budgetLeft(deadline))
        } else {
          throw new Error(`unknown action "${action}"`)
        }

        if (outcome && outcome.ok === false) {
          throw new Error(REFUSAL_REASONS[outcome.reason] ?? `the page refused the action (${outcome.reason})`)
        }

        // Give the page a moment to react so the next read observes the result.
        await new Promise((resolve) => setTimeout(resolve, Math.min(REACTION_PAUSE_MS, budgetLeft(deadline))))
        await this.settle(guest, budgetLeft(deadline))
        return prune({ tabId, action, ...outcome, ...(await this.describe(guest, budgetLeft(deadline))) })
      }

      /**
       * Reload a tab's page, optionally bypassing the cache.
       *
       * This is the recovery path. It exists for two failures seen in practice:
       * a tab whose renderer has stopped answering (a reload re-navigates it, and
       * the guest is recreated) and a development server whose assets were
       * served from Chrome's heuristic cache, which silently makes fresh CSS and
       * JS look like they never applied — `ignoreCache` is that case, and it is
       * what `python -m http.server`, which sends no `Cache-Control`, provokes.
       * @param sessionId - owning Session.
       * @param tabId - the tab to reload.
       * @param guest - the webview element.
       * @param input - `{ ignoreCache? }`.
       * @param deadline - the call's absolute deadline.
       * @returns the outcome plus the tab's resulting state.
       */
      async reload(sessionId, tabId, guest, input, deadline) {
        const ignoreCache = input.ignoreCache === true
        const bypassesCache = typeof guest.reloadIgnoringCache === 'function'
        if (ignoreCache && !bypassesCache && typeof guest.reload !== 'function') {
          throw new Error('this carrier cannot reload the page; reloading needs the Desktop webview.')
        }
        if (ignoreCache && bypassesCache) guest.reloadIgnoringCache()
        else if (typeof guest.reload === 'function') guest.reload()
        else throw new Error('this carrier cannot reload the page; reloading needs the Desktop webview.')

        await this.settle(guest, budgetLeft(deadline))
        return prune({
          tabId,
          action: 'reload',
          ok: true,
          // Reported because a carrier that has no cache-bypassing reload still
          // reloads, and claiming the cache was bypassed would be a lie.
          ignoreCache: ignoreCache && bypassesCache,
          ...(ignoreCache && !bypassesCache
            ? { note: 'this carrier has no cache-bypassing reload, so a plain reload was performed' }
            : {}),
          ...(await this.describe(guest, budgetLeft(deadline))),
        })
      }

      /**
       * Capture a tab's visible viewport as a PNG.
       *
       * An optional `preset` applies a viewport size first, so one call can
       * answer "show me this page at desktop width" without a separate
       * `setViewport` round-trip. It is worth reaching for: the default `auto`
       * size is the Sidebar COLUMN (often 400–700 CSS px), which is not a device
       * anybody uses and fires breakpoints no real visitor sees.
       *
       * The result always reports the viewport actually captured — preset, the
       * page's own `innerWidth`/`innerHeight`, and the display scale — so a
       * capture taken at the wrong size is visible in the answer instead of
       * being silently misleading.
       * @param sessionId - owning Session.
       * @param input - tabId, maximum width, and an optional preset to apply.
       * @returns base64 PNG bytes, dimensions, and the viewport used.
       */
      async screenshot(sessionId, input) {
        // A capture forces a paint of the whole guest, which a heavy page
        // legitimately takes longer to complete than a DOM read, so this call
        // gets its own (still bounded) budget.
        const deadline = beginCall(BUDGETS.screenshot)
        const tabId = resolveViewportTab(this, sessionId, input.tabId)
        const { guest, carrier } = this.resolve(sessionId, tabId)
        this.requireDrivable(carrier, 'be captured')

        // A named size is a request about THIS capture, not a statement about
        // how the user wants the tab displayed. It is applied, captured, and
        // then put back, so a screenshot never rewrites the stored choice —
        // which is how one `preset: "desktop"` used to leave the tab, and every
        // tab without a record of its own, scaled to 1280×800 for good.
        //
        // Only a webview can be sized, which `requireDrivable` has established.
        if (typeof input.preset !== 'string' || input.preset === '') {
          return await this.capture(sessionId, tabId, guest, input, deadline, undefined)
        }
        const before = this.viewport.remember()
        try {
          const frame = await this.viewport.select(sessionId, tabId, input, budgetLeft(deadline))
          return await this.capture(sessionId, tabId, guest, input, deadline, frame)
        } finally {
          this.viewport.restore(sessionId, tabId, before)
        }
      }

      /**
       * Capture one tab's visible viewport, with any size already applied.
       *
       * Split out of `screenshot` so the transient-size path can wrap it in a
       * `try`/`finally` without indenting the whole capture. `frame` is the
       * `select()` result when a size was applied for this capture, and
       * `undefined` otherwise; it is echoed in the result so the caller can see
       * which size the image was taken at.
       * @param sessionId - owning Session.
       * @param tabId - target tab.
       * @param guest - the resolved webview.
       * @param input - the caller's arguments.
       * @param deadline - when this call must be finished by.
       * @param frame - the applied size, or undefined when none was requested.
       * @returns the capture result.
       */
      async capture(sessionId, tabId, guest, input, deadline, frame) {
        const maxWidth = Math.max(64, Math.min(2048, Number.isFinite(input.maxWidth) ? input.maxWidth : 1568))
        await this.settle(guest, budgetLeft(deadline))

        // Refuse to hand back a picture of the failure page. A failed load still
        // paints — Chrome's error page, or a blank surface if it never rendered
        // — and returning that as a successful capture is how an agent came to
        // report a page as "not rendered" and wasted a round diagnosing CSS.
        //
        // Ask with more patience than the shared identity probe allows before
        // concluding the page is unreachable. `location.href` is trivially cheap
        // to answer, but a genuinely heavy page (the report's several-iframes-
        // running-canvas case) can be briefly busy, and refusing THAT capture
        // would defeat the larger screenshot budget. So a busy page gets up to a
        // few seconds; only a page that still cannot answer is treated as
        // unverifiable.
        //
        // Bounded by what is LEFT, not just by the ceiling: this call's contract
        // is that the whole thing fits in its budget, and granting a fixed floor
        // here could exceed the remaining time.
        const remaining = Math.max(0, budgetLeft(deadline))
        const identityBudget = Math.min(
          remaining,
          Math.max(BUDGETS.identity, Math.min(BUDGETS.identityCeiling, Math.floor(remaining / 2))),
        )
        const before = await this.describe(guest, identityBudget)
        if (before.failed) {
          throw new Error(
            `this tab is on a failed page load ("${before.url}"), so a screenshot would capture the ` +
              'browser error page rather than the site. Check that the server is running at the URL ' +
              'you navigated to, then navigate again (or browser_act { action: \'reload\' }).',
          )
        }
        // The mirror image of the case above, and the one an earlier build still
        // got wrong: a renderer that cannot be scripted at all (wedged, or
        // crashed) reports NO address, so `failed` cannot be evaluated and stays
        // false. Capturing then hands back a blank surface — byte-for-byte the
        // same symptom the report describes for a dead server, and just as
        // misleading — because the only check in place tested a flag that this
        // path can never set. Refusing is the honest answer: the page could not
        // be verified, so nothing can be promised about what the image shows.
        if (before.unverified) {
          const visibility = this.visibleDiagnosis(sessionId, tabId)
          throw new Error(
            'the page did not answer, so a screenshot could not be verified. A capture now would be a ' +
              'blank or stale surface rather than the site — which is exactly how a failed page gets ' +
              'mistaken for a page that "did not render".' +
              (visibility === undefined ? '' : ` ${visibility}.`) +
              ' Click this tab in the right Sidebar so it is the one being drawn (a hidden tab is not ' +
              'composited), wait for the page to settle, then retry.',
          )
        }

        if (typeof guest.capturePage !== 'function') {
          throw new Error('this carrier cannot capture the page; screenshots need the Desktop webview.')
        }
        // Capture, and on failure say WHY in terms the caller can act on.
        //
        // Measured live: a capture can fail while the same tab reads perfectly
        // well, which rules out "the browser is unreachable" — the old wording —
        // and rules out reloading, which the old wording also suggested and which
        // cannot change whether a tab is being drawn. A hidden guest is not
        // composited, so the honest diagnosis is usually about visibility, which
        // is exactly what the caller cannot see from the tool results.
        let image
        try {
          image = await raceBudget(guest.capturePage(), budgetLeft(deadline), 'the screenshot')
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          const visibility = this.visibleDiagnosis(sessionId, tabId)
          throw new Error(
            `the screenshot failed: ${reason}` +
              (visibility === undefined ? '' : ` — ${visibility}`) +
              '. The page was readable at the same moment, so the browser itself is fine: this is ' +
              'the capture path. Click this tab in the right Sidebar so it is the one being drawn ' +
              '(a hidden tab is not composited), or capture a different tab.',
          )
        }
        const original = image.getSize()
        if (original.width > maxWidth) image = image.resize({ width: maxWidth })
        const dataUrl = image.toDataURL()
        const comma = dataUrl.indexOf(',')
        if (comma < 0) throw new Error('the page produced no image data')
        const size = image.getSize()
        return prune({
          tabId,
          mediaType: 'image/png',
          base64: dataUrl.slice(comma + 1),
          // These are the DELIVERED IMAGE's pixel dimensions, nothing else. They
          // are capped by `maxWidth` (1568 by default), so when the captured
          // width exceeds that they describe the downscaled copy rather than the
          // viewport. A report read them as a fixed 16:10 output canvas because
          // two different presets both happened to be 16:10 and both exceeded the
          // cap, producing 1568×980 twice; the cap is the real explanation, and
          // `pageWidth`/`pageHeight` are the fields that describe the viewport.
          width: size.width,
          height: size.height,
          ...(await this.describe(guest, budgetLeft(deadline))),
          ...(frame === undefined
            ? {}
            : {
                preset: frame.preset,
                pageWidth: frame.pageWidth,
                pageHeight: frame.pageHeight,
                // `scale` and its basis travel together, so a caller never has to
                // guess what the ratio is against: scale === columnWidth / pageWidth.
                scale: frame.scale,
                ...(frame.columnWidth === undefined ? {} : { columnWidth: frame.columnWidth }),
                // Only meaningful when a size was applied: it says whether the
                // page was observed laying out at that size before capture.
                ...(frame.confirmed === undefined ? {} : { confirmed: frame.confirmed }),
              }),
        })
      }

      /**
       * Open a browser tab in a named Session.
       *
       * `sidebarRight.openTab` is the ON-SCREEN entry: it resolves its Session
       * from `sidebarRight.mounted` and places the tab there, ignoring who asked.
       * A tool call belongs to the Agent's own Session, which is routinely not
       * the one on screen — two Conversations each driving their own project's
       * dev server is the ordinary case. Using the on-screen entry therefore put
       * the new tab in the other Conversation's Sidebar, where that
       * Conversation's Agent then found it in its own inventory and drove a page
       * belonging to the other project, while the calling Agent polled its own
       * inventory, never saw the tab, and timed out claiming it "has not mounted
       * yet". `openTabIn` is the same navigation addressed to a Session, and is
       * the only entry that cannot land in the wrong Conversation.
       *
       * `openTabIn` is documented as outside `ISidebarRight`, so it is
       * feature-detected; and it is a silent no-op for a Session whose store was
       * never adopted, which the caller's poll — not this method — reports.
       * @param sessionId - owning Session.
       * @param options - navigation parameters and placement.
       */
      openBrowserTab(sessionId, options) {
        const sidebar = this.ctx.sidebarRight
        if (sidebar === undefined) {
          throw new Error(
            'the in-app browser needs the right Sidebar service, which is not mounted in this composition',
          )
        }
        if (typeof sidebar.openTabIn === 'function') {
          sidebar.openTabIn(sessionId, 'browser', options)
          return
        }
        // Without the Session-addressed entry, the on-screen one is only safe
        // when the on-screen Session IS this one. Otherwise it would place the
        // tab in another Conversation, which is strictly worse than failing.
        const onScreen = sidebar.mounted?.getSnapshot?.()
        if (onScreen === sessionId) {
          sidebar.openTab('browser', options)
          return
        }
        throw new Error(
          'this Session cannot open a browser tab: the right Sidebar exposes no Session-addressed ' +
            'open, and the on-screen Session is not this one, so opening would place the tab in ' +
            'another Conversation. Open this Conversation so its Sidebar is on screen, then retry.',
        )
      }

      /**
       * Close a browser tab in a named Session.
       *
       * The counterpart to `openBrowserTab`, and it exists because the tool set
       * had no way to undo an open at all: failed attempts left tabs behind that
       * nothing could remove, so they accumulated across a session. Same scoping
       * rule as opening — `closeIn` is Session-addressed, and the plain `close`
       * acts on the on-screen Session, so it is used only when that IS the
       * caller.
       * @param sessionId - owning Session.
       * @param tabId - the tab to close.
       */
      closeBrowserTab(sessionId, tabId) {
        const sidebar = this.ctx.sidebarRight
        if (sidebar === undefined) {
          throw new Error(
            'the in-app browser needs the right Sidebar service, which is not mounted in this composition',
          )
        }
        if (typeof sidebar.closeIn === 'function') {
          sidebar.closeIn(sessionId, tabId)
          return
        }
        const onScreen = sidebar.mounted?.getSnapshot?.()
        if (onScreen === sessionId && typeof sidebar.close === 'function') {
          sidebar.close(tabId)
          return
        }
        throw new Error(
          'this Session cannot close a browser tab: the right Sidebar exposes no Session-addressed ' +
            'close, and the on-screen Session is not this one, so closing would affect another ' +
            'Conversation. Open this Conversation so its Sidebar is on screen, then retry.',
        )
      }

      /**
       * Close one tab and confirm it is gone.
       *
       * `closeIn` is a silent no-op for a Session whose store was never adopted,
       * so a successful call is not by itself proof the tab closed; the poll is
       * what makes the answer true.
       * @param sessionId - owning Session.
       * @param tabId - the tab to close.
       * @returns `{ tabId, closed }`.
       */
      async closeTab(sessionId, tabId) {
        const deadline = beginCall()
        // Validate up front. Polling for absence cannot detect a tab that was
        // never there, so without this an unknown id would "succeed" instantly.
        if (!this.inventory(sessionId).some((tab) => tab.tabId === tabId)) {
          throw new Error(`no browser tab "${tabId}" in this Session. Call browser_tabs to list them.`)
        }
        this.closeBrowserTab(sessionId, tabId)
        while (budgetLeft(deadline) > 0) {
          if (!this.inventory(sessionId).some((tab) => tab.tabId === tabId)) {
            return { tabId, closed: true }
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(50, budgetLeft(deadline))))
        }
        throw new Error(
          `the browser tab "${tabId}" is still open: this Conversation's Sidebar did not accept the ` +
            'close. Open this Conversation so its Sidebar is on screen, then retry.',
        )
      }

      /**
       * Explain why a just-requested tab never became drivable in this Session.
       *
       * The causes need different fixes, and one message covering all of them
       * named none: the tab may have gone to another Conversation (the leak this
       * method exists to make visible), it may have been created here but not
       * mounted, or it may never have been created at all because this
       * Conversation's Sidebar has no surface yet.
       * @param sessionId - owning Session.
       * @param before - every `sessionId\0tabId` open before the request.
       * @returns the message to throw.
       */
      missingTabReason(sessionId, before) {
        const all = this.ctx.sidebarRight?.openTabs?.getSnapshot?.() ?? []
        const added = all.filter((tab) => !before.has(`${tab.sessionId}\u0000${tab.tabId}`))
        const strayed = added.find((tab) => tab.sessionId !== sessionId)
        if (strayed !== undefined) {
          return (
            `the browser tab was created in another Conversation ("${strayed.sessionId}") rather than this one, ` +
            'so nothing in this Session was changed. Opening a tab must be addressed to the calling Session.'
          )
        }
        if (added.length > 0) {
          return (
            'the browser tab was opened but has not mounted yet. It should appear in the right Sidebar shortly; ' +
            'call browser_tabs to confirm.'
          )
        }
        return (
          'the browser tab was not created: this Conversation has no right-Sidebar surface yet, so the Sidebar ' +
          'had nothing to place it in. Open this Conversation\u2019s right Sidebar once, then retry.'
        )
      }

      /**
       * Open a new browser tab, or navigate an existing one.
       * @param sessionId - owning Session.
       * @param input - target URL and optional tabId.
       * @returns the resulting tab.
       */
      async navigate(sessionId, input) {
        const deadline = beginCall()
        const url = input.url
        if (typeof url !== 'string' || url === '') throw new Error('browser_navigate needs a url')

        if (typeof input.tabId === 'string' && input.tabId !== '') {
          const resolved = this.resolve(sessionId, input.tabId)
          this.requireDrivable(resolved.carrier, 'be navigated')
          // `loadURL` never settles against a server that accepts the connection
          // and then stalls, so it is bounded like every other guest call.
          await raceBudget(
            resolved.guest.loadURL(url),
            budgetLeft(deadline),
            'the navigation',
          )
          await this.settle(resolved.guest, budgetLeft(deadline))
          return prune({
            tabId: resolved.tabId,
            ...(await this.describe(resolved.guest, budgetLeft(deadline))),
          })
        }

        const before = new Set(this.inventory(sessionId).map((tab) => tab.tabId))
        // Every open across every Session, so the failure below can tell "went
        // to the wrong Conversation" apart from "was never created here".
        const beforeKeys = new Set(
          (this.ctx.sidebarRight?.openTabs?.getSnapshot?.() ?? []).map(
            (tab) => `${tab.sessionId}\u0000${tab.tabId}`,
          ),
        )
        this.openBrowserTab(sessionId, { params: { url }, revealIfOpened: false })
        // The tab is created synchronously; poll for its guest to mount, sharing
        // the one call budget so mounting plus settling cannot exceed it.
        while (budgetLeft(deadline) > 0) {
          const created = this.inventory(sessionId).find((tab) => !before.has(tab.tabId))
          if (created) {
            const entry = this.guests(sessionId).get(created.tabId)
            if (entry) {
              this.requireDrivable(entry.carrier, 'be navigated')
              await this.settle(entry.element, budgetLeft(deadline))
              return prune({
                tabId: created.tabId,
                ...(await this.describe(entry.element, budgetLeft(deadline))),
              })
            }
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(100, budgetLeft(deadline))))
        }
        throw new Error(this.missingTabReason(sessionId, beforeKeys))
      }

      /**
       * Evaluate JavaScript in a tab.
       * @param sessionId - owning Session.
       * @param input - code and optional tabId.
       * @returns the evaluated value.
       */
      async evaluate(sessionId, input) {
        const code = input.code
        if (typeof code !== 'string' || code.trim() === '') throw new Error('browser_eval needs code')
        const deadline = beginCall()
        const { tabId, guest, carrier } = this.resolve(sessionId, input.tabId)
        this.requireDrivable(carrier, 'run script')
        await this.settle(guest, budgetLeft(deadline))
        const result = await this.run(guest, pageEval, [code], budgetLeft(deadline))
        return prune({ tabId, ...result, ...(await this.describe(guest, budgetLeft(deadline))) })
      }
    }

    /* DRIVER_EXTENSIONS */

    // -----------------------------------------------------------------------
    // Viewport controls
    // -----------------------------------------------------------------------

    /**
     * Find the Session that owns a tab, from the DOM if the record does not say.
     *
     * The menu owner hands over a `TabRecord`, whose exact fields are not part of
     * any shipped contract we can read, so `sessionId` is used when present and
     * the enclosing `[data-sidebar-right-session]` is read otherwise. Both are
     * the same value the tab body is rendered under.
     * @param tab - the tab record the kit passed.
     * @returns the Session id, or undefined when the tab is not in the DOM.
     */
    function sessionOfTab(tab) {
      if (typeof tab?.sessionId === 'string' && tab.sessionId !== '') return tab.sessionId
      const escape = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape : (value) => value
      const wrapper = document.querySelector(`[data-sidebar-right-tab="${escape(tab?.id ?? '')}"]`)
      return wrapper?.closest('[data-sidebar-right-session]')?.dataset.sidebarRightSession
    }

    /**
     * The per-tab size menu.
     *
     * Every action must call `dismiss()`: the menu belongs to the docking kit,
     * and an item that leaves it open floats it over content the action may have
     * just replaced.
     *
     * The store and controller come from module scope, not from injected props.
     * This matters more than it looks: the kit only opens a tab's menu when it
     * has something to show (`onClose !== undefined || extras.some(g => g !== "")`),
     * and with a single tab open the kit contributes no Close item. So if this
     * component threw — which an `undefined` injected prop would cause — the
     * entry would vanish and the menu would not open AT ALL, with no error
     * anywhere the user could see. Reading one runtime that `apply` guarantees
     * removes that failure mode.
     * @param props - owner props `{ tab, dismiss }` plus the standard `sessionId`.
     * @returns the menu entries, or null for a non-browser tab.
     */
    function ViewportMenuItems(props) {
      const { tab, dismiss, t, sessionId } = props
      // Never destructure the runtime unconditionally: if `apply` somehow has not
      // run yet, throwing here would remove the tab menu altogether (see the note
      // on `viewportRuntime`), so an unset runtime simply renders nothing.
      const runtime = viewportRuntime
      if (runtime === undefined) return null
      const { store: viewportStore, controller: viewportController, sync: viewportSync } = runtime
      // Subscribe to the store directly rather than declaring `store` on the
      // registration: a store handle can only be mounted under ONE slot scope,
      // and this plugin needs the same state in a session-scoped slot (the tab
      // menu) and a root-scoped one (Settings). The whole-state snapshot is
      // identity-stable, so this does not re-render in a loop.
      const snapshot = React.useSyncExternalStore(
        viewportStore.subscribe,
        viewportStore.getSnapshot,
        viewportStore.getSnapshot,
      )
      const current = snapshot.byTab[tab?.id]?.preset ?? snapshot.lastPreset
      const custom = snapshot.custom
      const [customOpen, setCustomOpen] = React.useState(false)

      // Offer the control for a browser tab. `kind` is the documented field, but
      // it is checked permissively: if the record ever lacks it (the layout's tab
      // shape is not a contract this plugin can read), falling back to "does the
      // tab have a guest webview in the DOM" keeps the control working. Being
      // wrong here means the menu silently never opens, which is far worse than
      // offering the control on a tab that turns out not to be a browser.
      const kind = tab?.kind
      const owner = sessionId ?? sessionOfTab(tab)
      const hasGuest =
        owner !== undefined &&
        tab?.id !== undefined &&
        viewportController.findGuest(owner, tab.id) !== undefined
      if (kind !== undefined && kind !== 'browser') return null
      if (kind === undefined && !hasGuest) return null

      const choose = (preset) => {
        viewportStore.actions.set(tab.id, preset)
        // `sessionId` is a standard slot prop here; fall back to the DOM only if
        // a future shell stops providing it.
        const owner = sessionId ?? sessionOfTab(tab)
        if (owner !== undefined) viewportController.apply(owner, tab.id)
        viewportSync?.(owner)
        dismiss()
      }

      // NOTE: `jsx(type, props, key)` — the third argument is the React KEY, not
      // children. Passing the label there compiles fine and renders an empty
      // button, which is exactly the bug this used to have. Children always go
      // in `props.children`.
      const items = VIEWPORT_PRESETS.filter((preset) => preset.id !== 'custom').map((preset) =>
        jsx(primitives.MenuItemButton, {
          key: preset.id,
          icon: current === preset.id ? jsx(primitives.IconCheckOutlineRegular, {}) : undefined,
          onSelect: () => choose(preset.id),
          children:
            preset.id === 'auto'
              ? t('viewport.auto')
              : `${t(`viewport.${preset.id}`)} · ${preset.description}`,
        }),
      )

      items.push(
        jsx(primitives.MenuItemButton, {
          key: 'custom',
          separatorBefore: true,
          icon: current === 'custom' ? jsx(primitives.IconCheckOutlineRegular, {}) : undefined,
          onSelect: () => {
            setCustomOpen(true)
          },
          children: t('viewport.custom'),
        }),
      )

      // At a wide preset in a narrow column the page is scaled right down, which
      // can look like a rendering fault. Say so, with the real percentage, so the
      // shrink reads as intentional. It joins the group as a disabled row so the
      // menu surface only ever sees MenuGroup children.
      const applied = viewportController.frameOf(tab.id)
      if (applied !== undefined && applied.scale > 0 && applied.scale < MIN_COMFORTABLE_SCALE) {
        items.push(
          jsx(primitives.MenuItemButton, {
            key: 'scale-note',
            disabled: true,
            onSelect: () => {},
            children: t('viewport.scaleNote', { percent: Math.round(applied.scale * 100) }),
          }),
        )
      }

      return jsxs(React.Fragment, {
        children: [
          jsx(primitives.MenuGroup, { label: t('viewport.title'), children: items }),
          // The form sits after the group so it never looks like a preset, but it
          // stays inside the menu element — which is what keeps the kit's
          // outside-pointerdown dismiss from tearing it down mid-typing.
          customOpen
            ? jsx(ViewportCustomForm, {
                t,
                initial: custom,
                onClose: () => {
                  setCustomOpen(false)
                },
                onApply: (size) => {
                  viewportStore.actions.setCustom(size)
                  viewportStore.actions.set(tab.id, 'custom')
                  const owner = sessionId ?? sessionOfTab(tab)
                  if (owner !== undefined) viewportController.apply(owner, tab.id)
                  viewportSync?.(owner)
                  setCustomOpen(false)
                  dismiss()
                },
              })
            : null,
        ],
      })
    }

    /**
     * The custom-size form.
     *
     * Rendered INSIDE the tab menu rather than as a `Modal`. That is deliberate:
     * the docking kit's menu closes on any `pointerdown` outside its own
     * element, and `Modal` portals to `document.body`, so a portaled dialog
     * would dismiss the menu — and therefore itself — the instant it was
     * clicked. Staying inside the menu keeps every click "inside" and the form
     * alive. `stopPropagation` is belt-and-braces for the same reason.
     * @param props - `{ t, initial, onApply, onClose }`.
     * @returns the inline form.
     */
    function ViewportCustomForm(props) {
      const { t, initial, onApply, onClose } = props
      const [width, setWidth] = React.useState(String(initial.width))
      const [height, setHeight] = React.useState(String(initial.height))

      const numeric = { width: Number(width), height: Number(height) }
      const valid =
        Number.isFinite(numeric.width) &&
        Number.isFinite(numeric.height) &&
        numeric.width >= VIEWPORT_LIMITS.minWidth &&
        numeric.width <= VIEWPORT_LIMITS.maxWidth &&
        numeric.height >= VIEWPORT_LIMITS.minHeight &&
        numeric.height <= VIEWPORT_LIMITS.maxHeight

      const message = t('viewport.invalid', {
        min: `${VIEWPORT_LIMITS.minWidth}×${VIEWPORT_LIMITS.minHeight}`,
        max: `${VIEWPORT_LIMITS.maxWidth}×${VIEWPORT_LIMITS.maxHeight}`,
      })

      const field = (label, value, setValue) =>
        jsxs('label', {
          style: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 },
          children: [
            jsx('span', { style: { font: 'var(--dsw-font-xxs-12)' }, children: label }),
            jsx(primitives.Input, {
              value,
              inputMode: 'numeric',
              onChange: (event) => setValue(event.currentTarget.value),
            }),
          ],
        })

      return jsxs('div', {
        // Keep every click inside the menu, so its outside-pointerdown
        // dismiss listener never fires while the user is typing.
        onPointerDown: (event) => event.stopPropagation(),
        onClick: (event) => event.stopPropagation(),
        style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '6px 8px 8px', minWidth: 210 },
        children: [
          jsx('span', {
            style: { font: 'var(--dsw-font-xxs-12)', color: 'var(--dsw-alias-label-secondary)' },
            children: t('viewport.customTitle'),
          }),
          jsxs('div', {
            style: { display: 'flex', gap: 8 },
            children: [
              field(t('viewport.width'), width, setWidth),
              field(t('viewport.height'), height, setHeight),
            ],
          }),
          valid
            ? null
            : jsx('span', {
                style: { color: 'var(--dsw-alias-state-error-primary)', font: 'var(--dsw-font-xxs-12)' },
                children: message,
              }),
          jsxs('div', {
            style: { display: 'flex', gap: 8, justifyContent: 'flex-end' },
            children: [
              jsx(primitives.Button, {
                variant: 'secondary',
                size: 'sm',
                onClick: onClose,
                children: t('viewport.cancel'),
              }),
              jsx(primitives.Button, {
                variant: 'primary',
                size: 'sm',
                disabled: !valid,
                onClick: () => onApply({ width: Math.round(numeric.width), height: Math.round(numeric.height) }),
                children: t('viewport.apply'),
              }),
            ],
          }),
        ],
      })
    }

    /**
     * The General-settings row for the default viewport preset.
     *
     * `lastPreset` is the default new tabs inherit, so this row writes it
     * directly rather than going through a per-tab key.
     * @param props - `{ t }`; the store comes from module scope.
     * @returns the row.
     */
    function ViewportSettingsRow(props) {
      const { t } = props
      const runtime = viewportRuntime
      if (runtime === undefined) return null
      const { store: viewportStore } = runtime
      // Same shared instance as the tab menu; see ViewportMenuItems for why this
      // subscribes directly instead of declaring `store` on the registration.
      const snapshot = React.useSyncExternalStore(
        viewportStore.subscribe,
        viewportStore.getSnapshot,
        viewportStore.getSnapshot,
      )
      const options = VIEWPORT_PRESETS.filter((preset) => preset.id !== 'custom').map((preset) => ({
        value: preset.id,
        label: preset.id === 'auto' ? t('viewport.auto') : t(`viewport.${preset.id}`),
      }))
      return jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 0' },
        children: [
          jsx('span', { style: { font: 'var(--dsw-font-xs-13)' }, children: t('viewport.settingsLabel') }),
          jsx(primitives.SegmentedControl, {
            id: 'sidebrowser-viewport-default',
            value: snapshot.lastPreset === 'custom' ? 'auto' : snapshot.lastPreset,
            options,
            onChange: (value) => {
              viewportStore.actions.setDefault(value)
            },
            label: t('viewport.settingsLabel'),
          }),
          jsx('span', {
            style: { color: 'var(--dsw-alias-label-tertiary)', font: 'var(--dsw-font-xxs-12)' },
            children: t('viewport.settingsHint'),
          }),
        ],
      })
    }

    // -----------------------------------------------------------------------
    // Inspect provider
    // -----------------------------------------------------------------------

    /** The provider accepts any JSON result; each method documents its shape. */
    const ANY_OUTPUT = { description: 'JSON data produced by the in-app browser driver.' }

    const TAB_ID = {
      type: 'string',
      description:
        'Browser tab id from browser_tabs; optional when the Session has exactly one mounted tab.',
    }

    /**
     * Decide which tab a viewport read or write targets.
     *
     * Setting a size must also work for a tab that is open but not mounted: the
     * choice is stored and applied when it mounts. Reading has the same
     * requirement for a different reason — the tool's result schema requires a
     * `tabId`, so a read that resolved no tab would fail output validation
     * instead of answering.
     *
     * A named tab is validated against the inventory rather than passed through,
     * so a typo'd id fails with the same unknown-tab error the other tools give
     * instead of looking like a valid, empty tab. Only when the caller named no
     * tab at all does the implicit-tab rule apply.
     * @param driver - the Session's browser driver.
     * @param sessionId - owning Session.
     * @param tabId - caller-named tab, if any.
     * @returns the resolved tabId.
     */
    function resolveViewportTab(driver, sessionId, tabId) {
      const named = typeof tabId === 'string' && tabId !== ''
      if (named) {
        if (driver.inventory(sessionId).some((tab) => tab.tabId === tabId)) return tabId
        throw new Error(`no browser tab "${tabId}" in this Session. Call browser_tabs to list them.`)
      }
      try {
        return driver.resolve(sessionId, undefined).tabId
      } catch (error) {
        // No mounted guest to resolve from: an open-but-unmounted tab is still a
        // legitimate target, so an unambiguous inventory decides.
        const inventory = driver.inventory(sessionId)
        if (inventory.length !== 1) throw error
        return inventory[0].tabId
      }
    }

    /**
     * Build the provider registration.
     * @param ctx - Client context.
     * @param viewport - the shared viewport controller.
     * @returns the manifest and query dispatcher.
     */
    function buildReferenceProvider(ctx, viewport) {
      const driver = new BrowserDriver(ctx, viewport)
      const sessionOf = (context) => {
        const sessionId = context?.sessionId
        if (typeof sessionId !== 'string' || sessionId === '') {
          throw new Error('the in-app browser needs a Session-backed Agent to know which tabs to drive')
        }
        return sessionId
      }
      return {
        manifest: {
          id: PROVIDER,
          description:
            'Drive the in-app right-Sidebar browser: list tabs, read page text and interactive elements, click, type, scroll, navigate, and capture screenshots. Desktop only.',
          methods: [
            {
              name: 'listTabs',
              description: "List this Session's browser tabs with title, url, loading state and whether each is mounted.",
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              outputSchema: ANY_OUTPUT,
            },
            {
              name: 'read',
              description: 'Read a browser tab: url, title, and visible text, interactive elements, or HTML.',
              inputSchema: {
                type: 'object',
                properties: {
                  tabId: TAB_ID,
                  mode: { type: 'string', enum: ['text', 'elements', 'html'], description: 'What to return.' },
                  maxChars: { type: 'number', description: 'Character budget for text and html modes.' },
                },
                additionalProperties: false,
              },
              outputSchema: ANY_OUTPUT,
            },
            {
              name: 'act',
              description:
                'Perform one interaction on a browser tab: click, type, press, scroll, select, reload or wait.',
              inputSchema: {
                type: 'object',
                properties: {
                  tabId: TAB_ID,
                  action: {
                    type: 'string',
                    enum: ['click', 'type', 'press', 'scroll', 'select', 'reload', 'wait'],
                    description: 'Interaction to perform.',
                  },
                  ref: { type: 'string', description: 'Element ref from a browser_read elements result.' },
                  selector: { type: 'string', description: 'CSS selector, used instead of ref.' },
                  text: { type: 'string', description: 'Text for type, or option value for select.' },
                  key: { type: 'string', description: 'Key name for press, such as Enter.' },
                  deltaX: { type: 'number', description: 'Horizontal scroll pixels.' },
                  deltaY: { type: 'number', description: 'Vertical scroll pixels.' },
                  timeoutMs: { type: 'number', description: 'Wait budget for the wait action.' },
                  state: {
                    type: 'string',
                    enum: ['attached', 'visible', 'hidden'],
                    description: "For 'wait' with a selector: the state the element must reach.",
                  },
                  ignoreCache: {
                    type: 'boolean',
                    description:
                      'For reload: bypass the cache, so freshly edited CSS or JS is actually re-fetched. ' +
                      'Use it when a change appears not to have taken effect.',
                  },
                },
                required: ['action'],
                additionalProperties: false,
              },
              outputSchema: ANY_OUTPUT,
            },
            {
              name: 'screenshot',
              description: "Capture a browser tab's visible viewport as a PNG image, optionally applying a viewport size first.",
              inputSchema: {
                type: 'object',
                properties: {
                  tabId: TAB_ID,
                  maxWidth: { type: 'number', description: 'Downscale the capture to at most this width.' },
                  preset: {
                    type: 'string',
                    enum: ['auto', 'phone', 'tablet', 'desktop', 'custom'],
                    description: 'Viewport size to apply before capturing, so one call can capture at a named size.',
                  },
                  width: { type: 'number', description: "Custom width, used with preset 'custom'." },
                  height: { type: 'number', description: "Custom height, used with preset 'custom'." },
                },
                additionalProperties: false,
              },
              outputSchema: ANY_OUTPUT,
            },
            {
              name: 'navigate',
              description: 'Open a URL in a new browser tab, or navigate an existing one.',
              inputSchema: {
                type: 'object',
                properties: {
                  url: { type: 'string', description: 'HTTP or HTTPS address to open.' },
                  tabId: TAB_ID,
                },
                required: ['url'],
                additionalProperties: false,
              },
              outputSchema: ANY_OUTPUT,
            },
            {
              name: 'eval',
              description: 'Evaluate JavaScript inside a browser tab and return the JSON-serializable result.',
              inputSchema: {
                type: 'object',
                properties: {
                  code: { type: 'string', description: 'Expression or statements to evaluate in the page.' },
                  tabId: TAB_ID,
                },
                required: ['code'],
                additionalProperties: false,
              },
              outputSchema: ANY_OUTPUT,
            },
            {
              name: 'getViewport',
              description:
                "Report a browser tab's viewport preset and the CSS pixel size its page is laying out at.",
              inputSchema: {
                type: 'object',
                properties: { tabId: TAB_ID },
                additionalProperties: false,
              },
              outputSchema: ANY_OUTPUT,
            },
            {
              name: 'setViewport',
              description:
                "Change a browser tab's viewport preset so the page lays out at a phone, tablet or desktop width (or 'auto' to follow the Sidebar column). Use it to check how a site renders at another size.",
              inputSchema: {
                type: 'object',
                properties: {
                  tabId: TAB_ID,
                  preset: {
                    type: 'string',
                    enum: ['auto', 'phone', 'tablet', 'desktop', 'custom'],
                    description: 'Viewport preset to apply.',
                  },
                  width: { type: 'number', description: "CSS pixel width, required when preset is 'custom'." },
                  height: { type: 'number', description: "CSS pixel height, required when preset is 'custom'." },
                },
                required: ['preset'],
                additionalProperties: false,
              },
              outputSchema: ANY_OUTPUT,
            },
            {
              name: 'closeTab',
              description: 'Close one browser tab of this Session, so tabs opened during a task can be cleaned up.',
              inputSchema: {
                type: 'object',
                properties: { tabId: TAB_ID },
                required: ['tabId'],
                additionalProperties: false,
              },
              outputSchema: ANY_OUTPUT,
            },
          ],
        },
        async query(method, input, context) {
          const sessionId = sessionOf(context)
          const args = input ?? {}
          if (method === 'listTabs') return await driver.listTabs(sessionId)
          if (method === 'read') return await driver.read(sessionId, args)
          if (method === 'act') return await driver.act(sessionId, args)
          if (method === 'screenshot') return await driver.screenshot(sessionId, args)
          if (method === 'navigate') return await driver.navigate(sessionId, args)
          if (method === 'eval') return await driver.evaluate(sessionId, args)
          if (method === 'closeTab') {
            const tabId = typeof args.tabId === 'string' && args.tabId !== '' ? args.tabId : undefined
            if (tabId === undefined) {
              throw new Error('closing a tab needs its tabId; call browser_tabs to list them')
            }
            return await driver.closeTab(sessionId, tabId)
          }
          if (method === 'getViewport') {
            return await viewport.describe(sessionId, resolveViewportTab(driver, sessionId, args.tabId))
          }
          if (method === 'setViewport') {
            return await viewport.select(sessionId, resolveViewportTab(driver, sessionId, args.tabId), args)
          }
          throw new Error(`DSHSideBrowser has no method "${method}"`)
        },
      }
    }

    /** Required Client services: the inspect registry, the Sidebar controller, and shortcuts. */
    const inject = ['cordisInspect', 'sidebarRight', 'slots', 'shortcuts', 'locale', 'remote', 'sessions']

    /** Locale copy for the viewport controls. */
    const COPY = {
      zh: {
        'viewport.title': '视口尺寸',
        'viewport.auto': '自适应',
        'viewport.phone': '手机',
        'viewport.tablet': '平板',
        'viewport.desktop': '电脑',
        'viewport.custom': '自定义…',
        'viewport.customTitle': '自定义视口尺寸',
        'viewport.width': '宽度',
        'viewport.height': '高度',
        'viewport.apply': '应用',
        'viewport.cancel': '取消',
        'viewport.invalid': '请输入 {min}–{max} 之间的整数',
        'viewport.scaleNote': '已缩小至 {percent}% 显示',
        'viewport.shortcut': '切换浏览器视口尺寸',
        'viewport.noTarget': '请先聚焦浏览器标签页',
        'viewport.settingsLabel': '浏览器视口',
        'viewport.settingsHint': '标签页右键菜单里可随时切换',
      },
      en: {
        'viewport.title': 'Viewport size',
        'viewport.auto': 'Fit column',
        'viewport.phone': 'Phone',
        'viewport.tablet': 'Tablet',
        'viewport.desktop': 'Desktop',
        'viewport.custom': 'Custom…',
        'viewport.customTitle': 'Custom viewport size',
        'viewport.width': 'Width',
        'viewport.height': 'Height',
        'viewport.apply': 'Apply',
        'viewport.cancel': 'Cancel',
        'viewport.invalid': 'Enter a whole number between {min} and {max}',
        'viewport.scaleNote': 'Shown at {percent}%',
        'viewport.shortcut': 'Cycle browser viewport size',
        'viewport.noTarget': 'Focus a browser tab first',
        'viewport.settingsLabel': 'Browser viewport',
        'viewport.settingsHint': 'Switch any time from a tab\u2019s right-click menu',
      },
    }

    /**
     * Register the provider, the per-tab size menu, the cycle shortcut, and the
     * settings row over one shared store and controller.
     * @param ctx - Client context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind('sidebrowser')
      ctx.effect(() => ctx.locale.register('sidebrowser', COPY), 'dsh-sidebrowser: copy')

      const store = viewportStore.create()
      const viewport = new ViewportController(store)

      // Apply a stored choice as soon as a tab's guest mounts, and keep every
      // mounted browser tab in step when the column resizes.
      const sync = (sessionId) => {
        const tabs = ctx.sidebarRight?.openTabs?.getSnapshot?.() ?? []
        const ids = tabs.filter((tab) => tab.sessionId === sessionId && tab.kind === 'browser').map((tab) => tab.tabId)
        viewport.applyAll(sessionId, ids)
      }

      // Publish the runtime the menu component reads from closure, before any
      // seat is registered, so a render can never observe it as undefined.
      viewportRuntime = { store, controller: viewport, sync }

      const provider = buildProvider(ctx, viewport)
      ctx.effect(
        () => {
          const unregister = ctx.cordisInspect.register(provider)
          return () => { unregister(); provider.dispose() }
        },
        'dsh-sidebrowser: provider',
      )

      // A restored Session mounts its tabs after this plugin loads, and a saved
      // preset has to come back with them. Poll the open-tab snapshot briefly on
      // startup and re-apply; `apply` is idempotent, so repeats are free.
      //
      // Deliberately not `openTabs.subscribe`: the tab inventory is a private
      // implementation detail whose observable surface is not part of any
      // contract we can read, and `getSnapshot()` is the only method every
      // shipped caller uses. A short bounded poll keeps this robust across
      // builds without depending on an unverified method.
      ctx.effect(() => {
        const openTabs = ctx.sidebarRight?.openTabs
        if (openTabs?.getSnapshot === undefined) return () => {}
        const applyOnce = () => {
          const tabs = openTabs.getSnapshot() ?? []
          for (const tab of tabs) {
            if (tab.kind === 'browser') viewport.apply(tab.sessionId, tab.tabId)
          }
        }
        applyOnce()
        // Cover the mount that happens just after load, then stop.
        const timers = [250, 750, 1500, 3000].map((delay) => setTimeout(applyOnce, delay))
        return () => {
          for (const timer of timers) clearTimeout(timer)
        }
      }, 'dsh-sidebrowser: viewport reconcile')

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.tab.menu.item', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.tab.menu.item',
                id: 'agent-sidebrowser-viewport',
                order: 40,
                locale: 'sidebrowser',
              },
              ViewportMenuItems,
            ),
          ),
        'dsh-sidebrowser: viewport menu',
      )

      // Ships unbound: an empty `defaults` map is required by the registry, and
      // leaving every platform out means the chord never collides with a built-in.
      // The README shows how to bind it from Settings → Shortcuts.
      ctx.effect(
        () =>
          ctx.shortcuts.register({
            id: 'sidebrowser.viewport.cycle',
            label: () => t('viewport.shortcut'),
            aliases: ['viewport', 'browser size', 'responsive'],
            defaults: {},
            regions: ['page', 'editable', 'terminal'],
            modals: [],
            resolve: ({ target: element }) => {
              const target = ctx.sidebarRight.commandTarget(element)
              if (target === undefined || target.tabId === undefined) {
                return { status: 'blocked', reason: t('viewport.noTarget') }
              }
              return {
                status: 'handled',
                run: () => {
                  const tabId = target.tabId
                  const order = ['auto', 'phone', 'tablet', 'desktop']
                  const snapshot = store.getSnapshot()
                  const current = snapshot.byTab[tabId]?.preset ?? snapshot.lastPreset
                  const next = order[(order.indexOf(current) + 1) % order.length] ?? 'auto'
                  store.actions.set(tabId, next)
                  viewport.apply(target.sessionId, tabId)
                },
              }
            },
          }),
        'dsh-sidebrowser: viewport shortcut',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('settings.general.item', () =>
            ctx.slots.register(
              {
                name: 'settings.general.item',
                id: 'sidebrowser-viewport',
                order: 18,
                locale: 'sidebrowser',
              },
              ViewportSettingsRow,
            ),
          ),
        'dsh-sidebrowser: viewport settings',
      )
    }

    exports.__testing = { PAGE_HELPERS, pageCall, BrowserDriver, parseNativeKey, AgentVisualFeedback }
    exports.apply = apply
    exports.inject = inject
    exports.PROVIDER = PROVIDER
    exports.buildProvider = buildProvider
    /**
     * Test seams.
     *
     * `budgets` is exposed so a check can shrink a wall-clock bound instead of
     * waiting it out: proving the screenshot budget exists must not cost 15 real
     * seconds. Production never writes to it.
     */
    exports.__viewport = {
      computeScale,
      computePlacement,
      normalizeViewportSize,
      resolveViewport,
      clampDimension,
      VIEWPORT_PRESETS,
      VIEWPORT_LIMITS,
      ViewportController,
      viewportStore,
      budgets: BUDGETS,
      /** Seed the module-scope runtime the menu and settings row read. */
      setRuntime: (runtime) => {
        viewportRuntime = runtime
      },
      getRuntime: () => viewportRuntime,
    }
    return module.exports
  },
})
