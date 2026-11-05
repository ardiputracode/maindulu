import { test, expect, chromium } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { createApp } from '../../server/app.mjs'
import { setAccountRoleByAdmin } from '../../server/auth/mutations.mjs'
import { startPlayer } from './helpers/player'
import { observeAssetTransfers } from './helpers/asset-transfers'

test('HTTP cache revalidates real ROM/BIOS across sessions and browser restart; deletion still blocks launch', async ({ browser }, info) => {
  test.skip(info.project.name !== 'node-backend', 'Cache katalog membutuhkan backend nyata.')
  test.setTimeout(180000)
  const parent = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir()
  const folder = await mkdtemp(join(parent, 'catalog-http-cache-'))
  const app = await createApp({ env: { MAIN_DULU_DATA_DIR: join(folder, 'data') } })
  const watched = new Set<string>()
  let phase = 'first-launch'
  // Observe Node's outgoing body writes, not JS-visible (cache-merged) statuses.
  // No routes, CDP cache toggles, or stream transforms: HTTP caching stays real.
  const transfers = observeAssetTransfers(app.server, watched, () => phase)
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const admin = await browser.newContext({ baseURL: address })
  let guest: BrowserContext | undefined
  const errors: string[] = []
  try {
    const bootstrap = await (await admin.request.get('/api/auth/csrf')).json()
    const username = 'cache_' + randomUUID().replaceAll('-', '').slice(0, 12)
    const registered = await admin.request.post('/api/auth/register', {
      headers: { origin: address, 'x-csrf-token': bootstrap.csrfToken },
      data: { username, password: 'Catalog123', passwordConfirmation: 'Catalog123' },
    })
    expect(registered.status()).toBe(201)
    setAccountRoleByAdmin(app.getDecorator<DatabaseSync>('database'), username, 'admin')
    const headers = { origin: address, 'x-csrf-token': (await registered.json()).csrfToken }
    const rom = await readFile('public/games/jalan-pulang.nes')
    const firmware = Buffer.alloc(512)
    const uploaded = await admin.request.post('/api/admin/games', { headers, multipart: {
      title: 'Game cache HTTP', consoleId: 'nes', license: 'CC0; homebrew Jalan Pulang',
      rom: { name: 'cache-demo.nes', mimeType: 'application/octet-stream', buffer: rom },
    } })
    expect(uploaded.status()).toBe(201)
    const game = (await uploaded.json()).item
    const uploadedBios = await admin.request.post('/api/admin/bios', { headers, multipart: {
      name: 'BIOS cache sintetis', consoleId: 'nes', distributionRights: 'Synthetic plumbing fixture, not real firmware',
      bios: { name: 'cache-firmware.bin', mimeType: 'application/octet-stream', buffer: firmware },
    } })
    expect(uploadedBios.status()).toBe(201)
    const bios = (await uploadedBios.json()).item
    for (const value of [game, bios]) watched.add(value.url)

    async function openBrowser() {
      // A new process uses the SAME isolated on-disk profile and server origin.
      const context = await chromium.launchPersistentContext(join(folder, 'profile'), {
        channel: info.project.use.channel, headless: true, baseURL: address,
        viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block',
        args: ['--enable-unsafe-swiftshader'],
      })
      const page = context.pages()[0] ?? await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      return { context, page }
    }
    async function setupGame(page: Page) {
      await page.goto('/library')
      await page.getByRole('button', { name: 'Mainkan Game cache HTTP', exact: true }).click()
      await page.locator('#bios-choice').selectOption(bios.id)
    }
    async function launch(page: Page) {
      await setupGame(page)
      await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
      const player = await startPlayer(page)
      // A live emulator with an exportable state proves more than a start screen.
      const runtime = await player.locator('body').evaluate(() => {
        const e = (window as unknown as { EJS_emulator: { started: boolean; gameManager: { getState: () => Uint8Array; FS: { readdir: (path: string) => string[] } } } }).EJS_emulator
        return { started: e.started, stateBytes: e.gameManager.getState().length, files: e.gameManager.FS.readdir('/') }
      })
      expect(runtime.started).toBe(true)
      expect(runtime.stateBytes).toBeGreaterThan(1000)
      expect(runtime.files).toEqual(expect.arrayContaining(['cache-demo.nes', 'cache-firmware.bin']))
      await expect(page.getByRole('alert')).toHaveCount(0)
      expect(errors).toEqual([])
    }
    async function exit(page: Page) {
      page.once('dialog', dialog => dialog.accept())
      await page.getByRole('button', { name: 'Kembali', exact: true }).click()
      await expect(page.locator('iframe')).toHaveCount(0)
    }
    function verify(since: number, cold: boolean) {
      for (const [value, content] of [[game, rom], [bios, firmware]] as const) {
        const records = transfers.slice(since).filter(record => record.url === value.url)
        const gets = records.filter(record => record.method === 'GET')
        expect(records.some(record => record.method === 'HEAD')).toBe(true)
        expect(gets.length).toBeGreaterThan(0)
        expect(gets.reduce((sum, record) => sum + record.bytes, 0)).toBe(cold ? content.length : 0)
        expect(gets.every(record => record.status === (cold ? 200 : 304))).toBe(true)
        const etag = `"${createHash('sha256').update(content).digest('hex')}"`
        for (const record of records) {
          expect(record.etag).toBe(etag)
          expect(record.cache).toBe('private, no-cache')
          if (record.status === 304) expect(record.bytes).toBe(0)
        }
        if (!cold) expect(gets.every(record => record.condition?.includes(etag))).toBe(true)
      }
    }

    let opened = await openBrowser()
    guest = opened.context
    let page = opened.page
    await launch(page)
    verify(0, true)
    await exit(page)
    phase = 'second-session'
    let since = transfers.length
    await launch(page)
    verify(since, false)
    await exit(page)
    await guest.close()
    guest = undefined

    phase = 'browser-restart'
    since = transfers.length
    opened = await openBrowser()
    guest = opened.context
    page = opened.page
    await launch(page)
    verify(since, false)
    await exit(page)

    // Leave stale selections in the UI, then delete each cached asset. Both
    // metadata launch guards and real browser HEAD/GET must reject old copies.
    phase = 'deleted-assets'
    await setupGame(page)
    expect((await admin.request.delete(`/api/admin/bios/${bios.id}`, { headers, data: {} })).status()).toBe(200)
    await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('sudah dihapus')
    await expect(page.locator('iframe')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Mainkan Game cache HTTP', exact: true }).click()
    expect((await admin.request.delete(`/api/admin/games/${game.id}`, { headers, data: {} })).status()).toBe(200)
    await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('sudah dihapus')
    await expect(page.locator('iframe')).toHaveCount(0)
    since = transfers.length
    for (const value of [game, bios]) for (const method of ['HEAD', 'GET']) {
      const result = await page.evaluate(async ({ url, method }) => {
        const response = await fetch(url, { method })
        await response.arrayBuffer()
        return { status: response.status, cache: response.headers.get('cache-control'), etag: response.headers.get('etag') }
      }, { url: value.url, method })
      expect(result).toEqual({ status: 404, cache: 'no-store', etag: null })
    }
    expect(transfers.slice(since).map(record => record.status)).toEqual([404, 404, 404, 404])
    expect(errors).toEqual([])
  } finally {
    const report = info.outputPath('server-asset-transfers.json')
    await writeFile(report, JSON.stringify(transfers, null, 2))
    await info.attach('server-asset-transfers', { path: report, contentType: 'application/json' })
    await guest?.close()
    await admin.close()
    await app.close()
    await rm(folder, { recursive: true, force: true })
  }
})
