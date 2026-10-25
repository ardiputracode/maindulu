import { test as base, expect } from '@playwright/test'
import type { Page, FrameLocator } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import { createApp } from '../../server/app.mjs'
import { startPlayer } from './helpers/player'

type TestApp = Awaited<ReturnType<typeof createApp>> & { database: DatabaseSync; appConfig: { saveQuotaBytes: number } }
const test = base.extend({
  // Isolate account rate-limit buckets/data per scenario; do not weaken the
  // production registration policy just to fit a growing integration suite.
  context: async ({ browser, baseURL, contextOptions }, use, info) => {
    if (info.project.name !== 'node-backend') {
      const context = await browser.newContext({ ...contextOptions, baseURL })
      try { await use(context) } finally { await context.close() }
      return
    }
    const parent = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir()
    const folder = await mkdtemp(join(parent, 'm5-browser-'))
    const app = await createApp({ env: { MAIN_DULU_DATA_DIR: folder } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const context = await browser.newContext({ ...contextOptions, baseURL: address })
    try { await use(context) }
    finally { await context.close(); await app.close(); await rm(folder, { recursive: true, force: true }) }
  },
})

type Engine = { EJS_emulator: { pause: () => void; play: () => void; paused: boolean; storage: { states: { get: (key: string) => Promise<unknown> } }; getBaseFileName: () => string; gameManager: { getState: () => Uint8Array; getSaveFile: () => Uint8Array | null; getSaveFilePath: () => string; FS: { writeFile: (path: string, bytes: Uint8Array) => void; syncfs: (populate: boolean, callback: (error: unknown) => void) => void } } } }
const username = () => 'save_' + randomUUID().replaceAll('-', '').slice(0, 12)
const password = 'Cloud123'
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
async function launch(page: Page, name: string) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: `Akun ${name}`, exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true }).first().click()
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  const frame = await startPlayer(page)
  // The save-state entry point lives inside the emulator's own bottom toolbar,
  // next to "Import Save File"; it must exist for account sessions only.
  await expect(frame.getByRole('button', { name: 'Save state server', exact: true })).toBeVisible()
  return frame
}
async function x(frame: FrameLocator) {
  return frame.locator('body').evaluate(() => {
    const bytes = (window as unknown as Engine).EJS_emulator.gameManager.getState()
    const tag = new TextEncoder().encode('RAM\0')
    for (let i = 0; i < bytes.length - 8; i++) if (tag.every((b, n) => bytes[i + n] === b)) return bytes[i + 8]
    throw new Error('NES RAM tag missing')
  })
}
async function move(page: Page, frame: FrameLocator) {
  await frame.locator('canvas').click()
  await page.keyboard.down('ArrowRight')
  try { await expect.poll(() => x(frame)).toBeGreaterThan(0xa0) }
  finally { await page.keyboard.up('ArrowRight') }
  return x(frame)
}
// The save overlay replaces the old inline panel. It opens from the emulator
// toolbar, pauses the game, and closing resumes only previously running games.
const overlay = (page: Page) => page.getByRole('dialog', { name: 'Save state server', exact: true })
const slotRow = (page: Page, label: string) => overlay(page).locator('article').filter({ hasText: label })
const saveSlot = async (page: Page, slotNumber: number) => { await slotRow(page, `Slot ${slotNumber}`).getByRole('button', { name: 'Ganti', exact: true }).click() }
const loadSlot = async (page: Page, slotNumber: number) => { await slotRow(page, `Slot ${slotNumber}`).getByRole('button', { name: 'Muat', exact: true }).click() }
const paused = (frame: FrameLocator) => frame.locator('body').evaluate(() => (window as unknown as Engine).EJS_emulator.paused)
async function openOverlay(page: Page, frame: FrameLocator) {
  // Multi-tab scenarios must reveal the toolbar in the actual foreground tab.
  await page.bringToFront()
  // Default engine behavior reveals the bar on downward motion, not every
  // mouse move. End near the bottom so this works after switching tabs too.
  const box = await frame.locator('canvas').boundingBox()
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 5, { steps: 5 })
  }
  await frame.getByRole('button', { name: 'Save state server', exact: true }).click()
  await expect(overlay(page)).toBeVisible()
  // The game pauses while the overlay is open, and state RPCs must not resume it.
  await expect.poll(() => paused(frame)).toBe(true)
}
async function closeOverlay(page: Page, frame: FrameLocator) {
  await overlay(page).getByRole('button', { name: 'Tutup dialog', exact: true }).click()
  await expect(overlay(page)).toHaveCount(0)
  // Closing resumes a game that was running when the overlay opened.
  await expect.poll(() => paused(frame)).toBe(false)
}

test.beforeEach(({}, info) => { test.skip(info.project.name !== 'node-backend', 'Save server membutuhkan backend; mode tamu/statis tetap diuji terpisah.') })

test('M7: browser and file states import explicitly, preserve guest data and provide restorable server backups', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true }).first().click()
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  const guest = await startPlayer(page)
  const position = await move(page, guest)
  await guest.getByRole('button', { name: 'Save State', exact: true }).click()
  const native = await guest.locator('body').evaluate(async () => {
    const e = (window as unknown as Engine).EJS_emulator
    return Array.from(await e.storage.states.get(e.getBaseFileName() + '.state') as Uint8Array)
  })
  expect(native.length).toBeGreaterThan(1000)
  page.once('dialog', d => d.accept())
  await page.getByRole('button', { name: 'Kembali', exact: true }).click()
  const name = username()
  await register(page, name)
  const frame = await launch(page, name)
  await openOverlay(page, frame)
  await overlay(page).getByRole('button', { name: 'Impor state', exact: true }).click()
  const transfer = page.getByRole('dialog', { name: 'Impor save', exact: true })
  await transfer.getByRole('button', { name: 'Baca save browser ini' }).click()
  await expect(transfer.getByText('Sumber browser', { exact: true })).toBeVisible()
  await page.locator('.player-shell').evaluate(element => element.requestFullscreen())
  expect(await transfer.evaluate(element => document.fullscreenElement?.contains(element))).toBe(true)
  await page.evaluate(() => document.exitFullscreen())
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await transfer.evaluate(element => {
    const r = element.getBoundingClientRect()
    return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && element.scrollWidth <= element.clientWidth
  })).toBe(true)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await transfer.getByRole('button', { name: 'Tinjau versi server', exact: true }).click()
  await transfer.getByRole('checkbox').check()
  await transfer.getByRole('button', { name: 'Konfirmasi impor ke server' }).click()
  await expect(transfer).toHaveCount(0)
  expect(await x(frame)).toBe(0x78) // import is NOT an implicit load
  page.once('dialog', d => d.accept())
  await loadSlot(page, 1)
  await closeOverlay(page, frame)
  await expect.poll(() => x(frame)).toBe(position)
  await openOverlay(page, frame)
  await overlay(page).getByRole('button', { name: 'Impor state', exact: true }).click()
  await transfer.getByLabel('File save', { exact: true }).setInputFiles({ name: 'backup.state', mimeType: 'application/octet-stream', buffer: Buffer.from(native) })
  await transfer.getByRole('button', { name: 'Tinjau versi server', exact: true }).click()
  await transfer.getByRole('checkbox').check()
  await transfer.getByRole('button', { name: 'Konfirmasi impor ke server' }).click()
  await expect(transfer).toHaveCount(0)
  await closeOverlay(page, frame)
  page.once('dialog', d => d.accept())
  await page.getByRole('button', { name: 'Kembali', exact: true }).click()
  await page.getByRole('button', { name: `Akun ${name}`, exact: true }).click()
  await page.getByRole('button', { name: 'Kelola cadangan konflik/impor', exact: true }).click()
  const backups = page.getByRole('dialog', { name: 'Cadangan konflik dan impor', exact: true })
  await expect(backups).toContainText('state slot 1')
  const download = page.waitForEvent('download')
  await backups.getByRole('button', { name: 'Unduh cadangan', exact: true }).click()
  expect((await download).suggestedFilename()).toMatch(/\.state$/)
  await backups.getByRole('button', { name: 'Tinjau pemulihan', exact: true }).click()
  await backups.getByRole('button', { name: 'Konfirmasi pemulihan / retry yang sama', exact: true }).click()
  await expect(backups).toContainText('Cadangan dipulihkan')
  await expect(backups.getByRole('button', { name: 'Unduh cadangan', exact: true })).toHaveCount(2)
  await backups.getByRole('button', { name: 'Tutup dialog', exact: true }).click()
  await page.getByRole('button', { name: 'Keluar akun', exact: true }).click()
  await page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true }).first().click()
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  const again = await startPlayer(page)
  await again.getByRole('button', { name: 'Load State', exact: true }).click()
  await expect.poll(() => x(again)).toBe(position)
})

test('M7: state revision conflict is resolved explicitly without implicit loading', async ({ page, context }) => {
  const name = username()
  await register(page, name)
  const first = await launch(page, name)
  const other = await context.newPage()
  const second = await launch(other, name)
  await move(page, first)
  await openOverlay(page, first)
  await saveSlot(page, 1)
  await expect(overlay(page)).toContainText('Tersimpan di server')
  await openOverlay(other, second)
  await saveSlot(other, 1)
  await expect(overlay(other)).toContainText('Ada konflik simpanan')
  await overlay(other).getByRole('button', { name: 'Tinjau konflik state', exact: true }).click()
  const transfer = other.getByRole('dialog', { name: 'Tinjau konflik simpanan', exact: true })
  await transfer.getByRole('button', { name: 'Tinjau versi server', exact: true }).click()
  await transfer.getByRole('checkbox').check()
  await transfer.getByRole('button', { name: 'Gunakan versi server', exact: true }).click()
  await expect(transfer).toHaveCount(0)
  await expect(overlay(other)).toContainText('Keputusan server dikonfirmasi')
  expect(await x(second)).toBe(0x78)
})

test('M7: absent browser storage is reported without creating guest databases', async ({ page }) => {
  const name = username()
  await register(page, name)
  const frame = await launch(page, name)
  const before = await page.evaluate(async () => (await indexedDB.databases()).map(d => d.name).sort())
  await openOverlay(page, frame)
  await overlay(page).getByRole('button', { name: 'Impor state', exact: true }).click()
  const transfer = page.getByRole('dialog', { name: 'Impor save', exact: true })
  await transfer.getByRole('button', { name: 'Baca save browser ini' }).click()
  await expect(transfer.getByRole('alert')).toContainText('Save browser tidak ditemukan')
  expect(await page.evaluate(async () => (await indexedDB.databases()).map(d => d.name).sort())).toEqual(before)
  await transfer.getByRole('button', { name: 'Batal', exact: true }).click()
  await closeOverlay(page, frame)
})

test('M5: save overlay stacks its sections, fits small screens, and keeps keyboard focus inside', async ({ page }, info) => {
  const name = username()
  await register(page, name)
  const frame = await launch(page, name)
  await openOverlay(page, frame)
  const panel = overlay(page)
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport)
    await expect(panel).toBeVisible()
    expect(await panel.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const content = element.querySelector('.server-state-content')!
      const sections = Array.from(content.children).map(child => child.getBoundingClientRect())
      return {
        fits: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
        noOverflow: element.scrollWidth <= element.clientWidth,
        vertical: sections.every((section, index) => index === 0 || section.top >= sections[index - 1].bottom),
      }
    })).toEqual({ fits: true, noOverflow: true, vertical: true })
    if (viewport.width === 1280 || viewport.width === 390) await page.screenshot({ path: info.outputPath(`save-overlay-${viewport.width}.png`) })
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  const close = panel.getByRole('button', { name: 'Tutup dialog', exact: true })
  await close.focus()
  await page.keyboard.press('Shift+Tab')
  await expect(panel.locator('summary')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(close).toBeFocused()
  await panel.getByRole('button', { name: 'Kelola simpanan', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Kelola simpanan server.' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Kelola simpanan server.' })).toHaveCount(0)
  await expect(panel).toBeVisible()
  expect(await paused(frame)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect.poll(() => paused(frame)).toBe(false)
})

test('M5: real NES state survives server recreation and a fresh browser context using only account server data', async ({ browser }) => {
  const parent = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir()
  const dataDir = await mkdtemp(join(parent, 'm5-roundtrip-'))
  let app = await createApp({ env: { MAIN_DULU_DATA_DIR: dataDir } }) as TestApp
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  let context = await browser.newContext({ baseURL: address })
  const name = username()
  try {
    const first = await context.newPage()
    await register(first, name)
    const engine = await launch(first, name)
    const progress = await move(first, engine)
    await openOverlay(first, engine)
    await saveSlot(first, 1)
    await expect(overlay(first).getByRole('status')).toContainText('Tersimpan di server')
    const files = app.database.prepare('SELECT * FROM saves').all()
    expect(files).toHaveLength(1)
    expect(files[0].size).toBeLessThan(32 * 1024 * 1024)
    expect(JSON.parse(String(files[0].metadata)).variant).toBe('legacy')
    await closeOverlay(first, engine)
    await context.close()
    await app.close()
    app = await createApp({ env: { MAIN_DULU_DATA_DIR: dataDir } }) as TestApp
    await app.listen({ host: '127.0.0.1', port: Number(new URL(address).port) })
    context = await browser.newContext({ baseURL: address })
    const second = await context.newPage()
    await login(second, name)
    const fresh = await launch(second, name)
    expect(await x(fresh)).toBe(0x78)
    second.on('dialog', dialog => dialog.accept())
    await openOverlay(second, fresh)
    await loadSlot(second, 1)
    await expect(overlay(second).getByRole('status')).toContainText('Perintah muat dikirim ke core')
    await closeOverlay(second, fresh)
    await expect.poll(() => x(fresh)).toBe(progress)
    expect(await fresh.locator('body').evaluate(() => (window as unknown as Engine).EJS_emulator.storage.states.get((window as unknown as Engine).EJS_emulator.getBaseFileName() + '.state'))).toBeFalsy()
    // A different engine/core version must prompt before any bytes reach the core.
    const oldMetadata = JSON.parse(String(files[0].metadata))
    app.database.prepare('UPDATE saves SET metadata = ?, revision = revision + 1').run(JSON.stringify({ ...oldMetadata, engineVersion: '99.0.0' }))
    await openOverlay(second, fresh)
    await second.getByRole('button', { name: 'Muat ulang daftar save', exact: true }).click()
    await expect(overlay(second)).toContainText('revisi 2')
    second.removeAllListeners('dialog')
    const dialogs: string[] = []
    second.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss() })
    await loadSlot(second, 1)
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]).toContain('Versi engine/core/format save berbeda')
    expect(await x(fresh)).toBe(progress)
    await closeOverlay(second, fresh)
    // An unsolicited same-origin message is still rejected unless source,
    // channel, session and request ID all match the live bridge operation.
    await second.evaluate(() => {
      const target = document.querySelector('iframe')!.contentWindow!
      target.postMessage({ channel: 'maindulu:host', type: 'import-state', sessionId: 'wrong-session', requestId: '11111111-1111-4111-8111-111111111111', bytes: new Uint8Array(100) }, location.origin)
      window.postMessage({ channel: 'maindulu:player', type: 'state-result', sessionId: 'wrong-session', requestId: '11111111-1111-4111-8111-111111111111', applied: true }, location.origin)
    })
    expect(await x(fresh)).toBe(progress)
  } finally { await context.close(); await app.close(); await rm(dataDir, { recursive: true, force: true }) }
})

test('M5: quota warning, explicit cross-game deletion, pending backup and retry use the real backend', async ({ browser }) => {
  const parent = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir()
  const dataDir = await mkdtemp(join(parent, 'm5-quota-'))
  const app = await createApp({ env: { MAIN_DULU_DATA_DIR: dataDir } }) as TestApp
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const context = await browser.newContext({ baseURL: address, viewport: { width: 390, height: 844 } })
  try {
    const page = await context.newPage()
    const name = username()
    await register(page, name)
    const frame = await launch(page, name)
    await openOverlay(page, frame)
    await saveSlot(page, 1)
    await expect(overlay(page).getByRole('status')).toContainText('Tersimpan di server')
    const size = Number(app.database.prepare('SELECT size FROM saves').get()!.size)
    app.appConfig.saveQuotaBytes = Math.ceil(size / 0.85)
    await page.getByRole('button', { name: 'Muat ulang daftar save', exact: true }).click()
    await expect(overlay(page)).toContainText('Penyimpanan hampir penuh')
    await saveSlot(page, 2)
    await expect(overlay(page).getByRole('alert')).toContainText('Kuota tidak cukup')
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Unduh cadangan state terbaru', exact: true }).click()
    expect((await download).suggestedFilename()).toContain('slot-2-cadangan.state')
    await page.getByRole('button', { name: 'Kelola simpanan', exact: true }).click()
    page.on('dialog', dialog => dialog.accept())
    const manager = page.getByRole('dialog', { name: 'Kelola simpanan server.' })
    await manager.getByRole('button', { name: 'Hapus Jalan Pulang slot 1', exact: true }).click()
    await expect(manager).toContainText('Belum ada save state')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Coba simpan lagi', exact: true }).click()
    await expect(overlay(page).getByRole('status').filter({ hasText: 'Tersimpan di server' })).toBeVisible()
    expect(app.database.prepare('SELECT slot FROM saves WHERE blob_key IS NOT NULL').all().map(r => r.slot)).toEqual([2])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally { await context.close(); await app.close(); await rm(dataDir, { recursive: true, force: true }) }
})

test('M5: failed initial listing never enables a blank overwrite; failed uploads retain an exportable snapshot', async ({ page }) => {
  const name = username()
  await register(page, name)
  await page.route('**/api/saves/', route => route.request().method() === 'GET' ? route.abort() : route.continue())
  await page.goto('/')
  await expect(page.getByRole('button', { name: `Akun ${name}`, exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true }).first().click()
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  const frame = await startPlayer(page)
  await openOverlay(page, frame)
  const replace = slotRow(page, 'Slot 1').getByRole('button', { name: 'Ganti', exact: true })
  await expect(replace).toBeDisabled()
  await expect(overlay(page).getByRole('alert')).toContainText('Gagal sinkron')
  await page.unroute('**/api/saves/')
  await page.getByRole('button', { name: 'Muat ulang daftar save', exact: true }).click()
  await expect(replace).toBeEnabled()
  await page.route('**/api/saves/', route => route.request().method() === 'PUT' ? route.abort() : route.continue())
  await saveSlot(page, 1)
  await expect(overlay(page).getByRole('alert')).toContainText('Gagal sinkron')
  await expect(page.getByRole('button', { name: 'Unduh cadangan state terbaru', exact: true })).toBeEnabled()
  await expect(overlay(page)).not.toContainText('Tersimpan di server')
  await page.unroute('**/api/saves/')
  await page.getByRole('button', { name: 'Coba simpan lagi', exact: true }).click()
  await expect(overlay(page).getByRole('status')).toContainText('Tersimpan di server')
})

test('M5: concurrent tab revision conflicts preserve both server bytes and the failed tab snapshot', async ({ page, context }) => {
  const name = username()
  await register(page, name)
  const frame = await launch(page, name)
  const second = await context.newPage()
  const secondFrame = await launch(second, name)
  await openOverlay(page, frame)
  await openOverlay(second, secondFrame)
  await saveSlot(page, 1)
  await expect(overlay(page).getByRole('status')).toContainText('Tersimpan di server')
  await saveSlot(second, 1)
  await expect(overlay(second).getByRole('alert')).toContainText('Ada konflik simpanan')
  await expect(second.getByRole('button', { name: 'Unduh cadangan state terbaru', exact: true })).toBeEnabled()
  await second.getByRole('button', { name: 'Coba simpan lagi', exact: true }).click()
  await expect(overlay(second).getByRole('alert')).toContainText('Ada konflik simpanan')
})

test('M5: shared-cookie account change tears down the previous iframe and cannot send its pending snapshot to the next account', async ({ page, context }) => {
  const name = username()
  await register(page, name)
  const frame = await launch(page, name)
  await openOverlay(page, frame)
  await page.route('**/api/saves/', route => route.request().method() === 'PUT' ? route.abort() : route.continue())
  await saveSlot(page, 1)
  await expect(overlay(page).getByRole('alert')).toContainText('Gagal sinkron')
  const second = await context.newPage()
  await second.goto('/')
  await second.getByRole('button', { name: `Akun ${name}`, exact: true }).click()
  await second.getByRole('button', { name: 'Keluar akun', exact: true }).click()
  await page.bringToFront()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Coba simpan lagi', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Unduh cadangan state terbaru', exact: true })).toBeEnabled()
  const otherName = username()
  await register(second, otherName)
  await page.bringToFront()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(overlay(page)).toContainText('Sinkronisasi dihentikan')
  await expect(page.getByRole('button', { name: 'Coba simpan lagi', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Unduh cadangan state terbaru', exact: true })).toHaveCount(0)
  await expect(overlay(page)).toContainText('Snapshot akun sebelumnya dibersihkan')
  await second.getByRole('button', { name: `Akun ${otherName}`, exact: true }).click()
  await second.getByRole('button', { name: 'Kelola simpanan server', exact: true }).click()
  await expect(second.getByRole('dialog')).toContainText('Belum ada save state')
})

test('M5: account players never read/write guest state store or IDBFS, and guest persistence remains intact', async ({ page }) => {
  // Seed a real guest browser state first using the native engine button.
  await page.goto('/')
  await page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true }).first().click()
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  const guest = await startPlayer(page)
  await expect(guest.getByRole('button', { name: 'Save state server', exact: true })).toHaveCount(0)
  const progress = await move(page, guest)
  await guest.getByRole('button', { name: 'Save State', exact: true }).click()
  const original = await guest.locator('body').evaluate(async () => {
    const e = (window as unknown as Engine).EJS_emulator
    const value = await e.storage.states.get(e.getBaseFileName() + '.state')
    return Array.from(value as Uint8Array)
  })
  expect(original.length).toBeGreaterThan(1000)
  page.on('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Kembali', exact: true }).click()
  const name = username()
  await register(page, name)
  const account = await launch(page, name)
  expect(await x(account)).toBe(0x78)
  await expect(account.getByRole('button', { name: 'Load State', exact: true })).not.toBeVisible()
  expect(await account.locator('body').evaluate(() => (window as unknown as Engine).EJS_emulator.storage.states.get((window as unknown as Engine).EJS_emulator.getBaseFileName() + '.state'))).toBeFalsy()
  // MEMFS mount has no IDBFS backend. Flushing cannot persist account data.
  const isolated = await account.locator('body').evaluate(() => {
    const e = (window as unknown as Engine).EJS_emulator
    const fs = e.gameManager.FS as unknown as { lookupPath: (path: string) => { node: { mount: { type: unknown } } }; filesystems: { IDBFS: unknown } }
    return fs.lookupPath('/data/saves').node.mount.type !== fs.filesystems.IDBFS
  })
  expect(isolated).toBe(true)
  await openOverlay(page, account)
  await saveSlot(page, 1)
  await expect(overlay(page).getByRole('status')).toContainText('Tersimpan di server')
  await closeOverlay(page, account)
  await page.getByRole('button', { name: 'Kembali', exact: true }).click()
  await page.getByRole('button', { name: `Akun ${name}`, exact: true }).click()
  await page.getByRole('button', { name: 'Keluar akun', exact: true }).click()
  await page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true }).first().click()
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  const again = await startPlayer(page)
  await again.getByRole('button', { name: 'Load State', exact: true }).click()
  await expect.poll(() => x(again)).toBe(progress)
})

test('M5: autosave writes only its dedicated slot while the game runs, pauses with the overlay, and skips while uploads are in flight', async ({ browser }) => {
  test.setTimeout(300_000)
  const parent = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir()
  const dataDir = await mkdtemp(join(parent, 'm5-autosave-'))
  const app = await createApp({ env: { MAIN_DULU_DATA_DIR: dataDir } }) as TestApp
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const context = await browser.newContext({ baseURL: address })
  try {
    const page = await context.newPage()
    const name = username()
    await register(page, name)
    const frame = await launch(page, name)
    await openOverlay(page, frame)
    await overlay(page).getByLabel('Aktifkan autosave state').check()
    await overlay(page).getByLabel('Interval', { exact: true }).selectOption('30000')
    const rows = () => app.database.prepare('SELECT slot, revision FROM saves WHERE game_id = ?').all('jalan-pulang-v1')
    // The overlay pauses the game: no autosave write may happen while it is open.
    const beforePause = app.database.prepare('SELECT COUNT(*) AS count FROM saves').get()!.count
    await page.waitForTimeout(40_000)
    expect(app.database.prepare('SELECT COUNT(*) AS count FROM saves').get()!.count).toBe(beforePause)
    await closeOverlay(page, frame)
    // The game is running now: the dedicated slot 99 receives its first write.
    await expect.poll(() => rows().some(r => r.slot === 99), { timeout: 120_000 }).toBe(true)
    const first = rows().find(r => r.slot === 99)!.revision as number
    await expect.poll(() => (rows().find(r => r.slot === 99)!.revision as number) > first, { timeout: 120_000 }).toBe(true)
    // Autosave replaces its own slot instead of accumulating rows or touching
    // manual slots; the three manual slots stay empty.
    const all = app.database.prepare('SELECT slot FROM saves').all().map(r => r.slot)
    expect(all).toEqual([99])
  } finally { await context.close(); await app.close(); await rm(dataDir, { recursive: true, force: true }) }
})
