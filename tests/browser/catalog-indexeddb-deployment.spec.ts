import { test, expect } from './helpers/gated-test'
import type { Page } from '@playwright/test'
import { fork, execFile } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { networkInterfaces, tmpdir, release } from 'node:os'
import { createHash } from 'node:crypto'
import { productionFixture, instrument, attachJson } from './helpers/asset-cache-production'
import type { ProductionFixture } from './helpers/asset-cache-production'
import type { AssetTransfer } from './helpers/asset-transfers'
import { startPlayer } from './helpers/player'

type Deployment = Awaited<ReturnType<typeof deploy>>
async function deploy(fixture: ProductionFixture, dist = resolve('dist')) {
  const child = fork('tests/fixtures/asset-cache-deployment.mjs', { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let logs = ''
  child.stdout!.on('data', data => { logs = (logs + data).slice(-12000) })
  child.stderr!.on('data', data => { logs = (logs + data).slice(-12000) })
  function message(type: string): Promise<{ port: number; records: AssetTransfer[] }> {
    return new Promise((resolveMessage, reject) => {
      const timer = setTimeout(() => finish(Error(`Deployment IPC timeout (${type}): ${logs}`)), 30000)
      function receive(value: { type: string; message?: string; port: number; records: AssetTransfer[] }) {
        if (value.type === 'error') finish(Error(value.message))
        else if (value.type === type) { cleanup(); resolveMessage(value) }
      }
      function finish(error: Error) { cleanup(); reject(error) }
      function exit(code: number | null) { finish(Error(`Deployment exited (${code}): ${logs}`)) }
      function cleanup() { clearTimeout(timer); child.off('message', receive); child.off('exit', exit); child.off('error', finish) }
      child.on('message', receive); child.once('exit', exit); child.once('error', finish)
    })
  }
  const ready = message('ready')
  child.send({ env: { MAIN_DULU_DATA_DIR: join(fixture.folder, 'data'), MAIN_DULU_DIST_DIR: dist },
    watched: [...new Set(fixture.transfers.map(t => t.url))], port: fixture.port })
  try { await ready } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited
    }
    throw error
  }
  return {
    pid: child.pid,
    async records() { const pending = message('transfers'); child.send({ type: 'transfers' }); return (await pending).records },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit')
      // This child belongs only to this test. Bound shutdown avoids orphaning a
      // disposable backend if a graceful-close regression occurs.
      const timer = setTimeout(() => child.kill(), 10000)
      try {
        child.send({ type: 'stop' })
        const [code, signal] = await exited
        if (code !== 0 || signal) throw Error(`Deployment shutdown failed (${code}, ${signal}): ${logs}`)
      } finally { clearTimeout(timer) }
    },
  }
}

async function launch(page: Page, fixture: ProductionFixture, game: { title?: string }, bios: { id: string }, origin: string) {
  await page.goto(origin + '/library')
  await page.getByRole('button', { name: `Mainkan ${game.title}`, exact: true }).click()
  await page.locator('#bios-choice').selectOption(bios.id)
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  const frame = await startPlayer(page)
  const runtime = await frame.locator('body').evaluate(() => {
    const e = (window as unknown as { EJS_emulator: { started: boolean; fileName: string; gameManager: { getState: () => Uint8Array } } }).EJS_emulator
    return { started: e.started, name: e.fileName, stateBytes: e.gameManager.getState().length }
  })
  expect(runtime.started).toBe(true); expect(runtime.stateBytes).toBeGreaterThan(1000)
  await page.addScriptTag({ content: fixture.bundle })
  const stats = await page.evaluate(() => window.productionCacheTest.stats())
  return { runtime, stats }
}
async function exitPlayer(page: Page) {
  await page.getByRole('button', { name: 'Kembali', exact: true }).click()
  await expect(page.locator('iframe')).toHaveCount(0)
}
async function verifyBuild(page: Page, origin: string, dist = resolve('dist')) {
  const files = ['/player/asset-helpers.js', '/player/player.js', '/player/builds.json']
  const script = await page.locator('script[type=module][src]').getAttribute('src')
  expect(script).toMatch(/^\/assets\//)
  const hashes: Record<string, string> = {}
  for (const path of [...files, script!]) {
    const response = await page.request.get(origin + path)
    expect(response.status()).toBe(200)
    const bytes = await response.body()
    expect(bytes).toEqual(await readFile(join(dist, path)))
    if (files.includes(path)) expect(bytes).toEqual(await readFile(join('public', path)))
    hashes[path] = createHash('sha256').update(bytes).digest('hex')
  }
  return hashes
}

let fixture: ProductionFixture, deployment: Deployment | undefined
test.beforeEach(async ({}, info) => {
  test.skip(info.project.name !== 'node-backend', 'M6 deployment membutuhkan backend Node nyata.')
  fixture = await productionFixture()
})
test.afterEach(async ({}, info) => {
  if (info.project.name !== 'node-backend') return
  try { await deployment?.close() } finally { deployment = undefined; await fixture?.close() }
})

for (const lan of [false, true]) test(`M6 built frontend and real NES/BIOS survive backend process replacement (${lan ? 'HTTP LAN' : 'loopback'})`, async ({ page }, info) => {
  test.setTimeout(120000)
  const ip = Object.values(networkInterfaces()).flat().find(v => v?.family === 'IPv4' && !v.internal)?.address
  test.skip(lan && !ip, 'Tidak ada IPv4 LAN non-loopback.')
  const origin = lan ? `http://${ip}:${fixture.port}` : fixture.address
  page.on('dialog', dialog => dialog.accept())
  const rom = await readFile('public/games/jalan-pulang.nes')
  const game = await fixture.publish(rom.length, 'games', rom), bios = await fixture.publish(512, 'bios')
  // Register watched URLs, then close the fixture app/SQLite entirely before
  // launching the separate production backend process on its original port.
  await page.request.head(fixture.address + game.url); await page.request.head(fixture.address + bios.url)
  await fixture.app.close()
  deployment = await deploy(fixture)
  const coldPid = deployment.pid
  await instrument(page, fixture, origin)
  await page.goto(origin + '/pengaturan')
  const hashes = await verifyBuild(page, origin)
  const toggle = page.getByRole('switch', { name: 'Gunakan cache ROM/BIOS backend' })
  await expect(toggle).toBeChecked(); await expect(toggle).toBeEnabled()
  const cold = await launch(page, fixture, game, bios, origin)
  await expect(page.getByRole('status', { name: 'Status cache ROM/BIOS' })).toContainText('Tersimpan di perangkat')
  const coldTransfers = await deployment.records()
  for (const entry of [game, bios]) {
    expect(coldTransfers.filter(t => t.url === entry.url).map(t => [t.method, t.status, t.bytes, t.etag, t.cache]))
      .toEqual([['HEAD', 200, 0, `"${entry.sha256}"`, 'private, no-cache'], ['GET', 200, entry.size, `"${entry.sha256}"`, 'private, no-cache']])
  }
  await exitPlayer(page)
  await deployment.close()
  deployment = await deploy(fixture)
  const warmPid = deployment.pid
  expect(warmPid).not.toBe(coldPid)
  const warm = await launch(page, fixture, game, bios, origin)
  await expect(page.getByRole('status', { name: 'Status cache ROM/BIOS' })).toContainText('Cache perangkat dipakai')
  expect(warm.stats.entries.map(e => e.generationId).sort()).toEqual(cold.stats.entries.map(e => e.generationId).sort())
  expect(warm.stats).toMatchObject({ count: 2, committedBytes: rom.length + 512, stagingCount: 0, reservedBytes: 0 })
  const warmTransfers = await deployment.records()
  expect(warmTransfers).toHaveLength(2)
  expect(warmTransfers.every(t => t.method === 'HEAD' && t.bytes === 0 && t.completed && t.status === 200)).toBe(true)
  await exitPlayer(page)
  // A different origin starts with empty bytes and default-on settings. Its
  // explicit opt-out must not change the original origin's preference/bytes.
  const otherOrigin = lan ? fixture.address : `http://127.0.0.2:${fixture.port}`
  await page.goto(otherOrigin + '/pengaturan')
  await expect(toggle).toBeChecked(); await expect(toggle).toBeEnabled()
  await toggle.click(); await expect(toggle).not.toBeChecked()
  await expect(page.getByRole('region', { name: 'Cache ROM dan BIOS backend' })).toContainText('0 B · 0 aset')
  await page.goto(origin + '/pengaturan')
  await expect(toggle).toBeChecked()
  await expect(page.getByRole('region', { name: 'Cache ROM dan BIOS backend' })).toContainText('2 aset')
  await attachJson(info, 'deployment-summary', { os: release(), node: process.version, browser: page.context().browser()?.version(),
    origin, otherOrigin, coldPid, warmPid, httpCacheDisabled: true, hashes, cold, warm, coldTransfers, warmTransfers })
})

test('M6 emergency build bypasses a previously enabled cache, keeps delete UI and restores preferences with the normal build', async ({ page }, info) => {
  test.setTimeout(180000)
  const parent = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir()
  const folder = await mkdtemp(join(parent, 'asset-cache-m6-build-')), dist = join(folder, 'dist')
  try {
    const built = await promisify(execFile)(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', dist],
      { env: { ...process.env, VITE_ASSET_CACHE_DISABLED: 'true' }, timeout: 90000 })
    await info.attach('emergency-build.txt', { body: built.stdout + built.stderr, contentType: 'text/plain' })
    page.on('dialog', dialog => dialog.accept())
    const rom = await readFile('public/games/jalan-pulang.nes')
    const game = await fixture.publish(rom.length, 'games', rom), bios = await fixture.publish(512, 'bios')
    await instrument(page, fixture)
    await page.evaluate(() => window.productionCacheTest.settings())
    const before = await launch(page, fixture, game, bios, fixture.address)
    await exitPlayer(page)
    await fixture.app.close()
    deployment = await deploy(fixture, dist)
    await page.goto(fixture.address + '/pengaturan')
    const hashes = await verifyBuild(page, fixture.address, dist)
    const toggle = page.getByRole('switch', { name: 'Gunakan cache ROM/BIOS backend' })
    await expect(toggle).toBeDisabled(); await expect(toggle).not.toBeChecked()
    await expect(page.getByRole('region', { name: 'Cache ROM dan BIOS backend' })).toContainText('dinonaktifkan oleh build')
    const killed = await launch(page, fixture, game, bios, fixture.address)
    await expect(page.getByRole('status', { name: 'Status cache ROM/BIOS' })).toContainText('dinonaktifkan oleh build')
    expect(killed.stats.entries.map(e => [e.generationId, e.lastUsedAt])).toEqual(before.stats.entries.map(e => [e.generationId, e.lastUsedAt]))
    expect(killed.stats.settings.enabled).toBe(true)
    const transfers = await deployment.records()
    for (const entry of [game, bios]) expect(transfers.filter(t => t.url === entry.url && t.method === 'GET')).toMatchObject([{ status: 200, bytes: entry.size }])
    await exitPlayer(page)
    await page.goto(fixture.address + '/pengaturan')
    await page.getByRole('button', { name: `Hapus cache BIOS ${bios.name}`, exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Ya, hapus cache' }).click()
    await expect(page.getByRole('region', { name: 'Cache ROM dan BIOS backend' })).toContainText('1 aset')
    await deployment.close()
    deployment = await deploy(fixture)
    await page.goto(fixture.address + '/pengaturan')
    await expect(toggle).toBeEnabled(); await expect(toggle).toBeChecked()
    const restored = await launch(page, fixture, game, bios, fixture.address)
    expect(restored.stats.entries.find(e => e.kind === 'rom')?.generationId).toBe(before.stats.entries.find(e => e.kind === 'rom')?.generationId)
    const restoredTransfers = await deployment.records()
    expect(restoredTransfers.filter(t => t.url === game.url).map(t => t.method)).toEqual(['HEAD'])
    expect(restoredTransfers.filter(t => t.url === bios.url).map(t => t.method)).toEqual(['HEAD', 'GET'])
    await exitPlayer(page)
    // A stored opt-out also survives emergency -> normal build replacement.
    await page.goto(fixture.address + '/pengaturan')
    await toggle.click(); await expect(toggle).not.toBeChecked()
    await deployment.close(); deployment = await deploy(fixture, dist)
    await page.goto(fixture.address + '/pengaturan'); await expect(toggle).toBeDisabled()
    await deployment.close(); deployment = await deploy(fixture)
    await page.goto(fixture.address + '/pengaturan'); await expect(toggle).toBeEnabled(); await expect(toggle).not.toBeChecked()
    await attachJson(info, 'rollback-summary', { hashes, before, killed, restored, transfers, restoredTransfers, optOutPreserved: true })
  } finally {
    await deployment?.close(); deployment = undefined
    await rm(folder, { recursive: true, force: true }) // Only this test's generated build.
  }
})
