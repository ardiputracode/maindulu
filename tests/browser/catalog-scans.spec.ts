import { test as base, expect } from './helpers/gated-test'
import { mkdtemp, mkdir, rm, writeFile, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createApp } from '../helpers/gated-backend.mjs'
import { setAccountRoleByAdmin } from '../../server/auth/mutations.mjs'
import { startPlayer } from './helpers/player'

type Site = { app: Awaited<ReturnType<typeof createApp>>; address: string; headers: Record<string, string>; data: string; roms: string; bios: string }
const test = base.extend<{ site: Site; external: boolean; shared: boolean }>({
  external: [false, { option: true }],
  shared: [false, { option: true }],
  site: async ({ context, external, shared }, use) => {
    const parent = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir()
    const folder = await mkdtemp(join(parent, 'scan-ui-')), data = join(folder, 'data')
    const roms = join(folder, 'romm/roms'), bios = join(folder, 'romm/bios')
    await mkdir(roms, { recursive: true }); await mkdir(bios, { recursive: true })
    const app = await createApp({ env: { MAIN_DULU_DATA_DIR: data, MAIN_DULU_SCREENSCRAPER_ENABLED: 'false', ...(external || shared ? { MAIN_DULU_EXTERNAL_ROM_DIR: roms, MAIN_DULU_EXTERNAL_BIOS_DIR: bios } : {}), ...(shared ? { MAIN_DULU_EXTERNAL_WRITABLE: 'true' } : {}) } })
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const username = 'scan_' + randomUUID().replaceAll('-', '').slice(0, 12)
      const csrf = (await (await context.request.get(address + '/api/auth/csrf')).json()).csrfToken
      const response = await context.request.post(address + '/api/auth/register', { headers: { origin: address, 'x-csrf-token': csrf }, data: { username, password: 'Admin123', passwordConfirmation: 'Admin123' } })
      expect(response.status()).toBe(201)
      const headers = { origin: address, 'x-csrf-token': (await response.json()).csrfToken }
      setAccountRoleByAdmin(app.database, username, 'admin')
      await use({ app, address, headers, data, roms, bios })
    } finally { await context.close(); await app.close(); await rm(folder, { recursive: true, force: true }) }
  },
})

test.describe('koleksi eksternal hanya-baca', () => {
  test.use({ external: true })
  test('scan UI indexes ROM/BIOS in place, prevents deletion and launches the real emulator from Library', async ({ page, site }) => {
    test.setTimeout(90000)
    const rom = await readFile('public/games/jalan-pulang.nes')
    await mkdir(join(site.roms, 'nes')); await mkdir(join(site.bios, 'nes'))
    await writeFile(join(site.roms, 'nes/romm_homebrew.nes'), rom)
    await writeFile(join(site.bios, 'nes/test-firmware.bin'), Buffer.alloc(512))
    await new Promise(resolve => setTimeout(resolve, 10100))
    await page.goto(site.address + '/admin/scan')
    await expect(page.getByText('Sumber ROM: eksternal hanya-baca.', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Mulai Scan', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Scan Selesai', exact: true })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'ditambahkan' })).toContainText('2 ditambahkan')
    const game = (await (await page.request.get(site.address + '/api/games')).json()).items[0]
    const firmware = (await (await page.request.get(site.address + '/api/bios')).json()).items[0]
    await page.goto(site.address + '/admin/games')
    const entry = page.getByRole('article', { name: 'romm homebrew', exact: true })
    await expect(entry).toContainText('Sumber eksternal hanya-baca')
    await expect(entry.getByRole('button', { name: 'Hapus game', exact: true })).toHaveCount(0)
    await expect(entry.getByRole('button', { name: 'Edit metadata', exact: true })).toBeVisible()
    const denied = await page.request.delete(site.address + '/api/admin/games/' + game.id, { headers: site.headers, data: {} })
    expect(denied.status()).toBe(409)
    await page.goto(site.address + '/library')
    await page.getByRole('button', { name: 'Mainkan romm homebrew', exact: true }).click()
    await page.locator('#bios-choice').selectOption(firmware.id)
    await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
    const frame = await startPlayer(page)
    await expect(frame.locator('canvas')).toBeVisible()
    const files = await frame.locator('body').evaluate(() => (window as unknown as { EJS_emulator: { gameManager: { FS: { readdir: (path: string) => string[] } } } }).EJS_emulator.gameManager.FS.readdir('/'))
    expect(files).toContain('romm_homebrew.nes'); expect(files).toContain('test-firmware.bin')
    expect(await readFile(join(site.roms, 'nes/romm_homebrew.nes'))).toEqual(rom)
    expect(site.app.database.prepare('SELECT COUNT(*) AS n FROM catalog_asset_files').get().n).toBe(0)
    expect(site.app.database.prepare('SELECT id FROM games').get().id).toBe(game.id)
  })
})

test.describe('folder bersama RomM dan maindulu', () => {
  test.use({ shared: true })
  test('upload UI and scan use one folder, real emulator plays, and both deletion directions affect availability', async ({ page, context, site }) => {
    test.setTimeout(90000)
    await mkdir(join(site.roms, 'nes')); await mkdir(join(site.bios, 'nes'))
    await writeFile(join(site.roms, 'nes/romm.nes'), 'synthetic RomM source')
    await writeFile(join(site.bios, 'nes/shared-boot.bin'), Buffer.alloc(512))
    await new Promise(resolve => setTimeout(resolve, 10100))
    await page.goto(site.address + '/admin/scan')
    await expect(page.getByText('Sumber ROM: folder bersama baca/tulis.', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Mulai Scan', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Scan Selesai', exact: true })).toBeVisible()
    await page.goto(site.address + '/admin/games')
    const scanned = page.getByRole('article', { name: 'romm', exact: true })
    await expect(scanned).toContainText('Folder bersama RomM / maindulu')
    await scanned.getByRole('button', { name: 'Hapus game', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('RomM juga kehilangan file ini')
    await page.getByRole('button', { name: 'Batal', exact: true }).click()
    await page.getByRole('button', { name: 'Upload game', exact: true }).click()
    const dialog = page.getByRole('dialog'), rom = await readFile('public/games/jalan-pulang.nes')
    await dialog.getByLabel('Judul game', { exact: true }).fill('Shared upload')
    await dialog.getByLabel('Console', { exact: true }).selectOption('nes')
    await dialog.getByLabel('Berkas ROM', { exact: true }).setInputFiles({ name: 'shared_upload.nes', mimeType: 'application/octet-stream', buffer: rom })
    await dialog.getByRole('button', { name: 'Upload game', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect(await readFile(join(site.roms, 'nes/shared_upload.nes'))).toEqual(rom)
    const game = (await (await page.request.get(site.address + '/api/games?q=Shared')).json()).items[0]
    const firmware = (await (await page.request.get(site.address + '/api/bios')).json()).items[0]
    await page.goto(site.address + '/library')
    await page.getByRole('button', { name: 'Mainkan Shared upload', exact: true }).click()
    await page.locator('#bios-choice').selectOption(firmware.id)
    await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
    const frame = await startPlayer(page)
    await expect(frame.locator('canvas')).toBeVisible()
    // Simulate RomM deleting the source; metadata/save identity stays intact.
    await unlink(join(site.roms, 'nes/shared_upload.nes'))
    expect((await page.request.head(site.address + game.url)).status()).toBe(404)
    const manage = await context.newPage()
    try {
      await manage.goto(site.address + '/admin/games')
      await expect(manage.getByRole('article', { name: 'Shared upload', exact: true })).toContainText('Berkas hilang')
      await manage.getByRole('article', { name: 'romm', exact: true }).getByRole('button', { name: 'Hapus game', exact: true }).click()
      await manage.getByRole('button', { name: 'Ya, hapus', exact: true }).click()
      await expect(manage.getByRole('dialog')).toHaveCount(0)
      await site.app.catalog.maintenance.cleanup()
      await expect.poll(async () => { try { await readFile(join(site.roms, 'nes/romm.nes')); return true } catch { return false } }).toBe(false)
      expect(site.app.database.prepare('SELECT id FROM games WHERE id = ? AND deleted_at IS NULL').get(game.id).id).toBe(game.id)
    } finally { await manage.close() }
  })
})
test.beforeEach(({}, info) => { test.skip(info.project.name !== 'node-backend', 'Memerlukan backend nyata.') })

test('WinSCP-style files register automatically, platform/filter/refresh work, repeat scan is idempotent and catalog assets stay exact', async ({ page, site }) => {
  test.setTimeout(60000)
  await mkdir(join(site.data, 'roms/gbc'), { recursive: true }); await mkdir(join(site.data, 'bios/gb'), { recursive: true })
  await writeFile(join(site.data, 'roms/gbc/scan_game.gbc'), 'synthetic scan ROM')
  await writeFile(join(site.data, 'bios/gb/boot.bin'), 'synthetic firmware')
  // Exercise the real 10-second transfer stability policy, not a browser mock.
  await new Promise(resolve => setTimeout(resolve, 10100))
  await page.goto(site.address + '/admin/scan')
  await expect(page.getByRole('heading', { name: 'Scan Koleksi', exact: true })).toBeVisible()
  await expect(page.getByLabel('Cari metadata dan cover untuk game baru')).toBeDisabled()
  await expect(page.getByLabel('Cari metadata dan cover untuk game baru')).not.toBeChecked()
  await page.getByLabel('Semua platform', { exact: true }).uncheck()
  await page.getByLabel('gbc', { exact: true }).check()
  await page.getByLabel('Jenis berkas').selectOption('games')
  await page.getByRole('button', { name: 'Mulai Scan', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Scan Selesai', exact: true })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'ditambahkan' })).toContainText('1 ditambahkan')
  expect((await (await page.request.get(site.address + '/api/bios')).json()).total).toBe(0)
  await page.getByLabel('Cari nama/path hasil').fill('tidak-ada')
  await expect(page.getByRole('article')).toHaveCount(0)
  await page.getByLabel('Cari nama/path hasil').fill('scan_game')
  await expect(page.getByRole('article')).toContainText('Ditambahkan')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Scan Selesai', exact: true })).toBeVisible()
  await expect(page.getByText('Scope scan ini: ROM · folder gbc', { exact: false })).toBeVisible()
  await expect(page.getByRole('article')).toContainText('roms/gbc/scan_game.gbc')
  await page.getByRole('button', { name: 'Mulai Scan', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'ditambahkan' })).toContainText('1 ditambahkan · 1 sudah terdaftar/duplikat')
  const game = (await (await page.request.get(site.address + '/api/games')).json()).items[0]
  expect(game.consoleId).toBe('gb')
  expect(await (await page.request.get(site.address + game.url)).text()).toBe('synthetic scan ROM')
  expect(await readFile(join(site.data, 'roms/gbc/scan_game.gbc'), 'utf8')).toBe('synthetic scan ROM')
  await page.getByRole('link', { name: 'Manage Game', exact: true }).click()
  await expect(page.getByRole('article', { name: 'scan game', exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Manage BIOS', exact: true }).click()
  await expect(page.getByRole('article', { name: 'boot.bin', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(site.address + '/admin/scan')
  await expect(page.getByRole('heading', { name: 'Scan Koleksi', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('scan displays not-ready/multifile errors and cancels a held worker across refresh without publishing the next file', async ({ page, site }) => {
  test.setTimeout(45000)
  await mkdir(join(site.data, 'roms/psx'), { recursive: true }); await mkdir(join(site.data, 'roms/nes'), { recursive: true })
  await writeFile(join(site.data, 'roms/psx/track.bin'), 'synthetic track')
  await writeFile(join(site.data, 'roms/nes/new.nes'), 'synthetic recent')
  await page.goto(site.address + '/admin/scan')
  await expect(page.getByRole('button', { name: 'Mulai Scan' })).toBeEnabled()
  await page.getByRole('button', { name: 'Mulai Scan' }).click()
  await expect(page.getByRole('heading', { name: 'Scan Selesai' })).toBeVisible()
  await expect(page.getByRole('article').filter({ hasText: 'track.bin' })).toContainText('Paket PSX tidak didukung')
  await expect(page.getByRole('article').filter({ hasText: 'new.nes' })).toContainText('Belum siap')
  const original = site.app.catalog.storage.adoption.bind(site.app.catalog.storage)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  site.app.catalog.storage.adoption = async (...args: unknown[]) => { await held; return original(...args) }
  try {
    await page.getByRole('button', { name: 'Mulai Scan' }).click()
    await expect(page.getByRole('button', { name: 'Batalkan scan' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('button', { name: 'Batalkan scan' })).toBeVisible()
    await page.getByRole('button', { name: 'Batalkan scan' }).click()
    release()
    await expect(page.getByRole('heading', { name: 'Scan Dibatalkan' })).toBeVisible()
    expect((await (await page.request.get(site.address + '/api/games')).json()).total).toBe(0)
  } finally { release() }
})
