import { test as base, expect } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createApp } from '../../server/app.mjs'
import { setAccountRoleByAdmin } from '../../server/auth/mutations.mjs'

type Site = { app: Awaited<ReturnType<typeof createApp>>; address: string; headers: Record<string, string>; data: string }
const test = base.extend<{ site: Site }>({
  site: async ({ context }, use) => {
    const parent = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir()
    const folder = await mkdtemp(join(parent, 'scan-ui-')), data = join(folder, 'data')
    const app = await createApp({ env: { MAIN_DULU_DATA_DIR: data, MAIN_DULU_SCREENSCRAPER_ENABLED: 'false' } })
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const username = 'scan_' + randomUUID().replaceAll('-', '').slice(0, 12)
      const csrf = (await (await context.request.get(address + '/api/auth/csrf')).json()).csrfToken
      const response = await context.request.post(address + '/api/auth/register', { headers: { origin: address, 'x-csrf-token': csrf }, data: { username, password: 'Admin123', passwordConfirmation: 'Admin123' } })
      expect(response.status()).toBe(201)
      const headers = { origin: address, 'x-csrf-token': (await response.json()).csrfToken }
      setAccountRoleByAdmin(app.database, username, 'admin')
      await use({ app, address, headers, data })
    } finally { await context.close(); await app.close(); await rm(folder, { recursive: true, force: true }) }
  },
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
