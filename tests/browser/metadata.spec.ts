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

type Site = { app: Awaited<ReturnType<typeof createApp>>; address: string; headers: Record<string, string>; release: () => void; mode: 'verified' | 'review' | 'failure'; calls: number; coverFails: boolean }
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
      metadata: { title, description: 'Sinopsis fixture', genre: 'Action', media: [{ type: 'box-2D', region: 'us' }] } })
    let site: Site
    const app = await createApp({ env: { MAIN_DULU_DATA_DIR: join(folder, 'data'), MAIN_DULU_SCREENSCRAPER_ENABLED: 'true', MAIN_DULU_SCREENSCRAPER_DEV_ID: 'dummy', MAIN_DULU_SCREENSCRAPER_DEV_PASSWORD: 'dummy', MAIN_DULU_SCREENSCRAPER_USER: 'dummy', MAIN_DULU_SCREENSCRAPER_PASSWORD: 'dummy' }, metadataDependencies: {
      clientFactory: () => ({ searchByHash: async (input: { size: number; md5: string; sha1: string; signal: AbortSignal }) => {
        site.calls++
        await Promise.race([gate, new Promise<void>((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))])
        if (site.mode === 'failure') throw new ScreenScraperError('not_found')
        return { method: 'hash', systemId: '3', candidates: site.mode === 'review' ? [makeCandidate('123', 'Kandidat pertama', input), makeCandidate('124', 'Kandidat kedua', input)] : [makeCandidate('123', 'Judul otomatis', input)] }
      }, searchByName: async () => { site.calls++; return { method: 'name', systemId: '3', candidates: [makeCandidate('123', 'Kandidat pertama'), makeCandidate('124', 'Kandidat kedua')] } } }),
      downloadCover: async () => { if (site.coverFails) throw new Error('Synthetic cover failure'); return { bytes: png, type: 'image/png' } },
    } })
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const csrf = (await (await context.request.get(address + '/api/auth/csrf')).json()).csrfToken
      const username = 'metadata_' + randomUUID().replaceAll('-', '').slice(0, 10)
      const registration = await context.request.post(address + '/api/auth/register', { headers: { origin: address, 'x-csrf-token': csrf }, data: { username, password: 'Metadata123', passwordConfirmation: 'Metadata123' } })
      expect(registration.status()).toBe(201)
      const headers = { origin: address, 'x-csrf-token': (await registration.json()).csrfToken }
      setAccountRoleByAdmin(app.database, username, 'admin')
      site = { app, address, headers, release, mode: 'verified', calls: 0, coverFails: false }
      await use(site)
    } finally { release(); await context.close(); await app.close(); await rm(folder, { recursive: true, force: true }) }
  },
})

async function upload(page: Page, site: Site) {
  await page.goto(site.address + '/admin/games')
  await page.getByRole('button', { name: 'Upload game', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Scan metadata otomatis')).toBeEnabled()
  await dialog.getByLabel('Console', { exact: true }).selectOption('nes')
  await dialog.getByLabel('Berkas ROM', { exact: true }).setInputFiles({ name: 'sementara.nes', mimeType: 'application/octet-stream', buffer: await readFile('public/games/jalan-pulang.nes') })
  await dialog.getByRole('button', { name: 'Upload game', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'sudah bisa dimainkan' })).toBeVisible()
  return (await (await page.request.get(site.address + '/api/games')).json()).items[0]
}

test('M5 upload stays playable while provider is held; another tab refreshes title/cover/favorites without reload or changing the active session', async ({ page, context, site }) => {
  const game = await upload(page, site)
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
    const row = await site.app.catalog.repository.publish('games', actor, { title: `Koleksi ${String(i).padStart(3, '0')}`, consoleId: 'nes', fileName: 'fixture.nes' }, stage, { scanMetadata: false })
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
