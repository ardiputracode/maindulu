import { test as base, expect } from '@playwright/test'
import type { Page, FrameLocator } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import { createApp } from '../../server/app.mjs'
import { buildNesBatteryFixture } from '../fixtures/nes-battery.mjs'
import { startPlayer } from './helpers/player'

type TestApp = Awaited<ReturnType<typeof createApp>> & { database: DatabaseSync }
type Backend = { app: TestApp; address: string; restart: () => Promise<void> }
const test = base.extend<{ backend: Backend | null }>({
  backend: async ({}, use, info) => {
    if (info.project.name !== 'node-backend') { await use(null); return }
    const parent = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir()
    const folder = await mkdtemp(join(parent, 'm6-browser-'))
    let app = await createApp({ env: { MAIN_DULU_DATA_DIR: folder } }) as TestApp
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const backend: Backend = { app, address, restart: async () => {
      await app.close()
      app = await createApp({ env: { MAIN_DULU_DATA_DIR: folder } }) as TestApp
      await app.listen({ host: '127.0.0.1', port: Number(new URL(address).port) })
      backend.app = app
    } }
    try { await use(backend) } finally { await app.close(); await rm(folder, { recursive: true, force: true }) }
  },
  context: async ({ browser, backend, baseURL, contextOptions }, use) => {
    const context = await browser.newContext({ ...contextOptions, baseURL: backend?.address ?? baseURL })
    try { await use(context) } finally { await context.close() }
  },
})
type Engine = { EJS_emulator: { gameManager: { getState: () => Uint8Array; getSaveFile: () => Uint8Array | null; simulateInput: (player: number, index: number, value: number) => void } } }
const password = 'Cloud123'
const username = () => 'game_' + randomUUID().replaceAll('-', '').slice(0, 12)
async function register(page: Page, name: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Masuk ke akun', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Belum punya akun? Daftar' }).click()
  await dialog.getByLabel('Username', { exact: true }).fill(name)
  await dialog.getByLabel('Password', { exact: true }).fill(password)
  await dialog.getByLabel('Konfirmasi password', { exact: true }).fill(password)
  await dialog.getByRole('button', { name: 'Daftar akun', exact: true }).click()
  await dialog.getByRole('checkbox', { name: 'Kode sudah kusimpan.' }).check()
  await dialog.getByRole('button', { name: 'Selesai', exact: true }).click()
}
async function login(page: Page, name: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Masuk ke akun', exact: true }).click()
  await page.getByLabel('Username', { exact: true }).fill(name)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('dialog').getByRole('button', { name: 'Masuk', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}
async function selectBattery(page: Page, filename = 'battery.nes') {
  await page.getByRole('button', { name: 'Buka ROM', exact: true }).click()
  await page.locator('input[type=file]').first().setInputFiles({ name: filename, mimeType: 'application/octet-stream', buffer: buildNesBatteryFixture() })
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
}
async function launchBattery(page: Page, filename?: string) {
  await selectBattery(page, filename)
  return startPlayer(page)
}
const progress = (page: Page) => page.getByRole('region', { name: 'Sinkronisasi progres game' })
const bytes = (frame: FrameLocator) => frame.locator('body').evaluate(() => Array.from((window as unknown as Engine).EJS_emulator.gameManager.getSaveFile() ?? []))
async function increment(frame: FrameLocator, value: number) {
  await frame.locator('body').evaluate(() => (window as unknown as Engine).EJS_emulator.gameManager.simulateInput(0, 8, 1))
  try { await expect.poll(async () => (await bytes(frame))[2]).toBe(value) }
  finally { await frame.locator('body').evaluate(() => (window as unknown as Engine).EJS_emulator.gameManager.simulateInput(0, 8, 0)) }
  await expect.poll(() => frame.locator('body').evaluate(() => {
    const state = (window as unknown as Engine).EJS_emulator.gameManager.getState()
    const tag = new TextEncoder().encode('RAM\0')
    for (let i = 0; i < state.length - 8; i++) if (tag.every((b, n) => state[i + n] === b)) return state[i + 8]
    return -1
  })).toBe(0)
}
test.beforeEach(({}, info) => { test.skip(info.project.name !== 'node-backend', 'M6 membutuhkan backend akun nyata.') })

test('M6: automatic CPU-written SRAM survives server restart and a new browser with a renamed ROM', async ({ page, browser, backend }) => {
  const name = username()
  const payloads: Buffer[] = []
  page.on('request', request => { if (request.method() === 'PUT' && request.url().includes('/api/game-saves/')) payloads.push(request.postDataBuffer()!) })
  await register(page, name)
  const frame = await launchBattery(page)
  await expect.poll(async () => (await bytes(frame)).slice(0, 3)).toEqual([0x4d, 0x44, 0])
  await increment(frame, 1)
  await expect(progress(page)).toContainText('dikonfirmasi server', { timeout: 25000 })
  expect(payloads.length).toBeGreaterThan(0)
  expect(payloads.every(p => p.subarray(0, 8).toString() === 'MDGSAVE1' && p.length < 9000)).toBe(true)
  expect(backend!.app.database.prepare('SELECT COUNT(*) AS n FROM game_saves').get()!.n).toBe(1)
  expect(backend!.app.database.prepare('SELECT COUNT(*) AS n FROM saves').get()!.n).toBe(0)
  const metadata = backend!.app.database.prepare('SELECT metadata FROM game_saves').get()!.metadata
  expect(JSON.parse(String(metadata)).variant).toBe('legacy')
  await page.context().close()
  await backend!.restart()
  const context = await browser.newContext({ baseURL: backend!.address })
  try {
    const fresh = await context.newPage()
    await login(fresh, name)
    const restored = await launchBattery(fresh, 'renamed-same-content.nes')
    await expect.poll(async () => (await bytes(restored)).slice(0, 3)).toEqual([0x4d, 0x44, 1])
    await increment(restored, 2) // proves core RAM, not merely the restored FS bytes
    await progress(fresh).getByRole('button', { name: 'Sinkronkan progres sekarang' }).click()
    await expect(progress(fresh)).toContainText('dikonfirmasi server')
  } finally { await context.close() }
})

test('M6: failed initial fetch holds boot and cannot create an empty replacement; retry uses a fresh iframe', async ({ page, backend }) => {
  await register(page, username())
  let uploads = 0
  page.on('request', r => { if (r.method() === 'PUT' && r.url().includes('/api/game-saves/')) uploads++ })
  await page.route('**/api/game-saves/', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Initial fetch fixture failure' }) }))
  await selectBattery(page)
  await expect(page.getByRole('alert')).toContainText('Initial fetch fixture failure')
  await expect(page.frameLocator('iframe').locator('canvas')).toHaveCount(0)
  expect(uploads).toBe(0)
  expect(backend!.app.database.prepare('SELECT COUNT(*) AS n FROM game_saves').get()!.n).toBe(0)
  await page.unroute('**/api/game-saves/')
  await page.getByRole('button', { name: 'Coba ambil progres lagi', exact: true }).click()
  const frame = await startPlayer(page)
  await expect.poll(async () => (await bytes(frame))[0]).toBe(0x4d)
})

test('M6: upload failure retains native backup and explicit retry, while navigation flushes latest progress', async ({ page, backend }) => {
  await register(page, username())
  const frame = await launchBattery(page)
  await increment(frame, 1)
  await page.route('**/api/game-saves/', route => route.request().method() === 'PUT' ? route.abort() : route.continue())
  await progress(page).getByRole('button', { name: 'Sinkronkan progres sekarang' }).click()
  await expect(progress(page)).toContainText('Gagal sinkron')
  const download = page.waitForEvent('download')
  await progress(page).getByRole('button', { name: 'Unduh cadangan progres' }).click()
  expect((await download).suggestedFilename()).toMatch(/\.srm$/)
  expect(backend!.app.database.prepare('SELECT COUNT(*) AS n FROM game_saves').get()!.n).toBe(0)
  await page.unroute('**/api/game-saves/')
  await progress(page).getByRole('button', { name: 'Sinkronkan progres sekarang' }).click()
  await expect(progress(page)).toContainText('dikonfirmasi server')
  const before = backend!.app.database.prepare('SELECT revision FROM game_saves').get()!.revision
  await increment(frame, 2)
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Kembali', exact: true }).click()
  await expect(page.locator('iframe')).toHaveCount(0)
  expect(backend!.app.database.prepare('SELECT revision FROM game_saves').get()!.revision).toBe(Number(before) + 1)
})

test('M6: two tabs cannot overwrite stale revisions and progress can be managed outside the player', async ({ page, context, backend }) => {
  await register(page, username())
  const first = await launchBattery(page)
  const secondPage = await context.newPage()
  await secondPage.goto('/')
  const second = await launchBattery(secondPage)
  await increment(first, 1)
  await progress(page).getByRole('button', { name: 'Sinkronkan progres sekarang' }).click()
  await expect(progress(page)).toContainText('dikonfirmasi server')
  await increment(second, 1)
  await increment(second, 2)
  await progress(secondPage).getByRole('button', { name: 'Sinkronkan progres sekarang' }).click()
  await expect(progress(secondPage)).toContainText('Progres server berubah')
  expect(backend!.app.database.prepare('SELECT revision FROM game_saves').get()!.revision).toBe(1)
  await page.close(); await secondPage.close()
  const manager = await context.newPage()
  await manager.goto('/')
  await manager.getByRole('button', { name: /^Akun / }).click()
  await manager.getByRole('button', { name: 'Kelola progres game', exact: true }).click()
  const dialog = manager.getByRole('dialog', { name: 'Kelola progres game', exact: true })
  const download = manager.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Unduh progres', exact: true }).click()
  expect((await download).suggestedFilename()).toMatch(/\.srm$/)
  manager.once('dialog', d => d.accept())
  await dialog.getByRole('button', { name: 'Hapus progres', exact: true }).click()
  await expect(dialog).toContainText('Belum ada progres game')
})

test('M6: guest SRAM is neither imported by an account nor overwritten by account progress', async ({ page }) => {
  await page.goto('/')
  const guest = await launchBattery(page)
  await increment(guest, 1)
  await guest.locator('body').evaluate(() => new Promise<void>((resolve, reject) => {
    const gm = (window as unknown as { EJS_emulator: { gameManager: { FS: { syncfs: (populate: boolean, callback: (error: unknown) => void) => void } } } }).EJS_emulator.gameManager
    gm.FS.syncfs(false, error => error ? reject(error) : resolve())
  }))
  page.on('dialog', d => d.accept())
  await page.getByRole('button', { name: 'Kembali', exact: true }).click()
  const name = username()
  await register(page, name)
  const account = await launchBattery(page)
  await expect.poll(async () => (await bytes(account))[2]).toBe(0)
  await expect(account.getByRole('button', { name: 'Import Save File', exact: true })).not.toBeVisible()
  await increment(account, 1); await increment(account, 2)
  await progress(page).getByRole('button', { name: 'Sinkronkan progres sekarang' }).click()
  await expect(progress(page)).toContainText('dikonfirmasi server')
  await page.getByRole('button', { name: 'Kembali', exact: true }).click()
  await page.getByRole('button', { name: `Akun ${name}`, exact: true }).click()
  await page.getByRole('button', { name: 'Keluar akun', exact: true }).click()
  const restoredGuest = await launchBattery(page)
  await expect.poll(async () => (await bytes(restoredGuest))[2]).toBe(1)
})

test('M6: logout stops a failed queue, retains an export, and another account never receives the old snapshot', async ({ page, context, backend }) => {
  const name = username()
  await register(page, name)
  const frame = await launchBattery(page)
  await increment(frame, 1)
  await page.route('**/api/game-saves/', route => route.request().method() === 'PUT' ? route.abort() : route.continue())
  await progress(page).getByRole('button', { name: 'Sinkronkan progres sekarang' }).click()
  await expect(progress(page)).toContainText('Gagal sinkron')
  const other = await context.newPage()
  await other.goto('/')
  await other.getByRole('button', { name: `Akun ${name}`, exact: true }).click()
  await other.getByRole('button', { name: 'Keluar akun', exact: true }).click()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(progress(page).getByRole('button', { name: 'Unduh cadangan progres' })).toBeEnabled()
  await expect(progress(page).getByRole('button', { name: 'Sinkronkan progres sekarang' })).toBeDisabled()
  const next = username()
  await register(other, next)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(progress(page)).toHaveCount(0)
  expect(backend!.app.database.prepare('SELECT COUNT(*) AS n FROM game_saves').get()!.n).toBe(0)
})

test('M6: incompatible build holds callMain rather than starting over or overwriting a server save', async ({ page, context, backend }) => {
  await register(page, username())
  const frame = await launchBattery(page)
  await increment(frame, 1)
  await progress(page).getByRole('button', { name: 'Sinkronkan progres sekarang' }).click()
  await expect(progress(page)).toContainText('dikonfirmasi server')
  await page.close()
  const row = backend!.app.database.prepare('SELECT * FROM game_saves').get()
  if (!row) throw new Error('Expected server progress fixture')
  const incompatible = { ...JSON.parse(row.metadata as string), runtimeBuild: 'c'.repeat(64) }
  backend!.app.database.prepare('UPDATE game_saves SET metadata = ? WHERE id = ?').run(JSON.stringify(incompatible), row.id)
  const fresh = await context.newPage()
  await fresh.goto('/')
  await selectBattery(fresh)
  await fresh.frameLocator('iframe').getByRole('button', { name: 'Mulai bermain', exact: true }).click()
  await expect(fresh.getByRole('alert')).toContainText('Versi engine/core progres berbeda')
  expect(backend!.app.database.prepare('SELECT revision FROM game_saves').get()!.revision).toBe(row.revision)
  await expect(progress(fresh).getByRole('button', { name: 'Sinkronkan progres sekarang' })).toBeDisabled()
  const download = fresh.waitForEvent('download')
  await progress(fresh).getByRole('button', { name: 'Unduh cadangan progres' }).click()
  expect((await download).suggestedFilename()).toMatch(/\.srm$/)
})

test('M6: server ROM SRAM uses the final runtime filename rather than the save-state name', async ({ page, context }) => {
  await register(page, username())
  const fixture = buildNesBatteryFixture()
  await context.route('**/catalog/games.json', route => route.fulfill({ json: [{ id: 'battery-server', title: 'Battery server', consoleId: 'nes', source: 'server', url: '/games/different-runtime-name.nes' }] }))
  await context.route('**/games/different-runtime-name.nes', route => route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'content-length': String(fixture.length) }, body: fixture }))
  async function launchServer(target: Page) {
    await target.goto('/')
    await target.getByRole('button', { name: 'Mainkan Battery server', exact: true }).first().click()
    await target.getByRole('button', { name: 'Main sekarang', exact: true }).click()
    return startPlayer(target)
  }
  const frame = await launchServer(page)
  await increment(frame, 1)
  await progress(page).getByRole('button', { name: 'Sinkronkan progres sekarang' }).click()
  await expect(progress(page)).toContainText('dikonfirmasi server')
  await page.close()
  const fresh = await context.newPage()
  const restored = await launchServer(fresh)
  await expect.poll(async () => (await bytes(restored))[2]).toBe(1)
  await increment(restored, 2)
})
