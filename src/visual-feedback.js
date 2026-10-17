// Host-document presentation only. Nothing is injected into visited pages.
// Coordinates are page CSS pixels mapped through the webview's rendered box.
const AGENT_VISUALS = new WeakMap()
const AGENT_ACTION_LABELS = {
  read: '读取页面', snapshot: '观察页面', extract: '提取数据', screenshot: '检查画面',
  navigate: '打开页面', eval: '执行页面脚本', getViewport: '查看视口', setViewport: '调整视口', closeTab: '关闭页面',
  click: '点击', click_xy: '点击', type: '输入', press: '按键', scroll: '滚动', select: '选择选项', reload: '刷新页面', wait: '等待页面',
}

class AgentVisualFeedback {
  constructor(ctx, driver) {
    this.ctx = ctx
    this.driver = driver
    this.states = new Map()
    this.positions = new WeakMap()
    this.frame = 0
    this.disposed = false
    this.running = new Map()
    this.unsubscribers = []
    const status = ctx.remote?.$on?.('api-session/status', (sessionId, running) => this.observeStatus(sessionId, running))
    const removed = ctx.remote?.$on?.('api-session/removed', sessionId => this.destroy(this.states.get(sessionId)))
    if (typeof status === 'function') this.unsubscribers.push(status)
    if (typeof removed === 'function') this.unsubscribers.push(removed)
    const list = ctx.sessions?.list
    if (list?.subscribe) this.unsubscribers.push(list.subscribe(() => {
      const snapshot = list.getSnapshot()
      for (const state of this.states.values()) {
        const row = snapshot.byId?.[state.sessionId]
        if (typeof row?.running === 'boolean') this.observeStatus(state.sessionId, row.running)
      }
    }))
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    this.style = document.createElement('style')
    this.style.dataset.sidebrowserFeedbackStyle = ''
    this.style.textContent = `
      .dsb-agent-feedback{position:fixed;z-index:2147483646;box-sizing:border-box;overflow:hidden;pointer-events:none!important;border-radius:8px;isolation:isolate;opacity:1;transition:opacity 650ms ease}
      .dsb-agent-feedback *{pointer-events:none!important;box-sizing:border-box}
      .dsb-agent-frame{position:absolute;inset:0;border:1px solid #60a5fa99;border-radius:8px;box-shadow:inset 0 0 24px 8px #3b82f680,inset 0 0 60px 16px #2563eb38}
      .dsb-agent-frame::after{content:'';position:absolute;inset:-1px;border:1px solid #60a5fa;border-radius:inherit;box-shadow:inset 0 0 38px 13px #3b82f6d1,inset 0 0 88px 26px #2563eb70;opacity:.12;animation:dsb-agent-glow 1800ms ease-in-out infinite;will-change:opacity}
      .dsb-agent-status{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
      .dsb-agent-cursor{position:absolute;left:0;top:0;width:25px;height:29px;opacity:0;transition:transform 160ms cubic-bezier(.2,.7,.2,1);will-change:transform;filter:drop-shadow(0 1px 2px #0f172a40)}
      .dsb-agent-feedback[data-cursor-visible=true] .dsb-agent-cursor{opacity:1}
      .dsb-agent-pointer{width:25px;height:29px;display:block;overflow:visible}
      .dsb-agent-ring{position:absolute;left:-13px;top:-13px;width:27px;height:27px;border:2px solid #2563eb;border-radius:50%;opacity:0;transform:scale(.5)}
      .dsb-agent-feedback[data-clicked=true] .dsb-agent-ring{animation:dsb-agent-click 520ms ease-out}
      .dsb-agent-feedback[data-phase=idle],.dsb-agent-feedback[data-phase=error]{opacity:0}
      .dsb-agent-feedback[data-phase=idle] .dsb-agent-frame::after,.dsb-agent-feedback[data-phase=error] .dsb-agent-frame::after{animation:none}
      @keyframes dsb-agent-glow{0%,100%{opacity:.12}50%{opacity:.95}}
      @keyframes dsb-agent-click{0%{opacity:.9;transform:scale(.45)}100%{opacity:0;transform:scale(1.45)}}
      @media(prefers-reduced-motion:reduce){.dsb-agent-cursor,.dsb-agent-feedback{transition:none}.dsb-agent-frame::after{animation:none;opacity:.5}.dsb-agent-feedback[data-clicked=true] .dsb-agent-ring{animation:none;opacity:.65;transform:scale(1)}}
    `
  }

  begin(sessionId, method, input) {
    if (this.disposed || method === 'listTabs') return null
    if (this.running.get(sessionId) === false) return null
    // A browser call starts/continues Agent ownership, not a transient tooltip.
    // Only Host session-running state ends it; tool completion never does.
    this.running.set(sessionId, true)
    const existing = this.states.get(sessionId)
    if (existing?.phase === 'active') {
      existing.method = method; existing.input = input
      existing.label = AGENT_ACTION_LABELS[input.action || method] || '操作页面'
      existing.detail.textContent = existing.label
      if (input.tabId && input.tabId !== existing.tabId || method === 'navigate' && !input.tabId) {
        existing.tabId = input.tabId || null; existing.guest = null; existing.point = null
        existing.newTab = method === 'navigate' && !input.tabId
        existing.before = new Set(this.driver.inventory(sessionId).map(tab => tab.tabId))
      }
      try { this.render(existing) } catch {}
      return existing
    }
    this.destroy(existing)
    const state = {
      sessionId, method, input, tabId: input.tabId || null, guest: null, point: null,
      before: new Set(this.driver.inventory(sessionId).map(tab => tab.tabId)),
      newTab: method === 'navigate' && !input.tabId, phase: 'active', label: AGENT_ACTION_LABELS[input.action || method] || '操作页面',
    }
    try {
      if (!this.style.isConnected) document.head.append(this.style)
      const root = document.createElement('div')
      root.className = 'dsb-agent-feedback'; root.dataset.sidebrowserFeedback = ''; root.dataset.phase = 'active'; root.hidden = true
      const frame = document.createElement('div'); frame.className = 'dsb-agent-frame'; frame.setAttribute('aria-hidden', 'true')
      const status = document.createElement('div'); status.className = 'dsb-agent-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true')
      const title = document.createElement('span'); title.textContent = 'Agent 正在操作此页面'
      const detail = document.createElement('span'); detail.className = 'dsb-agent-detail'; detail.textContent = state.label
      status.append(title, detail)
      const cursor = document.createElement('div'); cursor.className = 'dsb-agent-cursor'; cursor.setAttribute('aria-hidden', 'true')
      const ring = document.createElement('span'); ring.className = 'dsb-agent-ring'
      const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      arrow.setAttribute('class', 'dsb-agent-pointer'); arrow.setAttribute('viewBox', '0 0 25 29')
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', 'M2 2L2 23L8 17L12 26L17 24L12 16L22 16Z')
      path.setAttribute('fill', '#2563eb'); path.setAttribute('stroke', '#fff'); path.setAttribute('stroke-width', '1.8'); path.setAttribute('stroke-linejoin', 'round')
      arrow.append(path)
      cursor.append(ring, arrow); root.append(frame, status, cursor)
      Object.assign(state, { root, title, detail, cursor })
      document.body.append(root)
      this.states.set(sessionId, state)
      this.render(state); this.schedule()
    } catch { this.destroy(state); return null }
    return state
  }

  resolve(state) {
    if (state.guest?.isConnected && state.tabId) return state.guest
    let tabId = state.tabId
    if (!tabId && state.newTab) {
      const added = this.driver.inventory(state.sessionId).filter(tab => !state.before.has(tab.tabId))
      if (added.length !== 1) return null
      tabId = added[0].tabId
    }
    try {
      const target = this.driver.resolve(state.sessionId, tabId)
      state.tabId = target.tabId; state.guest = target.guest
      state.point ||= this.positions.get(target.guest) || null
      return target.guest
    } catch { return null }
  }

  drawn(element) {
    if (!element?.isConnected || !element.getClientRects().length) return false
    for (let node = element; node; node = node.parentElement) {
      const style = window.getComputedStyle(node)
      if (node.hidden || style.display === 'none' || style.visibility === 'hidden') return false
    }
    return true
  }

  render(state) {
    if (!state.root?.isConnected) return
    state.root.dataset.phase = state.phase
    const guest = this.resolve(state)
    state.root.hidden = !this.drawn(guest)
    if (!state.root.hidden) {
      const rect = guest.getBoundingClientRect()
      const left = Math.max(0, rect.left), top = Math.max(0, rect.top)
      const width = Math.min(window.innerWidth, rect.right) - left, height = Math.min(window.innerHeight, rect.bottom) - top
      if (width <= 0 || height <= 0) state.root.hidden = true
      else {
        Object.assign(state.root.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` })
        if (state.point) {
          const pageWidth = state.point.viewportWidth || guest.clientWidth || rect.width
          const pageHeight = state.point.viewportHeight || guest.clientHeight || rect.height
          const x = rect.left - left + state.point.x * rect.width / pageWidth
          const y = rect.top - top + state.point.y * rect.height / pageHeight
          state.cursor.style.transition = this.reducedMotion || !state.positioned || state.instantMove ? 'none' : ''
          state.cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`
          state.positioned = true
          state.root.dataset.cursorVisible = 'true'
        }
      }
    }
  }

  schedule() {
    if (this.frame || this.disposed || !this.states.size) return
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0
      for (const state of this.states.values()) { try { this.render(state) } catch { state.root.hidden = true } }
      this.schedule()
    })
  }

  async move(sessionId, tabId, guest, point, animate = true) {
    const state = this.states.get(sessionId)
    if (!state || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return
    state.tabId = tabId; state.guest = guest; state.point = point; this.positions.set(guest, point)
    try {
      state.instantMove = !animate
      this.render(state)
      state.instantMove = false
      if (animate && !state.root.hidden && !this.reducedMotion) await new Promise(resolve => setTimeout(resolve, 165))
    } catch { /* A presentation failure must never replay or block an action. */ }
  }

  pulse(sessionId) {
    const state = this.states.get(sessionId)
    if (!state?.root) return
    state.root.dataset.clicked = 'true'
    const ring = state.cursor.querySelector('.dsb-agent-ring')
    if (this.reducedMotion) Object.assign(ring.style, { animation: 'none', opacity: '.65', transform: 'scale(1)' })
    clearTimeout(state.pulseTimer)
    state.pulseTimer = setTimeout(() => { state.root.dataset.clicked = 'false'; ring.style.opacity = '' }, this.reducedMotion ? 220 : 540)
  }

  finish(state, value, failed) {
    if (!state?.root || this.states.get(state.sessionId) !== state) return
    if (value?.tabId && state.tabId !== value.tabId) {
      state.tabId = value.tabId; state.guest = null; state.point = null
    }
    if (failed && !state.guest && !this.resolve(state)) { this.destroy(state); return }
    // An error can be followed by recovery in the same Agent turn. Keep the
    // ownership glow until the authoritative status becomes idle/cancelled.
    if (state.phase !== 'active') return
    state.title.textContent = 'Agent 正在操作此页面'
    state.detail.textContent = failed ? '操作未确认，等待 Agent 后续处理' : '等待 Agent 后续操作'
    try { this.render(state) } catch {}
  }

  observeStatus(sessionId, running) {
    if (typeof running !== 'boolean') return
    this.running.set(sessionId, running)
    if (running) return
    const state = this.states.get(sessionId)
    if (!state || state.phase !== 'active') return
    state.phase = 'idle'
    state.title.textContent = 'Agent 已结束浏览器操作'
    state.detail.textContent = ''
    try { this.render(state) } catch {}
    state.endTimer = setTimeout(() => this.destroy(state), this.reducedMotion ? 0 : 700)
  }

  destroy(state) {
    if (!state) return
    clearTimeout(state.endTimer); clearTimeout(state.pulseTimer)
    state.root?.remove()
    if (this.states.get(state.sessionId) === state) this.states.delete(state.sessionId)
    if (!this.states.size && this.frame) { window.cancelAnimationFrame(this.frame); this.frame = 0 }
  }

  dispose() {
    this.disposed = true
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    for (const state of [...this.states.values()]) this.destroy(state)
    this.style.remove()
    if (AGENT_VISUALS.get(this.ctx) === this) AGENT_VISUALS.delete(this.ctx)
  }
}
