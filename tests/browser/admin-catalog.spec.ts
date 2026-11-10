import { test as base, expect } from './helpers/gated-test'
import type { Page } from '@playwright/test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { createApp } from '../helpers/gated-backend.mjs'
import { setAccountRoleByAdmin } from '../../server/auth/mutations.mjs'

type Site = { app: Awaited<ReturnType<typeof createApp>>; address: string; username: string; headers: Record<string, string> }
const test = base.extend<{ site: Site }>({
  site: async ({ context }, use) => {
    const parent = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir()
    const folder = await mkdtemp(join(parent, 'admin-ui-'))
    const app = await createApp({ env: { MAIN_DULU_DATA_DIR: join(folder, 'data') } })
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const username = 'admin_' + randomUUID().replaceAll('-', '').slice(0, 12)
      const csrf = (await (await context.request.get(address + '/api/auth/csrf')).json()).csrfToken
      const response = await context.request.post(address + '/api/auth/register', { headers: { origin: address, 'x-csrf-token': csrf }, data: { username, password: 'Admin123', passwordConfirmation: 'Admin123' } })
      expect(response.status()).toBe(201)
      const headers = { origin: address, 'x-csrf-token': (await response.json()).csrfToken }
      setAccountRoleByAdmin(app.database, username, 'admin')
      await use({ app, address, username, headers })
    } finally { await context.close(); await app.close(); await rm(folder, { recursive: true, force: true }) }
  },
})
test.beforeEach(({}, info) => { test.skip(info.project.name !== 'node-backend', 'UI admin memerlukan backend nyata.') })
const rom = { name: 'fixture.nes', mimeType: 'application/octet-stream', buffer: Buffer.from('Synthetic homebrew-shaped fixture; no gameplay claim') }
const firmware = { name: 'disksys.rom', mimeType: 'application/octet-stream', buffer: Buffer.alloc(512, 42) }
async function openUpload(page: Page, kind: 'game' | 'BIOS', title: string, file = kind === 'game' ? rom : firmware) {
  await page.getByRole('button', { name: `Upload ${kind}`, exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel(kind === 'game' ? 'Judul game' : 'Nama BIOS', { exact: true }).fill(title)
  await dialog.getByLabel('Console', { exact: true }).selectOption('nes')
  await dialog.getByLabel(kind === 'game' ? 'Berkas ROM' : 'Berkas BIOS / arsip', { exact: true }).setInputFiles(file)
  await dialog.getByLabel(kind === 'game' ? 'Lisensi / hak distribusi' : 'Keterangan hak distribusi', { exact: true }).fill('Synthetic fixture; test distribution permitted')
  return dialog
}

test('admin logs in through UI, refreshes deep links and manages ROM/cover/metadata/delete without changing ID', async ({ page, site }) => {
  const { address } = site
  expect((await page.request.post(address + '/api/auth/logout', { headers: site.headers, data: {} })).status()).toBe(200)
  await page.goto(address + '/admin/games')
  await expect(page.getByRole('heading', { name: 'Masuk sebagai admin.' })).toBeVisible()
  await page.getByRole('main').getByRole('button', { name: 'Masuk ke akun', exact: true }).click()
  await page.getByLabel('Username', { exact: true }).fill(site.username)
  await page.getByLabel('Password', { exact: true }).fill('Admin123')
  await page.getByRole('button', { name: 'Masuk', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Admin', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Manage Game', exact: true })).toBeVisible()
  const dialog = await openUpload(page, 'game', 'UI Game')
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#aabbcc' } }).png().toBuffer()
  await dialog.getByLabel('Cover opsional').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png })
  await dialog.getByRole('button', { name: 'Upload game', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const article = page.getByRole('article', { name: 'UI Game', exact: true })
  await expect(article).toContainText('Tersedia')
  await expect(article).toContainText(`${rom.buffer.length} B`)
  await expect(article).toContainText(createHash('sha256').update(rom.buffer).digest('hex'))
  await page.screenshot({ path: test.info().outputPath('admin-games-desktop.png'), fullPage: true })
  const before = (await (await page.request.get(address + '/api/games')).json()).items[0]
  const stored = site.app.catalog.repository.get('games', before.id)
  const storedPath = await site.app.catalog.storage.pathFor('games', stored.storage_key)
  expect(storedPath).toBe(join(site.app.appConfig.dataDir, 'roms', 'nes', rom.name))
  expect(await readFile(storedPath)).toEqual(rom.buffer)
  expect((await page.request.get(address + before.cover)).status()).toBe(200)
  await article.getByRole('button', { name: 'Edit metadata' }).click()
  const replacement = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#334455' } }).webp().toBuffer()
  await dialog.getByLabel('Cover opsional').setInputFiles({ name: 'replacement.webp', mimeType: 'image/webp', buffer: replacement })
  await dialog.getByRole('button', { name: 'Simpan metadata' }).click()
  await expect(dialog).toHaveCount(0)
  expect(await (await page.request.get(address + before.cover)).body()).toEqual(replacement)
  await article.getByRole('button', { name: 'Edit metadata' }).click()
  await expect(dialog.getByLabel('Console', { exact: true })).toBeDisabled()
  await dialog.getByLabel('Judul game', { exact: true }).fill('UI Game Edited')
  await dialog.getByLabel('Deskripsi', { exact: true }).fill('Deskripsi baru')
  await dialog.getByLabel('Hapus cover saat ini').check()
  await dialog.getByRole('button', { name: 'Simpan metadata' }).click()
  await expect(dialog).toHaveCount(0)
  const edited = page.getByRole('article', { name: 'UI Game Edited', exact: true })
  await expect(edited).toContainText('Tidak ada')
  const after = (await (await page.request.get(address + '/api/games/' + before.id)).json()).item
  expect(after.id).toBe(before.id); expect(after.sha256).toBe(before.sha256); expect(after.description).toBe('Deskripsi baru')
  expect(await site.app.catalog.storage.pathFor('games', stored.storage_key)).toBe(storedPath)
  await edited.getByRole('button', { name: 'Hapus game', exact: true }).click()
  await expect(dialog).toContainText('Save, progres pengguna, dan akun tidak dihapus.')
  await dialog.getByRole('button', { name: 'Ya, hapus' }).click()
  await expect(edited).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Upload game', exact: true })).toBeFocused()
  expect((await page.request.get(address + before.url)).status()).toBe(404)
  await page.getByLabel('Status katalog').selectOption('deleted')
  await expect(page.getByRole('article', { name: 'UI Game Edited', exact: true })).toContainText('Terhapus')
})

test('BIOS upload/edit/delete exposes hash, firmware filename, console filters and dependency warning', async ({ page, site }) => {
  await page.goto(site.address + '/admin/bios')
  const dialog = await openUpload(page, 'BIOS', 'UI Firmware')
  await dialog.getByRole('button', { name: 'Upload BIOS', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const article = page.getByRole('article', { name: 'UI Firmware', exact: true })
  await expect(article).toContainText('disksys.rom')
  await expect(article).toContainText(`${firmware.buffer.length} B`)
  await expect(article).toContainText(createHash('sha256').update(firmware.buffer).digest('hex'))
  const item = (await (await page.request.get(site.address + '/api/bios')).json()).items[0]
  const stored = site.app.catalog.repository.get('bios', item.id)
  expect(await site.app.catalog.storage.pathFor('bios', stored.storage_key)).toBe(join(site.app.appConfig.dataDir, 'bios', 'nes', firmware.name))
  await page.getByLabel('Filter console').selectOption('psx')
  await expect(article).toHaveCount(0)
  await page.getByLabel('Filter console').selectOption('nes')
  await expect(article).toBeVisible()
  await article.getByRole('button', { name: 'Edit metadata' }).click()
  await dialog.getByLabel('Nama BIOS', { exact: true }).fill('Firmware Edited')
  await dialog.getByRole('button', { name: 'Simpan metadata' }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole('article', { name: 'Firmware Edited', exact: true }).getByRole('button', { name: 'Hapus BIOS', exact: true }).click()
  await expect(dialog).toContainText('pilihan BIOS lain atau berkas lokal')
  await dialog.getByRole('button', { name: 'Ya, hapus' }).click()
  await expect(dialog).toHaveCount(0)
  expect((await page.request.get(site.address + '/api/bios')).ok()).toBeTruthy()
  expect((await (await page.request.get(site.address + '/api/bios')).json()).total).toBe(0)
})

test('same platform filename with different bytes is explained in UI and cannot overwrite the first upload', async ({ page, site }) => {
  await page.goto(site.address + '/admin/games')
  let dialog = await openUpload(page, 'game', 'First')
  await dialog.getByRole('button', { name: 'Upload game', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  dialog = await openUpload(page, 'game', 'Different', { ...rom, buffer: Buffer.from('different synthetic bytes') })
  await dialog.getByRole('button', { name: 'Upload game', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Nama berkas sudah dipakai')
  const catalog = (await (await page.request.get(site.address + '/api/games')).json())
  expect(catalog.total).toBe(1)
  expect(await (await page.request.get(site.address + catalog.items[0].url)).body()).toEqual(rom.buffer)
})

test('duplicates are explained and deleted ROM requires explicit reupload restoration of the original ID', async ({ page, site }) => {
  await page.goto(site.address + '/admin/games')
  let dialog = await openUpload(page, 'game', 'Original')
  await dialog.getByRole('button', { name: 'Upload game', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const before = (await (await page.request.get(site.address + '/api/games')).json()).items[0]
  dialog = await openUpload(page, 'game', 'Duplicate')
  await dialog.getByRole('button', { name: 'Upload game', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText(/sudah|duplikat/i)
  await dialog.getByRole('button', { name: 'Tutup', exact: true }).click()
  await page.getByRole('article', { name: 'Original', exact: true }).getByRole('button', { name: 'Hapus game' }).click()
  await page.getByRole('button', { name: 'Ya, hapus' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  dialog = await openUpload(page, 'game', 'Ignored restore title')
  await dialog.getByRole('button', { name: 'Upload game', exact: true }).click()
  await expect(dialog).toContainText('Game ini pernah dihapus. Pulihkan agar save lama tetap terhubung.')
  await expect(dialog).not.toContainText(before.id)
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  const consent = dialog.getByRole('checkbox', { name: 'Pulihkan game dan gunakan save lama' })
  const restore = dialog.getByRole('button', { name: 'Pulihkan game', exact: true })
  await expect(consent).toBeChecked()
  await expect(restore).toBeEnabled()
  await consent.uncheck()
  await expect(restore).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Upload game', exact: true })).toBeDisabled()
  expect((await (await page.request.get(site.address + '/api/games')).json()).total).toBe(0)
  await consent.check()
  await restore.click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('article', { name: 'Original', exact: true })).toBeVisible()
  const after = (await (await page.request.get(site.address + '/api/games')).json()).items[0]
  expect(after.id).toBe(before.id)
})

test('BIOS duplicates and explicit tombstone restoration preserve ID/hash and use the reuploaded firmware filename', async ({ page, site }) => {
  await page.goto(site.address + '/admin/bios')
  let dialog = await openUpload(page, 'BIOS', 'Original firmware')
  await dialog.getByRole('button', { name: 'Upload BIOS', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const before = (await (await page.request.get(site.address + '/api/bios')).json()).items[0]
  dialog = await openUpload(page, 'BIOS', 'Duplicate firmware')
  await dialog.getByRole('button', { name: 'Upload BIOS', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText(/sudah|duplikat/i)
  await dialog.getByRole('button', { name: 'Tutup', exact: true }).click()
  await page.getByRole('article', { name: 'Original firmware', exact: true }).getByRole('button', { name: 'Hapus BIOS' }).click()
  await page.getByRole('button', { name: 'Ya, hapus' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect((await page.request.head(site.address + before.url)).status()).toBe(404)
  dialog = await openUpload(page, 'BIOS', 'Ignored restored name', { ...firmware, name: 'renamed.bin' })
  await dialog.getByRole('button', { name: 'Upload BIOS', exact: true }).click()
  await expect(dialog).toContainText('BIOS ini pernah dihapus.')
  await expect(dialog).not.toContainText(before.id)
  await expect(dialog.getByRole('checkbox', { name: 'Pulihkan BIOS', exact: true })).toBeChecked()
  await dialog.getByRole('button', { name: 'Pulihkan BIOS', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  // Tombstone restoration uses the new upload basename. Only repair of an
  // active missing asset (metadata-only backup) retains the old basename.
  await expect(page.getByRole('article', { name: 'Original firmware', exact: true })).toContainText('renamed.bin')
  const after = (await (await page.request.get(site.address + '/api/bios')).json()).items[0]
  expect(after.id).toBe(before.id)
  expect(after.sha256).toBe(before.sha256)
  expect(after.fileName).toBe('renamed.bin')
  expect(after.url).toBe(`/bios/${before.id}/renamed.bin`)
  expect((await page.request.head(site.address + before.url)).status()).toBe(404)
  expect(await (await page.request.get(site.address + after.url)).body()).toEqual(firmware.buffer)
})

test('admin list supports pagination/search/deep-link refresh and mobile keyboard dialog focus', async ({ page, site }) => {
  for (let i = 0; i < 13; i++) {
    const response = await page.request.post(site.address + '/api/admin/games', { headers: site.headers, multipart: { title: `Game ${i}`, consoleId: 'nes', rom: { ...rom, name: `fixture-${i}.nes`, buffer: Buffer.from(`Fixture ${i}`) } } })
    expect(response.status()).toBe(201)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(site.address + '/admin/games')
  await expect(page.getByRole('article')).toHaveCount(12)
  await page.getByRole('button', { name: 'Berikutnya', exact: true }).click()
  await expect(page.getByRole('article')).toHaveCount(1)
  await expect(page).toHaveURL(/page=2/)
  await page.reload()
  await expect(page.getByRole('article')).toHaveCount(1)
  await page.getByLabel('Cari game', { exact: true }).fill('Game 7')
  await expect(page.getByRole('article', { name: 'Game 7', exact: true })).toBeVisible()
  await expect(page.getByRole('article')).toHaveCount(1)
  await expect(page).not.toHaveURL(/page=2/)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Upload game', exact: true }).click()
  await page.screenshot({ path: test.info().outputPath('admin-upload-mobile.png') })
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Tutup', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Tutup dialog', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Upload game', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Buka navigasi' }).click()
  await page.getByRole('link', { name: 'Admin', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Manage BIOS', exact: true })).toBeVisible()
})

test('ordinary users and guests cannot see admin content, including while session verification is pending', async ({ page, site, browser }) => {
  setAccountRoleByAdmin(site.app.database, site.username, 'user')
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/auth/session', async route => { await held; await route.continue() })
  try {
    await page.goto(site.address + '/admin/games')
    await expect(page.getByRole('status')).toContainText('Memeriksa sesi')
    await expect(page.getByRole('button', { name: 'Upload game', exact: true })).toHaveCount(0)
    release()
    await expect(page.getByRole('heading', { name: 'Akses admin diperlukan.' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0)
    const guest = await browser.newContext()
    try {
      const guestPage = await guest.newPage()
      await guestPage.goto(site.address + '/admin/bios')
      await expect(guestPage.getByRole('heading', { name: 'Masuk sebagai admin.' })).toBeVisible()
      expect((await guest.request.get(site.address + '/api/admin/bios')).status()).toBe(401)
    } finally { await guest.close() }
    expect((await page.request.get(site.address + '/api/admin/games')).status()).toBe(403)
  } finally { release() }
})

test('role revocation before upload hides admin UI and sends no multipart bytes', async ({ page, site }) => {
  await page.goto(site.address + '/admin/games')
  const dialog = await openUpload(page, 'game', 'Rejected')
  const uploads: string[] = []
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/admin/')) uploads.push(request.url()) })
  setAccountRoleByAdmin(site.app.database, site.username, 'user')
  await dialog.getByRole('button', { name: 'Upload game', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Akses admin diperlukan.' })).toBeVisible()
  expect(uploads).toEqual([])
  expect(site.app.database.prepare('SELECT COUNT(*) AS n FROM games').get().n).toBe(0)
})

test('storage errors, server processing phase and cancellation remain clear and retryable', async ({ page, site }) => {
  await page.goto(site.address + '/admin/games')
  await page.route('**/api/admin/games', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    await route.fulfill({ status: 507, json: { error: 'Storage penuh. Upload tidak diterbitkan.', code: 'STORAGE_FULL' } })
  })
  const dialog = await openUpload(page, 'game', 'Storage test')
  await dialog.getByRole('button', { name: 'Upload game', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Storage penuh')
  await page.unroute('**/api/admin/games')
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  // Delay a real server operation AFTER the HTTP body has arrived. Holding a
  // Playwright route instead stalls transport before XHR upload events fire.
  const storage = site.app.catalog.storage
  const promote = storage.promote
  storage.promote = async (...args: Parameters<typeof promote>) => { await held; return promote(...args) }
  try {
    await dialog.getByRole('button', { name: 'Upload game', exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText('Server sedang memvalidasi')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Batalkan permintaan' }).click()
    await expect(dialog.getByRole('alert')).toContainText('dibatalkan')
    await expect(dialog.getByRole('button', { name: 'Upload game', exact: true })).toBeEnabled()
  } finally { release(); storage.promote = promote }
})

test('expired session before upload is handled as lost access rather than successful publication', async ({ page, site }) => {
  await page.goto(site.address + '/admin/bios')
  const dialog = await openUpload(page, 'BIOS', 'Expired')
  site.app.database.prepare('DELETE FROM sessions').run()
  await dialog.getByRole('button', { name: 'Upload BIOS', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Masuk sebagai admin.' })).toBeVisible()
  expect(site.app.database.prepare('SELECT COUNT(*) AS n FROM bios').get().n).toBe(0)
})

test('invalid firmware/cover are explained without publishing, and list failure can be retried', async ({ page, site }) => {
  await page.route('**/api/admin/bios?*', route => route.fulfill({ status: 503, json: { error: 'Gangguan katalog uji' } }))
  await page.goto(site.address + '/admin/bios')
  await expect(page.getByRole('alert')).toContainText('Gangguan katalog uji')
  await page.unroute('**/api/admin/bios?*')
  await page.getByRole('button', { name: 'Coba lagi', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Belum ada hasil.' })).toBeVisible()
  const dialog = await openUpload(page, 'BIOS', 'Invalid firmware', { ...firmware, name: 'firmware.html' })
  await dialog.getByRole('button', { name: 'Upload BIOS', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Gunakan BIOS')
  await dialog.getByLabel('Berkas BIOS / arsip', { exact: true }).setInputFiles({ ...firmware, name: 'bad name.bin' })
  await dialog.getByRole('button', { name: 'Upload BIOS', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Nama BIOS raw')
  await dialog.getByRole('button', { name: 'Tutup', exact: true }).click()
  await page.getByRole('link', { name: 'Manage Game', exact: true }).click()
  const game = await openUpload(page, 'game', 'Invalid cover')
  await game.getByLabel('Cover opsional').setInputFiles({ name: 'cover.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') })
  await game.getByRole('button', { name: 'Upload game', exact: true }).click()
  await expect(game.getByRole('alert')).toContainText('Cover harus PNG/JPEG/WebP')
  expect(site.app.database.prepare('SELECT COUNT(*) AS n FROM games').get().n).toBe(0)
  expect(site.app.database.prepare('SELECT COUNT(*) AS n FROM bios').get().n).toBe(0)
})

test('role revoked by the server during finalization also removes management UI', async ({ page, site }) => {
  await page.goto(site.address + '/admin/games')
  const dialog = await openUpload(page, 'game', 'Late revocation')
  const storage = site.app.catalog.storage
  const promote = storage.promote
  storage.promote = async (...args: Parameters<typeof promote>) => {
    const file = await promote(...args)
    setAccountRoleByAdmin(site.app.database, site.username, 'user')
    return file
  }
  try {
    await dialog.getByRole('button', { name: 'Upload game', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Akses admin diperlukan.' })).toBeVisible()
    await expect(page.getByRole('article')).toHaveCount(0)
    expect(site.app.database.prepare('SELECT COUNT(*) AS n FROM games').get().n).toBe(0)
  } finally { storage.promote = promote }
})
