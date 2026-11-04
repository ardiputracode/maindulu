// Test-only M0 prototype. Not the production schema: no budget, race/abort
// fencing, leases or recovery. M1 must implement and test those separately.
import { sha256 } from '@noble/hashes/sha2.js'

const DB_NAME = 'maindulu-asset-cache-m0-spike'
const CHUNK_SIZE = 4 * 1024 * 1024
const hex = (bytes: Uint8Array) => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
async function open() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => { request.result.createObjectStore('chunks'); request.result.createObjectStore('entries') }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('M0 database blocked'))
  })
}
async function put(db: IDBDatabase, store: string, key: IDBValidKey, value: unknown) {
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, 'readwrite')
    transaction.objectStore(store).put(value, key)
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('M0 write aborted'))
  })
}
async function get<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, 'readonly')
    const request = transaction.objectStore(store).get(key)
    transaction.oncomplete = () => resolve(request.result as T)
    transaction.onabort = () => reject(transaction.error)
  })
}

export async function writeChunkSpike(url: string, size: number, expected: string) {
  const db = await open(), hash = sha256.create()
  const start = performance.now()
  let heartbeat = 0, maxGapMs = 0, lastBeat = start
  const timer = setInterval(() => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - lastBeat); lastBeat = now; heartbeat++ }, 50)
  try {
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok || Number(response.headers.get('content-length')) !== size) throw new Error('M0 invalid response')
    const reader = response.body!.getReader()
    let buffer = new Uint8Array(CHUNK_SIZE), used = 0, received = 0, index = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      hash.update(value); received += value.length
      if (received > size) throw new Error('M0 oversized body')
      for (let offset = 0; offset < value.length;) {
        const length = Math.min(CHUNK_SIZE - used, value.length - offset)
        buffer.set(value.subarray(offset, offset + length), used); used += length; offset += length
        if (used === CHUNK_SIZE) {
          await put(db, 'chunks', [url, index++], new Blob([buffer]))
          buffer = new Uint8Array(CHUNK_SIZE); used = 0
        }
      }
    }
    if (used) await put(db, 'chunks', [url, index++], new Blob([buffer.subarray(0, used)]))
    const checksum = hex(hash.digest())
    if (received !== size || checksum !== expected) throw new Error('M0 checksum mismatch')
    await put(db, 'entries', url, { size, checksum, count: index })
    return { size: received, checksum, chunks: index, elapsedMs: performance.now() - start, heartbeat, maxGapMs }
  } finally { clearInterval(timer); hash.destroy(); db.close() }
}

export async function readChunkSpike(url: string, expected: string) {
  const db = await open(), hash = sha256.create()
  const start = performance.now()
  try {
    const entry = await get<{ size: number; checksum: string; count: number }>(db, 'entries', url)
    if (!entry || entry.checksum !== expected) throw new Error('M0 entry missing')
    const parts: Blob[] = []
    let size = 0
    for (let index = 0; index < entry.count; index++) {
      const chunk = await get<Blob>(db, 'chunks', [url, index])
      if (!(chunk instanceof Blob) || chunk.size !== Math.min(CHUNK_SIZE, entry.size - size)) throw new Error('M0 chunk invalid')
      hash.update(new Uint8Array(await chunk.arrayBuffer()))
      size += chunk.size; parts.push(chunk)
    }
    const checksum = hex(hash.digest())
    if (size !== entry.size || checksum !== expected) throw new Error('M0 read checksum mismatch')
    return { blob: new Blob(parts, { type: 'application/octet-stream' }), summary: { size, checksum, chunks: entry.count, elapsedMs: performance.now() - start } }
  } finally { hash.destroy(); db.close() }
}
