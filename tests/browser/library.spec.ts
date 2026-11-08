import { test as base, expect } from '@playwright/test'
import type { FrameLocator, Page } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { createApp } from '../../server/app.mjs'
import { setAccountRoleByAdmin } from '../../server/auth/mutations.mjs'
import { createDataBackup, restoreDataBackup, verifyDataBackup } from '../../server/data-backup.mjs'
import { buildNesBatteryFixture } from '../fixtures/nes-battery.mjs'
import { startPlayer } from './helpers/player'
import { encodeGameSave } from '../../src/lib/game-save-format'
import { saveIdentity } from '../../src/lib/domain'

base('Library has portable deep links, URL filters, no duplicate demo, and console links rather than a second catalog', async ({ page }, info) => {
  const api: string[] = []
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) api.push(request.url()) })
  await page.goto('/library?console=nes&sort=title&q=jalan')
  await expect(page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true })).toHaveCount(1)
  await expect(page.getByLabel('Cari game', { exact: true })).toHaveValue('jalan')
  await expect(page.getByLabel('Filter console')).toHaveValue('nes')
  await page.reload()
  await expect(page.getByLabel('Urutan')).toHaveValue('title')
  await page.getByLabel('Cari game', { exact: true }).fill('tidak ada')
  await expect(page.getByRole('heading', { name: 'Belum ketemu judulnya.' })).toBeVisible()
  await page.goto('/console')
  await expect(page.locator('.game-card')).toHaveCount(0)
  await page.locator('.console-card').first().click()
  await expect(page).toHaveURL(/\/library\?console=nes$/)
  await expect(page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true })).toBeVisible()
  if (info.project.name !== 'node-backend') expect(api).toEqual([])
})

base('manifest entries with UUID IDs remain built-in and keep their original firmware names without API detail lookups', async ({ page }) => {
  const gameId = randomUUID(), biosId = randomUUID(), details: string[] = []
  await page.route('**/catalog/games.json', route => route.fulfill({ json: [{ id: gameId, title: 'Demo manifest UUID', source: 'server', consoleId: 'nes', url: '/games/jalan-pulang.nes', license: 'CC0' }] }))
  await page.route('**/catalog/bios.json', route => route.fulfill({ json: [{ id: biosId, name: 'BIOS manifest UUID', consoleId: 'nes', url: '/bios/manifest-firmware.bin' }] }))
  await page.route('**/bios/manifest-firmware.bin', route => route.fulfill({ contentType: 'application/octet-stream', body: Buffer.alloc(32) }))
  page.on('request', request => { if (/\/api\/(games|bios)\/[a-f0-9-]{36}$/.test(request.url())) details.push(request.url()) })
  await page.goto('/library')
  await page.getByRole('button', { name: 'Mainkan Demo manifest UUID', exact: true }).click()
  await page.locator('#bios-choice').selectOption(biosId)
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  const frame = await startPlayer(page)
  expect(await frame.locator('body').evaluate(() => (window as unknown as { EJS_emulator: { gameManager: { FS: { readdir: (path: string) => string[] } } } }).EJS_emulator.gameManager.FS.readdir('/'))).toContain('manifest-firmware.bin')
  expect(details).toEqual([])
})

type Site = { app: Awaited<ReturnType<typeof createApp>>; address: string; username: string; headers: Record<string, string>; restart: () => Promise<void>; restoreMetadata: () => Promise<void> }
const test = base.extend<{ site: Site }>({
  site: async ({ context }, use, info) => {
    test.skip(info.project.name !== 'node-backend', 'Integrasi katalog dinamis memerlukan backend nyata.')
    const parent = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir()
    const folder = await mkdtemp(join(parent, 'library-ui-'))
    const env = { MAIN_DULU_DATA_DIR: join(folder, 'data') }
    let app = await createApp({ env })
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const username = 'library_' + randomUUID().replaceAll('-', '').slice(0, 12)
      const csrf = (await (await context.request.get(address + '/api/auth/csrf')).json()).csrfToken
      const response = await context.request.post(address + '/api/auth/register', { headers: { origin: address, 'x-csrf-token': csrf }, data: { username, password: 'Library123', passwordConfirmation: 'Library123' } })
      expect(response.status()).toBe(201)
      const headers = { origin: address, 'x-csrf-token': (await response.json()).csrfToken }
      setAccountRoleByAdmin(app.database, username, 'admin')
      const site: Site = { app, address, username, headers, restart: async () => {
        await app.close(); app = await createApp({ env })
        await app.listen({ host: '127.0.0.1', port: Number(new URL(address).port) }); site.app = app
      }, restoreMetadata: async () => {
        const config = app.appConfig
        await app.close()
        const backup = join(folder, 'metadata-backup'), restored = join(folder, 'restored')
        const manifest = await createDataBackup(config, backup)
        expect(manifest.catalogAssets).toBe('excluded')
        expect(manifest.files.every((file: { path: string }) => !/^(games|bios|covers)\//.test(file.path))).toBe(true)
        await verifyDataBackup(config, backup)
        await restoreDataBackup(config, backup, restored)
        env.MAIN_DULU_DATA_DIR = restored
        app = await createApp({ env })
        await app.listen({ host: '127.0.0.1', port: Number(new URL(address).port) }); site.app = app
      } }
      await use(site)
    } finally { await context.close(); await app.close(); await rm(folder, { recursive: true, force: true }) }
  },
})

async function upload(page: Page, site: Site, kind: 'games' | 'bios', name: string, buffer: Buffer, consoleId = 'nes', fileName = kind === 'games' ? 'fixture.nes' : 'disksys.rom') {
  const response = await page.request.post(site.address + `/api/admin/${kind}`, { headers: site.headers, multipart: {
    [kind === 'games' ? 'title' : 'name']: name, consoleId,
    [kind === 'games' ? 'license' : 'distributionRights']: 'Original distributable test fixture',
    [kind === 'games' ? 'rom' : 'bios']: { name: fileName, mimeType: 'application/octet-stream', buffer },
  } })
  expect(response.status()).toBe(201)
  return (await response.json()).item
}

async function uploadGameUi(page: Page, title: string, buffer: Buffer) {
  await page.getByRole('button', { name: 'Upload game', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Judul game', { exact: true }).fill(title)
  await dialog.getByLabel('Console', { exact: true }).selectOption('nes')
  await dialog.getByLabel('Berkas ROM', { exact: true }).setInputFiles({ name: 'homebrew.nes', mimeType: 'application/octet-stream', buffer })
  await dialog.getByLabel('Lisensi / hak distribusi').fill('CC0-1.0 original homebrew fixture')
  await dialog.getByRole('button', { name: 'Upload game', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

test('admin UI upload is discoverable by a guest through the real API and plays without reading or hashing server asset bytes in the host', async ({ page, browser, site }) => {
  await page.goto(site.address + '/admin/games')
  await page.getByRole('button', { name: 'Upload game', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Judul game', { exact: true }).fill('Homebrew Library')
  await dialog.getByLabel('Console', { exact: true }).selectOption('nes')
  await dialog.getByLabel('Berkas ROM', { exact: true }).setInputFiles('public/games/jalan-pulang.nes')
  await dialog.getByLabel('Lisensi / hak distribusi').fill('CC0-1.0 homebrew')
  await dialog.getByRole('button', { name: 'Upload game', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.goto(site.address + '/admin/bios')
  await page.getByRole('button', { name: 'Upload BIOS', exact: true }).click()
  await dialog.getByLabel('Nama BIOS', { exact: true }).fill('Firmware Library')
  await dialog.getByLabel('Console', { exact: true }).selectOption('nes')
  await dialog.getByLabel('Berkas BIOS / arsip', { exact: true }).setInputFiles({ name: 'test-firmware.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(512) })
  await dialog.getByRole('button', { name: 'Upload BIOS', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const context = await browser.newContext({ baseURL: site.address })
  try {
    const guest = await context.newPage()
    await guest.addInitScript(() => {
      // Guard host reads, including incremental SHA fallback; the real engine in
      // its iframe must still be free to download/read the assets it executes.
      if (window === window.top) {
        Blob.prototype.arrayBuffer = async () => { throw new Error('Host must not read server ROM/BIOS bytes') }
        if (crypto.subtle) Object.defineProperty(crypto.subtle, 'digest', { value: () => { throw new Error('Host must not hash server ROM/BIOS') } })
      }
    })
    await guest.goto('/library')
    await expect(guest.locator('.game-card')).toHaveCount(2)
    await guest.getByRole('button', { name: 'Mainkan Homebrew Library', exact: true }).click()
    await expect(guest.getByRole('dialog')).toContainText('CC0-1.0 homebrew')
    await expect(guest.locator('#bios-choice option')).toHaveCount(3)
    await expect(guest.locator('#bios-choice')).toHaveValue('none')
    const value = await guest.locator('#bios-choice option').last().getAttribute('value')
    await guest.locator('#bios-choice').selectOption(value!)
    await expect(guest.getByRole('dialog')).toContainText('SHA-256 server:')
    await guest.getByRole('button', { name: 'Main sekarang', exact: true }).click()
    const frame = await startPlayer(guest)
    const files = await frame.locator('body').evaluate(() => (window as unknown as { EJS_emulator: { gameManager: { FS: { readdir: (path: string) => string[] } } } }).EJS_emulator.gameManager.FS.readdir('/'))
    expect(files).toContain('test-firmware.bin')
    expect(files).toContain('jalan-pulang.nes')
    expect(await guest.evaluate(() => JSON.parse(localStorage.getItem('maindulu.history.v1') || '[]')[0].id)).toMatch(/^[a-f0-9-]{36}$/)
    await guest.close()
    const local = await context.newPage()
    await local.goto('/library')
    await local.getByRole('button', { name: 'Buka ROM', exact: true }).click()
    await local.locator('input[type=file]').first().setInputFiles('public/games/jalan-pulang.nes')
    await local.locator('#bios-choice').selectOption(value!)
    await local.getByRole('button', { name: 'Main sekarang', exact: true }).click()
    const localEngine = await startPlayer(local)
    expect(await localEngine.locator('body').evaluate(() => (window as unknown as { EJS_emulator: { gameManager: { FS: { readdir: (path: string) => string[] } } } }).EJS_emulator.gameManager.FS.readdir('/'))).toContain('test-firmware.bin')
    const bios = (await (await page.request.get(site.address + '/api/bios/' + value)).json()).item
    await page.getByRole('article', { name: 'Firmware Library', exact: true }).getByRole('button', { name: 'Hapus BIOS', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('pilihan BIOS lain atau berkas lokal')
    await page.getByRole('button', { name: 'Ya, hapus' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    for (const method of ['GET', 'HEAD']) expect((await context.request.fetch(site.address + bios.url, { method })).status()).toBe(404)
    // An already running engine retains its downloaded bytes, not future access.
    await expect(localEngine.locator('canvas')).toBeVisible()
    await local.close()
    const afterDelete = await context.newPage()
    await afterDelete.goto('/library')
    await afterDelete.getByRole('button', { name: 'Mainkan Homebrew Library', exact: true }).click()
    await expect(afterDelete.locator('#bios-choice option')).toHaveCount(2)
    await expect(afterDelete.locator('#bios-choice')).toHaveValue('none')
    await expect(afterDelete.locator('#bios-choice')).not.toContainText('Firmware Library')
  } finally { await context.close() }
})

test('Library pagination, URL search/order/filter, back navigation and mobile focus work without changing identities', async ({ page, site }) => {
  for (let i = 0; i < 13; i++) await upload(page, site, 'games', `Koleksi ${String(i).padStart(2, '0')}`, Buffer.from(`Synthetic ROM ${i}`), 'nes', `fixture-${i}.nes`)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(site.address + '/library?sort=title&console=nes')
  await expect(page.locator('.game-card')).toHaveCount(12)
  await page.getByRole('button', { name: 'Berikutnya', exact: true }).click()
  await expect(page).toHaveURL(/page=2/)
  await expect(page.locator('.game-card')).toHaveCount(2)
  await page.reload()
  await expect(page.locator('.game-card')).toHaveCount(2)
  await page.getByLabel('Filter console').selectOption('gba')
  await expect(page).not.toHaveURL(/page=2/)
  await expect(page.getByRole('heading', { name: 'Belum ketemu judulnya.' })).toBeVisible()
  await page.goBack()
  await expect(page.getByLabel('Filter console')).toHaveValue('nes')
  await expect(page.locator('.game-card')).toHaveCount(2)
  await page.getByLabel('Cari game', { exact: true }).fill('Koleksi 05')
  await expect(page.locator('.game-card')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Mainkan Koleksi 05', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Mainkan Koleksi 05', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Mainkan Koleksi 05', exact: true })).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: test.info().outputPath('library-mobile.png'), fullPage: true })
})

test('all BIOS pages are offered only on their console, never auto-selected, and server BIOS works with a locally hashed ROM without upload', async ({ page, site }) => {
  for (let i = 0; i < 101; i++) await upload(page, site, 'bios', `Firmware ${String(i).padStart(3, '0')}`, Buffer.from(`Synthetic firmware ${i}`), 'nes', `disksys-${i}.rom`)
  await upload(page, site, 'bios', 'Firmware GBA', Buffer.from('Synthetic GBA'), 'gba', 'gba.bin')
  const writes: string[] = []
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()) })
  await page.goto(site.address + '/')
  await page.getByRole('button', { name: 'Buka ROM', exact: true }).click()
  await page.locator('input[type=file]').first().setInputFiles('public/games/jalan-pulang.nes')
  await expect(page.locator('#bios-choice option')).toHaveCount(103)
  await expect(page.locator('#bios-choice')).toHaveValue('none')
  await expect(page.locator('#bios-choice')).not.toContainText('Firmware GBA')
  await page.locator('#bios-choice').selectOption({ label: 'Firmware 100 · server' })
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  const frame = await startPlayer(page)
  const history = await page.evaluate(() => JSON.parse(localStorage.getItem('maindulu.history.v1') || '[]'))
  expect(history[0].id).toMatch(/^local-nes-[a-f0-9]{64}$/)
  expect(await frame.locator('body').evaluate(() => (window as unknown as { EJS_emulator: { gameManager: { FS: { readdir: (path: string) => string[] } } } }).EJS_emulator.gameManager.FS.readdir('/'))).toContain('disksys-100.rom')
  // Logged-in accounts may sync save data, but neither ROM nor BIOS is uploaded.
  expect(writes.filter(url => /\/api\/admin\//.test(url))).toEqual([])
})

test('game and BIOS API outages are visible/retryable and do not silently become empty static catalogs', async ({ page, site }) => {
  await upload(page, site, 'bios', 'Firmware tersedia', Buffer.alloc(32))
  await page.route('**/api/games?*', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }))
  await page.goto(site.address + '/library')
  await expect(page.getByRole('alert')).toContainText('HTTP 503')
  await expect(page.locator('.game-card')).toHaveCount(0)
  await page.unroute('**/api/games?*')
  await page.getByRole('button', { name: 'Coba lagi', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true })).toBeVisible()
  await page.route('**/api/bios?*', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }))
  await page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('HTTP 503')
  await page.locator('#bios-choice').selectOption('local')
  await expect(page.getByRole('button', { name: 'Pilih BIOS lokal' })).toBeVisible()
  await page.unroute('**/api/bios?*')
  await page.getByRole('button', { name: 'Coba lagi BIOS server' }).click()
  await expect(page.locator('#bios-choice option')).toHaveCount(3)
  await expect(page.locator('#bios-choice')).toHaveValue('local')
  await page.keyboard.press('Escape')
  await page.route('**/api/health', route => route.abort())
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('Mode statis tidak diaktifkan otomatis')
  await page.unroute('**/api/health')
  await page.getByRole('button', { name: 'Coba lagi', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true })).toBeVisible()
})

test('saved server favorites and history recheck deleted metadata before asset download; required BIOS cannot be skipped', async ({ page, site }) => {
  const game = await upload(page, site, 'games', 'Favorit server', await readFile('public/games/jalan-pulang.nes'))
  const assetRequests: string[] = []
  page.on('request', request => { if (new URL(request.url()).pathname === game.url) assetRequests.push(request.url()) })
  await page.goto(site.address + '/library')
  await page.getByRole('button', { name: 'Tambahkan Favorit server ke favorit' }).click()
  await page.evaluate(game => localStorage.setItem('maindulu.history.v1', JSON.stringify([game])), game)
  expect((await page.request.patch(site.address + '/api/admin/games/' + game.id, { headers: site.headers, data: { title: 'Judul terbaru', license: 'Lisensi terbaru' } })).status()).toBe(200)
  await page.goto(site.address + '/favorit')
  await page.getByRole('button', { name: 'Mainkan Judul terbaru', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Judul terbaru')
  await expect(page.getByRole('dialog')).toContainText('Lisensi terbaru')
  await page.keyboard.press('Escape')
  expect((await page.request.delete(site.address + '/api/admin/games/' + game.id, { headers: site.headers, data: {} })).status()).toBe(200)
  for (const path of ['/favorit', '/riwayat']) {
    await page.goto(site.address + path)
    await page.getByRole('button', { name: /^Mainkan (Judul terbaru|Favorit server)$/ }).click()
    await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('sudah dihapus')
    await expect(page.locator('iframe')).toHaveCount(0)
    await page.keyboard.press('Escape')
  }
  expect(assetRequests).toEqual([])
  await page.getByRole('button', { name: 'Buka ROM', exact: true }).click()
  await page.locator('input[type=file]').first().setInputFiles({ name: 'test.fds', mimeType: 'application/octet-stream', buffer: Buffer.alloc(10) })
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('membutuhkan BIOS')
})

type Engine = { EJS_emulator: { gameManager: { getSaveFile: () => Uint8Array | null; simulateInput: (player: number, index: number, value: number) => void } } }
const battery = (frame: FrameLocator) => frame.locator('body').evaluate(() => Array.from((window as unknown as Engine).EJS_emulator.gameManager.getSaveFile() || []))
async function increment(frame: FrameLocator, value: number) {
  await frame.locator('body').evaluate(() => (window as unknown as Engine).EJS_emulator.gameManager.simulateInput(0, 8, 1))
  try { await expect.poll(async () => (await battery(frame))[2]).toBe(value) }
  finally { await frame.locator('body').evaluate(() => (window as unknown as Engine).EJS_emulator.gameManager.simulateInput(0, 8, 0)) }
}
async function states(page: Page, frame: FrameLocator) {
  await frame.getByRole('button', { name: 'Save state server', exact: true }).dispatchEvent('click')
  const dialog = page.getByRole('dialog', { name: 'Save state server', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

test('complete admin login/upload → guest play → ordinary account progress/state → UI metadata edit → reload saves → UI delete rejects old URLs without deleting saves', async ({ page, site, browser }) => {
  // This is one uninterrupted lifecycle, in addition to the focused restart,
  // failure and migration tests. All catalog mutations here use the real UI.
  expect((await page.request.post(site.address + '/api/auth/logout', { headers: site.headers, data: {} })).status()).toBe(200)
  await page.goto(site.address + '/admin/games')
  await page.getByRole('main').getByRole('button', { name: 'Masuk ke akun', exact: true }).click()
  await page.getByLabel('Username', { exact: true }).fill(site.username)
  await page.getByLabel('Password', { exact: true }).fill('Library123')
  await page.getByRole('dialog').getByRole('button', { name: 'Masuk', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await uploadGameUi(page, 'Lifecycle homebrew', buildNesBatteryFixture())
  const game = (await (await page.request.get(site.address + '/api/games')).json()).items[0]
  const guest = await browser.newContext({ baseURL: site.address })
  try {
    const visitor = await guest.newPage()
    await visitor.goto('/library')
    await visitor.getByRole('button', { name: 'Mainkan Lifecycle homebrew', exact: true }).click()
    await visitor.getByRole('button', { name: 'Main sekarang', exact: true }).click()
    const engine = await startPlayer(visitor)
    await increment(engine, 1)
    expect(await visitor.evaluate(() => JSON.parse(localStorage.getItem('maindulu.history.v1') || '[]')[0].id)).toBe(game.id)
    expect(site.app.database.prepare('SELECT COUNT(*) AS n FROM game_saves').get()?.n).toBe(0)
  } finally { await guest.close() }

  const account = await browser.newContext({ baseURL: site.address })
  try {
    const csrf = (await (await account.request.get('/api/auth/csrf')).json()).csrfToken
    const response = await account.request.post('/api/auth/register', {
      headers: { origin: site.address, 'x-csrf-token': csrf },
      data: { username: 'player_' + randomUUID().replaceAll('-', '').slice(0, 12), password: 'Library123', passwordConfirmation: 'Library123' },
    })
    expect(response.status()).toBe(201)
    const user = (await response.json()).user
    expect(user.role).toBe('user')
    expect((await account.request.get('/api/admin/games')).status()).toBe(403)
    const player = await account.newPage()
    await player.goto('/library')
    await player.getByRole('button', { name: 'Mainkan Lifecycle homebrew', exact: true }).click()
    await player.getByRole('button', { name: 'Main sekarang', exact: true }).click()
    const engine = await startPlayer(player)
    await expect.poll(async () => (await battery(engine))[2]).toBe(0) // Guest SRAM was not imported.
    await increment(engine, 1)
    await player.getByRole('button', { name: 'Sinkronkan progres sekarang' }).click()
    const snapshot = encodeGameSave({ layout: 'nes-sram-v1', files: [{ key: 'sram', bytes: new Uint8Array(await battery(engine)) }] })
    const checksum = createHash('sha256').update(snapshot).digest('hex')
    const saveId = saveIdentity(game, 'fceumm')
    await expect.poll(() => site.app.database.prepare('SELECT checksum FROM game_saves WHERE game_id = ? AND user_id = ?').get(saveId, user.id)?.checksum).toBe(checksum)
    const overlay = await states(player, engine)
    await overlay.locator('article').filter({ hasText: 'Slot 1' }).getByRole('button', { name: 'Ganti', exact: true }).click()
    await expect(overlay).toContainText('Tersimpan di server')
    await player.close()

    await page.getByRole('article', { name: 'Lifecycle homebrew', exact: true }).getByRole('button', { name: 'Edit metadata' }).click()
    const edit = page.getByRole('dialog')
    await edit.getByLabel('Judul game', { exact: true }).fill('Lifecycle renamed')
    await edit.getByLabel('Deskripsi', { exact: true }).fill('Metadata berubah; identitas save tetap.')
    await edit.getByRole('button', { name: 'Simpan metadata' }).click()
    await expect(edit).toHaveCount(0)
    expect((await (await page.request.get(site.address + '/api/games/' + game.id)).json()).item.id).toBe(game.id)

    const fresh = await account.newPage()
    await fresh.goto('/library')
    await fresh.getByRole('button', { name: 'Mainkan Lifecycle renamed', exact: true }).click()
    await fresh.getByRole('button', { name: 'Main sekarang', exact: true }).click()
    const restored = await startPlayer(fresh)
    await expect.poll(async () => (await battery(restored))[2]).toBe(1)
    await increment(restored, 2)
    const saved = await states(fresh, restored)
    fresh.once('dialog', dialog => dialog.accept())
    await saved.locator('article').filter({ hasText: 'Slot 1' }).getByRole('button', { name: 'Muat', exact: true }).click()
    await expect(saved).toContainText('Perintah muat dikirim ke core')
    await saved.getByRole('button', { name: 'Tutup dialog', exact: true }).click()
    await expect.poll(async () => (await battery(restored))[2]).toBe(1)
  } finally { await account.close() }

  const saves = site.app.database.prepare('SELECT id, user_id, game_id FROM saves').all()
  const progress = site.app.database.prepare('SELECT id, user_id, game_id FROM game_saves').all()
  expect(saves).toHaveLength(1); expect(progress).toHaveLength(1)
  await page.getByRole('article', { name: 'Lifecycle renamed', exact: true }).getByRole('button', { name: 'Hapus game', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Save, progres pengguna, dan akun tidak dihapus.')
  await page.getByRole('button', { name: 'Ya, hapus' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  for (const url of [game.url, `/games/${game.id}/rom`, `/api/games/${game.id}`]) {
    for (const method of ['GET', 'HEAD']) {
      const denied = await page.request.fetch(site.address + url, { method })
      expect(denied.status()).toBe(404)
      expect(denied.headers()['cache-control']).toBe('no-store')
    }
  }
  expect(site.app.database.prepare('SELECT id, user_id, game_id FROM saves').all()).toEqual(saves)
  expect(site.app.database.prepare('SELECT id, user_id, game_id FROM game_saves').all()).toEqual(progress)
  await page.goto(site.address + '/library')
  await expect(page.getByRole('button', { name: 'Mainkan Lifecycle renamed', exact: true })).toHaveCount(0)
})

test('uploaded game state and CPU-written progress survive metadata edits, server restart and a fresh account browser with the same game ID', async ({ page, site, browser }) => {
  const game = await upload(page, site, 'games', 'Battery Library', buildNesBatteryFixture())
  await page.goto(site.address + '/library')
  await page.getByRole('button', { name: 'Mainkan Battery Library', exact: true }).click()
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  const frame = await startPlayer(page)
  await increment(frame, 1)
  await page.getByRole('button', { name: 'Sinkronkan progres sekarang' }).click()
  // Catalog/history IDs and the existing content-based save identity differ.
  await expect.poll(() => site.app.database.prepare('SELECT game_id FROM game_saves').get()?.game_id).toBe(saveIdentity(game, 'fceumm'))
  const overlay = await states(page, frame)
  await overlay.locator('article').filter({ hasText: 'Slot 1' }).getByRole('button', { name: 'Ganti', exact: true }).click()
  await expect(overlay).toContainText('Tersimpan di server')
  expect((await page.request.patch(site.address + '/api/admin/games/' + game.id, { headers: site.headers, data: { title: 'Battery berganti judul', description: 'Metadata baru', license: 'Original fixture' } })).status()).toBe(200)
  await page.close()
  await site.restart()
  const context = await browser.newContext({ baseURL: site.address })
  try {
    const other = await context.newPage()
    await other.goto('/library')
    await other.getByRole('button', { name: 'Masuk ke akun', exact: true }).click()
    await other.getByLabel('Username', { exact: true }).fill(site.username)
    await other.getByLabel('Password', { exact: true }).fill('Library123')
    await other.getByRole('dialog').getByRole('button', { name: 'Masuk', exact: true }).click()
    await expect(other.getByRole('dialog')).toHaveCount(0)
    await other.getByRole('button', { name: 'Mainkan Battery berganti judul', exact: true }).click()
    await other.getByRole('button', { name: 'Main sekarang', exact: true }).click()
    const restored = await startPlayer(other)
    await expect.poll(async () => (await battery(restored))[2]).toBe(1)
    await increment(restored, 2)
    const saved = await states(other, restored)
    other.once('dialog', d => d.accept())
    await saved.locator('article').filter({ hasText: 'Slot 1' }).getByRole('button', { name: 'Muat', exact: true }).click()
    await expect(saved).toContainText('Perintah muat dikirim ke core')
    await saved.getByRole('button', { name: 'Tutup dialog', exact: true }).click()
    await expect.poll(async () => (await battery(restored))[2]).toBe(1)
    expect(await other.evaluate(() => JSON.parse(localStorage.getItem('maindulu.history.v1') || '[]')[0].id)).toBe(game.id)
  } finally { await context.close() }
})

test('metadata-only backup restores accounts/saves but no ROM/BIOS; admin explicitly reuploads missing assets with the old IDs and firmware names before playing saved progress', async ({ page, site, browser }) => {
  const bytes = buildNesBatteryFixture(), firmware = Buffer.alloc(512, 42)
  const game = await upload(page, site, 'games', 'Game sesudah restore', bytes)
  const bios = await upload(page, site, 'bios', 'BIOS sesudah restore', firmware)
  await page.goto(site.address + '/library')
  await page.getByRole('button', { name: 'Mainkan Game sesudah restore', exact: true }).click()
  await page.locator('#bios-choice').selectOption(bios.id)
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  const frame = await startPlayer(page)
  await increment(frame, 1)
  await page.getByRole('button', { name: 'Sinkronkan progres sekarang' }).click()
  const snapshot = encodeGameSave({ layout: 'nes-sram-v1', files: [{ key: 'sram', bytes: new Uint8Array(await battery(frame)) }] })
  await expect.poll(() => site.app.database.prepare('SELECT checksum FROM game_saves WHERE game_id = ?').get(saveIdentity(game, 'fceumm'))?.checksum).toBe(createHash('sha256').update(snapshot).digest('hex'))
  const saved = await states(page, frame)
  await saved.locator('article').filter({ hasText: 'Slot 1' }).getByRole('button', { name: 'Ganti', exact: true }).click()
  await expect(saved).toContainText('Tersimpan di server')
  await page.close()
  await site.restoreMetadata()
  expect(site.app.database.prepare('SELECT COUNT(*) AS n FROM sessions').get()?.n).toBe(0)
  const context = await browser.newContext({ baseURL: site.address })
  try {
    expect((await context.request.head(game.url)).status()).toBe(404)
    expect((await context.request.head(bios.url)).status()).toBe(404)
    const other = await context.newPage()
    await other.goto('/admin/games')
    await other.getByRole('main').getByRole('button', { name: 'Masuk ke akun', exact: true }).click()
    await other.getByLabel('Username', { exact: true }).fill(site.username)
    await other.getByLabel('Password', { exact: true }).fill('Library123')
    await other.getByRole('dialog').getByRole('button', { name: 'Masuk', exact: true }).click()
    await expect(other.getByRole('dialog')).toHaveCount(0)
    await expect(other.getByRole('article', { name: game.title, exact: true })).toContainText('Berkas hilang')
    await expect(other.locator('.notice')).toContainText('tidak menyertakan berkas ROM, BIOS, atau cover')
    for (const [kind, item, data] of [['games', game, bytes], ['bios', bios, firmware]] as const) {
      if (kind === 'bios') await other.goto('/admin/bios')
      const label = kind === 'games' ? 'game' : 'BIOS'
      await expect(other.getByRole('article', { name: kind === 'games' ? game.title : bios.name, exact: true })).toContainText('Berkas hilang')
      await other.getByRole('button', { name: `Upload ${label}`, exact: true }).click()
      const dialog = other.getByRole('dialog')
      await dialog.getByLabel(kind === 'games' ? 'Judul game' : 'Nama BIOS', { exact: true }).fill('Nama upload tidak mengganti metadata lama')
      await dialog.getByLabel('Console', { exact: true }).selectOption('nes')
      await dialog.getByLabel(kind === 'games' ? 'Berkas ROM' : 'Berkas BIOS / arsip', { exact: true }).setInputFiles({ name: kind === 'games' ? 'renamed.nes' : 'renamed.bin', mimeType: 'application/octet-stream', buffer: data })
      await dialog.getByRole('button', { name: `Upload ${label}`, exact: true }).click()
      await expect(dialog).toContainText(item.id)
      await dialog.getByRole('button', { name: 'Pulihkan ID lama', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      const fresh = (await (await other.request.get(`/api/${kind}/${item.id}`)).json()).item
      expect(fresh.id).toBe(item.id); expect(fresh.url).toBe(item.url); expect(fresh.sha256).toBe(item.sha256)
      expect((await other.request.head(item.url)).status()).toBe(200)
    }
    await other.goto('/library')
    await other.getByRole('button', { name: 'Mainkan Game sesudah restore', exact: true }).click()
    await other.locator('#bios-choice').selectOption(bios.id)
    await other.getByRole('button', { name: 'Main sekarang', exact: true }).click()
    const restored = await startPlayer(other)
    await expect.poll(async () => (await battery(restored))[2]).toBe(1)
    const files = await restored.locator('body').evaluate(() => (window as unknown as { EJS_emulator: { gameManager: { FS: { readdir: (path: string) => string[] } } } }).EJS_emulator.gameManager.FS.readdir('/'))
    expect(files).toContain('disksys.rom')
    await increment(restored, 2)
    const overlay = await states(other, restored)
    other.once('dialog', d => d.accept())
    await overlay.locator('article').filter({ hasText: 'Slot 1' }).getByRole('button', { name: 'Muat', exact: true }).click()
    await expect(overlay).toContainText('Perintah muat dikirim ke core')
    await overlay.getByRole('button', { name: 'Tutup dialog', exact: true }).click()
    await expect.poll(async () => (await battery(restored))[2]).toBe(1)
  } finally { await context.close() }
})
