import { openAssetCache } from '../../src/lib/asset-cache.ts'
import type { AssetCache, AssetCacheWriter } from '../../src/lib/asset-cache.ts'
import { createIncrementalSha256 } from '../../src/lib/identity.ts'
import type { AssetDescriptor } from '../../src/lib/asset-cache-policy.ts'
export { openAssetCache }
let pending: { cache: AssetCache; writer: AssetCacheWriter } | undefined

export async function stageOnly() {
  const descriptor = await seed('Masih sementara')
  const cache = await openAssetCache()
  await cache.delete(descriptor.kind, descriptor.catalogId, descriptor.sha256)
  const writer = await cache.begin(descriptor)
  pending = { cache, writer }
  await writer.append(new Blob([new Uint8Array([1, 2, 3])]))
}
export async function finishStage() {
  if (!pending) throw Error('No pending test writer')
  try { await pending.writer.commit(); return 'committed' }
  catch { return 'fenced' }
  finally { await pending.writer.abort(); pending.cache.close(); pending = undefined }
}

export async function seed(label = 'ROM pengujian', kind: 'rom' | 'bios' = 'rom') {
  const bytes = new Uint8Array([1, 2, 3]), hash = createIncrementalSha256()
  hash.update(bytes)
  const catalogId = crypto.randomUUID(), fileName = kind === 'rom' ? 'test.nes' : 'firmware.bin'
  const descriptor: AssetDescriptor = { kind, catalogId, label, sha256: hash.digest(), size: bytes.length,
    consoleId: 'nes', fileName, url: kind === 'rom' ? `/games/${catalogId}/rom/${fileName}` : `/bios/${catalogId}/${fileName}` }
  hash.destroy()
  const cache = await openAssetCache()
  try {
    const settings = await cache.settings()
    await cache.setSettings({ ...settings, enabled: true })
    const writer = await cache.begin(descriptor)
    await writer.append(new Blob([bytes])); await writer.commit()
    return descriptor
  } finally { cache.close() }
}

export function abortNextClear() {
  const original = IDBObjectStore.prototype.clear
  IDBObjectStore.prototype.clear = function () {
    const req = original.call(this)
    if (this.name === 'entries' && this.transaction.db.name === 'maindulu-asset-cache') {
      IDBObjectStore.prototype.clear = original
      req.addEventListener('success', () => this.transaction.abort())
    }
    return req
  }
}

// Test-only failure injection into the actual production Player's transactions.
export function failNextWrite(mode: 'abort' | 'quota') {
  if (mode === 'quota') {
    const original = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (...args: Parameters<IDBObjectStore['add']>) {
      if (this.transaction.db.name === 'maindulu-asset-cache' && this.name === 'chunks') {
        IDBObjectStore.prototype.add = original
        throw new DOMException('Deterministic M4 quota failure', 'QuotaExceededError')
      }
      return original.apply(this, args)
    }
    return
  }
  const original = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
    if (this.transaction.db.name === 'maindulu-asset-cache' && this.name === 'entries') {
      IDBObjectStore.prototype.put = original
      const req = original.apply(this, args)
      req.addEventListener('success', () => this.transaction.abort())
      return req
    }
    return original.apply(this, args)
  }
}
