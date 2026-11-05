import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import type * as Harness from '../fixtures/asset-cache-storage'

declare global { interface Window {
  cacheTest: typeof Harness;
  storageOwner: Harness.AssetCache;
  storageWriter?: Harness.AssetCacheWriter;
} }

let bundle: string
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: ['tests/fixtures/asset-cache-storage.ts'], bundle: true, write: false,
    format: 'iife', globalName: 'cacheTest', target: 'es2022', platform: 'browser' })).outputFiles[0].text
})
test.beforeEach(async ({ page }) => {
  // Isolated same-origin harness, not an application/player mock. The production
  // storage module and real browser IDB transactions run unchanged.
  await page.route('**/__asset-cache-m1', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>M1 storage tests</title>' }))
  await page.goto('/__asset-cache-m1')
  await page.addScriptTag({ content: bundle })
})

test('staging is never a hit; commit persists across close/reopen and ignores label changes', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { fresh, descriptor, openAssetCache, name } = window.cacheTest
    const cache = await fresh(), d = descriptor(), writer = await cache.begin(d)
    await writer.append(new Blob([new Uint8Array([1, 2, 3])]))
    const before = await cache.stats(), hitBefore = await cache.read(d)
    await writer.commit(); cache.close()
    const reopened = await openAssetCache({ name })
    const hit = await reopened.read({ ...d, label: 'Renamed' }), stats = await reopened.stats()
    reopened.close()
    return { before, hitBefore, bytes: [...new Uint8Array(await hit!.blob.arrayBuffer())], stats }
  })
  expect(result.before.count).toBe(0)
  expect(result.before.stagingBytes).toBe(3)
  expect(result.before.reservedBytes).toBe(3)
  expect(result.hitBefore).toBeNull()
  expect(result.bytes).toEqual([1, 2, 3])
  expect(result.stats.count).toBe(1)
  expect(result.stats.reservedBytes).toBe(0)
})

test('request success followed by transaction abort is not a successful commit', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { fresh, descriptor, code } = window.cacheTest
    let abortCommit = true, requestSucceeded = false
    const cache = await fresh({ observeTransaction: (tx, operation) => {
      if (operation === 'commit' && abortCommit) {
        const store = tx.objectStore('entries'), put = store.put.bind(store)
        store.put = (...args: Parameters<IDBObjectStore['put']>) => {
          const req = put(...args)
          req.addEventListener('success', () => { requestSucceeded = true; tx.abort() })
          return req
        }
      }
    } })
    const writer = await cache.begin(descriptor())
    await writer.append(new Blob([new Uint8Array([1, 2, 3])]))
    const failure = await code(writer.commit()); abortCommit = false
    const stats = await cache.stats(); cache.close()
    return { failure, requestSucceeded, stats }
  })
  expect(result.requestSucceeded).toBe(true)
  expect(result.failure).toBe('aborted')
  expect(result.stats.count).toBe(0)
  expect(result.stats.stagingCount).toBe(0)
})

test('namespaces, same-size different bytes and IDs never collide', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { fresh, descriptor, write } = window.cacheTest
    const cache = await fresh(), a = new Uint8Array([1, 2, 3]), b = new Uint8Array([3, 2, 1])
    const values = [descriptor(a), descriptor(a, { kind: 'bios' }), descriptor(b),
      descriptor(a, { catalogId: '87654321-1234-1234-1234-123456789abc' })]
    for (const value of values) await write(cache, value.sha256 === values[2].sha256 ? b : a, value)
    const hits = []
    for (const value of values) hits.push([...new Uint8Array(await (await cache.read(value))!.blob.arrayBuffer())])
    const stats = await cache.stats(); cache.close()
    return { hits, stats }
  })
  expect(result.stats.count).toBe(4)
  expect(result.hits).toEqual([[1, 2, 3], [1, 2, 3], [3, 2, 1], [1, 2, 3]])
})

test('multi-chunk read validates bytes and chunk boundaries without a whole-file hash buffer', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { fresh, descriptor, write, ASSET_CHUNK_SIZE } = window.cacheTest
    const cache = await fresh(), bytes = new Uint8Array(ASSET_CHUNK_SIZE + 1).fill(37)
    const d = descriptor(bytes), entry = await write(cache, bytes, d)
    const hit = await cache.read(d)
    const size = hit!.blob.size; cache.close()
    return { count: entry.chunkCount, size }
  })
  expect(result).toEqual({ count: 2, size: 4 * 1024 * 1024 + 1 })
})

for (const corruption of ['missing', 'bytes', 'size', 'extra-index', 'negative-index', 'manifest-count'] as const) {
  test(`corruption ${corruption} is detected and conditionally invalidated`, async ({ page }) => {
    const result = await page.evaluate(async corruption => {
      const { fresh, descriptor, write, mutate, raw, code } = window.cacheTest
      const cache = await fresh(), d = descriptor(), entry = await write(cache)
      if (corruption === 'missing') await mutate('chunks', [entry.generationId, 0])
      if (corruption === 'bytes') await mutate('chunks', [entry.generationId, 0], new Blob([new Uint8Array([3, 2, 1])]))
      if (corruption === 'size') await mutate('chunks', [entry.generationId, 0], new Blob(['x']))
      if (corruption === 'extra-index') await mutate('chunks', [entry.generationId, 1], new Blob(['x']))
      if (corruption === 'negative-index') await mutate('chunks', [entry.generationId, -1], new Blob(['x']))
      if (corruption === 'manifest-count') await raw(tx => { tx.objectStore('entries').put({ ...entry, chunkCount: 2 }) })
      const failure = await code(cache.read(d)), stats = await cache.stats()
      await cache.cleanup(); cache.close()
      return { failure, count: stats.count }
    }, corruption)
    expect(result).toEqual({ failure: 'corrupt', count: 0 })
  })
}

test('invalid append and digest mismatch cannot publish a manifest', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { fresh, descriptor, code } = window.cacheTest
    const cache = await fresh(), d = descriptor()
    const first = await cache.begin(d), wrongSize = await code(first.append(new Blob(['x'])))
    const second = await cache.begin(d)
    await second.append(new Blob([new Uint8Array([3, 2, 1])]))
    const wrongHash = await code(second.commit())
    const third = await cache.begin(d), incomplete = await code(third.commit())
    const stats = await cache.stats(); cache.close()
    return { wrongSize, wrongHash, incomplete, count: stats.count, stages: stats.stagingCount }
  })
  expect(result).toEqual({ wrongSize: 'invalid', wrongHash: 'corrupt', incomplete: 'corrupt', count: 0, stages: 0 })
})

test('duplicate chunk indices abort rather than overwrite earlier bytes', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { fresh, descriptor, mutate, code, payloadCount } = window.cacheTest
    const cache = await fresh(), writer = await cache.begin(descriptor())
    await mutate('chunks', [writer.generationId, 0], new Blob(['old']))
    const failure = await code(writer.append(new Blob([new Uint8Array([1, 2, 3])])))
    const stats = await cache.stats(), chunks = await payloadCount(); cache.close()
    return { failure, count: stats.count, staging: stats.stagingCount, chunks }
  })
  expect(result).toEqual({ failure: 'corrupt', count: 0, staging: 0, chunks: 0 })
})

test('simultaneous tabs cannot over-reserve; clear fences a writer in the other tab', async ({ page }) => {
  const other = await page.context().newPage()
  await other.route('**/__asset-cache-m1', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>M1 second tab</title>' }))
  await other.goto('/__asset-cache-m1'); await other.addScriptTag({ content: bundle })
  await Promise.all([page, other].map(tab => tab.evaluate(async () => { window.storageOwner = await window.cacheTest.fresh({}, 5) })))
  const results = await Promise.all([page, other].map((tab, index) => tab.evaluate(async index => {
    try {
      window.storageWriter = await window.storageOwner.begin(window.cacheTest.descriptor(new Uint8Array(index ? [3, 2, 1] : [1, 2, 3])))
      return 'success'
    } catch (error) { return (error as { code: string }).code }
  }, index)))
  expect([...results].sort()).toEqual(['budget', 'success'])
  const winner = results[0] === 'success' ? page : other
  const clearer = winner === page ? other : page
  const stats = await clearer.evaluate(() => window.storageOwner.stats())
  expect(stats.reservedBytes).toBe(3)
  await winner.evaluate(() => window.storageWriter!.append(new Blob([new Uint8Array([1, 2, 3])])))
  await clearer.evaluate(() => window.storageOwner.clear())
  const late = await winner.evaluate(() => window.cacheTest.code(window.storageWriter!.commit()))
  expect(late).toBe('fenced')
  expect((await clearer.evaluate(() => window.storageOwner.stats())).count).toBe(0)
  await Promise.all([page, other].map(tab => tab.evaluate(() => window.storageOwner.close())))
  await other.close()
})

test('clear and per-asset deletion fence old append and publish across independent connections', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { fresh, descriptor, code } = window.cacheTest
    const a = await fresh(), b = await fresh(), d = descriptor()
    const first = await a.begin(d)
    await b.clear()
    const append = await code(first.append(new Blob([new Uint8Array([1, 2, 3])])))
    const second = await a.begin(d)
    await second.append(new Blob([new Uint8Array([1, 2, 3])]))
    await b.delete(d.kind, d.catalogId)
    const publish = await code(second.commit())
    const stats = await a.stats(); a.close(); b.close()
    return { append, publish, stats }
  })
  expect(result.append).toBe('fenced')
  expect(result.publish).toBe('fenced')
  expect(result.stats.count).toBe(0)
  expect(result.stats.epoch).toBe(1)
})

test('two writers share admission atomically, and same-key writers cannot overwrite each other', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { fresh, descriptor, code } = window.cacheTest
    const a = await fresh({}, 5), b = await fresh({}, 5), d = descriptor()
    const writer = await a.begin(d)
    const sameKey = await code(b.begin(d))
    const otherKey = await code(b.begin(descriptor(new Uint8Array([3, 2, 1]))))
    const stats = await b.stats()
    await writer.abort(); a.close(); b.close()
    return { sameKey, otherKey, reserved: stats.reservedBytes, count: stats.stagingCount }
  })
  expect(result).toEqual({ sameKey: 'busy', otherKey: 'budget', reserved: 3, count: 1 })
})

test('queued clear during append and delete during commit serialize without resurrection', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { fresh, descriptor, code } = window.cacheTest
    const a = await fresh(), b = await fresh(), d = descriptor()
    const writing = await a.begin(d)
    // Blob reading is outside IDB; clear may win before append is admitted.
    const [append] = await Promise.all([code(writing.append(new Blob([new Uint8Array([1, 2, 3])]))), b.clear()])
    const late = await code(writing.commit())
    const publishing = await a.begin(d)
    await publishing.append(new Blob([new Uint8Array([1, 2, 3])]))
    const [commit] = await Promise.all([code(publishing.commit()), b.delete(d.kind, d.catalogId)])
    const stats = await b.stats(); a.close(); b.close()
    return { append, late, commit, count: stats.count, staging: stats.stagingCount }
  })
  expect(['success', 'fenced']).toContain(result.append)
  expect(result.late).toBe('fenced')
  expect(['success', 'fenced']).toContain(result.commit)
  expect(result.count).toBe(0)
  expect(result.staging).toBe(0)
})

test('a reader whose expired pin is taken over cannot resume or invalidate a replacement', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { fresh, descriptor, write, code, ASSET_LEASE_MS } = window.cacheTest
    let now = 1000, onChunk: (() => void) | undefined, onResume: (() => void) | undefined
    const chunkSeen = new Promise<void>(resolve => { onChunk = resolve })
    const resume = new Promise<void>(resolve => { onResume = resolve })
    const a = await fresh({ now: () => now, observeTransaction: (_tx, op) => { if (op === 'read-chunk') onChunk?.() } }, 3)
    const b = await fresh({ now: () => now }, 3)
    await write(a)
    const original = Blob.prototype.arrayBuffer
    Blob.prototype.arrayBuffer = async function () { await resume; return original.call(this) }
    const reading = code(a.read(descriptor()))
    await chunkSeen
    // Ensure the read transaction has completed before advancing the clock.
    await b.stats()
    now += ASSET_LEASE_MS + 1
    await b.cleanup()
    const next = await b.begin(descriptor(new Uint8Array([3, 2, 1])))
    onResume!(); Blob.prototype.arrayBuffer = original
    const failure = await reading
    await next.append(new Blob([new Uint8Array([3, 2, 1])]))
    await next.commit()
    const hit = !!await b.read(descriptor(new Uint8Array([3, 2, 1])))
    a.close(); b.close()
    return { failure, hit }
  })
  expect(result).toEqual({ failure: 'fenced', hit: true })
})

test('expired lease takeover fences the old owner, including heartbeat and late cleanup', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { fresh, descriptor, code, ASSET_LEASE_MS } = window.cacheTest
    let now = 1000
    const a = await fresh({ now: () => now }), b = await fresh({ now: () => now }), d = descriptor()
    const old = await a.begin(d)
    await old.append(new Blob([new Uint8Array([1, 2, 3])]))
    now += ASSET_LEASE_MS + 1
    const current = await b.begin(d)
    const heartbeat = await code(old.heartbeat()), publish = await code(old.commit())
    await current.append(new Blob([new Uint8Array([1, 2, 3])]))
    await current.commit()
    await a.cleanup(); await a.cleanup()
    const hit = !!await b.read(d), stats = await b.stats(); a.close(); b.close()
    return { heartbeat, publish, hit, count: stats.count }
  })
  expect(result).toEqual({ heartbeat: 'fenced', publish: 'fenced', hit: true, count: 1 })
})

test('AbortSignal cleans staging; close/reopen never exposes abandoned staging and cleanup is repeatable', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { fresh, descriptor, code, openAssetCache, name, ASSET_LEASE_MS, payloadCount } = window.cacheTest
    let now = 1000
    const a = await fresh({ now: () => now }), d = descriptor(), controller = new AbortController()
    const writer = await a.begin(d, controller.signal)
    await writer.append(new Blob([new Uint8Array([1, 2, 3])]))
    controller.abort()
    const commit = await code(writer.commit())
    // Signal cleanup was queued before this metadata transaction.
    const afterAbort = await a.stats()
    const abandoned = await a.begin(d)
    await abandoned.append(new Blob([new Uint8Array([1, 2, 3])]))
    a.close()
    const b = await openAssetCache({ name, now: () => now })
    const hitBefore = await b.read(d)
    now += ASSET_LEASE_MS + 1
    await b.cleanup(1); await b.cleanup(1)
    const stats = await b.stats(), chunks = await payloadCount(); b.close()
    return { commit, abortedStages: afterAbort.stagingCount, hitBefore, stats, chunks }
  })
  expect(result.commit).toBe('aborted')
  expect(result.abortedStages).toBe(0)
  expect(result.hitBefore).toBeNull()
  expect(result.stats.stagingCount).toBe(0)
  expect(result.chunks).toBe(0)
})

test('concurrent signal/explicit abort waits for cancellation commit before connection close', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { fresh, descriptor, openAssetCache, name, payloadCount } = window.cacheTest
    const cache = await fresh(), controller = new AbortController()
    const writer = await cache.begin(descriptor(), controller.signal)
    await writer.append(new Blob([new Uint8Array([1, 2, 3])]))
    controller.abort() // Starts asynchronous cancellation from the signal listener.
    await Promise.all([writer.abort(), writer.abort()])
    cache.close() // Must not abort the cancellation transaction still in flight.
    const reopened = await openAssetCache({ name })
    try {
      const stats = await reopened.stats()
      return { stages: stats.stagingCount, reserved: stats.reservedBytes, count: stats.count, chunks: await payloadCount() }
    } finally { reopened.close() }
  })
  expect(result).toEqual({ stages: 0, reserved: 0, count: 0, chunks: 0 })
})

test('LRU respects an active assembly pin and metadata statistics never read chunk payloads', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { fresh, descriptor, write, code } = window.cacheTest
    let now = 1000, onChunk: (() => void) | undefined, onResume: (() => void) | undefined
    const chunkSeen = new Promise<void>(resolve => { onChunk = resolve })
    const resume = new Promise<void>(resolve => { onResume = resolve })
    const a = await fresh({ now: () => now, observeTransaction: (tx, operation) => {
      if (operation === 'stats') {
        const store = tx.objectStore('chunks')
        store.get = () => { throw new Error('stats read a payload') }
        store.getAll = () => { throw new Error('stats read payloads') }
        store.openCursor = () => { throw new Error('stats scanned payloads') }
      }
      if (operation === 'read-chunk') onChunk?.()
    } }, 3)
    const b = await fresh({ now: () => now }, 3), d = descriptor()
    await write(a)
    // Block Blob assembly outside IDB while leaving the reader lease live.
    const original = Blob.prototype.arrayBuffer
    Blob.prototype.arrayBuffer = async function () { await resume; return original.call(this) }
    const reading = a.read(d)
    await chunkSeen; now++
    const admission = await code(b.begin(descriptor(new Uint8Array([3, 2, 1]))))
    await b.cleanup()
    onResume!()
    const hit = !!await reading
    Blob.prototype.arrayBuffer = original
    const stats = await a.stats()
    const next = await b.begin(descriptor(new Uint8Array([3, 2, 1])))
    await next.abort()
    const after = await a.stats(); a.close(); b.close()
    return { admission, hit, count: stats.count, after: after.count }
  })
  expect(result).toEqual({ admission: 'budget', hit: true, count: 1, after: 0 })
})

test('quota abort retries the same chunk once after eviction; repeated failure leaves no false entry', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { fresh, descriptor, write, code } = window.cacheTest
    let failures = 0, attempts = 0
    const cache = await fresh({ observeTransaction: (_tx, operation) => {
      if (operation === 'append') { attempts++; if (failures-- > 0) throw new DOMException('Injected quota', 'QuotaExceededError') }
    } })
    await write(cache)
    failures = 1; attempts = 0
    const first = await write(cache, new Uint8Array([3, 2, 1]))
    const firstAttempts = attempts, firstCount = (await cache.stats()).count
    failures = 2; attempts = 0
    const writer = await cache.begin(descriptor())
    const failed = await code(writer.append(new Blob([new Uint8Array([1, 2, 3])])))
    const failedAttempts = attempts, stats = await cache.stats(); cache.close()
    return { first: first.size, firstAttempts, firstCount, failed, failedAttempts, stats }
  })
  expect(result.firstAttempts).toBe(2)
  expect(result.firstCount).toBe(1)
  expect(result.failed).toBe('quota')
  expect(result.failedAttempts).toBe(2)
  expect(result.stats.count).toBe(0)
  expect(result.stats.stagingCount).toBe(0)
})

test('disabled cache retains entries, fences writers and optional estimate failures are nonfatal', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { fresh, descriptor, write, code, DEFAULT_ASSET_BUDGET } = window.cacheTest
    const cache = await fresh({ estimate: async () => { throw new Error('No storage API on LAN') } })
    await write(cache)
    const pending = await cache.begin(descriptor(new Uint8Array([3, 2, 1])))
    await cache.setSettings({ enabled: false, budget: DEFAULT_ASSET_BUDGET })
    const hit = await cache.read(descriptor()), begin = await code(cache.begin(descriptor()))
    const late = await code(pending.commit()), count = (await cache.stats()).count
    await cache.setSettings({ enabled: true, budget: DEFAULT_ASSET_BUDGET })
    const restored = !!await cache.read(descriptor()); cache.close()
    return { hit, begin, late, count, restored }
  })
  expect(result).toEqual({ hit: null, begin: 'disabled', late: 'fenced', count: 1, restored: true })
})

test('budget LRU uses last successful read and never touches save databases or browser metadata', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { fresh, descriptor, write, DEFAULT_ASSET_BUDGET } = window.cacheTest
    localStorage.setItem('maindulu-save-sentinel', 'keep')
    const saves = await new Promise<IDBDatabase>(resolve => {
      const req = indexedDB.open('EmulatorJS-states', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('states').put('keep', 'sentinel')
      req.onsuccess = () => resolve(req.result)
    })
    let now = 1000
    const cache = await fresh({ now: () => now })
    const a = descriptor(), b = descriptor(new Uint8Array([3, 2, 1]))
    await write(cache); now++
    await write(cache, new Uint8Array([3, 2, 1]), b); now++
    await cache.read(a)
    await cache.setSettings({ enabled: true, budget: 3 })
    const kept = (await cache.stats()).entries.map(entry => entry.sha256)
    await cache.setSettings({ enabled: false, budget: DEFAULT_ASSET_BUDGET })
    await cache.clear(); cache.close()
    const save = await new Promise(resolve => {
      const req = saves.transaction('states').objectStore('states').get('sentinel')
      req.onsuccess = () => resolve(req.result)
    })
    saves.close()
    return { kept, expected: a.sha256, save, metadata: localStorage.getItem('maindulu-save-sentinel') }
  })
  expect(result.kept).toEqual([result.expected])
  expect(result.save).toBe('keep')
  expect(result.metadata).toBe('keep')
})

test('storage estimate reserve prevents admission but a missing estimate remains supported', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { fresh, descriptor, code, ASSET_SPACE_RESERVE } = window.cacheTest
    const cache = await fresh({ estimate: async () => ({ quota: ASSET_SPACE_RESERVE + 2, usage: 0 }) })
    const admission = await code(cache.begin(descriptor())), stats = await cache.stats(); cache.close()
    return { admission, reserved: stats.reservedBytes }
  })
  expect(result).toEqual({ admission: 'budget', reserved: 0 })
})

test('bounded key-only orphan cleanup makes progress and preserves live writers/entries', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { fresh, write, mutate, payloadCount, descriptor } = window.cacheTest
    const cache = await fresh()
    await write(cache)
    const writer = await cache.begin(descriptor(new Uint8Array([3, 2, 1])))
    await writer.append(new Blob([new Uint8Array([3, 2, 1])]))
    for (let i = 0; i < 5; i++) await mutate('chunks', ['orphan', i], new Blob(['x']))
    let maxScanned = 0, removed = 0
    for (let i = 0; i < 12; i++) {
      const result = await cache.cleanup(1)
      maxScanned = Math.max(maxScanned, result.scanned); removed += result.deleted
    }
    await writer.commit()
    const count = await payloadCount(), entries = (await cache.stats()).count; cache.close()
    return { maxScanned, removed, count, entries }
  })
  expect(result).toEqual({ maxScanned: 1, removed: 5, count: 2, entries: 2 })
})

test('newer database version is not downgraded or deleted; versionchange closes active owners', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { openAssetCache, code, name } = window.cacheTest
    const statuses: string[] = []
    const cache = await openAssetCache({ name, onLifecycle: status => statuses.push(status) })
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 2)
      req.onupgradeneeded = () => req.result.createObjectStore('future').put('keep', 'sentinel')
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error)
    })
    const closed = await code(cache.stats()), incompatible = await code(openAssetCache({ name }))
    const sentinel = await new Promise(resolve => {
      const req = upgraded.transaction('future').objectStore('future').get('sentinel')
      req.onsuccess = () => resolve(req.result)
    })
    upgraded.close()
    return { statuses, closed, incompatible, sentinel }
  })
  expect(result).toEqual({ statuses: ['versionchange'], closed: 'unavailable', incompatible: 'incompatible-version', sentinel: 'keep' })
})

test('blocked upgrade reports a structured error and an abandoned request never installs a cache', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { openAssetCache, code } = window.cacheTest
    // A v0->v1 upgrade cannot be blocked by an existing v1 connection, so use
    // a factory shim only to request version 2; locking/transactions are real.
    const dbName = 'maindulu-asset-cache-blocked-test'
    const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1)
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error)
    })
    blocker.onversionchange = () => {}
    const events: string[] = []
    const factory = { open: () => indexedDB.open(dbName, 2) } as unknown as IDBFactory
    const failure = await code(openAssetCache({ indexedDB: factory, onLifecycle: status => events.push(status) }))
    blocker.close()
    await new Promise(resolve => setTimeout(resolve, 50))
    const version = await new Promise<number>(resolve => {
      const req = indexedDB.open(dbName)
      req.onsuccess = () => { resolve(req.result.version); req.result.close() }
    })
    return { failure, events, version }
  })
  expect(result).toEqual({ failure: 'blocked', events: ['blocked'], version: 1 })
})
