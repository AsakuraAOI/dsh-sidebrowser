import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import { apply } from '../index.js'

export const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

export function hostHarness(config = {}, providerCall) {
  const tools = new Map(), guards = [], skills = [], disposers = []
  const ctx = {
    tools: {
      register(tool) { if (tools.has(tool.name)) throw new Error('Duplicate tool: ' + tool.name); tools.set(tool.name, tool); return () => tools.delete(tool.name) },
      guard(fn) { guards.push(fn); return () => {} },
    },
    cordisInspect: { query: providerCall || (async () => ({ transportVersion: 1, ok: true, value: {} })) },
    skills: { register(skill) { skills.push(skill); return () => {} } },
    get(name) { return this[name] },
    inject(_names, fn) { fn(ctx) },
    effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose); return dispose },
  }
  apply(ctx, config)
  return { tools, guards, skills, ctx, dispose() { for (const fn of disposers.reverse()) fn() } }
}

export function clientHarness(html = '') {
  const host = new Window({ url: 'https://dsh.invalid/', settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } })
  // The viewport controller observes its container. A carrier without the API
  // would make every `apply()` throw, which would look like a plugin bug rather
  // than a missing test double, so supply an inert one.
  if (typeof host.ResizeObserver !== 'function') {
    host.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  }
  let api
  host.__ModuleLoader__ = { load({ id, factory }) {
    if (id !== 'dsh-sidebrowser') throw new Error('Client module ID must match the package name')
    api = factory(name => {
      if (name === '@deepseek-ai/dsh-client-store') return { defineStore: value => value }
      return {}
    })
  } }
  host.eval(source)
  const guest = new Window({ url: 'https://fixture.invalid/', settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } })
  guest.document.body.innerHTML = html
  guest.HTMLElement.prototype.getClientRects = function () {
    return this.hidden || this.style.display === 'none' ? [] : [this.getBoundingClientRect()]
  }
  guest.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 10, y: 10, left: 10, top: 10, right: 210, bottom: 50, width: 200, height: 40 })
  guest.HTMLElement.prototype.scrollIntoView = () => {}
  guest.document.elementFromPoint = () => guest.document.querySelector('[data-hit]') || guest.document.querySelector('button,input')
  const records = [{ sessionId: 'A', tabId: 'a', kind: 'browser' }, { sessionId: 'B', tabId: 'b', kind: 'browser' }]
  const elements = new Map()
  for (const [sessionId, tabId] of [['A','a'], ['B','b']]) {
    const root = host.document.createElement('section'); root.dataset.sidebarRightSession = sessionId
    const wrapper = host.document.createElement('div'); wrapper.dataset.sidebarRightTab = tabId
    const view = host.document.createElement('webview'); view.dataset.sidebarBrowserFrame = 'webview'
    Object.assign(view, { executeJavaScript: code => Promise.resolve(guest.eval(code)), getURL: () => guest.location.href,
      getTitle: () => guest.document.title, isLoading: () => false, focus() {} })
    wrapper.append(view); root.append(wrapper); host.document.body.append(root); elements.set(tabId, view)
  }
  const listeners = new Map()
  const remote = { $on(name, callback) {
    if (!listeners.has(name)) listeners.set(name, new Set())
    listeners.get(name).add(callback)
    return () => listeners.get(name).delete(callback)
  } }
  const emit = (name, ...args) => { for (const callback of listeners.get(name) || []) callback(...args) }
  const ctx = { remote, sidebarRight: { openTabs: { getSnapshot: () => records }, commandTarget: () => ({ sessionId: 'A', tabId: 'a' }) } }
  const viewport = { measure: async () => undefined }
  const driver = new api.__testing.BrowserDriver(ctx, viewport)
  const provider = api.buildProvider(ctx, viewport)
  return { host, guest, api, driver, provider, records, elements, emit,
    async close() { provider.dispose(); await host.happyDOM.close(); await guest.happyDOM.close() } }
}
