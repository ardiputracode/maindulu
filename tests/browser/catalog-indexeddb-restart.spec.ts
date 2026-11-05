import { test, expect, chromium } from '@playwright/test'
import type { BrowserContext } from '@playwright/test'
import { readFile, rename, truncate, link, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'
import { createServer, request as httpRequest } from 'node:http'
import { productionFixture, instrument, attachJson, CHUNK } from './helpers/asset-cache-production'
import type { ProductionFixture } from './helpers/asset-cache-production'
import { startPlayer } from './helpers/player'
import { observeAssetTransfers } from './helpers/asset-transfers'

let fixture: ProductionFixture
test.beforeEach(async ({}, info) => {
  test.skip(info.project.name !== 'node-backend', 'M5 membutuhkan backend nyata.')
  fixture = await productionFixture()
})
test.afterEach(async ({}, info) => {
  if (!fixture || info.project.name !== 'node-backend') return
  try { await attachJson(info, 'server-asset-transfers', fixture.transfers) } finally { await fixture.close() }
})

for (const lan of [false, true]) test(`M5 real NES/BIOS survives process restart, HTTP cache off (${lan ? 'HTTP LAN' : 'loopback'})`, async ({}, info) => {
  test.setTimeout(180000)
  const ip = Object.values(networkInterfaces()).flat().find(value => value?.family === 'IPv4' && !value.internal)?.address
  test.skip(lan && !ip, 'Tidak ada interface IPv4 LAN.')
  const origin = lan ? `http://${ip}:${fixture.port}` : fixture.address
  const rom = await readFile('public/games/jalan-pulang.nes')
  expect(rom.length).toBe(24592)
  const game = await fixture.publish(rom.length, 'games', rom), bios = await fixture.publish(512, 'bios')
  let context: BrowserContext | undefined
  const snapshots: unknown[] = []
  async function open() {
    context = await chromium.launchPersistentContext(join(fixture.folder, 'profile'), { channel: info.project.use.channel,
      headless: true, baseURL: origin, serviceWorkers: 'block', viewport: { width: 1440, height: 1000 }, args: ['--enable-unsafe-swiftshader'] })
    const page = context.pages()[0] ?? await context.newPage()
    page.on('dialog', dialog => dialog.accept())
    await instrument(page, fixture, origin)
    if (lan) expect(await page.evaluate(() => ({ secure: isSecureContext, subtle: typeof crypto.subtle,
      locks: typeof navigator.locks, persist: typeof navigator.storage?.persist })))
      .toEqual({ secure: false, subtle: 'undefined', locks: 'undefined', persist: 'undefined' })
    return page
  }
  try {
    let page = await open()
    await page.evaluate(() => window.productionCacheTest.settings()) // Opt-in only on the FIRST process.
    for (const phase of ['cold', 'warm', 'restart', 'idb-deleted']) {
      if (phase === 'restart') { await context!.close(); context = undefined; page = await open() }
      if (phase === 'idb-deleted') {
        await page.evaluate(() => window.productionCacheTest.deleteDatabase())
        await page.evaluate(() => window.productionCacheTest.settings())
      }
      fixture.phase(phase)
      const since = fixture.transfers.length
      await page.goto(origin + '/library')
      await page.getByRole('button', { name: `Mainkan ${game.title}`, exact: true }).click()
      await page.locator('#bios-choice').selectOption(bios.id)
      await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
      const frame = await startPlayer(page)
      const runtime = await frame.locator('body').evaluate(() => {
        const e = (window as unknown as { EJS_emulator: { fileName: string; started: boolean; gameManager: {
          getState: () => Uint8Array; FS: { readdir: (path: string) => string[] } } } }).EJS_emulator
        return { started: e.started, name: e.fileName, stateBytes: e.gameManager.getState().length, files: e.gameManager.FS.readdir('/') }
      })
      expect(runtime.started).toBe(true); expect(runtime.stateBytes).toBeGreaterThan(1000)
      expect(runtime.files).toContain(bios.fileName)
      const cold = phase === 'cold' || phase === 'idb-deleted'
      await expect(page.getByRole('status', { name: 'Status cache ROM/BIOS' })).toContainText(cold ? 'Tersimpan di perangkat' : 'Cache perangkat dipakai')
      for (const entry of [game, bios]) {
        const transfers = fixture.transfers.slice(since).filter(t => t.url === entry.url)
        expect(transfers.filter(t => t.method === 'HEAD').length).toBeGreaterThan(0)
        expect(transfers.filter(t => t.method === 'GET')).toHaveLength(cold ? 1 : 0)
        expect(transfers.reduce((n, t) => n + t.bytes, 0)).toBe(cold ? entry.size : 0)
        expect(transfers.every(t => t.completed && t.status === 200 && t.etag === `"${entry.sha256}"`)).toBe(true)
      }
      await page.addScriptTag({ content: fixture.bundle })
      const stats = await page.evaluate(() => window.productionCacheTest.stats())
      expect(stats).toMatchObject({ count: 2, committedBytes: game.size + bios.size, stagingCount: 0, reservedBytes: 0 })
      snapshots.push({ phase, runtime, stats })
      await page.getByRole('button', { name: 'Kembali', exact: true }).click()
      await expect(page.locator('iframe')).toHaveCount(0)
    }
  } finally {
    await attachJson(info, 'cache-summary', { origin, httpCacheDisabledEveryProcess: true, snapshots })
    await context?.close()
  }
})

test('M5 chunk boundary transport uses committed production chunks and incremental verified reads', async ({ page }, info) => {
  await instrument(page, fixture)
  await page.evaluate(() => window.productionCacheTest.settings())
  const results = []
  for (const size of [CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK + 37]) {
    const entry = await fixture.publish(size)
    for (const phase of ['cold', 'warm']) {
      fixture.phase(`${size}-${phase}`)
      const since = fixture.transfers.length
      const result = await page.evaluate(entry => window.productionCacheTest.run(entry, 'rom'), entry)
      expect(result).toMatchObject({ source: phase === 'cold' ? 'network' : 'indexeddb',
        persistence: phase === 'cold' ? 'stored' : 'reused', size, sha256: entry.sha256 })
      expect(fixture.transfers.slice(since).map(t => t.method)).toEqual(phase === 'cold' ? ['HEAD', 'GET'] : ['HEAD'])
      expect(fixture.transfers.slice(since).reduce((n, t) => n + t.bytes, 0)).toBe(phase === 'cold' ? size : 0)
      results.push({ size, phase, result })
    }
    const metadata = await page.evaluate(() => window.productionCacheTest.stats())
    expect(metadata.entries.find(e => e.catalogId === entry.id)?.chunkCount).toBe(Math.ceil(size / CHUNK))
  }
  await attachJson(info, 'indexeddb-cache-events', results)
})

for (const action of ['clear', 'delete'] as const) test(`M5 two downloading tabs and ${action} fence late commit without resurrection`, async ({ page, context }) => {
  const entry = await fixture.publish(CHUNK + 37)
  await instrument(page, fixture)
  await page.evaluate(() => window.productionCacheTest.settings())
  const other = await context.newPage(); await instrument(other, fixture)
  await page.evaluate(entry => { window.m5Pending = window.productionCacheTest.run(entry, 'rom', 'hold') }, entry)
  await page.waitForFunction(() => window.productionCacheTest.held)
  // The second real resolver downloads once without acquiring a duplicate reservation.
  const second = await other.evaluate(entry => window.productionCacheTest.run(entry, 'rom'), entry)
  expect(second).toMatchObject({ source: 'network', persistence: 'not-stored', sha256: entry.sha256, warnings: [{ code: 'busy' }] })
  const during = await other.evaluate(() => window.productionCacheTest.stats())
  expect(during).toMatchObject({ count: 0, stagingCount: 1, reservedBytes: entry.size, stagingBytes: CHUNK })
  if (action === 'clear') await other.evaluate(() => window.productionCacheTest.clear())
  else await other.evaluate(entry => window.productionCacheTest.remove(entry, 'rom'), entry)
  await page.evaluate(() => window.productionCacheTest.release())
  expect(await page.evaluate(() => window.m5Pending)).toMatchObject({ source: 'network', persistence: 'not-stored', sha256: entry.sha256, warnings: [{ code: 'fenced' }] })
  expect(await other.evaluate(() => window.productionCacheTest.stats())).toMatchObject({ count: 0, stagingCount: 0, reservedBytes: 0 })
  expect(fixture.transfers.filter(t => t.method === 'GET')).toHaveLength(2) // No cross-tab dedup claim.
  expect(fixture.transfers.filter(t => t.method === 'GET').every(t => t.bytes === entry.size)).toBe(true)
})

test('M5 closing a tab inside a real chunk transaction leaves no hit; fenced cleanup and new download recover', async ({ page, context }) => {
  const entry = await fixture.publish(CHUNK + 1)
  await instrument(page, fixture); await page.evaluate(() => window.productionCacheTest.settings())
  const writer = await context.newPage(); await instrument(writer, fixture)
  await writer.evaluate(entry => { window.m5Pending = window.productionCacheTest.run(entry, 'rom', 'hold-transaction') }, entry)
  await writer.waitForFunction(() => window.productionCacheTest.held)
  await writer.close({ runBeforeUnload: false })
  expect((await page.evaluate(() => window.productionCacheTest.stats())).count).toBe(0)
  expect(await page.evaluate(() => window.productionCacheTest.cleanupExpired())).toMatchObject({ count: 0, stagingCount: 0, reservedBytes: 0 })
  expect(await page.evaluate(entry => window.productionCacheTest.run(entry, 'rom'), entry)).toMatchObject({ persistence: 'stored', sha256: entry.sha256 })
})

test('M5 offline and stopped origin cannot bypass cache; recovery reuses the untouched generation', async ({ page, context }) => {
  const entry = await fixture.publish(24593)
  await instrument(page, fixture); await page.evaluate(() => window.productionCacheTest.settings())
  await page.evaluate(entry => window.productionCacheTest.run(entry, 'rom'), entry)
  const before = await page.evaluate(() => window.productionCacheTest.stats())
  await context.setOffline(true)
  expect(await page.evaluate(entry => window.productionCacheTest.run(entry, 'rom'), entry)).toHaveProperty('error')
  await context.setOffline(false)
  // Stop ONLY the disposable server's listener, keeping its DB/app alive. Rebind
  // the identical port so profile origin and IDB identity cannot change.
  await new Promise<void>((resolve, reject) => { fixture.app.server.close(error => error ? reject(error) : resolve()); fixture.app.server.closeAllConnections() })
  try { expect(await page.evaluate(entry => window.productionCacheTest.run(entry, 'rom'), entry)).toHaveProperty('error') }
  finally { await new Promise<void>(resolve => fixture.app.server.listen(fixture.port, '0.0.0.0', resolve)) }
  expect((await page.evaluate(() => window.productionCacheTest.stats())).entries[0].generationId).toBe(before.entries[0].generationId)
  const since = fixture.transfers.length
  expect(await page.evaluate(entry => window.productionCacheTest.run(entry, 'rom'), entry)).toMatchObject({ source: 'indexeddb', persistence: 'reused' })
  expect(fixture.transfers.slice(since).map(t => t.method)).toEqual(['HEAD'])
})

test('M5 actual origin HEAD 503 rejects a cached asset; recovery keeps and reuses its generation', async ({ page }, info) => {
  const entry = await fixture.publish(24593)
  let unavailable = false
  // A disposable same-origin proxy injects an actual HTTP status, not a mocked
  // browser Response. Healthy traffic forwards bytes/validators unchanged.
  const proxy = createServer((incoming, outgoing) => {
    if (unavailable && incoming.url === entry.url && incoming.method === 'HEAD') {
      outgoing.writeHead(503, { 'cache-control': 'no-store' }); outgoing.end(); return
    }
    const upstream = httpRequest(fixture.address + incoming.url, { method: incoming.method, headers: incoming.headers }, response => {
      outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing)
    })
    upstream.on('error', () => { outgoing.writeHead(502); outgoing.end() })
    incoming.pipe(upstream)
  })
  const records = observeAssetTransfers(proxy, new Set([entry.url]), () => unavailable ? '503' : 'healthy')
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const bound = proxy.address()
  if (!bound || typeof bound === 'string') throw Error('Missing proxy address')
  const origin = `http://127.0.0.1:${bound.port}`
  try {
    await instrument(page, fixture, origin); await page.evaluate(() => window.productionCacheTest.settings())
    expect(await page.evaluate(entry => window.productionCacheTest.run(entry, 'rom'), entry)).toMatchObject({ persistence: 'stored' })
    const before = await page.evaluate(() => window.productionCacheTest.stats())
    unavailable = true
    const since = records.length
    expect(await page.evaluate(entry => window.productionCacheTest.run(entry, 'rom'), entry)).toMatchObject({ error: 'http' })
    expect(records.slice(since)).toMatchObject([{ method: 'HEAD', status: 503, bytes: 0 }])
    expect((await page.evaluate(() => window.productionCacheTest.stats())).entries[0].generationId).toBe(before.entries[0].generationId)
    unavailable = false
    const recovery = records.length
    expect(await page.evaluate(entry => window.productionCacheTest.run(entry, 'rom'), entry)).toMatchObject({ source: 'indexeddb', persistence: 'reused' })
    expect(records.slice(recovery).map(r => r.method)).toEqual(['HEAD'])
  } finally {
    await attachJson(info, 'origin-503-transfers', records)
    await new Promise<void>((resolve, reject) => { proxy.close(error => error ? reject(error) : resolve()); proxy.closeAllConnections() })
  }
})

for (const damage of ['missing', 'size', 'unsafe', 'deleted'] as const) test(`M5 cached ROM and BIOS never bypass ${damage} assets at the real origin`, async ({ page }) => {
  await instrument(page, fixture); await page.evaluate(() => window.productionCacheTest.settings())
  for (const kind of ['games', 'bios'] as const) {
    const entry = await fixture.publish(512, kind), assetKind: 'rom' | 'bios' = kind === 'games' ? 'rom' : 'bios'
    expect(await page.evaluate(({ entry, assetKind }) => window.productionCacheTest.run(entry, assetKind), { entry, assetKind })).toMatchObject({ persistence: 'stored' })
    const row = fixture.repo.get(kind, entry.id)!
    const path = await fixture.storage.pathFor(kind, row.storage_key), backup = path + '.m5-backup'
    if (damage === 'deleted') fixture.repo.delete(kind, fixture.actor, entry.id)
    else if (damage === 'missing') await rename(path, backup)
    else if (damage === 'size') await truncate(path, 1)
    else await link(path, backup) // Hard links are unsafe, without symlink/admin privileges.
    const since = fixture.transfers.length
    try {
      const failed = await page.evaluate(({ entry, assetKind }) => window.productionCacheTest.run(entry, assetKind), { entry, assetKind })
      expect(failed).toHaveProperty('error')
      expect(fixture.transfers.slice(since).filter(t => t.method === 'GET')).toHaveLength(0)
      if (damage === 'deleted' || damage === 'missing') expect((await page.evaluate(() => window.productionCacheTest.stats())).entries.some(e => e.catalogId === entry.id)).toBe(false)
    } finally {
      if (damage === 'missing') await rename(backup, path)
      if (damage === 'unsafe') await unlink(backup)
    }
  }
})

test('M5 safe actual Chromium quota probe never advertises an uncommitted cache', async ({ page }, info) => {
  const entry = await fixture.publish(CHUNK + 1)
  const cdp = await instrument(page, fixture)
  await page.evaluate(() => window.productionCacheTest.settings())
  // Browser-enforced origin quota, not disk filling and not a fabricated throw.
  await cdp.send('Storage.overrideQuotaForOrigin', { origin: fixture.address, quotaSize: 1024 * 1024 })
  try {
    const result = await page.evaluate(entry => window.productionCacheTest.run(entry, 'rom', 'quota'), entry)
    expect(result).toMatchObject({ source: 'network', sha256: entry.sha256, transferredBytes: entry.size })
    const metadata = await page.evaluate(() => window.productionCacheTest.stats())
    if ('requestError' in result && result.requestError === 'QuotaExceededError') {
      expect(result).toMatchObject({ persistence: 'not-stored', warnings: [{ code: 'quota' }] })
      expect(metadata).toMatchObject({ count: 0, stagingCount: 0, reservedBytes: 0 })
    } else {
      // Some Chromium versions apply a quota floor/ignore the override. Preserve
      // evidence of that limitation rather than treating it as actual exhaustion.
      expect(result).toMatchObject({ persistence: 'stored' }); expect(metadata.count).toBe(1)
    }
    expect(fixture.transfers.filter(t => t.method === 'GET')).toHaveLength(1)
    await attachJson(info, 'actual-quota-probe', { reproduced: 'requestError' in result && result.requestError === 'QuotaExceededError', result, metadata })
  } finally { await cdp.send('Storage.overrideQuotaForOrigin', { origin: fixture.address }) }
})
