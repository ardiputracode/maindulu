// Test-only resolver harness. Bundled in memory, never shipped in public/.
import { createServerAssetResolver } from '../../src/lib/server-assets.ts'
import { openAssetCache } from '../../src/lib/asset-cache.ts'
import { catalogAssetDescriptor, DEFAULT_ASSET_BUDGET } from '../../src/lib/asset-cache-policy.ts'
import type { AssetKind } from '../../src/lib/asset-cache-policy.ts'
import type { CatalogEntry } from '../../src/lib/catalog.ts'
import { hashRom } from '../../src/lib/identity.ts'

const name = 'maindulu-asset-cache-m2-tests'
export type Mode = 'normal' | 'quota' | 'budget' | 'unavailable' | 'disabled' | 'stored-disabled' | 'server-error' | 'bad-download'
export async function stats() {
  const cache = await openAssetCache({ name })
  try { return await cache.stats() } finally { cache.close() }
}
export async function run(entry: CatalogEntry, kind: AssetKind, mode: Mode = 'normal') {
  const descriptor = catalogAssetDescriptor(kind, entry), phases: string[] = []
  let appendAttempts = 0
  if (mode === 'stored-disabled') {
    const cache = await openAssetCache({ name })
    try { await cache.setSettings({ enabled: false, budget: DEFAULT_ASSET_BUDGET }) } finally { cache.close() }
  }
  const resolver = createServerAssetResolver({ cacheEnabled: mode !== 'disabled',
    fetch: mode === 'server-error' ? async (url, options) => options?.method === 'HEAD'
      ? new Response(null, { status: 503 }) : fetch(url, options) : mode === 'bad-download' ? async (url, options) => {
        const response = await fetch(url, options)
        if (options?.method !== 'GET') return response
        let changed = false
        return new Response(response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(bytes, controller) {
          if (!changed && bytes.length) { bytes[0] ^= 1; changed = true }
          controller.enqueue(bytes)
        } })), { headers: response.headers })
      } : undefined,
    openCache: async () => {
      if (mode === 'unavailable') throw new DOMException('Test-only storage denied', 'SecurityError')
      const cache = await openAssetCache({ name, estimate: async () => ({}), observeTransaction: (_, operation) => {
        if (mode === 'quota' && operation === 'append' && ++appendAttempts === 2) throw new DOMException('Test-only quota', 'QuotaExceededError')
      } })
      try {
        if (mode !== 'stored-disabled') await cache.setSettings({ enabled: true, budget: mode === 'budget' ? 1 : DEFAULT_ASSET_BUDGET })
        return cache
      } catch (error) { cache.close(); throw error }
    },
  })
  try {
    const result = await resolver.resolve(descriptor, { onProgress: progress => phases.push(progress.phase) })
    return { ...result, blob: undefined, size: result.blob.size, sha256: await hashRom(result.blob, {}), phases, appendAttempts }
  } finally { await resolver.close() }
}
export async function failure(entry: CatalogEntry, kind: AssetKind, mode: Mode = 'normal') {
  try { await run(entry, kind, mode); return 'success' }
  catch (error) { return (error as { code?: string }).code ?? String(error) }
}
export async function corrupt(entry: CatalogEntry, kind: AssetKind) {
  const metadata = await stats(), descriptor = catalogAssetDescriptor(kind, entry)
  const cached = metadata.entries.find(value => value.kind === kind && value.catalogId === descriptor.catalogId)!
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open(name); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('chunks', 'readwrite')
      tx.objectStore('chunks').put(new Blob([new Uint8Array(Math.min(entry.size, 4 * 1024 * 1024)).fill(0xff)]), [cached.generationId, 0])
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
    })
  } finally { db.close() }
}
