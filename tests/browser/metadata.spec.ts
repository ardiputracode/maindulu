import { test as base, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { createApp } from '../../server/app.mjs'
import { setAccountRoleByAdmin } from '../../server/auth/mutations.mjs'
import { startPlayer } from './helpers/player'
import { ScreenScraperError } from '../../server/metadata/screenscraper.mjs'
import { metadataZip } from '../helpers/metadata-zip.mjs'
import { screenScraperLimits } from '../../server/metadata/screenscraper-policy.mjs'

type Site = { app: Awaited<ReturnType<typeof createApp>>; address: string; headers: Record<string, string>; release: () => void; restart: () => Promise<void>; mode: 'verified' | 'review' | 'failure' | 'error'; calls: number; coverFails: boolean; providerTitle?: string }
const test = base.extend<{ site: Site }>({
  site: async ({ context }, use, info) => {
    test.skip(info.project.name !== 'node-backend', 'Metadata memerlukan backend nyata; provider tetap tiruan.')
    const parent = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir()
    const folder = await mkdtemp(join(parent, 'metadata-ui-'))
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#118844' } }).png().toBuffer()
    const makeCandidate = (id: string, title: string, input?: { size: number; md5: string; sha1: string }) => ({ id, systemId: '3', notGame: false,
      rom: input ? { id: '456', size: input.size, md5: input.md5, sha1: input.sha1, totalSupports: 1 } : null,
      metadata: { title: site.providerTitle ?? title, description: 'Sinopsis fixture', genre: 'Action', media: [{ type: 'box-2D', region: 'us' }] } })
    let site: Site
    const env = { MAIN_DULU_DATA_DIR: join(folder, 'data'), MAIN_DULU_SCREENSCRAPER_ENABLED: 'true', MAIN_DULU_SCREENSCRAPER_DEV_ID: 'dummy', MAIN_DULU_SCREENSCRAPER_DEV_PASSWORD: 'dummy', MAIN_DULU_SCREENSCRAPER_USER: 'dummy', MAIN_DULU_SCREENSCRAPER_PASSWORD: 'dummy' }
    const metadataDependencies = {
      clientFactory: () => ({ searchByHash: async (input: { size: number; md5: string; sha1: string; signal: AbortSignal }) => {
        site.calls++
        await Promise.race([gate, new Promise<void>((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))])
        if (site.mode === 'failure') throw new ScreenScraperError('not_found')
        if (site.mode === 'error') throw new Error('Synthetic provider failure')
        return { method: 'hash', systemId: '3', candidates: site.mode === 'review' ? [makeCandidate('123', 'Kandidat pertama', input), makeCandidate('124', 'Kandidat kedua', input)] : [makeCandidate('123', 'Judul otomatis', input)] }
      }, searchByName: async () => { site.calls++; return { method: 'name', systemId: '3', candidates: [makeCandidate('123', 'Kandidat pertama'), makeCandidate('124', 'Kandidat kedua')] } } }),
      downloadCover: async () => { if (site.coverFails) throw new Error('Synthetic cover failure'); return { bytes: png, type: 'image/png' } },
    }
    let app = await createApp({ env, metadataDependencies })
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const csrf = (await (await context.request.get(address + '/api/auth/csrf')).json()).csrfToken
      const username = 'metadata_' + randomUUID().replaceAll('-', '').slice(0, 10)
      const registration = await context.request.post(address + '/api/auth/register', { headers: { origin: address, 'x-csrf-token': csrf }, data: { username, password: 'Metadata123', passwordConfirmation: 'Metadata123' } })
      expect(registration.status()).toBe(201)
      const headers = { origin: address, 'x-csrf-token': (await registration.json()).csrfToken }
      setAccountRoleByAdmin(app.database, username, 'admin')
      site = { app, address, headers, release, mode: 'verified', calls: 0, coverFails: false, restart: async () => {
        await app.close()
        app = await createApp({ env, metadataDependencies })
        await app.listen({ host: '127.0.0.1', port: Number(new URL(address).port) })
        site.app = app
      } }
      await use(site)
    } finally { release(); await context.close(); await app.close(); await rm(folder, { recursive: true, force: true }) }
  },
})

async function upload(page: Page, site: Site, archived = false, title = '', scan = true) {
  await page.goto(site.address + '/admin/games')
  await page.getByRole('button', { name: 'Upload game', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Scan metadata otomatis')).toBeEnabled()
  await expect(dialog.getByLabel('Scan metadata otomatis')).toBeChecked()
  if (!scan) await dialog.getByLabel('Scan metadata otomatis').uncheck()
  if (title) await dialog.getByLabel('Judul game', { exact: true }).fill(title)
  await dialog.getByLabel('Console', { exact: true }).selectOption('nes')
  const data = await readFile('public/games/jalan-pulang.nes')
  await dialog.getByLabel('Berkas ROM', { exact: true }).setInputFiles({ name: archived ? 'sementara.zip' : 'sementara.nes', mimeType: 'application/octet-stream', buffer: archived ? metadataZip([{ name: 'demo.nes', data, method: 8 }]) : data })
  await dialog.getByRole('button', { name: 'Upload game', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'sudah bisa dimainkan' })).toBeVisible()
  return (await (await page.request.get(site.address + '/api/games')).json()).items[0]
}

test('service controls resume explicitly, backfill conservatively and stop a running scan across reload on mobile', async ({ page, site }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const game = await upload(page, site, false, 'Backfill fixture', false)
  site.app.database.exec("UPDATE metadata_provider_state SET paused_reason = 'auth_rejected', next_at = 0")
  await page.goto(site.address + '/admin/metadata?console=nes')
  const panel = page.getByRole('region', { name: 'Kontrol layanan' })
  await expect(panel).toContainText('Kredensial ScreenScraper ditolak')
  await page.getByLabel('Status metadata', { exact: true }).selectOption('disabled')
  await expect(page.getByRole('article', { name: 'Backfill fixture' })).toBeVisible()
  await panel.getByRole('button', { name: 'Scan game tanpa metadata', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Lanjutkan layanan terlebih dahulu.')
  await expect(dialog.getByRole('button', { name: /^Antrekan/ })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(panel.getByRole('button', { name: 'Scan game tanpa metadata', exact: true })).toBeFocused()
  await panel.getByRole('button', { name: 'Lanjutkan layanan', exact: true }).click()
  await expect(panel).toContainText('Layanan dilanjutkan.')
  await panel.getByRole('button', { name: 'Scan game tanpa metadata', exact: true }).click()
  await expect(dialog.getByLabel('Scope console')).toHaveValue('nes')
  await expect(dialog.getByLabel('Belum pernah dipindai')).toBeChecked()
  await expect(dialog.getByLabel('Ganti juga metadata yang terkunci')).not.toBeChecked()
  await expect(dialog).toContainText('≈ 1 game akan diantrekan')
  await dialog.getByRole('button', { name: 'Antrekan 1 scan', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(panel).toContainText('1 scan diantrekan')
  await expect.poll(() => site.calls).toBe(1)
  await page.reload()
  await panel.getByRole('button', { name: 'Hentikan semua scan', exact: true }).click()
  await expect(dialog).toContainText('Metadata yang sudah diterapkan tidak dihapus.')
  await dialog.getByRole('button', { name: 'Hentikan 1 scan', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Scan game tanpa metadata', exact: true })).toBeFocused()
  await expect.poll(() => site.app.database.prepare('SELECT status FROM metadata_jobs WHERE game_id = ? ORDER BY generation DESC LIMIT 1').get(game.id).status).toBe('cancelled')
  await page.reload()
  await expect(panel.getByRole('button', { name: 'Hentikan semua scan', exact: true })).toHaveCount(0)
  expect(site.app.database.prepare('SELECT paused_reason FROM metadata_provider_state').get().paused_reason).toBe(null)
  expect(site.app.catalog.repository.get('games', game.id).title).toBe('Backfill fixture')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: test.info().outputPath('metadata-controls-mobile.png'), fullPage: true })
})

test('backfill dialog offers cancelled scans unchecked by default and requeues only when selected', async ({ page, site }) => {
  const game = await upload(page, site, false, 'Cancelled fixture', false)
  site.app.database.prepare("UPDATE metadata_jobs SET status = 'cancelled', error_code = 'CANCELLED_BY_ADMIN' WHERE game_id = ?").run(game.id)
  await page.goto(site.address + '/admin/metadata?console=nes')
  const panel = page.getByRole('region', { name: 'Kontrol layanan' })
  await panel.getByRole('button', { name: 'Scan game tanpa metadata', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const cancelled = dialog.getByLabel('Dibatalkan', { exact: true })
  await expect(cancelled).not.toBeChecked()
  await expect(dialog.getByRole('button', { name: /^Antrekan/ })).toBeDisabled()
  await cancelled.check()
  await expect(dialog).toContainText('≈ 1 game akan diantrekan')
  await dialog.getByRole('button', { name: 'Antrekan 1 scan', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(panel).toContainText('1 scan diantrekan')
  await expect.poll(() => site.app.database.prepare('SELECT COUNT(*) AS n FROM metadata_jobs WHERE game_id = ?').get(game.id).n).toBe(2)
})

for (const lostAccess of ['role', 'session']) test(`service blockers explain disabled actions and revoked ${lostAccess} cannot submit a backfill dialog`, async ({ page, site }) => {
  await upload(page, site, false, 'Blocked fixture', false)
  site.app.database.prepare("UPDATE metadata_provider_state SET paused_reason = 'forbidden', next_at = ?").run(Date.now() + 60000)
  await page.goto(site.address + '/admin/metadata')
  const panel = page.getByRole('region', { name: 'Kontrol layanan' })
  await expect(panel.getByRole('button', { name: 'Lanjutkan layanan' })).toBeDisabled()
  await expect(panel).toContainText('Tunggu cooldown berakhir')
  site.app.appConfig.screenscraper.enabled = false
  await page.getByRole('button', { name: 'Muat ulang antrean' }).click()
  await expect(panel).toContainText('Perbaiki konfigurasi ScreenScraper')
  site.app.appConfig.screenscraper.enabled = true
  site.app.database.exec('UPDATE metadata_provider_state SET paused_reason = NULL, next_at = 0')
  await page.getByRole('button', { name: 'Muat ulang antrean' }).click()
  await expect(panel).toContainText('● Siap')
  await panel.getByRole('button', { name: 'Scan game tanpa metadata', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: 'Antrekan 1 scan', exact: true })).toBeEnabled()
  site.app.database.exec(lostAccess === 'role' ? "UPDATE users SET role = 'user'" : 'DELETE FROM sessions')
  await dialog.getByRole('button', { name: 'Antrekan 1 scan', exact: true }).click()
  await expect(page.getByRole('heading', { name: lostAccess === 'role' ? 'Akses admin diperlukan.' : 'Masuk sebagai admin.' })).toBeVisible()
  expect(site.app.database.prepare("SELECT COUNT(*) AS n FROM metadata_jobs WHERE status = 'queued'").get().n).toBe(0)
})

for (const archived of [false, true]) test(`${archived ? 'M7 ZIP' : 'M5 raw'} upload stays playable while provider is held; another tab refreshes title/cover/favorites without reload or changing the active session`, async ({ page, context, site }) => {
  const game = await upload(page, site, archived)
  let downloads = 0
  context.on('request', request => { if (request.method() === 'GET' && request.url() === site.address + game.url) downloads++ })
  await expect.poll(() => site.calls).toBe(1)
  const library = await context.newPage()
  await library.goto(site.address + '/library?console=nes&sort=title')
  await library.getByRole('button', { name: 'Tambahkan sementara ke favorit', exact: true }).click()
  await expect(library.getByText('Metadata sedang diproses')).toBeVisible()
  await page.goto(site.address + '/library')
  await page.getByRole('button', { name: 'Mainkan sementara', exact: true }).click()
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  const frame = await startPlayer(page)
  await expect(frame.locator('canvas')).toBeVisible()
  await expect(page.getByRole('status', { name: 'Status cache ROM/BIOS' })).toContainText('Tersimpan di perangkat')
  const identity = await frame.locator('body').evaluate(() => (window as unknown as { EJS_emulator: { config: { gameName: string } } }).EJS_emulator.config.gameName)
  expect(downloads).toBe(1)
  site.release()
  await expect.poll(async () => (await (await page.request.get(site.address + '/api/games/' + game.id)).json()).item.title).toBe('Judul otomatis')
  await library.bringToFront()
  await expect(library.getByRole('button', { name: 'Mainkan Judul otomatis', exact: true })).toBeVisible({ timeout: 15000 })
  await expect(library.locator('.game-card img[src*="/cover?v="]')).toBeVisible()
  await expect(library.getByLabel('Filter console')).toHaveValue('nes')
  await expect(library.getByText('Metadata sedang diproses')).toHaveCount(0)
  await expect(page.locator('h1')).toContainText('sementara')
  await library.getByRole('link', { name: /^Favoritku/ }).click()
  await expect(library.getByRole('button', { name: 'Mainkan Judul otomatis', exact: true })).toBeVisible()
  expect((await (await page.request.get(site.address + '/api/games/' + game.id)).json()).item.sha256).toBe(game.sha256)
  await library.getByRole('button', { name: 'Mainkan Judul otomatis', exact: true }).click()
  await library.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  const warm = await startPlayer(library)
  await expect(library.getByRole('status', { name: 'Status cache ROM/BIOS' })).toContainText('Cache perangkat dipakai')
  expect(await warm.locator('body').evaluate(() => (window as unknown as { EJS_emulator: { config: { gameName: string } } }).EJS_emulator.config.gameName)).toBe(identity)
  expect(downloads).toBe(1) // A new title/cover does not invalidate the committed ROM cache.
})

test('metadata queue survives reload, filters jobs, shows live completion and opens review on mobile', async ({ page, site }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await upload(page, site)
  await expect.poll(() => site.calls).toBe(1)
  await page.getByRole('link', { name: 'Antrean Metadata', exact: true }).click()
  await expect(page.getByRole('article', { name: 'sementara', exact: true })).toContainText('Sedang diproses')
  await page.reload()
  await expect(page.getByRole('article', { name: 'sementara', exact: true })).toContainText('Mencari metadata')
  await page.getByLabel('Status metadata', { exact: true }).selectOption('succeeded')
  await expect(page.getByText('Tidak ada tugas metadata.', { exact: true })).toBeVisible()
  site.release()
  const row = page.getByRole('article', { name: 'Judul otomatis', exact: true })
  await expect(row).toContainText('Metadata selesai', { timeout: 15000 })
  await page.getByLabel('Cari game atau berkas').fill('absent')
  await expect(page.getByText('Tidak ada tugas metadata.', { exact: true })).toBeVisible()
  await page.getByLabel('Cari game atau berkas').fill('sementara.nes')
  await row.getByRole('button', { name: 'Review / scan metadata' }).click()
  await expect(page.getByRole('dialog')).toContainText('Metadata selesai')
  await page.getByRole('dialog').getByRole('button', { name: 'Tutup', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Muat ulang antrean' })).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('upload with a supplied title automatically applies verified metadata and cover without opening review', async ({ page, site }) => {
  const game = await upload(page, site, false, 'Judul upload sementara')
  await expect(page.getByRole('article', { name: 'Judul upload sementara', exact: true })).toBeVisible()
  await expect.poll(() => site.calls).toBe(1)
  site.release()
  await expect(page.getByRole('article', { name: 'Judul otomatis', exact: true })).toBeVisible({ timeout: 15000 })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const latest = (await (await page.request.get(site.address + '/api/games/' + game.id)).json()).item
  expect(latest.title).toBe('Judul otomatis')
  expect(latest.description).toBe('Sinopsis fixture')
  expect(latest.cover).toBeTruthy()
  expect(latest.id).toBe(game.id)
  expect(latest.sha256).toBe(game.sha256)
})

test('M5 candidate selection, preview, explicit field apply and unlock work on mobile with focus restoration', async ({ page, site }) => {
  site.mode = 'review'
  await page.setViewportSize({ width: 390, height: 844 })
  const game = await upload(page, site)
  site.release()
  const article = page.getByRole('article', { name: 'sementara', exact: true })
  await article.getByRole('button', { name: 'Review / scan metadata' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Perlu ditinjau', { timeout: 15000 })
  await dialog.getByLabel('Kandidat tersimpan').selectOption('124')
  await expect(dialog).toContainText('Kandidat kedua')
  await dialog.getByLabel('Terapkan Judul', { exact: true }).check()
  await dialog.getByRole('button', { name: 'Terapkan field terpilih' }).click()
  await expect(dialog).toContainText('Metadata selesai', { timeout: 15000 })
  const latest = (await (await page.request.get(site.address + '/api/games/' + game.id)).json()).item
  expect(latest.title).toBe('Kandidat kedua'); expect(latest.description).toBe('')
  await dialog.getByRole('button', { name: 'Buka kunci Judul', exact: true }).click()
  await expect(dialog).toContainText('Kunci field dibuka.')
  await dialog.getByLabel('Nama pencarian manual').fill('Cari ulang')
  await dialog.getByRole('button', { name: 'Cari kandidat' }).click()
  await expect(dialog).toContainText('Perlu ditinjau', { timeout: 15000 })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Upload game', exact: true })).toBeFocused()
  await page.screenshot({ path: test.info().outputPath('metadata-mobile.png'), fullPage: true })
})

test('rescan applies verified suggestions including locked title by default, with an option to preserve locks', async ({ page, site }) => {
  const game = await upload(page, site)
  site.release()
  const metadataUrl = site.address + `/api/admin/games/${game.id}/metadata`
  await expect.poll(async () => (await (await page.request.get(metadataUrl)).json()).status).toBe('succeeded')
  for (const preserve of [false, true]) {
    await page.getByRole('article', { name: 'Judul otomatis', exact: true }).getByRole('button', { name: 'Edit metadata' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Judul game', { exact: true }).fill('Judul terkunci')
    await dialog.getByRole('button', { name: 'Simpan metadata' }).click()
    await expect(dialog).toHaveCount(0)
    site.app.database.prepare('UPDATE metadata_provider_state SET next_at = 0 WHERE id = 1').run()
    await page.getByRole('article', { name: 'Judul terkunci', exact: true }).getByRole('button', { name: 'Review / scan metadata' }).click()
    const replace = dialog.getByRole('checkbox', { name: 'Ganti juga metadata yang terkunci saat scan ulang', exact: true })
    await expect(replace).toBeChecked()
    if (preserve) await replace.uncheck()
    const before = (await (await page.request.get(metadataUrl)).json()).generation
    await dialog.getByRole('button', { name: 'Scan ulang', exact: true }).click()
    await expect.poll(async () => {
      const detail = (await (await page.request.get(metadataUrl)).json())
      return detail.generation > before && detail.status === 'succeeded'
    }).toBe(true)
    const detail = (await (await page.request.get(metadataUrl)).json())
    expect(detail.preview.fields.title.current).toBe(preserve ? 'Judul terkunci' : 'Judul otomatis')
    expect(detail.preview.fields.title.locked).toBe(preserve)
    await dialog.getByRole('button', { name: 'Tutup', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  }
})

test('M5 edit during lookup wins; unchanged form fields are not overwritten or locked', async ({ page, site }) => {
  const game = await upload(page, site)
  await expect.poll(() => site.calls).toBe(1)
  await page.getByRole('article', { name: 'sementara', exact: true }).getByRole('button', { name: 'Edit metadata' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Judul game', { exact: true }).fill('Pilihan admin')
  await dialog.getByRole('button', { name: 'Simpan metadata' }).click()
  await expect(dialog).toHaveCount(0)
  site.release()
  await expect.poll(async () => (await (await page.request.get(site.address + `/api/admin/games/${game.id}/metadata`)).json()).status).toBe('needs_review')
  const detail = (await (await page.request.get(site.address + `/api/admin/games/${game.id}/metadata`)).json())
  expect(detail.preview.fields.title.current).toBe('Pilihan admin'); expect(detail.preview.fields.title.locked).toBe(true)
  expect(detail.preview.fields.description.locked).toBe(false)
  await page.getByRole('article', { name: 'Pilihan admin', exact: true }).getByRole('button', { name: 'Edit metadata' }).click()
  await dialog.getByLabel('Lisensi / hak distribusi').fill('Hak distribusi manual')
  await dialog.getByRole('button', { name: 'Simpan metadata' }).click()
  const after = (await (await page.request.get(site.address + `/api/admin/games/${game.id}/metadata`)).json())
  expect(after.preview.fields.description.locked).toBe(false)
})

for (const mode of ['verified', 'review', 'failure'] as const) test(`rescan survives closing review and SPA navigation, notifying ${mode} once`, async ({ page, site }) => {
  site.mode = mode
  const game = await upload(page, site, false, 'Contra', false)
  await page.getByRole('article', { name: 'Contra', exact: true }).getByRole('button', { name: 'Review / scan metadata' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Scan ulang', exact: true }).click()
  await expect.poll(() => site.calls).toBe(1)
  await expect(dialog).toContainText('Scan tetap berjalan di latar belakang')
  await dialog.getByRole('button', { name: 'Tutup', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole('link', { name: 'Library game', exact: true }).click()
  site.release()
  const toast = page.locator('.metadata-toast')
  await expect(toast).toContainText(mode === 'verified' ? 'Metadata Contra berhasil diperbarui.' : mode === 'review' ? 'Hasil scan Contra perlu ditinjau.' : 'Metadata Contra tidak ditemukan.', { timeout: 15000 })
  const detail = (await (await page.request.get(site.address + `/api/admin/games/${game.id}/metadata`)).json())
  expect(detail.status).toBe(mode === 'verified' ? 'succeeded' : mode === 'review' ? 'needs_review' : 'not_found')
  await toast.getByRole('button', { name: 'Tutup notifikasi metadata' }).click()
  await expect(toast).toHaveCount(0)
  // Reopen and refetch the same generation: no duplicate completion toast.
  await page.getByRole('link', { name: 'Admin', exact: true }).click()
  await page.getByRole('link', { name: 'Manage Game', exact: true }).click()
  await page.getByRole('article', { name: mode === 'verified' ? 'Judul otomatis' : 'Contra', exact: true }).getByRole('button', { name: 'Review / scan metadata' }).click()
  await expect(dialog).toContainText(mode === 'verified' ? 'Metadata selesai' : mode === 'review' ? 'Perlu ditinjau' : 'Tidak ditemukan')
  await expect.poll(() => site.calls).toBe(1)
  await expect(toast).toHaveCount(0)
})

test('closing review before the scan response arrives does not cancel task submission', async ({ page, site }) => {
  await upload(page, site, false, 'Contra', false)
  let releaseRequest = () => {}, requestStarted = () => {}
  const held = new Promise<void>(resolve => { releaseRequest = resolve })
  const started = new Promise<void>(resolve => { requestStarted = resolve })
  await page.route('**/metadata/scan', async route => { requestStarted(); await held; await route.continue() })
  try {
    await page.getByRole('article', { name: 'Contra', exact: true }).getByRole('button', { name: 'Review / scan metadata' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Scan ulang', exact: true }).click()
    await started
    await dialog.getByRole('button', { name: 'Tutup', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await page.getByRole('link', { name: 'Library game', exact: true }).click()
    releaseRequest()
    await expect.poll(() => site.calls).toBe(1)
    site.release()
    await expect(page.locator('.metadata-toast')).toContainText('Metadata Contra berhasil diperbarui.', { timeout: 15000 })
  } finally { releaseRequest() }
})

test('logout stops private metadata tracking without cancelling the server scan', async ({ page, site }) => {
  const game = await upload(page, site, false, 'Contra', false)
  await page.getByRole('article', { name: 'Contra', exact: true }).getByRole('button', { name: 'Review / scan metadata' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Scan ulang', exact: true }).click()
  await expect.poll(() => site.calls).toBe(1)
  await dialog.getByRole('button', { name: 'Tutup', exact: true }).click()
  await page.getByRole('button', { name: /^Akun / }).click()
  await dialog.getByRole('button', { name: 'Keluar akun', exact: true }).click()
  await expect(page.locator('.topbar').getByRole('button', { name: 'Masuk ke akun', exact: true })).toBeVisible()
  site.release()
  await expect.poll(() => site.app.database.prepare('SELECT status FROM metadata_jobs WHERE game_id = ? ORDER BY generation DESC LIMIT 1').get(game.id)?.status).toBe('succeeded')
  await expect(page.locator('.metadata-toast')).toHaveCount(0)
})

test('CHD PS1 serial auto-apply shows serial badge, survives reload and caches the provider', async ({ page, site }) => {
  // Stop the fixture's worker to avoid conflict on shared database
  await site.app.catalog.worker.stop()

  const chdEnv = { ...site.app.appConfig.env ?? {}, MAIN_DULU_DATA_DIR: site.app.appConfig.dataDir, MAIN_DULU_SCREENSCRAPER_ENABLED: 'true', MAIN_DULU_SCREENSCRAPER_DEV_ID: 'dummy', MAIN_DULU_SCREENSCRAPER_DEV_PASSWORD: 'dummy', MAIN_DULU_SCREENSCRAPER_USER: 'dummy', MAIN_DULU_SCREENSCRAPER_PASSWORD: 'dummy' }
  const chdDependencies = {
    clientFactory: () => ({ searchBySerial: async (input: { consoleId: string; fileName: string; serial: string; signal: AbortSignal }) => {
      site.calls++
      await Promise.race([site.release, new Promise<void>((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))])
      return { method: 'serial', systemId: '57', candidates: [{ id: '123', systemId: '57', notGame: false, rom: null, metadata: { title: 'CHD Serial Title', description: 'Serial description', media: [] } }] }
    }, searchByHash: async () => { site.calls++; return { method: 'hash', systemId: '57', candidates: [] } } }),
    downloadCover: async () => { if (site.coverFails) throw new Error('Synthetic cover failure'); return { bytes: png, type: 'image/png' } },
    readSerial: async () => ({ serial: 'SLUS-12345' }),
  }
  const newApp = await createApp({ env: chdEnv, metadataDependencies: chdDependencies })
  await newApp.catalog.worker.start()
  const address = await newApp.listen({ host: '127.0.0.1', port: 0 })
  const newSite = { ...site, app: newApp, address, calls: 0 }
  try {
    await page.goto(address + '/admin/games')
    await page.getByRole('button', { name: 'Upload game', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('Scan metadata otomatis')).toBeChecked()
    await dialog.getByLabel('Judul game', { exact: true }).fill('')
    await dialog.getByLabel('Console', { exact: true }).selectOption('psx')
    const data = Buffer.from('Synthetic CHD fixture bytes; not a commercial disc image.')
    await dialog.getByLabel('Berkas ROM', { exact: true }).setInputFiles({ name: 'Game.chd', mimeType: 'application/octet-stream', buffer: data })
    await dialog.getByRole('button', { name: 'Upload game', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: 'sudah bisa dimainkan' })).toBeVisible()
    const gamesResp = await page.request.get(address + '/api/games')
    const games = (await gamesResp.json()).items
    const game = games.find(g => g.fileName === 'Game.chd')
    expect(game).toBeTruthy()

    const gate = new Promise<void>(resolve => { site.release = resolve })
    await expect.poll(() => site.calls).toBe(1)
    site.release()
    await expect.poll(async () => (await (await page.request.get(address + `/api/admin/games/${game.id}/metadata`)).json()).status).toBe('succeeded', { timeout: 15000 })

    const detail = (await (await page.request.get(address + `/api/admin/games/${game.id}/metadata`)).json())
    expect(detail.matchMethod).toBe('serial')
    expect(detail.preview.fields.title.current).toBe('CHD Serial Title')

    const article = page.getByRole('article', { name: 'CHD Serial Title', exact: true })
    await expect(article).toBeVisible()
    await page.reload()
    await expect(page.getByRole('article', { name: 'CHD Serial Title', exact: true })).toBeVisible()

    site.calls = 0
    newSite.app.database.prepare('UPDATE metadata_provider_state SET next_at = 0 WHERE id = 1').run()
    await page.getByRole('article', { name: 'CHD Serial Title', exact: true }).getByRole('button', { name: 'Review / scan metadata' }).click()
    const dialog2 = page.getByRole('dialog')
    await expect(dialog2).toContainText('Kecocokan serial')
    await dialog2.getByRole('button', { name: 'Scan ulang', exact: true }).click()
    await expect.poll(() => site.calls).toBe(0)
    await dialog2.getByRole('button', { name: 'Tutup', exact: true }).click()
  } finally {
    await newApp.close()
  }
})

test('exhausted rescan retries notify failure after review is closed', async ({ page, site }) => {
  site.mode = 'error'
  await site.app.catalog.worker.stop()
  const game = await upload(page, site, false, 'Contra', false)
  await page.getByRole('article', { name: 'Contra', exact: true }).getByRole('button', { name: 'Review / scan metadata' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Scan ulang', exact: true }).click()
  await expect(dialog).toContainText('Tugas dijadwalkan.')
  site.app.database.prepare("UPDATE metadata_jobs SET attempts = ? WHERE game_id = ? AND status = 'queued'").run(screenScraperLimits.maxAttempts - 1, game.id)
  const work = site.app.catalog.worker.processOne()
  try {
    await expect.poll(() => site.calls).toBe(1)
    await dialog.getByRole('button', { name: 'Tutup', exact: true }).click()
    await page.getByRole('link', { name: 'Library game', exact: true }).click()
    site.release()
    await work
    await expect(page.locator('.metadata-toast')).toContainText('Scan Contra gagal. Buka Review metadata untuk mencoba lagi.', { timeout: 15000 })
  } finally { site.release(); await work }
})

test('M5 older backend without metadata capability never probes metadata endpoints', async ({ page, site }) => {
  const paths: string[] = []
  page.on('request', r => { if (/\/metadata|\/api\/catalog\/revision/.test(r.url())) paths.push(r.url()) })
  await page.route('**/api/health', async route => { const response = await route.fetch(); const body = await response.json(); delete body.capabilities.metadata; await route.fulfill({ json: body }) })
  await page.goto(site.address + '/admin/games')
  await page.getByRole('button', { name: 'Upload game', exact: true }).click()
  await expect(page.getByLabel('Scan metadata otomatis')).toBeDisabled()
  await page.getByRole('button', { name: 'Tutup', exact: true }).click()
  await page.goto(site.address + '/library')
  await expect(page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true })).toBeVisible()
  expect(paths).toEqual([])
})

test('M5 lookup failure stays playable, shows Indonesian reason/retry time, and supports name-search fallback', async ({ page, site }) => {
  site.mode = 'failure'
  const game = await upload(page, site)
  site.release()
  await page.getByRole('article', { name: 'sementara', exact: true }).getByRole('button', { name: 'Review / scan metadata' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Tidak ditemukan')
  await expect(dialog).toContainText('Percobaan berikutnya:')
  await expect(dialog.getByRole('button', { name: 'Scan ulang' })).toBeDisabled()
  expect((await page.request.get(site.address + game.url)).status()).toBe(200)
  await dialog.getByLabel('Nama pencarian manual').fill('Judul alternatif')
  await expect(dialog.getByRole('button', { name: 'Cari kandidat' })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Cari kandidat' }).click()
  await expect(dialog).toContainText('Perlu ditinjau')
})

test('M5 disabled feature reports no scheduled scan and performs zero provider calls', async ({ page, site }) => {
  site.app.appConfig.screenscraper.enabled = false
  await page.goto(site.address + '/admin/games')
  await page.getByRole('button', { name: 'Upload game', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Scan metadata otomatis')).toBeDisabled()
  await dialog.getByLabel('Console', { exact: true }).selectOption('nes')
  await dialog.getByLabel('Berkas ROM', { exact: true }).setInputFiles({ name: 'offline.nes', mimeType: 'application/octet-stream', buffer: Buffer.from('offline fixture') })
  await dialog.getByRole('button', { name: 'Upload game', exact: true }).click()
  await expect(page.getByText('Game berhasil diunggah dan sudah bisa dimainkan. Scan otomatis tidak dijadwalkan.', { exact: true })).toBeVisible()
  expect(site.calls).toBe(0)
})

test('M5 multi-page title changes retain URL filters/page and never render a mixed snapshot', async ({ page, site }) => {
  const actor = site.app.database.prepare('SELECT id FROM users LIMIT 1').get().id
  const ids: string[] = []
  for (let i = 0; i < 101; i++) {
    const stage = await site.app.catalog.storage.stage('games', (async function* () { yield Buffer.from(`fixture ${i}`) })())
    const row = await site.app.catalog.repository.publish('games', actor, { title: `Koleksi ${String(i).padStart(3, '0')}`, consoleId: 'nes', fileName: `fixture-${i}.nes` }, stage, { scanMetadata: false })
    ids.push(row.id)
  }
  await page.goto(site.address + '/library?console=nes&sort=title&q=Koleksi&page=2')
  await expect(page.locator('.game-card')).toHaveCount(12)
  const input = page.getByLabel('Cari game', { exact: true })
  await input.focus()
  await site.app.catalog.repository.update('games', actor, ids[0], { title: 'Koleksi ZZZ' })
  await expect(page.getByText('Katalog diperbarui.', { exact: false })).toBeVisible()
  await expect(page).toHaveURL(/console=nes&sort=title&q=Koleksi&page=2/)
  await expect(input).toBeFocused()
  await expect(page.getByRole('button', { name: 'Mainkan Koleksi 024', exact: true })).toBeVisible()
  const titles = await page.locator('.game-name').allTextContents()
  expect(new Set(titles).size).toBe(12)
})

test('M5 cover warning can retry just the stored cover without repeating the successful lookup', async ({ page, site }) => {
  site.coverFails = true
  const game = await upload(page, site)
  site.release()
  await expect.poll(async () => (await (await page.request.get(site.address + `/api/admin/games/${game.id}/metadata`)).json()).status).toBe('succeeded')
  await page.getByRole('article', { name: 'Judul otomatis', exact: true }).getByRole('button', { name: 'Review / scan metadata' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('cover belum tersedia')
  site.coverFails = false
  await dialog.getByLabel('Terapkan Cover', { exact: true }).check()
  await expect(dialog.getByRole('button', { name: 'Terapkan field terpilih' })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Terapkan field terpilih' }).click()
  await expect.poll(async () => (await (await page.request.get(site.address + '/api/games/' + game.id)).json()).item.cover).toBeTruthy()
  expect(site.calls).toBe(1)
})

test('M5 stale edit in another tab reports conflict and preserves newer admin choices', async ({ page, context, site }) => {
  const game = await upload(page, site)
  const second = await context.newPage()
  await second.goto(site.address + '/admin/games')
  for (const tab of [page, second]) await tab.getByRole('article', { name: 'sementara', exact: true }).getByRole('button', { name: 'Edit metadata' }).click()
  await page.getByLabel('Judul game', { exact: true }).fill('Admin pertama')
  await page.getByRole('button', { name: 'Simpan metadata' }).click()
  await second.getByLabel('Deskripsi', { exact: true }).fill('Edit dari tab lama')
  await second.getByRole('button', { name: 'Simpan metadata' }).click()
  await expect(second.getByRole('dialog').getByRole('alert')).toContainText('Metadata berubah')
  expect((await (await second.request.get(site.address + '/api/games/' + game.id)).json()).item.description).toBe('')
})

test('M5 polling pauses when hidden/offline and resumes on focus without clearing the grid', async ({ page, context, site }) => {
  await upload(page, site)
  const requests: string[] = []
  page.on('request', r => { if (r.url().endsWith('/api/catalog/revision')) requests.push(r.url()) })
  await page.goto(site.address + '/library')
  await expect(page.getByRole('button', { name: 'Mainkan sementara', exact: true })).toBeVisible()
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const before = requests.length
  await page.waitForTimeout(3000)
  expect(requests.length).toBe(before)
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')) })
  await expect.poll(() => requests.length).toBeGreaterThan(before)
  await context.setOffline(true)
  const offline = requests.length
  await page.waitForTimeout(3000)
  expect(requests.length).toBe(offline)
  await expect(page.getByRole('button', { name: 'Mainkan sementara', exact: true })).toBeVisible()
  await context.setOffline(false)
  await expect.poll(() => requests.length).toBeGreaterThan(offline)
})

test('M6 restart retains applied metadata, manual override and playable ROM without another provider lookup', async ({ page, site }) => {
  const game = await upload(page, site)
  site.release()
  const detail = () => page.request.get(site.address + `/api/admin/games/${game.id}/metadata`).then(r => r.json())
  await expect.poll(async () => (await detail()).status).toBe('succeeded')
  const before = await detail()
  const edit = await page.request.patch(site.address + `/api/admin/games/${game.id}`, { headers: site.headers,
    data: { title: 'Judul pilihan admin', expectedRevision: before.preview.revision } })
  expect(edit.status()).toBe(200)
  const cover = await (await page.request.get(site.address + `/games/${game.id}/cover`)).body()
  await site.restart()
  await page.goto(site.address + '/library')
  await expect(page.getByRole('button', { name: 'Mainkan Judul pilihan admin', exact: true })).toBeVisible()
  const after = await detail()
  expect(after.status).toBe('succeeded')
  expect(after.preview.fields.title).toMatchObject({ current: 'Judul pilihan admin', locked: true, source: 'manual' })
  expect(await (await page.request.get(site.address + `/games/${game.id}/cover`)).body()).toEqual(cover)
  expect(site.calls).toBe(1)
  await page.getByRole('button', { name: 'Mainkan Judul pilihan admin', exact: true }).click()
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  await startPlayer(page)
  expect(site.calls).toBe(1)
})

test('M6 delete during a held lookup prevents late metadata and cover publication', async ({ page, site }) => {
  const game = await upload(page, site)
  await expect.poll(() => site.calls).toBe(1)
  await page.getByRole('article', { name: 'sementara', exact: true }).getByRole('button', { name: 'Hapus game', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Ya, hapus', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  site.release()
  await expect.poll(() => site.app.catalog.worker.status().processing).toBe(false)
  expect((await page.request.get(site.address + '/api/games/' + game.id)).status()).toBe(404)
  expect((await page.request.get(site.address + game.url)).status()).toBe(404)
  expect((await page.request.get(site.address + `/games/${game.id}/cover`)).status()).toBe(404)
  const row = site.app.database.prepare('SELECT title, cover_storage_key FROM games WHERE id = ?').get(game.id)
  expect(row.title).toBe('sementara'); expect(row.cover_storage_key).toBeNull()
  await page.goto(site.address + '/library')
  await expect(page.getByRole('button', { name: 'Mainkan sementara', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Mainkan Judul otomatis', exact: true })).toHaveCount(0)
})

test('M6 provider markup remains literal text in catalog and review without script execution or hotlinks', async ({ page, site }) => {
  site.providerTitle = '<img src=x onerror=alert(1)>'
  const dialogs: string[] = [], requests: string[] = []
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss() })
  page.on('request', request => { if (new URL(request.url()).pathname === '/x') requests.push(request.url()) })
  const game = await upload(page, site)
  site.release()
  await expect.poll(async () => (await (await page.request.get(site.address + `/api/admin/games/${game.id}/metadata`)).json()).status).toBe('succeeded')
  await page.goto(site.address + '/library')
  await expect(page.getByRole('button', { name: `Mainkan ${site.providerTitle}`, exact: true })).toBeVisible()
  expect(await page.locator('img[src="x"]').count()).toBe(0)
  await page.goto(site.address + '/admin/games')
  await page.getByRole('article', { name: site.providerTitle, exact: true }).getByRole('button', { name: 'Review / scan metadata' }).click()
  await expect(page.getByRole('dialog')).toContainText(site.providerTitle)
  expect(await page.locator('img[src="x"]').count()).toBe(0)
  expect(dialogs).toEqual([]); expect(requests).toEqual([])
})
