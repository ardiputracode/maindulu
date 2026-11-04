// Browser-only M1 harness, bundled in memory by the spec. No production loader.
import { sha256 } from '@noble/hashes/sha2.js'
import { openAssetCache } from '../../src/lib/asset-cache.ts'
import type { AssetCache, AssetCacheOptions } from '../../src/lib/asset-cache.ts'
import { ASSET_CHUNK_SIZE, DEFAULT_ASSET_BUDGET } from '../../src/lib/asset-cache-policy.ts'
import type { AssetDescriptor } from '../../src/lib/asset-cache-policy.ts'
export * from '../../src/lib/asset-cache.ts'
export * from '../../src/lib/asset-cache-policy.ts'

export const name = 'maindulu-asset-cache-m1-tests'
export const id = '12345678-1234-1234-1234-123456789abc'
export const hash = (bytes: Uint8Array) => Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
export function descriptor(bytes = new Uint8Array([1, 2, 3]), overrides: Partial<AssetDescriptor> = {}): AssetDescriptor {
  const value: AssetDescriptor = { kind: 'rom', catalogId: id, size: bytes.length, sha256: hash(bytes),
    fileName: 'test game.nes', url: '', consoleId: 'nes', label: 'Test', ...overrides }
  value.url = value.kind === 'rom' ? `/games/${value.catalogId}/rom/${encodeURIComponent(value.fileName)}` : `/bios/${value.catalogId}/${encodeURIComponent(value.fileName)}`
  return value
}
export async function fresh(options: AssetCacheOptions = {}, budget = DEFAULT_ASSET_BUDGET): Promise<AssetCache> {
  const cache = await openAssetCache({ name, estimate: async () => ({}), ...options })
  await cache.setSettings({ enabled: true, budget })
  return cache
}
export async function write(cache: AssetCache, bytes = new Uint8Array([1, 2, 3]), value = descriptor(bytes)) {
  const writer = await cache.begin(value)
  for (let offset = 0; offset < bytes.length; offset += ASSET_CHUNK_SIZE) {
    await writer.append(new Blob([bytes.slice(offset, offset + ASSET_CHUNK_SIZE)]))
  }
  return writer.commit()
}
export async function code(promise: Promise<unknown>): Promise<string> {
  try { await promise; return 'success' } catch (error) { return (error as { code?: string }).code ?? String(error) }
}
export async function raw<T>(body: (tx: IDBTransaction) => void): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name)
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error)
  })
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(['entries', 'chunks', 'staging', 'control'], 'readwrite')
      tx.oncomplete = () => resolve(undefined as T); tx.onabort = () => reject(tx.error)
      body(tx)
    })
  } finally { db.close() }
}
export async function mutate(store: string, key: IDBValidKey, value?: unknown): Promise<void> {
  await raw(tx => { if (value === undefined) tx.objectStore(store).delete(key); else tx.objectStore(store).put(value, key) })
}
export async function payloadCount(): Promise<number> {
  let count = 0
  await raw(tx => { const req = tx.objectStore('chunks').count(); req.onsuccess = () => { count = req.result } })
  return count
}
