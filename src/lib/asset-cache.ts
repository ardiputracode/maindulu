import { createIncrementalSha256, createSessionId } from './identity.ts'
import {
  ASSET_CHUNK_SIZE, ASSET_LEASE_MS, ASSET_SPACE_RESERVE, DEFAULT_ASSET_BUDGET, AssetCacheError,
  assetChunkCount, assetChunkSize, assetKey, assetKeyString, cacheStorageError, checkCacheAbort,
  planAssetAdmission, readAssetDescriptor, requireAssetDescriptor, requireCacheSettings,
} from './asset-cache-policy.ts'
import type { AssetCacheSettings, AssetDescriptor, AssetKey } from './asset-cache-policy.ts'

export const ASSET_CACHE_DATABASE = 'maindulu-asset-cache'
export const ASSET_CACHE_VERSION = 1
const STORES = ['entries', 'chunks', 'staging', 'control']
const request = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
})

export type AssetCacheEntry = AssetDescriptor & {
  key: AssetKey; generationId: string; chunkCount: number; createdAt: number; lastUsedAt: number;
}
type Staging = {
  generationId: string; descriptor: AssetDescriptor; ownerId: string; epoch: number;
  expectedSize: number; receivedSize: number; chunkCount: number; heartbeatAt: number; reservation: number;
}
type Pin = { generationId: string; expiresAt: number }
type Control = { epoch: number; settings: AssetCacheSettings; pins: Record<string, Pin>; cleanupAfter?: IDBValidKey }
export type AssetCacheStats = {
  entries: AssetCacheEntry[]; count: number; committedBytes: number; stagingBytes: number;
  reservedBytes: number; stagingCount: number; epoch: number; settings: AssetCacheSettings;
}
export type AssetCacheOptions = {
  indexedDB?: IDBFactory; keyRange?: typeof IDBKeyRange; name?: string;
  now?: () => number; createId?: () => string;
  estimate?: () => Promise<{ quota?: number; usage?: number }>;
  onLifecycle?: (status: 'blocked' | 'versionchange' | 'closed') => void;
  // Dependency injection for deterministic browser transaction/quota failures.
  observeTransaction?: (transaction: IDBTransaction, operation: string) => void;
}

function validEntry(entry: AssetCacheEntry): boolean {
  return !!readAssetDescriptor(entry) && JSON.stringify(entry.key) === assetKeyString(entry) &&
    typeof entry.generationId === 'string' && entry.generationId.length > 0 &&
    entry.chunkCount === assetChunkCount(entry.size) && Number.isSafeInteger(entry.createdAt) &&
    entry.createdAt >= 0 && Number.isSafeInteger(entry.lastUsedAt) && entry.lastUsedAt >= 0
}

function validStage(stage: Staging): boolean {
  return !!stage && !!readAssetDescriptor(stage.descriptor) && typeof stage.generationId === 'string' && !!stage.generationId &&
    typeof stage.ownerId === 'string' && !!stage.ownerId && Number.isSafeInteger(stage.epoch) && stage.epoch >= 0 &&
    stage.expectedSize === stage.descriptor.size && stage.reservation === stage.expectedSize &&
    Number.isSafeInteger(stage.chunkCount) && stage.chunkCount >= 0 && stage.chunkCount <= assetChunkCount(stage.expectedSize) &&
    stage.receivedSize === Math.min(stage.expectedSize, stage.chunkCount * ASSET_CHUNK_SIZE) &&
    Number.isSafeInteger(stage.heartbeatAt) && stage.heartbeatAt >= 0
}

// Opening errors are structured failures, not a reason to delete or downgrade a
// database. M2 can catch them and continue its verified network-only pipeline.
export async function openAssetCache(options: AssetCacheOptions = {}): Promise<AssetCache> {
  let factory: IDBFactory | undefined
  try { factory = 'indexedDB' in options ? options.indexedDB : globalThis.indexedDB }
  catch (error) { throw cacheStorageError(error) }
  if (!factory) throw new AssetCacheError('unavailable', 'IndexedDB tidak tersedia; cache tidak dipakai.')
  let abandoned = false
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    let opening: IDBOpenDBRequest
    try { opening = factory.open(options.name ?? ASSET_CACHE_DATABASE, ASSET_CACHE_VERSION) }
    catch (error) { reject(cacheStorageError(error)); return }
    opening.onupgradeneeded = () => {
      if (abandoned) { opening.transaction?.abort(); return }
      const database = opening.result
      const entries = database.createObjectStore('entries', { keyPath: 'key' })
      entries.createIndex('lru', ['lastUsedAt', 'createdAt'])
      entries.createIndex('catalog', ['kind', 'catalogId'])
      entries.createIndex('generation', 'generationId', { unique: true })
      database.createObjectStore('chunks')
      // Out-of-line composite chunk keys already group each generation.
      const staging = database.createObjectStore('staging', { keyPath: 'generationId' })
      staging.createIndex('heartbeat', 'heartbeatAt')
      staging.createIndex('catalog', ['descriptor.kind', 'descriptor.catalogId'])
      database.createObjectStore('control').put({ epoch: 0,
        settings: { enabled: false, budget: DEFAULT_ASSET_BUDGET }, pins: {} } satisfies Control, 'state')
    }
    opening.onblocked = () => {
      abandoned = true
      reject(new AssetCacheError('blocked', 'Tab lain menghalangi pembukaan database cache. Tutup tab tersebut lalu coba lagi.'))
      options.onLifecycle?.('blocked')
    }
    opening.onerror = () => reject(cacheStorageError(opening.error))
    opening.onsuccess = () => {
      if (abandoned) { opening.result.close(); return }
      resolve(opening.result)
    }
  })
  return new AssetCache(db, options)
}

export class AssetCache {
  private db: IDBDatabase
  private options: AssetCacheOptions
  private closed = false
  private active = new Set<IDBTransaction>()
  private keyRange: typeof IDBKeyRange
  readonly now: () => number
  readonly createId: () => string

  constructor(db: IDBDatabase, options: AssetCacheOptions) {
    this.db = db
    this.options = options
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? createSessionId
    this.keyRange = options.keyRange ?? globalThis.IDBKeyRange
    db.onversionchange = () => { this.close(); options.onLifecycle?.('versionchange') }
    db.onclose = () => { this.close(); options.onLifecycle?.('closed') }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const tx of this.active) { try { tx.abort() } catch { /* Already complete. */ } }
    this.db.close()
  }

  private newId(): string {
    try {
      const id = this.createId()
      if (typeof id !== 'string' || !id || id.length > 128 || /[\x00-\x1f\x7f]/.test(id)) throw new Error('ID cache tidak valid.')
      return id
    } catch (error) { throw cacheStorageError(error) }
  }

  // The body may await IDB requests ONLY. Network, Blob reads, hashing and UI
  // yields must stay outside this callback. Resolve only on transaction complete.
  private transact<T>(operation: string, mode: IDBTransactionMode,
    body: (tx: IDBTransaction) => Promise<T>, signal?: AbortSignal): Promise<T> {
    checkCacheAbort(signal)
    if (this.closed) return Promise.reject(new AssetCacheError('unavailable', 'Koneksi cache sudah ditutup.'))
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction
      try { tx = this.db.transaction(STORES, mode) }
      catch (error) { reject(cacheStorageError(error)); return }
      this.active.add(tx)
      let result: T, failure: unknown
      const abort = () => { failure = new AssetCacheError('aborted', 'Operasi cache dibatalkan.'); try { tx.abort() } catch { /* Complete. */ } }
      const finish = () => { this.active.delete(tx); signal?.removeEventListener('abort', abort) }
      signal?.addEventListener('abort', abort, { once: true })
      tx.oncomplete = () => { finish(); resolve(result) }
      tx.onabort = () => { finish(); reject(cacheStorageError(failure ?? tx.error ?? new DOMException('Transaction aborted', 'AbortError'))) }
      // Keep the original request error (not merely the enclosing AbortError).
      tx.addEventListener('error', event => { failure ??= (event.target as IDBRequest).error })
      try {
        const running = body(tx)
        running.then(value => { result = value }, error => {
          failure ??= error
          try { tx.abort() } catch { finish(); reject(cacheStorageError(failure)) }
        })
        this.options.observeTransaction?.(tx, operation)
      } catch (error) { failure = error; try { tx.abort() } catch { finish(); reject(cacheStorageError(error)) } }
    })
  }

  private async control(tx: IDBTransaction): Promise<Control> {
    const control = await request<Control | undefined>(tx.objectStore('control').get('state'))
    if (!control || !Number.isSafeInteger(control.epoch) || control.epoch < 0 || !control.pins ||
      typeof control.pins !== 'object' || Array.isArray(control.pins) || Object.values(control.pins).some(pin =>
        !pin || typeof pin.generationId !== 'string' || !Number.isSafeInteger(pin.expiresAt) || pin.expiresAt < 0)) {
      throw new AssetCacheError('corrupt', 'Metadata pengelola cache rusak.')
    }
    try { requireCacheSettings(control.settings) }
    catch { throw new AssetCacheError('corrupt', 'Pengaturan cache perangkat rusak.') }
    return control
  }

  private async manifests(tx: IDBTransaction): Promise<AssetCacheEntry[]> {
    const entries = await request<AssetCacheEntry[]>(tx.objectStore('entries').getAll())
    if (entries.some(entry => !validEntry(entry))) throw new AssetCacheError('corrupt', 'Manifest cache rusak.')
    return entries
  }

  private async stages(tx: IDBTransaction): Promise<Staging[]> {
    const stages = await request<Staging[]>(tx.objectStore('staging').getAll())
    if (stages.some(stage => !validStage(stage))) throw new AssetCacheError('corrupt', 'Reservation cache rusak.')
    return stages
  }

  private livePins(control: Control): Set<string> {
    const now = this.now()
    for (const [token, pin] of Object.entries(control.pins)) if (pin.expiresAt <= now) delete control.pins[token]
    return new Set(Object.values(control.pins).map(pin => pin.generationId))
  }

  private chunkRange(generationId: string): IDBKeyRange {
    // The immediate string successor includes every child key, even malformed
    // negative/string indices. A numeric-only range would hide corrupt extras.
    return this.keyRange.bound([generationId], [generationId + '\0'], false, true)
  }

  private removeGeneration(tx: IDBTransaction, generationId: string): void {
    tx.objectStore('chunks').delete(this.chunkRange(generationId))
  }

  private async expireWriters(tx: IDBTransaction): Promise<Staging[]> {
    const stages = await this.stages(tx)
    const live: Staging[] = []
    for (const stage of stages) {
      if (stage.heartbeatAt + ASSET_LEASE_MS <= this.now()) {
        // Removal of the reservation is the fencing operation. The old owner
        // cannot renew, append or publish even if it wakes up later.
        tx.objectStore('staging').delete(stage.generationId)
        this.removeGeneration(tx, stage.generationId)
      } else live.push(stage)
    }
    return live
  }

  async settings(signal?: AbortSignal): Promise<AssetCacheSettings> {
    return this.transact('settings-read', 'readonly', async tx => ({ ...(await this.control(tx)).settings }), signal)
  }

  async stats(signal?: AbortSignal): Promise<AssetCacheStats> {
    return this.transact('stats', 'readonly', async tx => {
      const control = await this.control(tx)
      const entries = await this.manifests(tx)
      const staging = await this.stages(tx)
      return { entries, count: entries.length, committedBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
        stagingBytes: staging.reduce((sum, stage) => sum + stage.receivedSize, 0),
        reservedBytes: staging.reduce((sum, stage) => sum + stage.reservation, 0), stagingCount: staging.length,
        epoch: control.epoch, settings: control.settings }
    }, signal)
  }

  async setSettings(settings: AssetCacheSettings, signal?: AbortSignal): Promise<void> {
    const valid = requireCacheSettings(settings)
    await this.transact('settings', 'readwrite', async tx => {
      const control = await this.control(tx)
      control.settings = valid
      // Turning off fences existing writers, without deleting committed assets.
      if (!valid.enabled) {
        control.epoch++
        const stages = await this.stages(tx)
        for (const stage of stages) this.removeGeneration(tx, stage.generationId)
        tx.objectStore('staging').clear()
      } else {
        const stages = await this.expireWriters(tx)
        const entries = await this.manifests(tx)
        const victims = planAssetAdmission(0, valid.budget, entries, stages.reduce((n, s) => n + s.reservation, 0), this.livePins(control))
        for (const entry of entries) if (victims.includes(entry.generationId)) {
          tx.objectStore('entries').delete(entry.key); this.removeGeneration(tx, entry.generationId)
        }
      }
      tx.objectStore('control').put(control, 'state')
    }, signal)
  }

  async begin(value: AssetDescriptor, signal?: AbortSignal): Promise<AssetCacheWriter> {
    const descriptor = requireAssetDescriptor(value)
    checkCacheAbort(signal)
    let availableBytes: number | undefined
    try {
      const estimate = this.options.estimate ?? (typeof navigator !== 'undefined' && navigator.storage?.estimate ? () => navigator.storage.estimate() : undefined)
      const space = await estimate?.()
      if (space && Number.isFinite(space.quota) && Number.isFinite(space.usage) && space.quota! >= 0 && space.usage! >= 0) {
        availableBytes = Math.max(0, space.quota! - space.usage! - ASSET_SPACE_RESERVE)
      }
    } catch { /* Optional estimate is not a storage prerequisite on HTTP LAN. */ }
    const generationId = this.newId(), ownerId = this.newId()
    const stage = await this.transact('begin', 'readwrite', async tx => {
      const control = await this.control(tx)
      if (!control.settings.enabled) throw new AssetCacheError('disabled', 'Cache perangkat dinonaktifkan.')
      const stages = await this.expireWriters(tx)
      if (stages.some(stage => assetKeyString(stage.descriptor) === assetKeyString(descriptor))) {
        throw new AssetCacheError('busy', 'Aset sedang disimpan oleh sesi lain.')
      }
      const entries = await this.manifests(tx)
      const pins = this.livePins(control)
      if (entries.some(entry => entry.generationId === generationId) || pins.has(generationId) ||
        await request(tx.objectStore('chunks').count(this.chunkRange(generationId)))) {
        throw new AssetCacheError('busy', 'ID generation cache sudah digunakan.')
      }
      const victims = planAssetAdmission(descriptor.size, control.settings.budget, entries,
        stages.reduce((sum, stage) => sum + stage.reservation, 0), pins, availableBytes)
      for (const entry of entries) if (victims.includes(entry.generationId)) {
        tx.objectStore('entries').delete(entry.key); this.removeGeneration(tx, entry.generationId)
      }
      const stage: Staging = { generationId, ownerId, descriptor, epoch: control.epoch, expectedSize: descriptor.size,
        receivedSize: 0, chunkCount: 0, heartbeatAt: this.now(), reservation: descriptor.size }
      // add(), not put(): generation collisions must never overwrite an owner.
      tx.objectStore('staging').add(stage)
      tx.objectStore('control').put(control, 'state')
      return stage
    }, signal)
    return new AssetCacheWriter(this, stage, signal)
  }

  private async owned(tx: IDBTransaction, writer: Staging): Promise<{ control: Control; stage: Staging }> {
    const control = await this.control(tx)
    const stage = await request<Staging | undefined>(tx.objectStore('staging').get(writer.generationId))
    if (stage && !validStage(stage)) throw new AssetCacheError('corrupt', 'Reservation cache rusak.')
    if (!stage || stage.ownerId !== writer.ownerId || stage.epoch !== writer.epoch || control.epoch !== writer.epoch ||
      !control.settings.enabled || stage.heartbeatAt + ASSET_LEASE_MS <= this.now()) {
      throw new AssetCacheError('fenced', 'Sesi penyimpanan cache sudah tidak berlaku.')
    }
    return { control, stage }
  }

  async appendChunk(writer: Staging, blob: Blob, signal?: AbortSignal): Promise<void> {
    await this.transact('append', 'readwrite', async tx => {
      const { stage } = await this.owned(tx, writer)
      if (stage.chunkCount !== writer.chunkCount || stage.receivedSize !== writer.receivedSize ||
        blob.size !== assetChunkSize(stage.expectedSize, stage.chunkCount) || blob.size < 1) {
        throw new AssetCacheError('invalid', 'Urutan atau ukuran chunk cache tidak valid.')
      }
      tx.objectStore('chunks').add(blob, [stage.generationId, stage.chunkCount])
      stage.chunkCount++; stage.receivedSize += blob.size; stage.heartbeatAt = this.now()
      tx.objectStore('staging').put(stage)
    }, signal)
  }

  async heartbeat(writer: Staging, signal?: AbortSignal): Promise<void> {
    await this.transact('heartbeat', 'readwrite', async tx => {
      const { stage } = await this.owned(tx, writer)
      stage.heartbeatAt = this.now()
      tx.objectStore('staging').put(stage)
    }, signal)
  }

  async publish(writer: Staging, digest: string, signal?: AbortSignal): Promise<AssetCacheEntry> {
    return this.transact('commit', 'readwrite', async tx => {
      const { control, stage } = await this.owned(tx, writer)
      if (stage.receivedSize !== stage.expectedSize || stage.chunkCount !== assetChunkCount(stage.expectedSize) || digest !== stage.descriptor.sha256) {
        throw new AssetCacheError('corrupt', 'Ukuran atau SHA-256 aset cache tidak cocok.')
      }
      const existing = await request<AssetCacheEntry | undefined>(tx.objectStore('entries').get(assetKey(stage.descriptor)))
      if (existing && !this.livePins(control).has(existing.generationId)) this.removeGeneration(tx, existing.generationId)
      const entry: AssetCacheEntry = { ...stage.descriptor, key: assetKey(stage.descriptor), generationId: stage.generationId,
        chunkCount: stage.chunkCount, createdAt: this.now(), lastUsedAt: this.now() }
      tx.objectStore('entries').put(entry)
      tx.objectStore('staging').delete(stage.generationId)
      tx.objectStore('control').put(control, 'state')
      return entry
    }, signal)
  }

  async cancelWriter(writer: Staging): Promise<void> {
    await this.transact('cancel', 'readwrite', async tx => {
      const stage = await request<Staging | undefined>(tx.objectStore('staging').get(writer.generationId))
      if (stage?.ownerId !== writer.ownerId) return
      tx.objectStore('staging').delete(stage.generationId)
      this.removeGeneration(tx, stage.generationId)
    })
  }

  async recoverQuota(writer: Staging): Promise<boolean> {
    return this.transact('quota-cleanup', 'readwrite', async tx => {
      const { control } = await this.owned(tx, writer)
      const pins = this.livePins(control)
      const entries = await this.manifests(tx)
      const victim = entries.filter(entry => !pins.has(entry.generationId)).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
      if (!victim) return false
      tx.objectStore('entries').delete(victim.key)
      this.removeGeneration(tx, victim.generationId)
      tx.objectStore('control').put(control, 'state')
      return true
    })
  }

  async read(value: AssetDescriptor, signal?: AbortSignal): Promise<{ blob: Blob; entry: AssetCacheEntry } | null> {
    const descriptor = requireAssetDescriptor(value), token = this.newId()
    let entry: AssetCacheEntry | undefined
    let invalidGeneration: string | undefined
    let epoch = -1
    const hash = createIncrementalSha256()
    try {
      entry = await this.transact('pin', 'readwrite', async tx => {
        const control = await this.control(tx)
        if (!control.settings.enabled) return undefined
        const found = await request<AssetCacheEntry | undefined>(tx.objectStore('entries').get(assetKey(descriptor)))
        if (!found) return undefined
        invalidGeneration = found.generationId
        if (!validEntry(found) || found.size !== descriptor.size || found.url !== descriptor.url || found.consoleId !== descriptor.consoleId) {
          throw new AssetCacheError('corrupt', 'Manifest cache tidak sesuai descriptor.')
        }
        this.livePins(control)
        control.pins[token] = { generationId: found.generationId, expiresAt: this.now() + ASSET_LEASE_MS }
        epoch = control.epoch
        tx.objectStore('control').put(control, 'state')
        return found
      }, signal)
      if (!entry) return null
      const parts: Blob[] = []
      for (let index = 0; index < entry.chunkCount; index++) {
        const chunk = await this.transact('read-chunk', 'readwrite', async tx => {
          const control = await this.control(tx), pin = control.pins[token]
          if (control.epoch !== epoch || !pin || pin.expiresAt <= this.now()) throw new AssetCacheError('fenced', 'Pembacaan cache sudah tidak berlaku.')
          pin.expiresAt = this.now() + ASSET_LEASE_MS
          tx.objectStore('control').put(control, 'state')
          return request<Blob | undefined>(tx.objectStore('chunks').get([entry!.generationId, index]))
        }, signal)
        if (!(chunk instanceof Blob) || chunk.size !== assetChunkSize(entry.size, index)) throw new AssetCacheError('corrupt', 'Chunk cache hilang atau ukurannya salah.')
        checkCacheAbort(signal)
        hash.update(new Uint8Array(await chunk.arrayBuffer()))
        parts.push(chunk)
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      checkCacheAbort(signal)
      if (hash.digest() !== descriptor.sha256) throw new AssetCacheError('corrupt', 'SHA-256 cache perangkat tidak cocok.')
      // Check exact cardinality too: unexpected duplicate/out-of-range chunk
      // indices must not quietly become a valid hit.
      await this.transact('read-complete', 'readwrite', async tx => {
        const control = await this.control(tx), pin = control.pins[token]
        if (control.epoch !== epoch || !pin || pin.expiresAt <= this.now()) throw new AssetCacheError('fenced', 'Pembacaan cache sudah tidak berlaku.')
        const count = await request(tx.objectStore('chunks').count(this.chunkRange(entry!.generationId)))
        if (count !== entry!.chunkCount) throw new AssetCacheError('corrupt', 'Jumlah chunk cache tidak cocok.')
        const current = await request<AssetCacheEntry | undefined>(tx.objectStore('entries').get(entry!.key))
        if (current?.generationId === entry!.generationId) {
          current.lastUsedAt = this.now()
          tx.objectStore('entries').put(current)
        }
      }, signal)
      return { blob: new Blob(parts, { type: 'application/octet-stream' }), entry }
    } catch (error) {
      if (error instanceof AssetCacheError && error.code === 'corrupt') {
        // Conditional invalidation must not delete a newer replacement.
        await this.invalidate(descriptor, entry?.generationId ?? invalidGeneration).catch(() => {})
      }
      throw cacheStorageError(error)
    } finally {
      hash.destroy()
      await this.transact('unpin', 'readwrite', async tx => {
        const control = await this.control(tx)
        delete control.pins[token]
        tx.objectStore('control').put(control, 'state')
      }).catch(() => {})
    }
  }

  private async invalidate(descriptor: AssetDescriptor, generationId?: string): Promise<void> {
    await this.transact('invalidate', 'readwrite', async tx => {
      const entry = await request<AssetCacheEntry | undefined>(tx.objectStore('entries').get(assetKey(descriptor)))
      if (!entry || (generationId && entry.generationId !== generationId)) return
      if (!generationId && validEntry(entry)) return
      tx.objectStore('entries').delete(assetKey(descriptor))
      const control = await this.control(tx)
      if (typeof entry.generationId === 'string' && !this.livePins(control).has(entry.generationId)) this.removeGeneration(tx, entry.generationId)
    })
  }

  // User deletion fences every pending version of this catalog asset. Optional
  // sha256 scopes deletion to one version; server 404 can remove the whole ID.
  async delete(kind: AssetDescriptor['kind'], catalogId: string, sha256?: string, signal?: AbortSignal): Promise<void> {
    await this.transact('delete', 'readwrite', async tx => {
      const control = await this.control(tx), pins = this.livePins(control)
      const entries = await request<AssetCacheEntry[]>(tx.objectStore('entries').index('catalog').getAll([kind, catalogId]))
      for (const entry of entries) if (!sha256 || entry.sha256 === sha256) {
        tx.objectStore('entries').delete(entry.key)
        if (!pins.has(entry.generationId)) this.removeGeneration(tx, entry.generationId)
      }
      const stages = await request<Staging[]>(tx.objectStore('staging').index('catalog').getAll([kind, catalogId]))
      for (const stage of stages) if (!sha256 || stage.descriptor.sha256 === sha256) {
        tx.objectStore('staging').delete(stage.generationId)
        this.removeGeneration(tx, stage.generationId)
      }
      tx.objectStore('control').put(control, 'state')
    }, signal)
  }

  async clear(signal?: AbortSignal): Promise<void> {
    await this.transact('clear', 'readwrite', async tx => {
      const control = await this.control(tx)
      control.epoch++; control.pins = {}; delete control.cleanupAfter
      tx.objectStore('entries').clear(); tx.objectStore('chunks').clear(); tx.objectStore('staging').clear()
      tx.objectStore('control').put(control, 'state')
    }, signal)
  }

  async cleanup(limit = 256, signal?: AbortSignal): Promise<{ scanned: number; deleted: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 4096) throw new AssetCacheError('invalid', 'Batas pembersihan cache tidak valid.')
    return this.transact('cleanup', 'readwrite', async tx => {
      const control = await this.control(tx), pins = this.livePins(control)
      const stages = await this.expireWriters(tx)
      const entries = await this.manifests(tx)
      const live = new Set([...pins, ...stages.map(stage => stage.generationId), ...entries.map(entry => entry.generationId)])
      let scanned = 0, deleted = 0
      const range = control.cleanupAfter === undefined ? undefined : this.keyRange.lowerBound(control.cleanupAfter, true)
      // Key-only cursor: never materialize payloads for maintenance/statistics.
      await new Promise<void>((resolve, reject) => {
        const cursor = tx.objectStore('chunks').openKeyCursor(range)
        cursor.onerror = () => reject(cursor.error)
        cursor.onsuccess = () => {
          const item = cursor.result
          if (!item) { delete control.cleanupAfter; resolve(); return }
          scanned++
          const key = item.key
          if (!Array.isArray(key) || !live.has(String(key[0]))) { tx.objectStore('chunks').delete(key); deleted++ }
          control.cleanupAfter = key
          if (scanned >= limit) resolve()
          else item.continue()
        }
      })
      tx.objectStore('control').put(control, 'state')
      return { scanned, deleted }
    }, signal)
  }
}

export class AssetCacheWriter {
  private cache: AssetCache
  private stage: Staging
  private signal?: AbortSignal
  private hash = createIncrementalSha256()
  private busy = false
  private finished = false
  private aborting?: Promise<void>
  private quotaRetried = false
  private abortListener: () => void

  constructor(cache: AssetCache, stage: Staging, signal?: AbortSignal) {
    this.cache = cache; this.stage = stage; this.signal = signal
    this.abortListener = () => { void this.abort().catch(() => {}) }
    signal?.addEventListener('abort', this.abortListener, { once: true })
    if (signal?.aborted) this.abortListener()
  }

  get generationId(): string { return this.stage.generationId }

  private enter(): void {
    checkCacheAbort(this.signal)
    if (this.finished) throw new AssetCacheError('fenced', 'Writer cache sudah selesai.')
    if (this.busy) throw new AssetCacheError('busy', 'Operasi writer cache harus berurutan.')
    this.busy = true
  }

  private finish(): void {
    this.finished = true
    this.signal?.removeEventListener('abort', this.abortListener)
    this.hash.destroy()
  }

  async append(blob: Blob): Promise<void> {
    this.enter()
    try {
      if (!(blob instanceof Blob) || blob.size !== assetChunkSize(this.stage.expectedSize, this.stage.chunkCount) || blob.size < 1) {
        throw new AssetCacheError('invalid', 'Ukuran chunk cache tidak valid.')
      }
      // One bounded buffer, outside any IDB transaction. Retain the same Blob
      // for the single permitted quota retry; never fetch bytes again.
      const bytes = new Uint8Array(await blob.arrayBuffer())
      checkCacheAbort(this.signal)
      if (this.finished) throw new AssetCacheError('fenced', 'Writer cache sudah selesai.')
      try { await this.cache.appendChunk(this.stage, blob, this.signal) }
      catch (error) {
        if (!(error instanceof AssetCacheError) || error.code !== 'quota' || this.quotaRetried) throw error
        this.quotaRetried = true
        if (!await this.cache.recoverQuota(this.stage)) throw error
        await this.cache.appendChunk(this.stage, blob, this.signal)
      }
      checkCacheAbort(this.signal)
      if (this.finished) throw new AssetCacheError('fenced', 'Writer cache sudah selesai.')
      this.hash.update(bytes)
      this.stage.chunkCount++; this.stage.receivedSize += blob.size
    } catch (error) { await this.abort().catch(() => {}); throw cacheStorageError(error) }
    finally { this.busy = false }
  }

  async heartbeat(): Promise<void> {
    this.enter()
    try { await this.cache.heartbeat(this.stage, this.signal) }
    finally { this.busy = false }
  }

  async commit(): Promise<AssetCacheEntry> {
    this.enter()
    try {
      const digest = this.hash.digest()
      const entry = await this.cache.publish(this.stage, digest, this.signal)
      this.finish()
      return entry
    } catch (error) { await this.abort().catch(() => {}); throw cacheStorageError(error) }
    finally { this.busy = false }
  }

  async abort(): Promise<void> {
    // The signal listener can already be cancelling when resolver.finally also
    // calls abort(). Both must await transaction completion before closing DB.
    if (this.aborting) return this.aborting
    if (this.finished) return
    this.finish()
    this.aborting = this.cache.cancelWriter(this.stage)
    await this.aborting
  }
}
