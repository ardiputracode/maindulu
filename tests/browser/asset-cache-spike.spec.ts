import { test, expect, chromium } from '@playwright/test'
import type { BrowserContext, FrameLocator, Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { networkInterfaces, tmpdir } from 'node:os'
import { startSpikeServer, ROM_URL, BIOS_URL, ZIP_URL, BIOS_ZIP_URL, CHUNK_SIZE, syntheticHash } from './helpers/asset-cache-spike'
import { saveIdentity } from '../../src/lib/domain'
import { compatibleState } from '../../src/lib/saves'
import type { StateMetadata } from '../../src/lib/saves'

type Engine = {
  started: boolean; fileName: string; config: { gameName: string }; pause: () => void; play: () => void;
  getBaseFileName: () => string;
  gameManager: {
    getState: () => Uint8Array; loadState: (bytes: Uint8Array) => void; getSaveFile: () => Uint8Array | null;
    getSaveFilePath: () => string; simulateInput: (player: number, index: number, value: number) => void;
    FS: { readdir: (path: string) => string[]; readFile: (path: string) => Uint8Array };
  };
}
type Runtime = Window & { EJS_emulator: Engine; spikeMetadata: StateMetadata; spikeBeforeBootPath: string; spikeStarted: boolean }
type Snapshot = { progress: number[]; state: number[]; metadata: StateMetadata; fileName: string; savePath: string; stateKey: string; gameName: string; files: string[] }
let server: Awaited<ReturnType<typeof startSpikeServer>>
test.beforeAll(async () => { server = await startSpikeServer() })
test.afterAll(async () => { await server?.close() })

async function launch(page: Page, mode: 'url' | 'prepared', url = ROM_URL, biosUrl = BIOS_URL, initial?: Snapshot) {
  await page.goto(server.address + '/spike/host')
  await page.waitForFunction(() => (window as unknown as { spikeMessages: { type: string }[] }).spikeMessages.some(value => value.type === 'spike-frame-ready'))
  const saveId = saveIdentity({ id: 'catalog-m0', sha256: server.assetHash(url) }, 'fceumm')
  await page.evaluate(async config => {
    const path = '/spike/tools.js'
    const tools = await import(path) as typeof import('../../src/lib/engine-assets')
    let rom: File | undefined, bios: Blob | undefined
    if (config.mode === 'prepared') {
      const read = async (url: string) => {
        const head = await fetch(url, { method: 'HEAD', cache: 'no-store' })
        if (!head.ok) throw new Error('M0 fresh HEAD failed')
        return (await fetch(url, { cache: 'no-store' })).blob()
      }
      rom = tools.preparedRomFile(await read(config.url), config.url)
      bios = await tools.preparedBiosBlob(await read(config.biosUrl), config.biosUrl)
    }
    document.querySelector('iframe')!.contentWindow!.postMessage({ type: 'spike-configure', config: { ...config, rom, bios } }, location.origin)
  }, { mode, url, biosUrl, saveId, initial })
  const frame = page.frameLocator('iframe')
  const start = frame.getByRole('button', { name: 'Mulai bermain', exact: true })
  await expect(start).toBeVisible()
  // No implicit start while the File is prepared/cloned and the loader boots.
  expect(await frame.locator('body').evaluate(() => !!(window as unknown as Runtime).spikeStarted)).toBe(false)
  await start.click()
  await expect(frame.locator('canvas')).toBeVisible({ timeout: 60000 })
  await expect.poll(() => frame.locator('body').evaluate(() => !!(window as unknown as Runtime).spikeStarted)).toBe(true)
  return frame
}
async function snapshot(frame: FrameLocator): Promise<Snapshot> {
  return frame.locator('body').evaluate(() => {
    const w = window as unknown as Runtime, e = w.EJS_emulator
    return {
      progress: Array.from(e.gameManager.getSaveFile() ?? []), state: Array.from(e.gameManager.getState()),
      metadata: w.spikeMetadata, fileName: e.fileName, savePath: e.gameManager.getSaveFilePath(),
      stateKey: e.getBaseFileName() + '.state', gameName: e.config.gameName, files: e.gameManager.FS.readdir('/'),
    }
  })
}
async function count(frame: FrameLocator) {
  return frame.locator('body').evaluate(() => (window as unknown as Runtime).EJS_emulator.gameManager.getSaveFile()?.[2])
}
async function increment(frame: FrameLocator, value: number) {
  await frame.locator('body').evaluate(() => (window as unknown as Runtime).EJS_emulator.gameManager.simulateInput(0, 8, 1))
  try { await expect.poll(() => count(frame)).toBe(value) }
  finally { await frame.locator('body').evaluate(() => (window as unknown as Runtime).EJS_emulator.gameManager.simulateInput(0, 8, 0)) }
  // Let the fixture's controller latch observe release before another press.
  await expect.poll(() => frame.locator('body').evaluate(() => {
    const state = (window as unknown as Runtime).EJS_emulator.gameManager.getState()
    const tag = new TextEncoder().encode('RAM\0')
    for (let index = 0; index < state.length - 8; index++) if (tag.every((value, n) => state[index + n] === value)) return state[index + 8]
    return -1
  })).toBe(0)
}

test('M0: native File preserves URL-era SRAM, state, names and build without an engine patch', async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const baselinePage = await page.context().newPage()
  baselinePage.on('pageerror', error => errors.push(error.message))
  const baseline = await launch(baselinePage, 'url')
  await increment(baseline, 1)
  const old = await snapshot(baseline)
  expect(old.fileName).toBe('battery%20test.nes')
  expect(old.savePath).toBe('/data/saves/FCEUmm/battery%20test.srm')
  expect(old.files).toContain('firmware%20test.bin')
  expect(old.progress[2]).toBe(1)
  expect(old.state.length).toBeGreaterThan(1000)
  expect(errors).toEqual([])
  // Each boot owns a separate page. Closing without beforeunload avoids the
  // unchanged engine's exit/unmount handler for its account MEMFS-only mode;
  // this spike tests data compatibility, not application exit orchestration.
  await baselinePage.close({ runBeforeUnload: false })
  const since = server.transfers.length
  const prepared = await launch(page, 'prepared', ROM_URL, BIOS_URL, old)
  await expect.poll(() => count(prepared)).toBe(1)
  const current = await snapshot(prepared)
  expect(compatibleState(old.metadata, current.metadata)).toBe(true)
  for (const field of ['fileName', 'savePath', 'stateKey', 'gameName'] as const) expect(current[field]).toBe(old[field])
  expect(current.files).toContain('firmware%20test.bin')
  const clone = await prepared.locator('body').evaluate(() => (window as unknown as { spikeClone: unknown }).spikeClone)
  expect(clone).toEqual({ isFile: true, name: 'battery%20test.nes', size: server.rom.length })
  await increment(prepared, 2)
  await prepared.locator('body').evaluate((_element, state) => {
    const e = (window as unknown as Runtime).EJS_emulator
    e.pause(); e.gameManager.loadState(new Uint8Array(state)); e.play()
  }, old.state)
  await expect.poll(() => count(prepared)).toBe(1)
  await increment(prepared, 2)
  for (const url of [ROM_URL, BIOS_URL]) {
    const gets = server.transfers.slice(since).filter(value => value.url === url && value.method === 'GET')
    expect(gets).toHaveLength(1) // Host preparation only; native engine does not refetch the URL.
    expect(gets[0].bytes).toBe(url === ROM_URL ? server.rom.length : 512)
  }
  expect(errors).toEqual([])
  await info.attach('url-to-native-file-compatibility', { body: JSON.stringify({ old: { ...old, progress: old.progress.slice(0, 8), state: old.state.length }, current: { ...current, progress: current.progress.slice(0, 8), state: current.state.length }, clone, transfers: server.transfers.slice(since) }, null, 2), contentType: 'application/json' })
})

test('M0: demo and ZIP ROM/BIOS remain playable through native inputs and preserve extracted names', async ({ page }, info) => {
  const results = []
  const errors: string[] = []
  async function run(mode: 'url' | 'prepared', url: string, biosUrl: string) {
    const boot = await page.context().newPage()
    boot.on('pageerror', error => errors.push(error.message))
    try { return await snapshot(await launch(boot, mode, url, biosUrl)) }
    finally { await boot.close({ runBeforeUnload: false }) }
  }
  for (const [url, biosUrl, expectedName] of [['/spike/assets/demo.nes', BIOS_URL, 'demo.nes'], [ZIP_URL, BIOS_ZIP_URL, 'inside-game.nes']]) {
    const baseline = await run('url', url, biosUrl)
    const since = server.transfers.length
    const prepared = await run('prepared', url, biosUrl)
    expect(prepared.fileName).toBe(expectedName)
    expect(prepared.fileName).toBe(baseline.fileName)
    expect(prepared.savePath).toBe(baseline.savePath)
    expect(prepared.stateKey).toBe(baseline.stateKey)
    expect(prepared.metadata).toEqual(baseline.metadata)
    expect(prepared.files).toContain('firmware%20test.bin')
    expect(prepared.state.length).toBeGreaterThan(1000)
    expect(server.transfers.slice(since).filter(value => value.url === url && value.method === 'GET')).toHaveLength(1)
    results.push({ url, fileName: prepared.fileName, savePath: prepared.savePath, metadata: prepared.metadata })
  }
  expect(errors).toEqual([])
  await info.attach('native-input-names', { body: JSON.stringify(results, null, 2), contentType: 'application/json' })
})

test('M0: 4 MiB chunks persist across browser restart on HTTP LAN; native File reads a synthetic 500 MiB asset', async ({}, info) => {
  const address = Object.values(networkInterfaces()).flat().find(value => value?.family === 'IPv4' && !value.internal)?.address
  test.skip(!address, 'Requires a real non-loopback IPv4 interface, not a pretend insecure localhost.')
  const origin = `http://${address}:${server.port}`
  const parent = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir()
  const folder = await mkdtemp(join(parent, 'asset-cache-m0-'))
  let context: BrowserContext | undefined
  const evidence: Record<string, unknown> = { origin, chunkSize: CHUNK_SIZE, synthetic: true, gameplay: false, sizes: [] }
  const memory: unknown[] = []
  async function open() {
    context = await chromium.launchPersistentContext(join(folder, 'profile'), { channel: info.project.use.channel, headless: true, serviceWorkers: 'block', viewport: { width: 1200, height: 900 } })
    const page = context.pages()[0] ?? await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
    await page.goto(origin + '/spike/blank')
    return { page, cdp }
  }
  try {
    let { page, cdp } = await open()
    expect(await page.evaluate(() => ({ secure: isSecureContext, subtle: typeof crypto.subtle, random: typeof crypto.getRandomValues }))).toEqual({ secure: false, subtle: 'undefined', random: 'function' })
    evidence.environment = await page.evaluate(async () => ({ userAgent: navigator.userAgent, secure: isSecureContext, locks: typeof navigator.locks, persist: typeof navigator.storage?.persist, estimate: typeof navigator.storage?.estimate === 'function' ? await navigator.storage.estimate() : null }))
    const records: Record<string, unknown>[] = []
    // Boundary cases as well as the explicit large-file target; one profile.
    for (const size of [CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, 500 * 1024 * 1024]) {
      const url = `/spike/large/${size}.chd`, checksum = syntheticHash(size)
      const result = await page.evaluate(async ({ url, size, checksum }) => {
        const path = '/spike/tools.js'
        const tools = await import(path) as typeof import('../fixtures/asset-cache-chunks')
        return tools.writeChunkSpike(url, size, checksum)
      }, { url, size, checksum })
      expect(result.size).toBe(size)
      expect(result.checksum).toBe(checksum)
      expect(result.chunks).toBe(Math.ceil(size / CHUNK_SIZE))
      if (size > 32 * 1024 * 1024) expect(result.heartbeat).toBeGreaterThan(0)
      records.push({ url, size, checksum, write: result })
    }
    evidence.sizes = records
    memory.push({ phase: 'after-write', ...await cdp.send('Runtime.getHeapUsage') })
    await context!.close(); context = undefined
    const since = server.transfers.length
    ;({ page, cdp } = await open())
    for (const record of records) {
      const result = await page.evaluate(async ({ url, checksum }) => {
        const path = '/spike/tools.js'
        const tools = await import(path) as typeof import('../fixtures/asset-cache-chunks') & typeof import('../../src/lib/engine-assets')
        const { blob, summary } = await tools.readChunkSpike(url as string, checksum as string)
        ;(window as unknown as { spikeFile: File }).spikeFile = tools.preparedRomFile(blob, url as string)
        return summary
      }, record)
      expect(result.size).toBe(record.size)
      expect(result.checksum).toBe(record.checksum)
      record.readAfterRestart = result
    }
    expect(server.transfers.slice(since).filter(value => value.url.startsWith('/spike/large/'))).toEqual([])
    memory.push({ phase: 'after-read-500MiB', ...await cdp.send('Runtime.getHeapUsage') })
    // Structured-clone the assembled File to another realm, just as Player will.
    await page.evaluate(async () => {
      const iframe = document.createElement('iframe')
      iframe.src = '/spike/blank'; document.body.appendChild(iframe)
      await new Promise<void>(resolve => { iframe.onload = () => resolve() })
    })
    const child = page.frames().find(frame => frame !== page.mainFrame())!
    await child.evaluate(() => {
      window.addEventListener('message', event => {
        if (event.origin === location.origin && event.source === window.parent && event.data instanceof File) (window as unknown as { spikeFile: File }).spikeFile = event.data
      })
    })
    await page.evaluate(() => { document.querySelector('iframe')!.contentWindow!.postMessage((window as unknown as { spikeFile: File }).spikeFile, location.origin) })
    await expect.poll(() => child.evaluate(() => (window as unknown as { spikeFile?: File }).spikeFile?.size)).toBe(500 * 1024 * 1024)
    await child.addScriptTag({ url: origin + '/vendor/emulatorjs/4.2.3/data/emulator.min.js' })
    for (const method of ['HEAD', 'GET']) {
      const result = await child.evaluate(async method => {
        const w = window as unknown as { spikeFile: File; EmulatorJS: { prototype: { downloadFile: (path: File, cb: null, notWithPath: boolean, options: object) => Promise<{ data?: Uint8Array; headers: object }> } }; spikeData?: Uint8Array }
        const start = performance.now()
        const result = await w.EmulatorJS.prototype.downloadFile.call(Object.create(w.EmulatorJS.prototype), w.spikeFile, null, true, { method, responseType: 'arraybuffer' })
        w.spikeData = result.data
        return { method, bytes: result.data?.byteLength ?? 0, elapsedMs: performance.now() - start, name: w.spikeFile.name }
      }, method)
      expect(result.bytes).toBe(method === 'GET' ? 500 * 1024 * 1024 : 0)
      memory.push({ phase: `native-file-${method}`, ...result, ...await cdp.send('Runtime.getHeapUsage') })
    }
    const nativeHash = await child.evaluate(async () => {
      const path = '/spike/tools.js'
      const tools = await import(path) as { sha256: (bytes: Uint8Array) => Uint8Array }
      return Array.from(tools.sha256((window as unknown as { spikeData: Uint8Array }).spikeData), byte => byte.toString(16).padStart(2, '0')).join('')
    })
    expect(nativeHash).toBe(records.at(-1)!.checksum)
    evidence.nativeFileHash = nativeHash
    // Measure the chosen session adapter separately after releasing the raw
    // baseline. Forced GC is measurement setup, not a production dependency.
    await child.evaluate(() => { delete (window as unknown as { spikeData?: Uint8Array }).spikeData })
    await cdp.send('HeapProfiler.collectGarbage')
    evidence.forcedGcBeforeAdapterMeasurement = true
    await child.evaluate(async () => {
      const path = '/spike/tools.js'
      const tools = await import(path) as typeof import('../../src/lib/engine-assets')
      const w = window as unknown as { spikeFile: File; spikeInput: ReturnType<typeof tools.engineRomInput> }
      w.spikeInput = tools.engineRomInput(w.spikeFile)
    })
    for (const method of ['HEAD', 'GET']) {
      const result = await child.evaluate(async method => {
        const w = window as unknown as { spikeInput: { file: File }; EmulatorJS: { prototype: { downloadFile: (path: File, cb: null, notWithPath: boolean, options: object) => Promise<{ data?: Uint8Array }> } }; spikeData?: Uint8Array }
        const start = performance.now()
        const result = await w.EmulatorJS.prototype.downloadFile.call(Object.create(w.EmulatorJS.prototype), w.spikeInput.file, null, true, { method, responseType: 'arraybuffer' })
        w.spikeData = result.data
        return { method, bytes: result.data?.byteLength ?? 0, elapsedMs: performance.now() - start }
      }, method)
      expect(result.bytes).toBe(method === 'GET' ? 500 * 1024 * 1024 : 0)
      const heap = await cdp.send('Runtime.getHeapUsage')
      memory.push({ phase: `session-adapter-${method}`, ...result, ...heap })
      // This measures JS external/backing buffers, not total browser/WASM RAM.
      // One 500 MiB shared read plus small overhead, not two full File reads.
      expect(heap.backingStorageSize).toBeLessThan(500 * 1024 * 1024 + 64 * 1024 * 1024)
    }
    const adapterHash = await child.evaluate(async () => {
      const path = '/spike/tools.js'
      const tools = await import(path) as { sha256: (bytes: Uint8Array) => Uint8Array }
      const w = window as unknown as { spikeData?: Uint8Array; spikeInput: { release: () => void } }
      const value = Array.from(tools.sha256(w.spikeData!), byte => byte.toString(16).padStart(2, '0')).join('')
      w.spikeInput.release(); delete w.spikeData
      return value
    })
    expect(adapterHash).toBe(nativeHash)
    evidence.sessionAdapterHash = adapterHash
    await cdp.send('HeapProfiler.collectGarbage')
    memory.push({ phase: 'session-adapter-released-after-gc', ...await cdp.send('Runtime.getHeapUsage') })
    evidence.memory = memory
    expect(server.transfers.slice(since).filter(value => value.url.startsWith('/spike/large/'))).toEqual([])
    for (const record of records) {
      const gets = server.transfers.filter(value => value.url === record.url && value.method === 'GET')
      expect(gets).toHaveLength(1)
      expect(gets[0]).toMatchObject({ bytes: record.size, completed: true, status: 200 })
    }
  } finally {
    evidence.memory = memory
    evidence.transfers = server.transfers.filter(value => value.url.startsWith('/spike/large/'))
    const report = info.outputPath('m0-chunk-memory-spike.json')
    await writeFile(report, JSON.stringify(evidence, null, 2))
    await info.attach('m0-chunk-memory-spike', { path: report, contentType: 'application/json' })
    await context?.close()
    await rm(folder, { recursive: true, force: true })
  }
})
