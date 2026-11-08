import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, networkInterfaces } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { DatabaseSync } from 'node:sqlite'
import type { Page } from '@playwright/test'
import { createApp } from '../../server/app.mjs'
import { createCatalogStorage } from '../../server/catalog/storage.mjs'
import { createCatalogRepository } from '../../server/catalog/repository.mjs'
import { catalogDto } from '../../server/catalog/queries.mjs'
import type { CatalogEntry } from '../../src/lib/catalog'
import type * as Harness from '../fixtures/server-assets'

declare global { interface Window { serverAssetTest: typeof Harness } }
type Transfer = { url: string; method: string; status: number; bytes: number }
let bundle: string, folder: string, address: string, app: Awaited<ReturnType<typeof createApp>>
let repo: ReturnType<typeof createCatalogRepository>, actor: string
let game: CatalogEntry, bios: CatalogEntry
const transfers: Transfer[] = []
const rom = Buffer.alloc(4 * 1024 * 1024 + 37, 0x39), firmware = Buffer.alloc(512, 0xa9)

test.beforeEach(({}, info) => test.skip(info.project.name !== 'node-backend', 'Resolver M2 membutuhkan backend nyata.'))
test.beforeAll(async ({}, info) => {
  if (info.project.name !== 'node-backend') return
  bundle = (await build({ entryPoints: ['tests/fixtures/server-assets.ts'], bundle: true, write: false,
    format: 'iife', globalName: 'serverAssetTest', target: 'es2022', platform: 'browser' })).outputFiles[0].text
  const parent = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir()
  folder = await mkdtemp(join(parent, 'server-assets-m2-'))
  app = await createApp({ env: { MAIN_DULU_DATA_DIR: join(folder, 'data') } })
  const db = app.getDecorator<DatabaseSync>('database')
  actor = randomUUID()
  db.prepare('INSERT INTO users (id, username, password_hash, recovery_code_hash, created_at, role) VALUES (?, ?, ?, ?, ?, ?)').run(actor, 'm2_admin', 'test-only', 'test-only', Date.now(), 'admin')
  const storage = await createCatalogStorage(app.getDecorator('appConfig'))
  repo = createCatalogRepository(db, storage)
  game = catalogDto('games', await repo.publish('games', actor, { title: 'M2 synthetic ROM', consoleId: 'nes', fileName: 'test game.nes' }, await storage.stage('games', Readable.from([rom]))))
  bios = catalogDto('bios', await repo.publish('bios', actor, { name: 'M2 synthetic BIOS', consoleId: 'nes', fileName: 'firmware.bin' }, await storage.stage('bios', Readable.from([firmware]))))
  // Count actual outgoing body bytes. CDP disables HTTP cache ONLY in this new
  // suite, never in the historical HTTP-cache tests. No asset request routing.
  app.server.prependListener('request', (request, response) => {
    if (![game.url, bios.url].includes(request.url!)) return
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
  if (!bound || typeof bound === 'string') throw new Error('Missing server port')
  address = `http://127.0.0.1:${bound.port}`
})
test.afterAll(async () => {
  await app?.close()
  if (folder) await rm(folder, { recursive: true, force: true }) // Only this suite's disposable fixture.
})

async function harness(page: Page, origin = address) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  // Load a real document from this origin: fulfilling a synthetic LAN document
  // loses its browser address-space classification and triggers a false PNA block.
  await page.goto(origin + '/')
  await page.addScriptTag({ content: bundle })
}

test('real backend miss/hit for ROM and BIOS, committed hashes and no GET on hit with HTTP cache disabled', async ({ page }, info) => {
  await harness(page)
  const since = transfers.length
  for (const [entry, kind] of [[game, 'rom'], [bios, 'bios']] as const) {
    const cold = await page.evaluate(({ entry, kind }) => window.serverAssetTest.run(entry, kind), { entry, kind })
    expect(cold).toMatchObject({ source: 'network', persistence: 'stored', size: entry.size, sha256: entry.sha256, transferredBytes: entry.size, warnings: [] })
    expect(cold.phases).toContain('saving')
    const coldTransfers = transfers.slice(since).filter(value => value.url === entry.url)
    expect(coldTransfers.filter(value => value.method === 'HEAD')).toHaveLength(1)
    expect(coldTransfers.filter(value => value.method === 'GET')).toEqual([{ url: entry.url, method: 'GET', status: 200, bytes: entry.size }])
    const beforeHit = transfers.length
    const warm = await page.evaluate(({ entry, kind }) => window.serverAssetTest.run(entry, kind), { entry, kind })
    expect(warm).toMatchObject({ source: 'indexeddb', persistence: 'reused', size: entry.size, sha256: entry.sha256, transferredBytes: 0 })
    expect(transfers.slice(beforeHit)).toEqual([{ url: entry.url, method: 'HEAD', status: 200, bytes: 0 }])
  }
  const metadata = await page.evaluate(() => window.serverAssetTest.stats())
  expect(metadata.count).toBe(2); expect(metadata.stagingCount).toBe(0)
  expect(metadata.committedBytes).toBe(rom.length + firmware.length)
  expect(game.sha256).toBe(createHash('sha256').update(rom).digest('hex'))
  await info.attach('server-asset-transfers.json', { body: JSON.stringify(transfers.slice(since), null, 2), contentType: 'application/json' })
})

test('corrupt real IndexedDB generation is invalidated and replaced with exactly one download', async ({ page }) => {
  await harness(page)
  await page.evaluate(entry => window.serverAssetTest.run(entry, 'rom'), game)
  await page.evaluate(entry => window.serverAssetTest.corrupt(entry, 'rom'), game)
  const since = transfers.length
  const recovered = await page.evaluate(entry => window.serverAssetTest.run(entry, 'rom'), game)
  expect(recovered).toMatchObject({ source: 'network', persistence: 'stored', sha256: game.sha256 })
  expect(recovered.warnings.map(value => value.code)).toEqual(['corrupt'])
  expect(transfers.slice(since).map(value => value.method)).toEqual(['HEAD', 'GET'])
  const metadata = await page.evaluate(() => window.serverAssetTest.stats())
  expect(metadata.count).toBe(1); expect(metadata.stagingCount).toBe(0)
})

test('quota fault in the second real chunk transaction preserves one download without a committed manifest', async ({ page }) => {
  await harness(page)
  const since = transfers.length
  const result = await page.evaluate(entry => window.serverAssetTest.run(entry, 'rom', 'quota'), game)
  expect(result).toMatchObject({ persistence: 'not-stored', source: 'network', sha256: game.sha256, appendAttempts: 2 })
  expect(result.warnings.map(value => value.code)).toEqual(['quota'])
  expect(transfers.slice(since)).toEqual([{ url: game.url, method: 'HEAD', status: 200, bytes: 0 }, { url: game.url, method: 'GET', status: 200, bytes: game.size }])
  const metadata = await page.evaluate(() => window.serverAssetTest.stats())
  expect(metadata.count).toBe(0); expect(metadata.stagingCount).toBe(0); expect(metadata.reservedBytes).toBe(0)
})

test('same-size wrong download hash aborts an already-staged real chunk and never publishes', async ({ page }) => {
  await harness(page)
  const since = transfers.length
  expect(await page.evaluate(entry => window.serverAssetTest.failure(entry, 'rom', 'bad-download'), game)).toBe('integrity')
  expect(transfers.slice(since).map(value => value.method)).toEqual(['HEAD', 'GET'])
  const metadata = await page.evaluate(() => window.serverAssetTest.stats())
  expect(metadata.count).toBe(0); expect(metadata.stagingCount).toBe(0); expect(metadata.reservedBytes).toBe(0)
})

test('budget, unavailable storage and toggle off retain verified network-only fallback; stored opt-out stays off', async ({ page }) => {
  await harness(page)
  for (const mode of ['stored-disabled', 'budget', 'unavailable', 'disabled'] as const) {
    const since = transfers.length
    const result = await page.evaluate(({ entry, mode }) => window.serverAssetTest.run(entry, 'rom', mode), { entry: game, mode })
    expect(result).toMatchObject({ persistence: 'not-stored', sha256: game.sha256 })
    expect(result.warnings).toHaveLength(1)
    expect(transfers.slice(since).map(value => value.method)).toEqual(['HEAD', 'GET'])
    expect((await page.evaluate(() => window.serverAssetTest.stats())).count).toBe(0)
  }
})

test('server 503 never bypasses a hit or deletes it; metadata deletion invalidates the cached asset', async ({ page }) => {
  await harness(page)
  await page.evaluate(entry => window.serverAssetTest.run(entry, 'bios'), bios)
  expect(await page.evaluate(entry => window.serverAssetTest.failure(entry, 'bios', 'server-error'), bios)).toBe('http')
  expect((await page.evaluate(() => window.serverAssetTest.stats())).count).toBe(1)
  expect((await page.evaluate(entry => window.serverAssetTest.run(entry, 'bios'), bios)).source).toBe('indexeddb')
  repo.delete('bios', actor, bios.id)
  const since = transfers.length
  expect(await page.evaluate(entry => window.serverAssetTest.failure(entry, 'bios'), bios)).toBe('unavailable')
  expect((await page.evaluate(() => window.serverAssetTest.stats())).count).toBe(0)
  expect(transfers.slice(since)).toEqual([])
})

test('real non-loopback HTTP LAN uses portable hashing and real IndexedDB without secure-context APIs', async ({ page }, info) => {
  const lan = Object.values(networkInterfaces()).flat().find(value => value?.family === 'IPv4' && !value.internal)
  test.skip(!lan, 'Tidak ada interface IPv4 LAN untuk origin non-loopback.')
  const origin = new URL(address); origin.hostname = lan!.address
  await harness(page, origin.origin)
  expect(await page.evaluate(() => ({ secure: isSecureContext, subtle: typeof crypto.subtle, locks: typeof navigator.locks, estimate: typeof navigator.storage?.estimate })))
    .toEqual({ secure: false, subtle: 'undefined', locks: 'undefined', estimate: 'undefined' })
  const cold = await page.evaluate(entry => window.serverAssetTest.run(entry, 'rom'), game)
  expect(cold).toMatchObject({ persistence: 'stored', sha256: game.sha256 })
  const since = transfers.length
  const warm = await page.evaluate(entry => window.serverAssetTest.run(entry, 'rom'), game)
  expect(warm).toMatchObject({ source: 'indexeddb', persistence: 'reused', transferredBytes: 0, sha256: game.sha256 })
  expect(transfers.slice(since)).toEqual([{ url: game.url, method: 'HEAD', status: 200, bytes: 0 }])
  await info.attach('lan-origin.json', { body: JSON.stringify({ origin: origin.origin, size: game.size, sha256: game.sha256 }), contentType: 'application/json' })
})
