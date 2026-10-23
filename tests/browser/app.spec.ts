import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'

async function launchDemo(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true }).click()
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  const player = page.frameLocator('iframe[title="Emulator Jalan Pulang"]')
  await player.getByRole('button', { name: 'Mulai bermain', exact: true }).click()
  await expect(player.locator('canvas')).toBeVisible({ timeout: 60000 })
  await expect(page.locator('.player-status')).toHaveCount(0, { timeout: 60000 })
  return player
}

test('desktop navigation, original assets, and responsive layout', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Dulu pulang sekolah.')
  await expect(page.locator('.console-card')).toHaveCount(6)
  await expect(page.locator('.hero-art')).toBeVisible()
  await expect(page.locator('.brand img')).toHaveAttribute('src', '/assets/maindulu.svg')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/desktop-home.png', fullPage: true })
  await page.getByRole('link', { name: 'Jelajahi console', exact: true }).first().click()
  await page.getByPlaceholder('Cari game di server…').fill('tidak-ada')
  await expect(page.getByRole('heading', { name: 'Belum ketemu judulnya.' })).toBeVisible()
  await page.getByPlaceholder('Cari game di server…').fill('jalan')
  await expect(page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('favorite and settings survive refresh; history toggle is a real switch', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Tambahkan Jalan Pulang ke favorit' }).click()
  await page.getByRole('link', { name: /Favoritku/ }).click()
  await expect(page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Hapus Jalan Pulang dari favorit' })).toBeVisible()
  await page.getByRole('link', { name: 'Pengaturan', exact: true }).click()
  await expect(page.locator('.page-footnote')).toContainText(/maindulu v\d+\.\d+\.\d+/)
  await page.getByRole('slider', { name: 'Volume awal' }).fill('23')
  await page.getByRole('switch', { name: 'Simpan riwayat bermain' }).click()
  await page.reload()
  await expect(page.getByRole('slider')).toHaveValue('23')
  await expect(page.getByRole('switch')).not.toBeChecked()
})

test('local file validation, console detection, BIOS selection, and dialog keyboard close', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Buka ROM', exact: true }).click()
  await page.locator('input[type=file]').first().setInputFiles({ name: 'sample.GBA', mimeType: 'application/octet-stream', buffer: Buffer.from([1, 2, 3]) })
  await expect(page.getByLabel('Console', { exact: false })).toHaveValue('gba')
  await page.locator('#console-choice').selectOption('nes')
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('tidak cocok')
  await page.locator('#bios-choice').selectOption('local')
  await expect(page.getByRole('button', { name: 'Pilih BIOS lokal' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('mobile drawer, readable hero, and no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/mobile-home.png', fullPage: true })
  await page.getByRole('button', { name: 'Buka navigasi' }).click()
  await page.getByRole('link', { name: 'Pengaturan', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Atur jeda mainmu.' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('cold-cache server game runs without any external request and records real play', async ({ page, context, baseURL }) => {
  const external: string[] = []
  const errors: string[] = []
  await context.route('**/*', route => {
    const url = route.request().url()
    if (url.startsWith(new URL(baseURL!).origin + '/') || url.startsWith('blob:') || url.startsWith('data:')) return route.continue()
    external.push(url)
    return route.abort()
  })
  page.on('pageerror', e => errors.push(e.message))
  const player = await launchDemo(page)
  await player.locator('canvas').click()
  await page.keyboard.press('ArrowRight')
  // Exercise the actual engine's browser-state store and deserialize the result.
  const roundTrip = await player.locator('body').evaluate(async () => {
    const e = (window as unknown as { EJS_emulator: {
      getBaseFileName: () => string;
      gameManager: { getState: () => Uint8Array; loadState: (state: Uint8Array) => void; FS: { readFile: (name: string) => Uint8Array } };
      storage: { states: { put: (key: string, state: Uint8Array) => Promise<void>; get: (key: string) => Promise<Uint8Array> } };
    } }).EJS_emulator
    const state = e.gameManager.getState()
    const key = e.getBaseFileName() + '.state'
    await e.storage.states.put(key, state)
    const restored = await e.storage.states.get(key)
    e.gameManager.loadState(restored)
    return { bytes: state.length, restored: restored.length, loaded: e.gameManager.FS.readFile('/game.state').length, key }
  })
  expect(roundTrip.bytes).toBeGreaterThan(1000)
  expect(roundTrip.restored).toBe(roundTrip.bytes)
  expect(roundTrip.loaded).toBe(roundTrip.bytes)
  expect(roundTrip.key).toContain('jalan-pulang-v1')
  await page.screenshot({ path: 'test-results/player-server.png', fullPage: true })
  expect(external).toEqual([])
  expect(errors).toEqual([])
  const history = await page.evaluate(() => JSON.parse(localStorage.getItem('maindulu.history.v1') || '[]'))
  expect(history[0].id).toBe('jalan-pulang-v1')
  page.once('dialog', dialog => dialog.dismiss())
  await page.getByRole('link', { name: 'Beranda', exact: true }).click()
  await expect(page).toHaveURL(/\/main$/)
  await expect(player.locator('canvas')).toBeVisible()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Kembali', exact: true }).click()
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Dulu pulang sekolah.')
})

test('local ROM and a local raw BIOS run without upload; disabled history stays empty', async ({ page }) => {
  const buffer = await readFile('public/games/jalan-pulang.nes')
  const writes: string[] = []
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()) })
  await page.goto('/pengaturan')
  await page.getByRole('switch').click()
  await page.getByRole('button', { name: 'Buka ROM', exact: true }).click()
  await page.locator('input[type=file]').first().setInputFiles({ name: 'kenanganku.nes', mimeType: 'application/octet-stream', buffer })
  await page.locator('#bios-choice').selectOption('local')
  await page.locator('input[type=file]').nth(1).setInputFiles({ name: 'test-firmware.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(512) })
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  const player = page.frameLocator('iframe')
  await player.getByRole('button', { name: 'Mulai bermain', exact: true }).click()
  await expect(player.locator('canvas')).toBeVisible({ timeout: 60000 })
  await expect(page.locator('.player-status')).toHaveCount(0, { timeout: 60000 })
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('maindulu.history.v1') || '[]'))).toEqual([])
  const files = await player.locator('body').evaluate(() => (window as unknown as { EJS_emulator: { gameManager: { FS: { readdir: (path: string) => string[] } } } }).EJS_emulator.gameManager.FS.readdir('/'))
  expect(files).toContain('test-firmware.bin')
  expect(writes).toEqual([])
})

test('server ROM can use an explicitly selected server BIOS', async ({ page }) => {
  await page.route('**/catalog/bios.json', route => route.fulfill({ json: [{ id: 'test-bios', name: 'Firmware sintetis uji', consoleId: 'nes', url: '/bios/test-firmware.bin' }] }))
  await page.route('**/bios/test-firmware.bin', route => route.fulfill({ contentType: 'application/octet-stream', body: Buffer.alloc(512) }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true }).click()
  await page.locator('#bios-choice').selectOption('test-bios')
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  const player = page.frameLocator('iframe')
  await player.getByRole('button', { name: 'Mulai bermain', exact: true }).click()
  await expect(player.locator('canvas')).toBeVisible({ timeout: 60000 })
  await expect(page.locator('.player-status')).toHaveCount(0, { timeout: 60000 })
  expect(await player.locator('body').evaluate(() => (window as unknown as { EJS_emulator: { gameManager: { FS: { readdir: (path: string) => string[] } } } }).EJS_emulator.gameManager.FS.readdir('/'))).toContain('test-firmware.bin')
})

test('missing local core fails clearly without falling back to a CDN', async ({ page, context }) => {
  const external: string[] = []
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== 'localhost') external.push(request.url()) })
  await context.route('**/cores/fceumm*wasm.data', route => route.fulfill({ status: 404, body: 'not found' }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true }).click()
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  await page.frameLocator('iframe').getByRole('button', { name: 'Mulai bermain', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Core lokal tidak tersedia')
  expect(external).toEqual([])
})

test('a missing server ROM produces an actionable error rather than a hung engine', async ({ page }) => {
  await page.route('**/games/jalan-pulang.nes', route => route.fulfill({ status: 404, body: 'not found' }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true }).click()
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('ROM server tidak ditemukan')
})

test('native Save State and Load State buttons perform a browser-storage round-trip', async ({ page }) => {
  const player = await launchDemo(page)
  const box = await player.locator('#game').boundingBox()
  await player.locator('#game').hover({ position: { x: 20, y: box!.height - 12 } })
  await player.getByRole('button', { name: 'Save State', exact: true }).click({ force: true })
  await expect(player.locator('.ejs_message')).toContainText('SAVE SAVED TO BROWSER')
  await player.getByRole('button', { name: 'Load State', exact: true }).click({ force: true })
  await expect(player.locator('.ejs_message')).toContainText('SAVE LOADED FROM BROWSER')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('the engine Graphics menu Layar lebar toggle stretches play and persists', async ({ page }) => {
  const player = await launchDemo(page)
  const box = await player.locator('#game').boundingBox()
  await player.locator('#game').hover({ position: { x: 20, y: box!.height - 12 } })
  await player.getByRole('button', { name: 'Settings', exact: true }).click()
  await player.locator('.ejs_settings_main_bar').filter({ hasText: 'Graphics Settings' }).click()
  await player.locator('.ejs_settings_main_bar').filter({ hasText: 'Layar lebar' }).click()
  await player.locator('.ejs_option_row').filter({ hasText: 'Nyala' }).click()
  const scaleX = () => player.locator('canvas').evaluate((canvas) => {
    const transform = getComputedStyle(canvas).transform
    return transform === 'none' ? null : new DOMMatrix(transform).a
  })
  await expect.poll(scaleX).toBeGreaterThan(1.2)
  await expect(page.locator('.player-shell')).toHaveClass(/is-widescreen/)
  await page.screenshot({ path: 'test-results/player-widescreen.png' })
  await expect.poll(async () => page.evaluate(() => { const s = JSON.parse(localStorage.getItem('maindulu.settings.v1') || '{}'); return s.widescreen })).toBe(true)
  await player.locator('.ejs_settings_main_bar').filter({ hasText: 'Layar lebar' }).click()
  await player.locator('.ejs_option_row').filter({ hasText: 'Mati' }).click()
  await expect.poll(scaleX).toBe(null)
  await expect(page.locator('.player-shell')).not.toHaveClass(/is-widescreen/)
  await expect.poll(async () => page.evaluate(() => { const s = JSON.parse(localStorage.getItem('maindulu.settings.v1') || '{}'); return s.widescreen })).toBe(false)
})

// Regression: a saved "Layar lebar" preference fatally threw inside startGame
// because the engine builds the settings menu before the canvas joins the DOM,
// and the default menu row fired the widescreen hook while detached.
test('a saved widescreen preference does not break game start', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(() => {
    localStorage.setItem('maindulu.settings.v1', JSON.stringify({ volume: 50, history: true, widescreen: true }))
  })
  const player = await launchDemo(page)
  expect(errors).toEqual([])
  // The preference must engage without touching the engine menu at all.
  await expect.poll(() => player.locator('canvas').evaluate((canvas) => {
    const transform = getComputedStyle(canvas).transform
    return transform === 'none' ? null : new DOMMatrix(transform).a
  })).toBeGreaterThan(1.2)
  await expect(page.locator('.player-shell')).toHaveClass(/is-widescreen/)
})
