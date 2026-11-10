import { test, expect } from './helpers/gated-test'
import type { Page, FrameLocator } from '@playwright/test'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, networkInterfaces } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { DatabaseSync } from 'node:sqlite'
import { createApp } from '../helpers/gated-backend.mjs'
import { createCatalogStorage } from '../../server/catalog/storage.mjs'
import { createCatalogRepository } from '../../server/catalog/repository.mjs'
import { catalogDto } from '../../server/catalog/queries.mjs'
import type { CatalogEntry } from '../../src/lib/catalog'
import type * as Controls from '../fixtures/player-assets'
import type * as Strict from '../fixtures/player-strict'
import { buildNesBatteryFixture } from '../fixtures/nes-battery.mjs'
import { startPlayer } from './helpers/player'

type Runtime = Window & { EJS_gameUrl?: unknown; EJS_biosUrl?: unknown; EJS_emulator: {
  fileName: string; config: { gameName: string }; started: boolean; pause: () => void; play: () => void;
  getBaseFileName: () => string; gameManager: { getState: () => Uint8Array; loadState: (bytes: Uint8Array) => void;
    getSaveFile: () => Uint8Array | null; getSaveFilePath: () => string; simulateInput: (p: number, i: number, v: number) => void;
    FS: { readdir: (path: string) => string[] } } } }
declare global { interface Window { playerAssetTest: typeof Controls; strictPlayerTest: typeof Strict; m3SlowChunks?: number } }
type Transfer = { url: string; method: string; status: number; bytes: number }
let folder: string, address: string, bundle: string, strictBundle: string, settingsBundle: string, app: Awaited<ReturnType<typeof createApp>>
let game: CatalogEntry, other: CatalogEntry, bios: CatalogEntry
const transfers: Transfer[] = []
const rom = buildNesBatteryFixture(), firmware = Buffer.alloc(512, 0x29)

test.beforeEach(({}, info) => test.skip(info.project.name !== 'node-backend', 'Integrasi M3 membutuhkan backend nyata.'))
test.beforeAll(async ({}, info) => {
  if (info.project.name !== 'node-backend') return
  bundle = (await build({ entryPoints: ['tests/fixtures/player-assets.ts'], bundle: true, write: false,
    format: 'iife', globalName: 'playerAssetTest', target: 'es2022', platform: 'browser' })).outputFiles[0].text
  settingsBundle = (await build({ entryPoints: ['tests/fixtures/asset-cache-settings.ts'], bundle: true, write: false,
    format: 'iife', globalName: 'cacheSettingsTest', target: 'es2022', platform: 'browser' })).outputFiles[0].text
  strictBundle = (await build({ entryPoints: ['tests/fixtures/player-strict.tsx'], bundle: true, write: false,
    format: 'iife', globalName: 'strictPlayerTest', target: 'es2022', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' } })).outputFiles[0].text
  const parent = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir()
  folder = await mkdtemp(join(parent, 'player-assets-m3-'))
  app = await createApp({ env: { MAIN_DULU_DATA_DIR: join(folder, 'data'), MAIN_DULU_PUBLIC_ORIGIN: 'http://localhost:7777', MAIN_DULU_ALLOW_INSECURE_HTTP: 'true' } })
  const db = app.getDecorator<DatabaseSync>('database'), actor = randomUUID()
  db.prepare('INSERT INTO users (id, username, password_hash, recovery_code_hash, created_at, role) VALUES (?, ?, ?, ?, ?, ?)').run(actor, 'm3_admin', 'test-only', 'test-only', Date.now(), 'admin')
  const storage = await createCatalogStorage(app.getDecorator('appConfig'), app.database)
  const repo = createCatalogRepository(db, storage)
  game = catalogDto('games', await repo.publish('games', actor, { title: 'M3 Battery', consoleId: 'nes', fileName: 'battery test.nes' }, await storage.stage('games', Readable.from([rom]))))
  const changed = Buffer.from(rom); changed[1000] ^= 1 // Unused PRG padding: same size/name, different bytes.
  // Historical UUID assets may share an original basename. Keep this legacy
  // fixture to prove old cache identities still cannot alias after the change;
  // NEW platform-folder uploads intentionally reject such a name collision.
  const legacyRepo = createCatalogRepository(db, { ...storage, promote: (value: Parameters<typeof storage.promote>[0]) => storage.promote(value) })
  other = catalogDto('games', await legacyRepo.publish('games', actor, { title: 'M3 Other', consoleId: 'nes', fileName: 'battery test.nes' }, await storage.stage('games', Readable.from([changed]))))
  bios = catalogDto('bios', await repo.publish('bios', actor, { name: 'M3 Firmware', consoleId: 'nes', fileName: 'firmware-test.bin' }, await storage.stage('bios', Readable.from([firmware]))))
  app.server.prependListener('request', (request, response) => {
    if (![game.url, other.url, bios.url].includes(request.url!)) return
    let bytes = 0
    const count = (chunk: unknown, encoding: unknown) => {
      if (request.method === 'HEAD') return
      if (typeof chunk === 'string') bytes += Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : undefined)
      else if (chunk instanceof Uint8Array) bytes += chunk.byteLength
    }
    const write = response.write, end = response.end
    response.write = function (...args: unknown[]) { count(args[0], args[1]); return Reflect.apply(write, this, args) }
    response.end = function (...args: unknown[]) { count(args[0], args[1]); return Reflect.apply(end, this, args) }
    response.once('finish', () => transfers.push({ url: request.url!, method: request.method!, status: response.statusCode, bytes }))
  })
  await app.listen({ host: '0.0.0.0', port: 0 })
  const bound = app.server.address()
  if (!bound || typeof bound === 'string') throw Error('Missing server port')
  address = `http://127.0.0.1:${bound.port}`
  app.appConfig.publicOrigins.push(address, ...Object.values(networkInterfaces()).flat().filter(value => value?.family === 'IPv4' && !value.internal).map(value => `http://${value!.address}:${bound.port}`))
})
test.afterAll(async () => {
  await app?.close()
  if (folder) await rm(folder, { recursive: true, force: true }) // Only this suite's disposable fixture.
})

async function open(page: Page, enabled = true) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await page.goto(address + '/library')
  await page.addScriptTag({ content: bundle })
  // Legacy URL-path scenarios require an explicit opt-out after the default-on rollout.
  await page.evaluate(enabled => typeof indexedDB === 'undefined' ? undefined : window.playerAssetTest.setCache(enabled), enabled)
}
async function select(page: Page, entry = game, firmwareId?: string) {
  if (new URL(page.url()).pathname !== '/library') await page.getByRole('link', { name: 'Library game', exact: true }).click()
  await page.getByRole('button', { name: `Mainkan ${entry.title}`, exact: true }).click()
  if (firmwareId) await page.locator('#bios-choice').selectOption(firmwareId)
}
async function launch(page: Page, entry = game, firmwareId?: string) {
  await select(page, entry, firmwareId)
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  const start = page.frameLocator('iframe').getByRole('button', { name: 'Mulai bermain', exact: true })
  await expect(start).toBeVisible()
  expect(await page.frameLocator('iframe').locator('body').evaluate(() => !!(window as unknown as Runtime).EJS_emulator.started)).toBe(false)
  return startPlayer(page)
}
async function exit(page: Page) {
  const accept = (dialog: import('@playwright/test').Dialog) => dialog.accept()
  page.on('dialog', accept)
  try {
    await page.getByRole('button', { name: 'Kembali', exact: true }).click()
    await expect(page.locator('iframe')).toHaveCount(0)
  } finally { page.off('dialog', accept) }
}
async function snapshot(frame: FrameLocator) {
  return frame.locator('body').evaluate(() => {
    const e = (window as unknown as Runtime).EJS_emulator
    return { name: e.fileName, gameName: e.config.gameName, key: e.getBaseFileName(), path: e.gameManager.getSaveFilePath(),
      state: Array.from(e.gameManager.getState()), progress: Array.from(e.gameManager.getSaveFile() ?? []), files: e.gameManager.FS.readdir('/') }
  })
}
async function increment(frame: FrameLocator, value: number) {
  await frame.locator('body').evaluate(() => (window as unknown as Runtime).EJS_emulator.gameManager.simulateInput(0, 8, 1))
  try { await expect.poll(() => frame.locator('body').evaluate(() => (window as unknown as Runtime).EJS_emulator.gameManager.getSaveFile()?.[2])).toBe(value) }
  finally { await frame.locator('body').evaluate(() => (window as unknown as Runtime).EJS_emulator.gameManager.simulateInput(0, 8, 0)) }
}

async function register(page: Page) {
  const csrf = await (await page.request.get(address + '/api/auth/csrf')).json()
  const name = 'm3_' + randomUUID().replaceAll('-', '').slice(0, 12)
  const response = await page.request.post(address + '/api/auth/register', { headers: { origin: address, 'x-csrf-token': csrf.csrfToken },
    data: { username: name, password: 'Catalog123', passwordConfirmation: 'Catalog123' } })
  expect(response.status()).toBe(201)
  return { ...(await response.json()), name }
}
async function states(page: Page, frame: FrameLocator) {
  await frame.getByRole('button', { name: 'Save state server', exact: true }).dispatchEvent('click')
  const overlay = page.getByRole('dialog', { name: 'Save state server', exact: true })
  await expect(overlay).toBeVisible()
  return overlay
}

test('M3 production Player miss/hit/reopen: real NES, committed cache and zero engine asset refetch', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  await open(page)
  const since = transfers.length
  let frame = await launch(page, game, bios.id)
  let cold = await snapshot(frame)
  expect(cold.name).toBe('battery%20test.nes')
  expect(cold.files).toContain('firmware-test.bin')
  expect(cold.state.length).toBeGreaterThan(1000)
  await expect(page.locator('.player-asset-notice')).toContainText('Tersimpan di perangkat')
  for (const entry of [game, bios]) expect(transfers.slice(since).filter(v => v.url === entry.url)).toEqual([
    { url: entry.url, method: 'HEAD', status: 200, bytes: 0 }, { url: entry.url, method: 'GET', status: 200, bytes: entry.size },
  ])
  expect(await frame.locator('body').evaluate(() => ({ rom: typeof (window as unknown as Runtime).EJS_gameUrl, bios: typeof (window as unknown as Runtime).EJS_biosUrl }))).toEqual({ rom: 'undefined', bios: 'undefined' })
  const stats = await page.evaluate(() => window.playerAssetTest.stats())
  expect(stats.count).toBe(2); expect(stats.stagingCount).toBe(0); expect(stats.reservedBytes).toBe(0)
  await exit(page)
  const warmSince = transfers.length
  frame = await launch(page, game, bios.id)
  const warm = await snapshot(frame)
  for (const key of ['name', 'gameName', 'key', 'path'] as const) expect(warm[key]).toBe(cold[key])
  await expect(page.locator('.player-asset-notice')).toContainText('Cache perangkat dipakai')
  expect(transfers.slice(warmSince)).toEqual([game, bios].map(entry => ({ url: entry.url, method: 'HEAD', status: 200, bytes: 0 })))
  await exit(page)
  // Application document restart, NOT a persistent-profile/browser-process restart (M5).
  await open(page)
  const reopenSince = transfers.length
  await launch(page, game, bios.id)
  expect(transfers.slice(reopenSince).every(v => v.method === 'HEAD' && v.bytes === 0)).toBe(true)
  await exit(page)
  await page.evaluate(() => window.playerAssetTest.setCache(false))
  const offSince = transfers.length
  await launch(page, game, bios.id)
  await expect(page.locator('.player-asset-notice')).toHaveCount(0)
  for (const entry of [game, bios]) expect(transfers.slice(offSince).filter(v => v.url === entry.url && v.method === 'GET')).toEqual([{ url: entry.url, method: 'GET', status: 200, bytes: entry.size }])
  expect((await page.evaluate(() => window.playerAssetTest.stats())).count).toBe(2) // Off is not clear.
  expect(errors).toEqual([])
  await info.attach('server-asset-transfers.json', { body: JSON.stringify(transfers.slice(since), null, 2), contentType: 'application/json' })
})

test('M3 URL-era state/SRAM names and old state restore survive prepared input; equal names/sizes never alias', async ({ page }) => {
  await open(page, false)
  let frame = await launch(page, game, bios.id)
  await increment(frame, 1)
  const old = await snapshot(frame)
  await exit(page)
  await page.evaluate(() => window.playerAssetTest.setCache(true))
  frame = await launch(page, game, bios.id)
  const prepared = await snapshot(frame)
  for (const key of ['name', 'gameName', 'key', 'path'] as const) expect(prepared[key]).toBe(old[key])
  await frame.locator('body').evaluate((_body, state) => {
    const e = (window as unknown as Runtime).EJS_emulator
    e.pause(); e.gameManager.loadState(new Uint8Array(state)); e.play()
  }, old.state)
  await expect.poll(() => frame.locator('body').evaluate(() => (window as unknown as Runtime).EJS_emulator.gameManager.getSaveFile()?.[2])).toBe(1)
  await exit(page)
  const since = transfers.length
  frame = await launch(page, other)
  const different = await snapshot(frame)
  expect(different.gameName).not.toBe(old.gameName)
  expect(other.size).toBe(game.size); expect(other.sha256).not.toBe(game.sha256)
  expect(transfers.slice(since).filter(v => v.method === 'GET')).toEqual([{ url: other.url, method: 'GET', status: 200, bytes: other.size }])
  expect((await page.evaluate(() => window.playerAssetTest.stats())).entries.map(v => v.sha256)).toEqual(expect.arrayContaining([game.sha256, other.sha256]))
})

test('M3 local/server BIOS combinations and no BIOS keep local bytes out of the cache', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'Buka ROM', exact: true }).click()
  await page.locator('input[type=file]').first().setInputFiles({ name: 'local.nes', mimeType: 'application/octet-stream', buffer: rom })
  await page.locator('#bios-choice').selectOption(bios.id)
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  let frame = await startPlayer(page)
  expect((await snapshot(frame)).files).toContain('firmware-test.bin')
  expect((await page.evaluate(() => window.playerAssetTest.stats())).entries.map(v => v.kind)).toEqual(['bios'])
  await exit(page)
  await select(page, game, 'local')
  await page.locator('input[type=file]').nth(1).setInputFiles({ name: 'local-fw.bin', mimeType: 'application/octet-stream', buffer: firmware })
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  frame = await startPlayer(page)
  expect((await snapshot(frame)).files).toContain('local-fw.bin')
  expect((await page.evaluate(() => window.playerAssetTest.stats())).count).toBe(2)
  await exit(page)
  await launch(page)
  expect((await page.evaluate(() => window.playerAssetTest.stats())).count).toBe(2)
})

test('M3 explicit toggle off retains URL path; budget fallback downloads once and never claims stored', async ({ page }) => {
  await open(page, false)
  await launch(page)
  await expect(page.locator('.player-asset-notice')).toHaveCount(0)
  expect((await page.evaluate(() => window.playerAssetTest.stats())).count).toBe(0)
  await exit(page)
  await page.evaluate(() => window.playerAssetTest.setCache(true, 1))
  const since = transfers.length
  await launch(page)
  await expect(page.locator('.player-asset-notice')).toContainText('Dimainkan tanpa disimpan')
  expect(transfers.slice(since).filter(v => v.method === 'GET')).toEqual([{ url: game.url, method: 'GET', status: 200, bytes: game.size }])
  expect((await page.evaluate(() => window.playerAssetTest.stats())).count).toBe(0)
})

test('M3 account URL-era SRAM/state restore through prepared input; incompatible builds still block boot', async ({ page }) => {
  await register(page)
  await open(page, false)
  let frame = await launch(page)
  await increment(frame, 1)
  const region = page.getByRole('region', { name: 'Sinkronisasi progres game' })
  await region.getByRole('button', { name: 'Sinkronkan progres sekarang' }).click()
  await expect(region).toContainText('dikonfirmasi server')
  const old = await snapshot(frame)
  let overlay = await states(page, frame)
  await overlay.locator('article').filter({ hasText: 'Slot 1' }).getByRole('button', { name: 'Ganti', exact: true }).click()
  await expect(overlay).toContainText('Tersimpan di server')
  await overlay.getByRole('button', { name: 'Tutup dialog', exact: true }).click()
  // Real legacy URL boot creates the pre-feature server fixture; no new build
  // fingerprint or compatibility allowlist is substituted for the prepared boot.
  const db = app.getDecorator<DatabaseSync>('database')
  const row = db.prepare('SELECT * FROM game_saves WHERE game_id = ?').get(old.gameName)!
  expect(row).toBeTruthy()
  await exit(page)
  await page.evaluate(() => window.playerAssetTest.setCache(true))
  frame = await launch(page)
  await expect.poll(() => frame.locator('body').evaluate(() => (window as unknown as Runtime).EJS_emulator.gameManager.getSaveFile()?.[2])).toBe(1)
  const prepared = await snapshot(frame)
  for (const key of ['name', 'gameName', 'key', 'path'] as const) expect(prepared[key]).toBe(old[key])
  overlay = await states(page, frame)
  await overlay.getByLabel('Aktifkan autosave state').check()
  await overlay.getByLabel('Interval', { exact: true }).selectOption('30000')
  const download = page.waitForEvent('download')
  await overlay.getByRole('button', { name: 'Unduh state saat ini', exact: true }).click()
  expect((await download).suggestedFilename()).toContain('-cadangan.state')
  page.once('dialog', dialog => dialog.accept())
  await overlay.locator('article').filter({ hasText: 'Slot 1' }).getByRole('button', { name: 'Muat', exact: true }).click()
  await expect(overlay).toContainText('Perintah muat dikirim')
  await overlay.getByRole('button', { name: 'Tutup dialog', exact: true }).click()
  await expect.poll(() => db.prepare('SELECT count(*) AS count FROM saves WHERE game_id = ? AND slot = 99').get(old.gameName)!.count, { timeout: 45000 }).toBe(1)
  await exit(page)
  const saved = db.prepare('SELECT * FROM game_saves WHERE id = ?').get(row.id)!
  db.prepare('UPDATE game_saves SET metadata = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(String(saved.metadata)), runtimeBuild: 'c'.repeat(64) }), saved.id)
  await select(page)
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  await page.frameLocator('iframe').getByRole('button', { name: 'Mulai bermain', exact: true }).click()
  await expect(page.locator('.player-error')).toContainText('Versi engine/core progres berbeda')
  expect(db.prepare('SELECT checksum FROM game_saves WHERE id = ?').get(saved.id)!.checksum).toBe(saved.checksum)
})

test('M3 exit during pending GET fences late completion and permits a fresh session without active writers', async ({ page }) => {
  await open(page)
  let release!: () => void, reached!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), requested = new Promise<void>(resolve => { reached = resolve })
  await page.route('**' + game.url, async route => {
    if (route.request().method() !== 'GET') return route.continue()
    reached(); await held
    await route.continue().catch(() => {}) // The old request may already be aborted.
  })
  await select(page)
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  await requested
  await expect(page.frameLocator('iframe').getByRole('button', { name: 'Mulai bermain', exact: true })).toHaveCount(0)
  await page.evaluate(() => {
    window.postMessage({ channel: 'maindulu:player', type: 'started' }, location.origin) // Wrong source.
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://wrong.invalid', source: document.querySelector('iframe')!.contentWindow,
      data: { channel: 'maindulu:player', type: 'started' } }))
  })
  await page.frameLocator('iframe').locator('body').evaluate(() => parent.postMessage({ channel: 'maindulu:player', type: 'started', sessionId: crypto.randomUUID() }, location.origin))
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('maindulu.history.v1') ?? '[]'))).toEqual([])
  await exit(page)
  release()
  await page.unroute('**' + game.url)
  await launch(page)
  await expect.poll(async () => {
    const stats = await page.evaluate(() => window.playerAssetTest.stats())
    return { count: stats.count, staging: stats.stagingCount, reserved: stats.reservedBytes }
  }).toEqual({ count: 1, staging: 0, reserved: 0 })
})

test('M3 logout during asset preparation removes iframe and prevents stale account configuration', async ({ page }) => {
  const account = await register(page)
  await open(page)
  let release!: () => void, reached!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), requested = new Promise<void>(resolve => { reached = resolve })
  await page.route('**' + game.url, async route => {
    if (route.request().method() !== 'GET') return route.continue()
    reached(); await held; await route.continue().catch(() => {})
  })
  await select(page)
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  await requested
  // Account management is intentionally disabled in an active Player. Revoke
  // through the real UI in another tab, then let the original tab refresh auth.
  const otherTab = await page.context().newPage()
  await otherTab.goto(address + '/')
  await otherTab.getByRole('button', { name: `Akun ${account.name}`, exact: true }).click()
  await otherTab.getByRole('button', { name: 'Keluar akun', exact: true }).click()
  await otherTab.close()
  await page.bringToFront()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('iframe')).toHaveCount(0)
  release(); await page.unroute('**' + game.url)
  await expect(page.locator('.player-error')).toContainText('Sesi akun berakhir')
  await expect.poll(async () => (await page.evaluate(() => window.playerAssetTest.stats())).stagingCount).toBe(0)
})

test('M3 production bridge rejects forged source/origin/session and mismatched/oversized prepared payloads', async ({ page }) => {
  await page.goto(address + '/')
  // A host harness exercises the production iframe/validator, not a fake engine.
  for (const mode of ['identity', 'size', 'namespace', 'bios'] as const) {
    const result = await page.evaluate(async ({ game, mode }) => {
      const messages: string[] = [], id = crypto.randomUUID()
      const iframe = document.createElement('iframe'); iframe.src = '/player/index.html'
      let cleanup = () => {}
      const ready = new Promise<void>(resolve => {
        const listener = (event: MessageEvent) => {
          if (event.source !== iframe.contentWindow || event.data?.channel !== 'maindulu:player') return
          messages.push(event.data.type)
          if (event.data.type === 'ready') resolve()
        }
        window.addEventListener('message', listener)
        // Keep this listener only for this harness iframe.
        cleanup = () => window.removeEventListener('message', listener)
      })
      document.body.appendChild(iframe)
      await ready
      const w = iframe.contentWindow!
      // Dispatch forged events INSIDE the iframe: neither origin nor source is trusted.
      for (const [origin, source] of [['https://wrong.invalid', window], [location.origin, w]] as const) {
        w.dispatchEvent(new MessageEvent('message', { origin, source, data: { channel: 'maindulu:host', type: 'configure', sessionId: id, core: 'fceumm', game: { id: 'forged' } } }))
      }
      w.postMessage({ channel: 'maindulu:host', type: 'configure', sessionId: 'bad-session', core: 'fceumm', game: { id: 'forged' } }, location.origin)
      const descriptor = { kind: 'rom', catalogId: game.id, sha256: game.sha256, size: game.size, fileName: game.fileName, url: game.url, consoleId: 'nes', label: game.title }
      const file = new File([new Uint8Array(game.size)], game.url.split('/').pop()!)
      const config = { channel: 'maindulu:host', type: 'configure', sessionId: id, core: 'fceumm', consoleId: 'nes',
        game: { ...game, source: 'server' }, preparedRom: { descriptor, file }, preparedBios: undefined as unknown }
      if (mode === 'identity') config.game.sha256 = 'b'.repeat(64)
      if (mode === 'size') config.preparedRom.descriptor.size = 768 * 1048576 + 1
      if (mode === 'namespace') config.preparedRom.descriptor.kind = 'bios'
      if (mode === 'bios') config.preparedBios = { descriptor: { ...descriptor, kind: 'bios' }, file }
      const error = new Promise<void>(resolve => {
        const listener = (event: MessageEvent) => {
          if (event.source === w && event.data?.type === 'error') { window.removeEventListener('message', listener); resolve() }
        }
        window.addEventListener('message', listener)
      })
      w.postMessage(config, location.origin)
      await error
      const loaded = !!w.document.querySelector('script[src*="loader.js"]')
      cleanup(); iframe.remove()
      return { messages, loaded }
    }, { game, mode })
    expect(result.loaded).toBe(false)
    expect(result.messages).toEqual(['ready', 'error'])
  }
})

test('M3 development StrictMode mount/cleanup keeps a live preparation and starts exactly once', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await page.goto(address + '/player/index.html')
  await page.addScriptTag({ content: bundle })
  await page.evaluate(() => window.playerAssetTest.setCache(true))
  await page.addScriptTag({ content: strictBundle })
  const consoles = await (await page.request.get(address + '/catalog/consoles.json')).json()
  const consoleInfo = consoles.find((value: { id: string }) => value.id === 'nes')
  const since = transfers.length
  await page.evaluate(({ game, consoleInfo }) => window.strictPlayerTest.mount({ id: crypto.randomUUID(), game: { ...game, title: game.title!, source: 'server' }, consoleInfo,
    serverRom: { kind: 'rom', catalogId: game.id, sha256: game.sha256, size: game.size, fileName: game.fileName, url: game.url, consoleId: game.consoleId, label: game.title! } }), { game, consoleInfo })
  await startPlayer(page)
  expect(await page.evaluate(() => window.strictPlayerTest.startCount())).toBe(1)
  expect(transfers.slice(since)).toEqual([{ url: game.url, method: 'HEAD', status: 200, bytes: 0 }, { url: game.url, method: 'GET', status: 200, bytes: game.size }])
  await page.evaluate(() => window.strictPlayerTest.unmount())
  await expect(page.locator('iframe')).toHaveCount(0)
  const stats = await page.evaluate(() => window.playerAssetTest.stats())
  expect(stats.stagingCount).toBe(0); expect(stats.reservedBytes).toBe(0)
})

test('M3 transfer with continuing bytes exceeds 90 seconds without the handshake/engine timer firing', async ({ page }) => {
  await open(page)
  await page.clock.install()
  await page.evaluate(url => {
    const original = window.fetch.bind(window)
    window.fetch = async (input, options) => {
      const response = await original(input, options)
      if (String(input) !== new URL(url, location.origin).href || options?.method !== 'GET') return response
      // Small legal fixture only: delay delivery from the real backend response
      // under a virtual clock. No synthetic validator or bytes are substituted.
      const bytes = new Uint8Array(await response.arrayBuffer()), step = Math.ceil(bytes.length / 8)
      let offset = 0
      window.m3SlowChunks = 0
      const body = new ReadableStream<Uint8Array>({ async pull(controller) {
        await new Promise(resolve => setTimeout(resolve, 20000))
        if (options.signal?.aborted) { controller.error(options.signal.reason); return }
        controller.enqueue(bytes.subarray(offset, offset + step)); offset += step
        window.m3SlowChunks!++
        if (offset >= bytes.length) controller.close()
      } })
      return new Response(body, { status: response.status, headers: response.headers })
    }
  }, game.url)
  await select(page)
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  await expect(page.locator('.player-status')).toContainText('Mengunduh ROM')
  await page.waitForFunction(() => window.m3SlowChunks === 0)
  for (let i = 0; i < 8; i++) {
    await page.clock.runFor(20000)
    await expect.poll(() => page.evaluate(() => window.m3SlowChunks)).toBe(i + 1)
  }
  await expect(page.frameLocator('iframe').getByRole('button', { name: 'Mulai bermain', exact: true })).toBeVisible()
  await expect(page.locator('.player-error')).toHaveCount(0)
  await expect(page.locator('.player-asset-notice')).toContainText('Tersimpan di perangkat')
})

for (const mode of ['abort', 'quota'] as const) {
  test(`M4 Player ${mode} writes show not-stored, play real NES with exactly one download`, async ({ page }) => {
    await open(page)
    await page.addScriptTag({ content: settingsBundle })
    await page.evaluate(mode => window.cacheSettingsTest.failNextWrite(mode), mode)
    const since = transfers.length
    const frame = await launch(page)
    expect((await snapshot(frame)).state.length).toBeGreaterThan(1000)
    const notice = page.getByRole('status', { name: 'Status cache ROM/BIOS' })
    await expect(notice).toContainText('Dimainkan tanpa disimpan')
    await expect(notice).toContainText(mode === 'abort' ? 'dibatalkan' : 'penuh')
    await expect(notice).not.toContainText('Tersimpan di perangkat')
    expect(transfers.slice(since).filter(v => v.method === 'GET')).toEqual([{ url: game.url, method: 'GET', status: 200, bytes: game.size }])
    const stats = await page.evaluate(() => window.playerAssetTest.stats())
    expect(stats.count).toBe(0); expect(stats.stagingCount).toBe(0)
  })
}

test('M4 clear via settings in another tab leaves live NES, SRAM, state, account and history intact', async ({ page, context }) => {
  const account = await register(page)
  await open(page)
  const frame = await launch(page)
  await increment(frame, 1)
  await page.getByRole('region', { name: 'Sinkronisasi progres game' }).getByRole('button', { name: 'Sinkronkan progres sekarang' }).click()
  await expect(page.getByRole('region', { name: 'Sinkronisasi progres game' })).toContainText('dikonfirmasi server')
  const overlay = await states(page, frame)
  await overlay.locator('article').filter({ hasText: 'Slot 1' }).getByRole('button', { name: 'Ganti', exact: true }).click()
  await expect(overlay).toContainText('Tersimpan di server')
  await overlay.getByRole('button', { name: 'Tutup dialog', exact: true }).click()
  const db = app.getDecorator<DatabaseSync>('database')
  const savedState = db.prepare('SELECT checksum FROM saves WHERE user_id = ? AND game_id = ?').get(account.user.id, `fceumm-${game.sha256}`)
  const savedProgress = db.prepare('SELECT checksum FROM game_saves WHERE user_id = ? AND game_id = ?').get(account.user.id, `fceumm-${game.sha256}`)
  expect(savedState).toBeTruthy(); expect(savedProgress).toBeTruthy()
  const before = await snapshot(frame)
  const history = await page.evaluate(() => localStorage.getItem('maindulu.history.v1'))
  const otherTab = await context.newPage()
  await otherTab.goto(address + '/pengaturan')
  await expect(otherTab.getByRole('region', { name: 'Cache ROM dan BIOS backend' })).toContainText('1 aset')
  await otherTab.getByRole('button', { name: 'Hapus semua cache', exact: true }).click()
  await otherTab.getByRole('dialog').getByRole('button', { name: 'Ya, hapus cache' }).click()
  await expect(otherTab.getByRole('region', { name: 'Cache ROM dan BIOS backend' })).toContainText('0 B · 0 aset')
  await expect(otherTab.getByRole('button', { name: `Akun ${account.name}`, exact: true })).toBeVisible()
  await otherTab.close()
  await page.bringToFront()
  const after = await snapshot(frame)
  expect(after.progress).toEqual(before.progress)
  expect(after.state.length).toBeGreaterThan(1000)
  expect(after.path).toBe(before.path)
  expect(await page.evaluate(() => localStorage.getItem('maindulu.history.v1'))).toBe(history)
  expect(db.prepare('SELECT checksum FROM saves WHERE user_id = ? AND game_id = ?').get(account.user.id, `fceumm-${game.sha256}`)).toEqual(savedState)
  expect(db.prepare('SELECT checksum FROM game_saves WHERE user_id = ? AND game_id = ?').get(account.user.id, `fceumm-${game.sha256}`)).toEqual(savedProgress)
  await exit(page)
  // Disable through the real UI: subsequent launches use the URL path and do
  // not fill the now-empty cache, while server SRAM still restores normally.
  await page.goto(address + '/pengaturan')
  const toggle = page.getByRole('switch', { name: 'Gunakan cache ROM/BIOS backend' })
  await expect(toggle).toBeChecked(); await toggle.click(); await expect(toggle).not.toBeChecked()
  const next = await launch(page)
  expect((await snapshot(next)).progress[2]).toBe(1)
  await expect(page.locator('.player-asset-notice')).toHaveCount(0)
  await page.addScriptTag({ content: bundle })
  expect((await page.evaluate(() => window.playerAssetTest.stats())).count).toBe(0)
})

test('M4 explicit preparation cancellation leaves no writer and retry creates a new session', async ({ page }) => {
  await open(page)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**' + game.url, async route => {
    if (route.request().method() !== 'GET') return route.continue()
    await held; await route.continue().catch(() => {})
  })
  await select(page)
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  const preparation = page.getByRole('region', { name: 'Persiapan aset ROM/BIOS' })
  await expect(preparation.getByRole('progressbar', { name: 'Progres download ROM' })).toBeVisible()
  await preparation.getByRole('button', { name: 'Batalkan persiapan' }).click()
  await expect(page.locator('iframe')).toHaveCount(0)
  release(); await page.unroute('**' + game.url)
  await expect.poll(async () => (await page.evaluate(() => window.playerAssetTest.stats())).stagingCount).toBe(0)
  await launch(page)
  await expect(page.getByRole('status', { name: 'Status cache ROM/BIOS' })).toContainText('Tersimpan di perangkat')
})

test('M4 real NES cache works without storage estimate/persistence or BroadcastChannel APIs', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'storage', { value: undefined })
    Object.defineProperty(window, 'BroadcastChannel', { value: undefined })
  })
  await open(page)
  await launch(page)
  await expect(page.getByRole('status', { name: 'Status cache ROM/BIOS' })).toContainText('Tersimpan di perangkat')
  await exit(page)
  const since = transfers.length
  await launch(page)
  await expect(page.getByRole('status', { name: 'Status cache ROM/BIOS' })).toContainText('Cache perangkat dipakai')
  expect(transfers.slice(since).filter(v => v.method === 'GET')).toHaveLength(0)
})

test('M4 cache settings unavailable warns visibly but healthy NES still plays via legacy path', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }))
  await open(page, false)
  const frame = await launch(page)
  expect((await snapshot(frame)).state.length).toBeGreaterThan(1000)
  await expect(page.getByRole('status', { name: 'Status cache ROM/BIOS' })).toContainText('tanpa cache perangkat')
})

test('M4 HTTP LAN settings opt-in and real NES miss/hit work without secure-context storage APIs', async ({ page }, info) => {
  const lan = Object.values(networkInterfaces()).flat().find(value => value?.family === 'IPv4' && !value.internal)
  test.skip(!lan, 'Tidak ada interface IPv4 LAN untuk origin non-loopback.')
  const origin = address.replace('127.0.0.1', lan!.address)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await page.goto(origin + '/pengaturan')
  const capabilities = await page.evaluate(() => ({ secure: isSecureContext, subtle: !!crypto.subtle,
    estimate: typeof navigator.storage?.estimate, persist: typeof navigator.storage?.persist }))
  expect(capabilities.secure).toBe(false); expect(capabilities.subtle).toBe(false)
  await expect(page.getByRole('region', { name: 'Cache ROM dan BIOS backend' })).toContainText('Estimasi ruang browser tidak tersedia')
  const toggle = page.getByRole('switch', { name: 'Gunakan cache ROM/BIOS backend' })
  await expect(toggle).toBeEnabled(); await expect(toggle).toBeChecked()
  await toggle.click(); await expect(toggle).not.toBeChecked()
  await toggle.click(); await expect(toggle).toBeChecked()
  async function launchGuest() {
    // The door and account API now require an explicitly configured LAN origin.
    // Entering the shared door still does not create a personal account.
    return launch(page)
  }
  await launchGuest()
  await expect(page.getByRole('status', { name: 'Status cache ROM/BIOS' })).toContainText('Tersimpan di perangkat')
  await exit(page)
  const since = transfers.length
  await launchGuest()
  await expect(page.getByRole('status', { name: 'Status cache ROM/BIOS' })).toContainText('Cache perangkat dipakai')
  expect(transfers.slice(since)).toEqual([{ url: game.url, method: 'HEAD', status: 200, bytes: 0 }])
  await exit(page)
  await page.goto(origin + '/pengaturan')
  await expect(page.getByRole('region', { name: 'Cache ROM dan BIOS backend' })).toContainText('24.02 KiB · 1 aset')
  await info.attach('lan-storage-capabilities.json', { body: JSON.stringify({ origin, ...capabilities }), contentType: 'application/json' })
})
