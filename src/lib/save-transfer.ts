import { SaveClient, SaveError, readStateMetadata, readServerSave } from './saves.ts'
import type { StateMetadata, ServerSave } from './saves.ts'
import { readGameSave } from './game-saves.ts'
import type { ServerGameSave } from './game-saves.ts'
import { hashRom } from './identity.ts'

export type SaveKind = 'state' | 'progress'
export type TransferSave = ServerSave | ServerGameSave
export type Operation = { id: string; action: 'replace' | 'preserve'; reason: 'conflict' | 'import' | 'restore' }
export type SaveTarget = { gameId: string; consoleId: string; core: string; title: string; slot?: number }
export type Backup = SaveTarget & { id: string; kind: SaveKind; slot: number; size: number; checksum: string; metadata: StateMetadata; sourceRevision: number | null; createdAt: number; reason: string }
const route = (kind: SaveKind) => kind === 'state' ? '/api/saves/' : '/api/game-saves/'
export class TransferClient extends SaveClient {
  async current(kind: SaveKind, target: SaveTarget) {
    const { data } = await this.fetch(route(kind), { headers: { 'X-Save-User': this.userId } })
    const list = data as { saves?: unknown[] }
    if (!Array.isArray(list?.saves) || list.saves.length > 5000) throw new SaveError('Daftar server tidak valid.')
    const saves = list.saves.map(s => kind === 'state' ? readServerSave(s) : readGameSave(s))
    if (saves.some(s => !s)) throw new SaveError('Metadata server tidak valid.')
    return saves.find(s => s!.gameId === target.gameId && s!.core === target.core && s!.consoleId === target.consoleId && (kind !== 'state' || (s as ServerSave).slot === target.slot)) ?? null
  }
  async bytes(kind: SaveKind, save: TransferSave) {
    const { data, response } = await this.fetch(route(kind) + save.id, { headers: { 'X-Save-User': this.userId } })
    let actual: TransferSave | null = null
    try { const v = JSON.parse(decodeURIComponent(response.headers.get('x-save-metadata') ?? '')); actual = kind === 'state' ? readServerSave(v) : readGameSave(v) } catch { /* reject below */ }
    if (!actual || actual.id !== save.id || actual.revision !== save.revision || actual.checksum !== save.checksum || !(data instanceof Uint8Array) || data.length !== save.size || await hashRom(new Blob([new Uint8Array(data)])) !== save.checksum) throw new SaveError('Versi server berubah/rusak. Tinjau ulang.', 409, 'REVISION_CONFLICT')
    return data
  }
  async decide(kind: SaveKind, bytes: Uint8Array, target: SaveTarget, metadata: StateMetadata, revision: number, operation: Operation) {
    const checksum = await hashRom(new Blob([new Uint8Array(bytes)]))
    const { data } = await this.fetch(route(kind), { method: 'PUT', headers: { ...await this.headers(true), 'X-Save-Metadata': encodeURIComponent(JSON.stringify({ ...target, metadata, expectedRevision: revision, checksum, operation })) }, body: new Uint8Array(bytes) })
    const result = data as { save: unknown; backupId: string | null }
    const save = result?.save === null ? null : kind === 'state' ? readServerSave(result?.save) : readGameSave(result?.save)
    if (!result || result.save !== null && !save || result.backupId !== null && (typeof result.backupId !== 'string' || !/^[a-f0-9-]{36}$/.test(result.backupId))) throw new SaveError('Konfirmasi keputusan tidak valid. Retry keputusan yang sama.')
    if (operation.action === 'replace' && (!save || save.checksum !== checksum || save.size !== bytes.length || save.revision !== revision + 1 || save.gameId !== target.gameId || save.core !== target.core || save.consoleId !== target.consoleId || kind === 'state' && (save as ServerSave).slot !== target.slot)) throw new SaveError('Konfirmasi penggantian tidak sesuai. Retry keputusan yang sama.')
    if (operation.action === 'preserve' && (!result.backupId || (save?.revision ?? 0) !== revision)) throw new SaveError('Konfirmasi cadangan tidak sesuai. Retry keputusan yang sama.')
    return save
  }
  async backups() {
    const { data } = await this.fetch('/api/save-backups/', { headers: { 'X-Save-User': this.userId } })
    const v = data as { backups: Backup[]; usage: { usedBytes: number; quotaBytes: number } }
    if (!v || !Array.isArray(v.backups) || v.backups.length > 5000 || !v.usage || !Number.isSafeInteger(v.usage.usedBytes) || !Number.isSafeInteger(v.usage.quotaBytes)) throw new SaveError('Daftar cadangan tidak valid.')
    for (const b of v.backups) if (!b || !['state', 'progress'].includes(b.kind) || typeof b.id !== 'string' || !/^[a-f0-9-]{36}$/.test(b.id) || !Number.isSafeInteger(b.size) || b.size < 1 || b.size > 64 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(b.checksum) || !readStateMetadata(b.metadata)) throw new SaveError('Metadata cadangan tidak valid.')
    return v
  }
  async backupBytes(b: Backup) {
    const { data } = await this.fetch('/api/save-backups/' + b.id, { headers: { 'X-Save-User': this.userId } })
    if (!(data instanceof Uint8Array) || data.length !== b.size || await hashRom(new Blob([new Uint8Array(data)])) !== b.checksum) throw new SaveError('Checksum cadangan tidak sesuai.')
    return data
  }
  async removeBackup(b: Backup) {
    await this.fetch('/api/save-backups/' + b.id + '/delete', { method: 'POST', headers: await this.headers(), body: JSON.stringify({ checksum: b.checksum }) })
  }
}

export function validateImport(bytes: Uint8Array, kind: SaveKind, core: string) {
  const prefix = new TextDecoder().decode(bytes.subarray(0, 7))
  if (kind === 'state') {
    if (bytes.length < 32 || bytes.length > 64 * 1024 * 1024 || prefix !== 'RASTATE') throw new SaveError('Berkas bukan save state RASTATE yang didukung.')
  } else {
    if (!['fceumm', 'pcsx_rearmed'].includes(core) || !bytes.length || bytes.length > 8 * 1024 * 1024 - 4096 || prefix === 'RASTATE' || prefix.startsWith('NES\x1a') || prefix.startsWith('PK\x03\x04') || core === 'pcsx_rearmed' && bytes.length !== 131072) throw new SaveError('Berkas bukan native .srm pada layout yang dicakup (PS1: 128 KiB). Tidak ada konversi ROM/arsip/memcard eksternal.')
  }
  return bytes
}

// Only an explicitly selected key is read. No EJS_STORAGE.get(): that helper
// opens readwrite transactions and creates databases on an absent origin.
export function browserSaveBytes(value: unknown, kind: SaveKind): Uint8Array | null {
  if (!(value instanceof Uint8Array || value instanceof Int8Array) || !value.byteLength || value.byteLength > (kind === 'state' ? 64 : 8) * 1024 * 1024) return null
  return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
}
export function readBrowserSave(kind: SaveKind, stateKey: string, progressPath: string | null): Promise<Uint8Array> {
  const name = kind === 'state' ? 'EmulatorJS-states' : '/data/saves'
  const store = kind === 'state' ? 'states' : 'FILE_DATA'
  const key = kind === 'state' ? stateKey : progressPath
  if (!key || !key.length || key.length > 512 || kind === 'progress' && !/^\/data\/saves\/(FCEUmm|PCSX-ReARMed)\/[^/\\\x00-\x1f]+\.srm$/.test(key)) return Promise.reject(new SaveError('Key browser tidak cocok dengan layout runtime.'))
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new SaveError('Penyimpanan browser tidak tersedia.')); return }
    let db: IDBDatabase | undefined
    let settled = false
    let transaction: IDBTransaction | undefined
    const finish = (bytes?: Uint8Array, message = 'Save browser tidak ditemukan pada origin/profil ini.') => {
      if (settled) return
      settled = true; clearTimeout(timer); db?.close()
      if (bytes) resolve(bytes); else reject(new SaveError(message))
    }
    const timer = setTimeout(() => { transaction?.abort(); finish(undefined, 'Pembacaan storage browser terlalu lama/terblokir.') }, 10000)
    const request = indexedDB.open(name)
    request.onupgradeneeded = () => { request.transaction?.abort() }
    request.onerror = () => finish(undefined, request.error?.name === 'AbortError' ? undefined : 'Penyimpanan browser ditolak/rusak; bukan bukti save kosong.')
    request.onblocked = () => finish(undefined, 'Storage browser terkunci. Tutup sesi tamu lain dahulu.')
    request.onsuccess = () => {
      db = request.result
      if (settled) { db.close(); return }
      try {
        if (!db.objectStoreNames.contains(store)) { finish(); return }
        transaction = db.transaction(store, 'readonly')
        const read = transaction.objectStore(store).get(key)
        let bytes: Uint8Array | undefined
        read.onsuccess = () => {
          const value = kind === 'state' ? read.result : read.result?.contents
          // Emscripten's packaged IDBFS stores native SRAM as Int8Array;
          // browser states use Uint8Array. Copy bytes, never reinterpret values
          // as text or assume all persisted binary views are unsigned.
          bytes = browserSaveBytes(value, kind) ?? undefined
        }
        transaction.oncomplete = () => finish(bytes)
        transaction.onabort = transaction.onerror = () => finish(undefined, 'Pembacaan save browser gagal; sumber tidak diubah.')
      } catch { finish(undefined, 'Skema storage browser tidak dikenali; gunakan ekspor file dari sesi tamu.') }
    }
  })
}
