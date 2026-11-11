import { test as base, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApp } from '../../server/app.mjs'
import { launchDemo } from './helpers/player'

const test = base.extend({
  baseURL: async ({}, use, info) => {
    if (info.project.name !== 'node-backend') { await use('http://localhost:5173'); return }
    const parent = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir()
    const folder = await mkdtemp(join(parent, 'door-browser-'))
    const app = await createApp({ env: { MAIN_DULU_DATA_DIR: join(folder, 'data'), MAIN_DULU_GATE_USERNAME: 'test_gate', MAIN_DULU_GATE_PASSWORD: 'Gate-test-123!' } })
    try { await use(await app.listen({ host: '127.0.0.1', port: 0 })) }
    finally { await app.close(); await rm(folder, { recursive: true, force: true }) }
  },
})

const credentials = { username: 'test_gate', password: 'Gate-test-123!' }
const dataPath = (url: string) => /^\/(?:catalog|games|bios|covers)\//.test(new URL(url).pathname) || /^\/api\/(?!gate\/|health$)/.test(new URL(url).pathname)
async function openDoor(page: Page) {
  await page.getByLabel('Username', { exact: true }).fill(credentials.username)
  await page.getByLabel('Password', { exact: true }).fill(credentials.password)
  await page.getByRole('button', { name: 'Buka pintu', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true }).first()).toBeVisible()
}

test.beforeEach(({}, info) => test.skip(info.project.name !== 'node-backend', 'Pintu masuk membutuhkan backend nyata. Peringatan statis diuji di backend.spec.ts.'))

test('anonymous deep links render only the door, without catalog, account, saved metadata or engine requests', async ({ page }) => {
  const requests: string[] = []
  page.on('request', request => requests.push(request.url()))
  await page.addInitScript(() => localStorage.setItem('maindulu:favorites:v1', JSON.stringify([{ title: 'PRIVATE FAVORITE' }])))
  await page.goto('/admin/metadata')
  await expect(page.getByRole('heading', { name: 'Sebelum main, buka pintunya dulu.' })).toBeVisible()
  expect(requests.filter(dataPath)).toEqual([])
  expect(requests.filter(url => new URL(url).pathname.startsWith('/vendor/'))).toEqual([])
  await expect(page.getByRole('button', { name: 'Buka ROM', exact: true })).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('PRIVATE FAVORITE')
})

test('wrong login stays closed; correct shared login opens a guest workspace and survives refresh', async ({ page, context }) => {
  await page.goto('/')
  await page.getByLabel('Username', { exact: true }).fill(credentials.username)
  await page.getByLabel('Password', { exact: true }).fill('Wrong-123!')
  await page.getByRole('button', { name: 'Buka pintu', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Username atau password belum cocok. Coba lagi, ya.')
  await openDoor(page)
  const cookies = await context.cookies()
  expect(cookies.find(cookie => cookie.name === 'maindulu_gate')).toMatchObject({ path: '/', httpOnly: true, sameSite: 'Strict' })
  expect(cookies.find(cookie => cookie.name === 'maindulu_session')).toBeUndefined()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Masuk ke akun', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save state server', exact: true })).toHaveCount(0)
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
  expect(stored).not.toContain(credentials.password)
  expect(stored).not.toContain(cookies.find(cookie => cookie.name === 'maindulu_gate')!.value)
})

test('a data 401 removes Workspace and the open player, then returns to the door', async ({ page, context }) => {
  await page.goto('/'); await openDoor(page)
  await page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true }).click()
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  await expect(page.locator('iframe')).toHaveCount(1)
  await context.clearCookies({ name: 'maindulu_gate' })
  expect(await page.evaluate(async () => (await fetch('/api/games')).status)).toBe(401)
  await expect(page.getByRole('heading', { name: 'Sebelum main, buka pintunya dulu.' })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('Pintunya terkunci lagi')
  await expect(page.locator('iframe')).toHaveCount(0)
})

test('expiration timer closes the door even without a data request', async ({ page }) => {
  await page.clock.install()
  await page.goto('/'); await openDoor(page)
  await page.clock.fastForward(7 * 86400 * 1000 + 1000)
  await expect(page.getByRole('heading', { name: 'Sebelum main, buka pintunya dulu.' })).toBeVisible()
})

test('an iframe ROM preflight 401 also rechecks the door without relying on catalog polling', async ({ page, context }) => {
  await page.goto('/'); await openDoor(page)
  await page.route('**/api/catalog/revision', route => route.fulfill({ json: { revision: 1 } }))
  await page.route('**/games/jalan-pulang.nes', async route => {
    await context.clearCookies({ name: 'maindulu_gate' })
    await route.continue({ headers: { ...route.request().headers(), cookie: '' } })
  })
  await page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true }).click()
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Buka pintu', exact: true })).toBeVisible()
  await expect(page.locator('iframe')).toHaveCount(0)
})

test('door outage stays closed and retry recovers without loading catalog first', async ({ page }) => {
  const data: string[] = []
  page.on('request', request => { if (dataPath(request.url())) data.push(request.url()) })
  await page.route('**/api/gate/session', route => route.fulfill({ status: 503, json: { error: 'unavailable' } }))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Pintu masuk sedang istirahat.' })).toBeVisible()
  expect(data).toEqual([])
  await page.unroute('**/api/gate/session')
  await page.getByRole('button', { name: 'Coba lagi', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Buka pintu', exact: true })).toBeVisible()
})

test('personal logout keeps the door open; door logout revokes the personal session', async ({ page, context, baseURL }) => {
  await page.goto('/'); await openDoor(page)
  page.on('dialog', dialog => dialog.accept())
  const guest = await launchDemo(page)
  await expect(guest.getByRole('button', { name: 'Save state server', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Kembali', exact: true }).click()
  const username = 'gate_' + Date.now().toString(36)
  const csrf = await (await context.request.get('/api/auth/csrf')).json()
  const registered = await context.request.post('/api/auth/register', { headers: { origin: baseURL!, 'x-csrf-token': csrf.csrfToken }, data: { username, password: 'Account-123!', passwordConfirmation: 'Account-123!' } })
  expect(registered.status()).toBe(201)
  await page.reload()
  await page.getByRole('button', { name: `Akun ${username}`, exact: true }).click()
  await page.getByRole('button', { name: 'Keluar akun', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Masuk ke akun', exact: true })).toBeVisible()
  expect((await context.cookies()).some(cookie => cookie.name === 'maindulu_gate')).toBe(true)
  const before = await (await context.request.get('/api/auth/csrf')).json()
  const account = await context.request.post('/api/auth/login', { headers: { origin: baseURL!, 'x-csrf-token': before.csrfToken }, data: { username, password: 'Account-123!' } })
  expect(account.status()).toBe(200)
  const oldSession = (await context.cookies()).find(cookie => cookie.name === 'maindulu_session')!
  await page.reload()
  await expect(page.getByRole('button', { name: `Akun ${username}`, exact: true })).toBeVisible()
  const player = await launchDemo(page)
  await player.getByRole('button', { name: 'Save state server', exact: true }).dispatchEvent('click')
  const overlay = page.getByRole('dialog', { name: 'Save state server', exact: true })
  await overlay.locator('article').filter({ hasText: 'Slot 1' }).getByRole('button', { name: 'Timpa Save', exact: true }).click()
  await expect(overlay).toContainText('Tersimpan di server')
  await overlay.getByRole('button', { name: 'Tutup dialog', exact: true }).click()
  await page.getByRole('button', { name: 'Kembali', exact: true }).click()
  await page.goto('/pengaturan')
  await page.getByRole('button', { name: 'Keluar ruang main', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Buka pintu', exact: true })).toBeVisible()
  expect((await context.cookies()).filter(cookie => ['maindulu_gate', 'maindulu_session'].includes(cookie.name))).toEqual([])
  expect((await context.request.get('/api/games')).status()).toBe(401)
  await page.goto('/'); await openDoor(page)
  await context.addCookies([oldSession])
  expect((await (await context.request.get('/api/auth/session')).json()).user).toBeNull()
})

test('mobile door has labels, keyboard submit and no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByLabel('Username', { exact: true }).fill(credentials.username)
  await page.getByLabel('Password', { exact: true }).fill(credentials.password)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true })).toBeVisible()
})
