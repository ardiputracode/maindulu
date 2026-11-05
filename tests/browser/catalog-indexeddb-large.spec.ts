import { test, expect, chromium } from '@playwright/test'
import type { BrowserContext, CDPSession } from '@playwright/test'
import { join } from 'node:path'
import { networkInterfaces, freemem } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { productionFixture, instrument, preflight, attachJson, CHUNK } from './helpers/asset-cache-production'

const exec = promisify(execFile)

// This is transport/storage + native input, NOT playable CHD/PS1. No proprietary
// ROMs and no hundreds-of-MiB buffers/fixtures committed to the repository.
for (const size of [329641708, 524288000]) test(`M5 production resolver ${size} bytes persists on HTTP LAN after browser process restart`, async ({}, info) => {
  const ip = Object.values(networkInterfaces()).flat().find(value => value?.family === 'IPv4' && !value.internal)?.address
  expect(ip, 'Large LAN proof requires a real non-loopback IPv4 interface').toBeTruthy()
  const fixture = await productionFixture()
  let context: BrowserContext | undefined, cdp: CDPSession | undefined
  let sampling = false, sampler: ReturnType<typeof setInterval> | undefined
  let lastSample = Promise.resolve()
  const results: unknown[] = [], resources: unknown[] = [], errors: string[] = []
  const origin = `http://${ip}:${fixture.port}`, profile = join(fixture.folder, 'profile')
  let phase = 'preflight'
  async function sample() {
    if (sampling) return
    sampling = true
    const sampledPhase = phase
    try {
      const metrics = await cdp?.send('Performance.getMetrics').catch(() => undefined)
      let browserMemory: unknown = null
      if (process.platform === 'win32') {
        // Sum only this isolated profile's browser tree. Working sets may share
        // pages; neither this nor JS heap is an exact total physical-RAM peak.
        const escaped = profile.replaceAll("'", "''")
        const script = `$all = @(Get-CimInstance Win32_Process -Filter "name = 'msedge.exe'"); $ids = @($all | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${escaped}') } | ForEach-Object ProcessId); do { $before = $ids.Count; $ids = @($ids + @($all | Where-Object { $_.ParentProcessId -in $ids } | ForEach-Object ProcessId) | Sort-Object -Unique) } while ($ids.Count -gt $before); if ($ids.Count) { @(Get-Process -Id $ids -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PrivateMemorySize64) | ConvertTo-Json -Compress }`
        try { browserMemory = JSON.parse((await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000 })).stdout || 'null') }
        catch (error) { browserMemory = { unavailable: String(error) } }
      }
      resources.push({ at: new Date().toISOString(), phase: sampledPhase, systemAvailableBytes: freemem(), node: process.memoryUsage(),
        pageMetrics: metrics?.metrics.filter(m => /JSHeap|TaskDuration/.test(m.name)), browserProcessMemory: browserMemory })
    } finally { sampling = false }
  }
  async function open() {
    context = await chromium.launchPersistentContext(profile, { channel: info.project.use.channel, headless: true,
      serviceWorkers: 'block', viewport: { width: 1200, height: 900 } })
    const page = context.pages()[0] ?? await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    cdp = await instrument(page, fixture, origin)
    return page
  }
  try {
    const capacity = await preflight(fixture.folder)
    await attachJson(info, 'preflight', { ...capacity, sizeBytes: size, sizeMiB: size / 1024 ** 2,
      limits: { freeDiskGiB: 6, availableRamGiB: 2, workers: 1, retries: 0, timeoutMinutes: 10 } })
    const entry = await fixture.publish(size)
    let page = await open()
    const environment = await page.evaluate(() => ({ userAgent: navigator.userAgent, secure: isSecureContext,
      subtle: typeof crypto.subtle, locks: typeof navigator.locks, estimate: typeof navigator.storage?.estimate, persist: typeof navigator.storage?.persist }))
    expect(environment).toMatchObject({ secure: false, subtle: 'undefined', locks: 'undefined', estimate: 'undefined', persist: 'undefined' })
    await attachJson(info, 'environment', { origin, ...environment, synthetic: true, gameplay: false })
    await page.evaluate(() => window.productionCacheTest.settings())
    sampler = setInterval(() => { if (!sampling) lastSample = sample().catch(error => { errors.push(`Resource sampler: ${error}`) }) }, 3000)
    for (phase of ['cold', 'warm', 'restart', 'idb-deleted']) {
      if (phase === 'restart') { await context!.close(); context = undefined; cdp = undefined; page = await open() }
      if (phase === 'idb-deleted') {
        await page.evaluate(() => window.productionCacheTest.deleteDatabase())
        await page.evaluate(() => window.productionCacheTest.settings())
      }
      fixture.phase(phase)
      const since = fixture.transfers.length
      await sample()
      const result = await page.evaluate(({ entry, nativeRead }) => window.productionCacheTest.run(entry, 'rom', 'normal', nativeRead), { entry, nativeRead: phase === 'restart' })
      results.push({ phase, result })
      await sample()
      const cold = phase === 'cold' || phase === 'idb-deleted'
      expect(result).toMatchObject({ source: cold ? 'network' : 'indexeddb', persistence: cold ? 'stored' : 'reused',
        sha256: entry.sha256, size, transferredBytes: cold ? size : 0, warnings: [] })
      if (phase === 'restart') expect(result).toHaveProperty('native', { size, name: entry.fileName })
      const records = fixture.transfers.slice(since)
      expect(records.map(t => t.method)).toEqual(cold ? ['HEAD', 'GET'] : ['HEAD'])
      expect(records.reduce((n, t) => n + t.bytes, 0)).toBe(cold ? size : 0)
      expect(records.every(t => t.completed && t.status === 200 && t.etag === `"${entry.sha256}"` && t.cache === 'private, no-cache')).toBe(true)
      const stats = await page.evaluate(() => window.productionCacheTest.stats())
      expect(stats).toMatchObject({ count: 1, committedBytes: size, stagingCount: 0, reservedBytes: 0 })
      expect(stats.entries[0]).toMatchObject({ sha256: entry.sha256, size, chunkCount: Math.ceil(size / CHUNK) })
      results.push({ phase, metadata: stats })
    }
    expect(errors).toEqual([])
  } finally {
    if (sampler) clearInterval(sampler)
    await lastSample
    // All artifacts are copied into Playwright output BEFORE disposable fixtures
    // and profiles are removed, including when an assertion/transfer fails.
    try {
      await attachJson(info, 'server-asset-transfers', fixture.transfers)
      await attachJson(info, 'indexeddb-cache-events', results)
      await attachJson(info, 'cache-summary', { sizeBytes: size, sizeMiB: size / 1024 ** 2, origin,
        httpCacheDisabledEveryProcess: true, resources, errors, browserMemoryIsSampledNotExactPeak: true })
    } finally { await context?.close(); await fixture.close() }
  }
})

test('M5 500 MiB mid-stream quota fallback remains readable with one origin download and no false entry', async ({ browser }, info) => {
  const fixture = await productionFixture()
  const context = await browser.newContext({ serviceWorkers: 'block' })
  try {
    await attachJson(info, 'preflight', await preflight(fixture.folder))
    const entry = await fixture.publish(524288000)
    const page = await context.newPage()
    await instrument(page, fixture)
    await page.evaluate(() => window.productionCacheTest.settings())
    const result = await page.evaluate(entry => window.productionCacheTest.run(entry, 'rom', 'quota-fault', true), entry)
    await attachJson(info, 'indexeddb-cache-events', result)
    const metadata = await page.evaluate(() => window.productionCacheTest.stats())
    await attachJson(info, 'cache-summary', { sizeBytes: entry.size, metadata, synthetic: true, gameplay: false, httpCacheDisabled: true })
    expect(result).toMatchObject({ source: 'network', persistence: 'not-stored', size: entry.size, sha256: entry.sha256,
      transferredBytes: entry.size, warnings: [{ code: 'quota' }], native: { size: entry.size, name: entry.fileName } })
    expect(metadata).toMatchObject({ count: 0, stagingCount: 0, reservedBytes: 0 })
    expect(fixture.transfers.map(t => t.method)).toEqual(['HEAD', 'GET'])
    expect(fixture.transfers.reduce((n, t) => n + t.bytes, 0)).toBe(entry.size)
  } finally {
    try { await attachJson(info, 'server-asset-transfers', fixture.transfers) }
    finally { await context.close(); await fixture.close() }
  }
})
