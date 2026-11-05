// M5 test-only instrumentation around the real production resolver/storage.
import { createServerAssetResolver } from '../../src/lib/server-assets.ts'
import { openAssetCache, ASSET_CACHE_DATABASE } from '../../src/lib/asset-cache.ts'
import { catalogAssetDescriptor, DEFAULT_ASSET_BUDGET, ASSET_LEASE_MS } from '../../src/lib/asset-cache-policy.ts'
import { hashRom } from '../../src/lib/identity.ts'
import { preparedRomFile, engineRomInput } from '../../src/lib/engine-assets.ts'
import type { CatalogEntry } from '../../src/lib/catalog.ts'
import type { AssetKind } from '../../src/lib/asset-cache-policy.ts'

export { openAssetCache, catalogAssetDescriptor, ASSET_LEASE_MS }
export type Mode = 'normal' | 'hold' | 'hold-transaction' | 'quota' | 'quota-fault'
export let held = false
let releaseHold: (() => void) | undefined
export function release() { releaseHold?.() }
export async function settings() {
  const cache = await openAssetCache()
  try { await cache.setSettings({ enabled: true, budget: DEFAULT_ASSET_BUDGET }) } finally { cache.close() }
}
export async function stats() {
  const cache = await openAssetCache()
  try { return await cache.stats() } finally { cache.close() }
}
export async function clear() {
  const cache = await openAssetCache()
  try { await cache.clear() } finally { cache.close() }
}
export async function remove(entry: CatalogEntry, kind: AssetKind) {
  const cache = await openAssetCache()
  try { await cache.delete(kind, entry.id) } finally { cache.close() }
}
export async function deleteDatabase() {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(ASSET_CACHE_DATABASE)
    req.onsuccess = () => resolve(); req.onerror = () => reject(req.error)
    req.onblocked = () => reject(Error('M5 database deletion blocked'))
  })
}
export async function cleanupExpired() {
  const cache = await openAssetCache({ now: () => Date.now() + ASSET_LEASE_MS + 1000 })
  try { await cache.cleanup(); return await cache.stats() } finally { cache.close() }
}
export async function run(entry: CatalogEntry, kind: AssetKind, mode: Mode = 'normal', nativeRead = false) {
  const phases: { phase: string; atMs: number }[] = [], started = performance.now()
  let hashOffset = -1
  const transactions: Record<string, { completed: number; aborted: number; totalMs: number; maxMs: number }> = {}
  let appends = 0, requestError: string | undefined, maxUiGapMs = 0, lastTick = performance.now()
  const pulse = setInterval(() => { const now = performance.now(); maxUiGapMs = Math.max(maxUiGapMs, now - lastTick); lastTick = now }, 20)
  const resolver = createServerAssetResolver({
    openCache: async () => {
      const cache = await openAssetCache({ observeTransaction: (tx, operation) => {
        const at = performance.now()
        const record = (completed: boolean) => {
          const duration = performance.now() - at
          const value = transactions[operation] ??= { completed: 0, aborted: 0, totalMs: 0, maxMs: 0 }
          value[completed ? 'completed' : 'aborted']++; value.totalMs += duration; value.maxMs = Math.max(value.maxMs, duration)
        }
        tx.addEventListener('complete', () => record(true)); tx.addEventListener('abort', () => record(false))
        if (operation !== 'append') return
        if (mode === 'quota-fault' && ++appends === 2) throw new DOMException('M5 deterministic mid-stream quota', 'QuotaExceededError')
        if (mode === 'quota') tx.addEventListener('error', event => { requestError = (event.target as IDBRequest).error?.name })
        if (mode === 'hold-transaction' && !held) {
          const store = tx.objectStore('chunks'), add = store.add.bind(store)
          store.add = (...args: Parameters<IDBObjectStore['add']>) => {
            const req = add(...args)
            req.addEventListener('success', () => {
              held = true
              // Keep a REAL chunk write transaction active until this tab closes.
              const keepAlive = () => { store.count().onsuccess = keepAlive }
              keepAlive()
            })
            return req
          }
        }
      } })
      if (mode === 'hold') {
        const begin = cache.begin.bind(cache)
        cache.begin = async (...args) => {
          const writer = await begin(...args), append = writer.append.bind(writer)
          writer.append = async blob => {
            await append(blob)
            if (++appends === 1) { held = true; await new Promise<void>(resolve => { releaseHold = resolve }) }
          }
          return writer
        }
      }
      return cache
    },
  })
  try {
    const result = await resolver.resolve(catalogAssetDescriptor(kind, entry), { onProgress: progress => {
      if (phases.at(-1)?.phase !== progress.phase) phases.push({ phase: progress.phase, atMs: performance.now() - started })
    } })
    const resolvedMs = performance.now() - started, hashStart = performance.now()
    const sha256 = await hashRom({ size: result.blob.size, slice: (start: number, end: number) => {
      hashOffset = start; return result.blob.slice(start, end)
    } } as Blob, {}) // Independent bounded rehash; offset retained for diagnostics.
    const hashMs = performance.now() - hashStart
    let native: { size: number; name: string } | undefined
    if (nativeRead && kind === 'rom') {
      const input = engineRomInput(preparedRomFile(result.blob, entry.url))
      try { native = { size: (await input.file.arrayBuffer()).byteLength, name: input.file.name } }
      finally { input.release() }
    }
    return { ...result, blob: undefined, size: result.blob.size, sha256, phases, resolvedMs, hashMs,
      totalMs: performance.now() - started, maxUiGapMs, native, requestError, transactions }
  } catch (error) {
    let cacheDiagnostic: unknown
    if (error instanceof Error && error.name === 'NotReadableError') {
      const cache = await openAssetCache()
      try {
        const hit = await cache.read(catalogAssetDescriptor(kind, entry))
        cacheDiagnostic = { hit: !!hit, sha256: hit ? await hashRom(hit.blob, {}) : undefined }
      } catch (failure) { cacheDiagnostic = String(failure) }
      finally { cache.close() }
    }
    return { error: (error as { code?: string }).code ?? String(error), hashOffset, cacheDiagnostic, transactions,
      errorName: error instanceof Error ? error.name : undefined, errorMessage: error instanceof Error ? error.message : String(error), phases, requestError }
  }
  finally { clearInterval(pulse); await resolver.close() }
}
