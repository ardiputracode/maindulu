import { openAssetCache } from './asset-cache.ts'
import type { AssetCache, AssetCacheWriter } from './asset-cache.ts'
import { ASSET_CHUNK_SIZE, AssetCacheError, cacheStorageError, catalogAssetDescriptor, requireAssetDescriptor } from './asset-cache-policy.ts'
import type { AssetCacheErrorCode, AssetDescriptor } from './asset-cache-policy.ts'
import { CatalogRequestError, latestCatalogEntry } from './catalog.ts'
import { createIncrementalSha256 } from './identity.ts'

export type ServerAssetErrorCode = 'invalid' | 'changed' | 'unavailable' | 'http' | 'validator' |
  'integrity' | 'network' | 'timeout' | 'aborted' | 'unsupported-stream'
export class ServerAssetError extends Error {
  readonly code: ServerAssetErrorCode
  readonly status?: number
  constructor(code: ServerAssetErrorCode, message: string, options?: ErrorOptions & { status?: number }) {
    super(message, options); this.name = 'ServerAssetError'; this.code = code; this.status = options?.status
  }
}
export type AssetPreparationProgress = {
  phase: 'metadata' | 'checking' | 'reading-cache' | 'downloading' | 'verifying' | 'saving' | 'ready';
  kind: AssetDescriptor['kind']; receivedBytes: number; totalBytes: number;
}
export type PreparedServerAsset = {
  descriptor: AssetDescriptor; blob: Blob; source: 'indexeddb' | 'network';
  persistence: 'reused' | 'stored' | 'not-stored'; transferredBytes: number;
  warnings: { code: AssetCacheErrorCode; message: string }[];
}
// The resolver owns connections opened by this factory and closes them after
// settlement. Inject adapters for tests, never an application-wide shared owner.
export type ServerAssetResolverOptions = {
  origin?: string; fetch?: typeof fetch; latest?: typeof latestCatalogEntry;
  openCache?: () => Promise<Pick<AssetCache, 'read' | 'begin' | 'delete' | 'close'>>;
  cacheEnabled?: boolean; connectionTimeoutMs?: number; idleTimeoutMs?: number;
}
type ResolveOptions = { signal?: AbortSignal; onProgress?: (progress: AssetPreparationProgress) => void }
const aborted = () => new ServerAssetError('aborted', 'Persiapan aset dibatalkan.')
function checkAbort(signal: AbortSignal) { if (signal.aborted) throw aborted() }
const descriptorIdentity = (value: AssetDescriptor) => JSON.stringify([
  value.kind, value.catalogId, value.sha256, value.size, value.fileName, value.url, value.consoleId,
])

// Unlike a bare Promise.race, this removes its listener on every settlement and
// observes late rejection. Also fences injected APIs that ignore cancellation.
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const detach = () => signal.removeEventListener('abort', abort)
    const abort = () => { detach(); reject(signal.reason ?? aborted()) }
    if (signal.aborted) { promise.catch(() => {}); abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { detach(); resolve(value) }, error => { detach(); reject(error) })
  })
}

function networkScope(parent: AbortSignal) {
  const controller = new AbortController()
  const abort = () => controller.abort(aborted())
  parent.addEventListener('abort', abort, { once: true })
  if (parent.aborted) abort()
  return {
    signal: controller.signal,
    async wait<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
      const timer = setTimeout(() => controller.abort(new ServerAssetError('timeout', 'Transfer aset terlalu lama tidak merespons. Coba lagi.')), milliseconds)
      try { return await abortable(promise, controller.signal) }
      catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason
        if (error instanceof ServerAssetError) throw error
        throw new ServerAssetError('network', 'Koneksi aset terputus. Periksa koneksi lalu coba lagi.', { cause: error })
      } finally { clearTimeout(timer) }
    },
    close() { parent.removeEventListener('abort', abort) },
  }
}

function validateResponse(response: Response, url: string, descriptor: AssetDescriptor) {
  if (response.status === 404 || response.status === 410) {
    throw new ServerAssetError('unavailable', 'ROM/BIOS server sudah dihapus atau tidak tersedia.', { status: response.status })
  }
  if (response.status !== 200) throw new ServerAssetError('http', `Aset server belum dapat dipakai (HTTP ${response.status}). Coba lagi.`, { status: response.status })
  if (response.redirected || response.type === 'opaqueredirect' || (response.url && response.url !== url)) {
    throw new ServerAssetError('validator', 'Sumber aset berpindah. Muat ulang entri katalog.')
  }
  const length = response.headers.get('content-length'), type = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!length || !/^[1-9]\d*$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) !== descriptor.size ||
    response.headers.get('etag') !== `"${descriptor.sha256}"` || /(?:text\/html|application\/xhtml\+xml)/.test(type) ||
    response.headers.has('content-range')) {
    throw new ServerAssetError('validator', 'Ukuran, jenis, atau ETag aset tidak sesuai katalog. Muat ulang entri sebelum bermain.')
  }
}

async function prepare(value: AssetDescriptor, options: ServerAssetResolverOptions, signal: AbortSignal,
  progress: (progress: AssetPreparationProgress) => void): Promise<PreparedServerAsset> {
  let descriptor = value, receivedBytes = 0
  const emit = (phase: AssetPreparationProgress['phase']) => { checkAbort(signal); progress({ phase, kind: descriptor.kind, receivedBytes, totalBytes: descriptor.size }) }
  const warnings: PreparedServerAsset['warnings'] = []
  const warn = (error: unknown) => {
    checkAbort(signal)
    const storage = cacheStorageError(error)
    if (!warnings.some(warning => warning.code === storage.code)) warnings.push({ code: storage.code, message: storage.message })
  }
  let cache: Awaited<ReturnType<NonNullable<ServerAssetResolverOptions['openCache']>>> | undefined
  let writer: Pick<AssetCacheWriter, 'append' | 'commit' | 'abort'> | undefined
  let cacheAttempted = false
  const connect = async (invalidate = false) => {
    if (cacheAttempted || options.cacheEnabled === false && !invalidate) return
    cacheAttempted = true
    try {
      const opening = (options.openCache ?? openAssetCache)().then(connection => {
        if (signal.aborted) { connection.close(); throw aborted() }
        cache = connection
        return connection
      })
      cache = await abortable(opening, signal)
      checkAbort(signal)
    }
    catch (error) { warn(error) }
  }
  const stopWriting = async (error: unknown) => {
    warn(error)
    const current = writer; writer = undefined
    await current?.abort().catch(warn)
  }
  try {
    let origin: string
    try { origin = new URL(options.origin ?? globalThis.location?.origin).origin }
    catch (error) { throw new ServerAssetError('invalid', 'Origin aset tidak valid.', { cause: error }) }
    if (!/^https?:\/\//.test(origin)) throw new ServerAssetError('invalid', 'Origin aset harus HTTP atau HTTPS.')
    const url = new URL(descriptor.url, origin).href
    emit('metadata')
    const latest = await abortable((options.latest ?? latestCatalogEntry)(descriptor.kind === 'rom' ? 'games' : 'bios', descriptor.catalogId, signal), signal)
    checkAbort(signal)
    let fresh: AssetDescriptor
    try { fresh = catalogAssetDescriptor(descriptor.kind, latest) }
    catch (error) { throw new ServerAssetError('changed', 'Metadata aset berubah atau tidak valid. Buka ulang entri katalog.', { cause: error }) }
    if (descriptorIdentity(fresh) !== descriptorIdentity(descriptor)) {
      throw new ServerAssetError('changed', 'Aset berubah sejak dipilih. Buka ulang entri katalog sebelum bermain.')
    }
    descriptor = fresh // Label edits do not change byte/save identity.
    emit('checking')
    const fetcher = options.fetch ?? globalThis.fetch
    const connectionMs = options.connectionTimeoutMs ?? 30000, idleMs = options.idleTimeoutMs ?? 60000
    const head = networkScope(signal)
    try {
      const response = await head.wait(fetcher(url, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', signal: head.signal }), connectionMs)
      try { validateResponse(response, url, descriptor) }
      finally { void response.body?.cancel().catch(() => {}) }
    } finally { head.close() }
    // A disabled/unavailable DB never bypasses the fresh origin check above.
    await connect()
    if (cache) {
      emit('reading-cache')
      try {
        const hit = await cache.read(descriptor, signal)
        checkAbort(signal)
        if (hit) {
          emit('ready')
          return { descriptor, blob: hit.blob, source: 'indexeddb', persistence: 'reused', transferredBytes: 0, warnings }
        }
      } catch (error) {
        warn(error) // M1 conditionally invalidates the corrupt generation itself.
        if (!(error instanceof AssetCacheError) || error.code !== 'corrupt') { cache.close(); cache = undefined }
      }
      if (cache) {
        try { writer = await cache.begin(descriptor, signal); checkAbort(signal) }
        catch (error) { warn(error) }
      }
    } else if (options.cacheEnabled === false) warn(new AssetCacheError('disabled', 'Cache perangkat dinonaktifkan.'))

    const get = networkScope(signal), hash = createIncrementalSha256()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const chunks: Blob[] = []
    let pending: Blob[] = [], pendingSize = 0
    const flush = async () => {
      const blob = new Blob(pending, { type: 'application/octet-stream' })
      pending = []; pendingSize = 0; chunks.push(blob)
      if (writer) {
        try { await writer.append(blob); checkAbort(signal) }
        catch (error) { await stopWriting(error) }
      }
      // Bound buffers and let rendering/cancellation run between storage chunks.
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      checkAbort(signal)
    }
    try {
      emit('downloading')
      const response = await get.wait(fetcher(url, { method: 'GET', cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', signal: get.signal }), connectionMs)
      try { validateResponse(response, url, descriptor) }
      catch (error) { void response.body?.cancel().catch(() => {}); throw error }
      if (!response.body || typeof response.body.getReader !== 'function') {
        throw new ServerAssetError('unsupported-stream', 'Browser tidak mendukung download streaming aset. Gunakan browser yang lebih baru.')
      }
      reader = response.body.getReader()
      for (;;) {
        const { value: bytes, done } = await get.wait(reader.read(), idleMs)
        checkAbort(signal)
        if (done) break
        if (!(bytes instanceof Uint8Array)) throw new ServerAssetError('integrity', 'Stream aset bukan byte yang valid.')
        if (bytes.length > descriptor.size - receivedBytes) throw new ServerAssetError('integrity', 'Body aset melebihi ukuran katalog.')
        hash.update(bytes); receivedBytes += bytes.length
        for (let offset = 0; offset < bytes.length;) {
          const count = Math.min(ASSET_CHUNK_SIZE - pendingSize, bytes.length - offset)
          pending.push(new Blob([bytes.subarray(offset, offset + count)])); pendingSize += count; offset += count
          if (pendingSize === ASSET_CHUNK_SIZE) await flush()
        }
        emit('downloading')
      }
      emit('verifying')
      if (receivedBytes !== descriptor.size || hash.digest() !== descriptor.sha256) {
        throw new ServerAssetError('integrity', 'Ukuran atau SHA-256 hasil download tidak cocok. Aset tidak dijalankan atau disimpan.')
      }
      if (pendingSize) await flush()
      let persistence: PreparedServerAsset['persistence'] = 'not-stored'
      if (writer) {
        emit('saving')
        try { await writer.commit(); checkAbort(signal); writer = undefined; persistence = 'stored' }
        catch (error) { await stopWriting(error) }
      }
      emit('ready')
      return { descriptor, blob: new Blob(chunks, { type: 'application/octet-stream' }), source: 'network', persistence, transferredBytes: receivedBytes, warnings }
    } finally {
      hash.destroy(); get.close()
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock() }
    }
  } catch (error) {
    if (signal.aborted) throw aborted()
    const removed = error instanceof CatalogRequestError && (error.status === 404 || error.status === 410) ||
      error instanceof ServerAssetError && error.code === 'unavailable'
    if (removed) {
      await connect(true)
      try { await cache?.delete(descriptor.kind, descriptor.catalogId, undefined, signal) }
      catch { /* Preserve the fatal source failure even when invalidation fails. */ }
      throw new ServerAssetError('unavailable', 'ROM/BIOS server sudah dihapus atau tidak tersedia.', { status: error.status, cause: error })
    }
    if (error instanceof ServerAssetError) throw error
    if (error instanceof CatalogRequestError) throw new ServerAssetError('http', error.message, { status: error.status, cause: error })
    throw new ServerAssetError('network', error instanceof Error ? error.message : 'Persiapan aset server gagal.', { cause: error })
  } finally {
    await writer?.abort().catch(() => {})
    cache?.close()
  }
}

type Subscriber = { resolve: (value: PreparedServerAsset) => void; reject: (error: unknown) => void;
  progress?: ResolveOptions['onProgress']; detach: () => void }
type Flight = { controller: AbortController; subscribers: Set<Subscriber>; progress?: AssetPreparationProgress }

// One factory per tab/lifecycle. Settled tasks are never memoized: every new
// launch must validate origin again. Each subscriber owns ONLY its subscription;
// the shared fetch is aborted immediately when the last subscriber leaves.
export function createServerAssetResolver(options: ServerAssetResolverOptions = {}) {
  for (const timeout of [options.connectionTimeoutMs, options.idleTimeoutMs]) {
    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647)) throw new ServerAssetError('invalid', 'Timeout aset tidak valid.')
  }
  const flights = new Map<string, Flight>(), running = new Set<Promise<void>>()
  let closed = false
  return {
    resolve(value: AssetDescriptor, subscriber: ResolveOptions = {}): Promise<PreparedServerAsset> {
      let descriptor: AssetDescriptor
      try { descriptor = requireAssetDescriptor(value) }
      catch (error) { return Promise.reject(new ServerAssetError('invalid', 'Descriptor aset backend tidak valid.', { cause: error })) }
      if (closed || subscriber.signal?.aborted) return Promise.reject(aborted())
      const key = descriptorIdentity(descriptor)
      let flight = flights.get(key)
      const isNew = !flight
      if (!flight) { flight = { controller: new AbortController(), subscribers: new Set() }; flights.set(key, flight) }
      const current = flight
      const notify = (progress: AssetPreparationProgress, target: Subscriber) => {
        try { target.progress?.({ ...progress }) } catch { /* Observers cannot fail transfer/storage. */ }
      }
      const result = new Promise<PreparedServerAsset>((resolve, reject) => {
        const abort = () => {
          target.detach(); current.subscribers.delete(target); reject(aborted())
          if (!current.subscribers.size) {
            if (flights.get(key) === current) flights.delete(key)
            current.controller.abort()
          }
        }
        const target: Subscriber = { resolve, reject, progress: subscriber.onProgress,
          detach: () => subscriber.signal?.removeEventListener('abort', abort) }
        current.subscribers.add(target)
        subscriber.signal?.addEventListener('abort', abort, { once: true })
        if (current.progress) notify(current.progress, target)
      })
      if (isNew) {
        const task = prepare(descriptor, options, current.controller.signal, progress => {
          current.progress = progress
          for (const target of current.subscribers) notify(progress, target)
        }).then(value => {
          if (flights.get(key) === current) flights.delete(key)
          for (const target of current.subscribers) { target.detach(); target.resolve(value) }
        }, error => {
          if (flights.get(key) === current) flights.delete(key)
          for (const target of current.subscribers) { target.detach(); target.reject(error) }
        }).finally(() => { current.subscribers.clear(); running.delete(task) })
        running.add(task)
      }
      return result
    },
    async close(): Promise<void> {
      closed = true
      for (const flight of flights.values()) flight.controller.abort()
      flights.clear()
      await Promise.allSettled([...running])
    },
  }
}
