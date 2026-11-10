import { test as base, expect, chromium } from '@playwright/test'
import type { APIRequestContext, BrowserContext, Cookie, Page } from '@playwright/test'

export { expect, chromium }
export const gateCredentials = { username: 'test_gate', password: 'Gate-test-123!' }
const originals = new WeakMap<APIRequestContext, { get: APIRequestContext['get']; post: APIRequestContext['post'] }>()
const entered = new WeakMap<APIRequestContext, Map<string, Promise<void>>>()
const contexts = new WeakMap<APIRequestContext, BrowserContext>()
const sharedCookies = new Map<string, Cookie>()

// Existing gameplay/account regressions explicitly enter the real door first.
// No route mocks or forged cookies: HTTP-cache tests keep real browser caching.
// gate.spec.ts deliberately uses Playwright directly to exercise anonymous UI.
export async function enterGate(request: APIRequestContext, origin: string, context = contexts.get(request)) {
  let origins = entered.get(request)
  if (!origins) { origins = new Map(); entered.set(request, origins) }
  if (!origins.has(origin)) origins.set(origin, (async () => {
    const cached = sharedCookies.get(origin)
    if (cached && context) await context.addCookies([cached])
    const methods = originals.get(request) ?? { get: request.get.bind(request), post: request.post.bind(request) }
    const session = await methods.get(origin + '/api/gate/session')
    if (!session.ok() || !session.headers()['content-type']?.includes('application/json')) return
    if ((await session.json()).authenticated) return
    const response = await methods.post(origin + '/api/gate/login', { headers: { origin }, data: gateCredentials })
    expect(response.status(), await response.text()).toBe(200)
    const cookie = (await context?.cookies(origin))?.find(cookie => cookie.name === 'maindulu_gate')
    if (cookie) sharedCookies.set(origin, cookie)
  })())
  await origins.get(origin)
}

export function prepareContext(context: BrowserContext, baseURL?: string) {
  const request = context.request
  contexts.set(request, context)
  if (originals.has(request)) return
  originals.set(request, { get: request.get.bind(request), post: request.post.bind(request) })
  // Isolated context fixtures supply their actual backend URL explicitly;
  // Playwright's project-level baseURL can still refer to the shared server.
  let resolvedBase: Promise<string> | undefined
  const targetFor = async (url: string) => {
    if (/^https?:\/\//.test(url)) return new URL(url)
    if (baseURL) return new URL(url, baseURL)
    resolvedBase ??= originals.get(request)!.get('/api/gate/session').then(response => new URL(response.url()).origin).catch(() => baseURL!)
    return new URL(url, await resolvedBase)
  }
  for (const method of ['get', 'post', 'put', 'delete', 'head', 'patch'] as const) {
    const original = request[method].bind(request)
    request[method] = async (url, options) => {
      const target = await targetFor(url)
      if (!target.pathname.startsWith('/api/gate/') && target.pathname !== '/api/health') await enterGate(request, target.origin)
      return original(target.href, options)
    }
  }
  const preparePage = (page: Page) => {
    const goto = page.goto.bind(page)
    page.goto = async (url, options) => {
      const target = await targetFor(url)
      await enterGate(request, target.origin)
      const response = await goto(url, options)
      if (new URL(page.url()).origin !== target.origin) throw new Error('Origin fixture tidak sesuai. Panggil prepareContext(context, alamatBackend) sebelum membuat halaman.')
      return response
    }
  }
  context.on('page', preparePage)
  context.pages().forEach(preparePage)
}

export const test = base.extend<{ gateRegression: void }>({
  gateRegression: [async ({ context, browser, baseURL }, use, info) => {
    if (info.project.name !== 'node-backend') { await use(); return }
    prepareContext(context, baseURL)
    const newContext = browser.newContext.bind(browser)
    browser.newContext = async options => { const next = await newContext(options); prepareContext(next, options?.baseURL); return next }
    try { await use() } finally { browser.newContext = newContext }
  }, { auto: true }],
})
