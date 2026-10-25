import { readStateMetadata, SaveClient, SaveError } from './saves.ts'
import type { StateMetadata } from './saves.ts'
import { decodeGameSave, gameSaveLayout, MAX_GAME_SAVE_BYTES } from './game-save-format.ts'
import type { GameSaveLayout } from './game-save-format.ts'
import { hashRom } from './identity.ts'

export type GameSaveMetadata = StateMetadata & { layout: GameSaveLayout }
export type ServerGameSave = { id: string; gameId: string; consoleId: string; core: string; title: string; revision: number; size: number; checksum: string; deleted: boolean; updatedAt: number; metadata: GameSaveMetadata }
export type GameSaveList = { saves: ServerGameSave[]; usage: { usedBytes: number; quotaBytes: number; maxGameSaveBytes: number } }
export function readGameSave(value: unknown): ServerGameSave | null {
  if (!value || typeof value !== 'object') return null
  const v = value as ServerGameSave
  const m = readStateMetadata(v.metadata)
  if (!m || !gameSaveLayout(v.core) || v.metadata.layout !== gameSaveLayout(v.core) || typeof v.id !== 'string' || !/^[a-f0-9-]{36}$/.test(v.id) || typeof v.gameId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(v.gameId) || !['nes', 'psx'].includes(v.consoleId) || (v.consoleId === 'nes' ? v.core !== 'fceumm' : v.core !== 'pcsx_rearmed') || typeof v.title !== 'string' || v.title.length > 200 || !Number.isSafeInteger(v.revision) || v.revision < 1 || !Number.isSafeInteger(v.size) || v.size < 0 || v.size > MAX_GAME_SAVE_BYTES || !/^[a-f0-9]{64}$/.test(v.checksum) || typeof v.deleted !== 'boolean' || !Number.isSafeInteger(v.updatedAt)) return null
  if (v.deleted ? v.size !== 0 : v.size < 13) return null
  return { id: v.id, gameId: v.gameId, consoleId: v.consoleId, core: v.core, title: v.title, revision: v.revision, size: v.size, checksum: v.checksum, deleted: v.deleted, updatedAt: v.updatedAt, metadata: { ...m, layout: v.metadata.layout } }
}
export class GameSaveClient extends SaveClient {
  async listProgress(): Promise<GameSaveList> {
    const { data } = await this.fetch('/api/game-saves/', { headers: { 'X-Save-User': this.userId } })
    const v = data as GameSaveList
    if (!v || !Array.isArray(v.saves) || v.saves.length > 5000 || !v.usage || ![v.usage.usedBytes, v.usage.quotaBytes, v.usage.maxGameSaveBytes].every(Number.isSafeInteger) || v.usage.usedBytes < 0 || v.usage.quotaBytes < 1024 || v.usage.maxGameSaveBytes < 1024 || v.usage.maxGameSaveBytes > MAX_GAME_SAVE_BYTES) throw new SaveError('Daftar progres tidak valid. Game tidak dimulai.')
    const saves = v.saves.map(readGameSave)
    if (saves.some(s => !s)) throw new SaveError('Metadata progres tidak valid. Game tidak dimulai.')
    return { saves: saves as ServerGameSave[], usage: v.usage }
  }
  async getProgress(save: ServerGameSave) {
    const { data, response } = await this.fetch('/api/game-saves/' + save.id, { headers: { 'X-Save-User': this.userId } })
    let actual: ServerGameSave | null = null
    try { actual = readGameSave(JSON.parse(decodeURIComponent(response.headers.get('x-save-metadata') ?? ''))) } catch { /* reject below */ }
    if (!(data instanceof Uint8Array) || !actual || actual.id !== save.id || actual.revision !== save.revision || actual.checksum !== save.checksum || actual.deleted || data.length !== save.size || await hashRom(new Blob([new Uint8Array(data)])) !== save.checksum || decodeGameSave(data).layout !== save.metadata.layout) throw new SaveError('Progres berubah/rusak. Coba muat ulang; jangan mulai baru.', 409, 'REVISION_CONFLICT')
    return data
  }
  async putProgress(bytes: Uint8Array, metadata: Record<string, unknown>) {
    const headers = await this.headers(true)
    const { data } = await this.fetch('/api/game-saves/', { method: 'PUT', headers: { ...headers, 'X-Save-Metadata': encodeURIComponent(JSON.stringify(metadata)) }, body: new Uint8Array(bytes) })
    const save = readGameSave((data as { save?: unknown })?.save)
    if (!save || save.gameId !== metadata.gameId || save.core !== metadata.core || save.consoleId !== metadata.consoleId || save.checksum !== metadata.checksum || save.deleted || save.size !== bytes.length || save.revision !== Number(metadata.expectedRevision) + 1) throw new SaveError('Konfirmasi progres tidak valid. Unduh cadangan sebelum mencoba lagi.')
    return save
  }
  async removeProgress(save: ServerGameSave) {
    await this.fetch('/api/game-saves/' + save.id + '/delete', { method: 'POST', headers: await this.headers(), body: JSON.stringify({ expectedRevision: save.revision }) })
  }
}

export type ProgressStatus = 'loading' | 'ready' | 'saving' | 'saved' | 'failed' | 'conflict' | 'stopped'
export type ProgressView = { status: ProgressStatus; message: string; pending: boolean }
type Pending = { bytes: Uint8Array; checksum: string; revision: number; metadata: GameSaveMetadata }
type Identity = { gameId: string; consoleId: string; core: string; title: string }
// One account/session owns this controller for its entire lifetime. No persisted
// queue, rebinding, revision refresh, or last-write-wins conflict resolution.
export class GameSaveSync {
  private revision = 0
  private checksum = ''
  private pending: Pending | null = null
  private latest: Uint8Array | null = null
  private closed = false
  private initialized = false
  private blocked = false
  private held = false
  private retries = 0
  private retryAt = 0
  private operation: Promise<boolean> | null = null
  private maxBytes = MAX_GAME_SAVE_BYTES
  private metadata: GameSaveMetadata | null = null
  private client: GameSaveClient
  private identity: Identity
  private capture: () => Promise<Uint8Array | null>
  private notify: (view: ProgressView) => void
  constructor(client: GameSaveClient, identity: Identity, capture: () => Promise<Uint8Array | null>, notify: (view: ProgressView) => void) {
    this.client = client; this.identity = identity; this.capture = capture; this.notify = notify
  }
  private report(status: ProgressStatus, message: string) { if (!this.closed) this.notify({ status, message, pending: !!this.pending }) }
  async prepare() {
    this.report('loading', 'Mengambil progres server sebelum game dimulai…')
    const list = await this.client.listProgress()
    const saved = list.saves.find(s => s.gameId === this.identity.gameId && s.consoleId === this.identity.consoleId && s.core === this.identity.core)
    const bytes = saved && !saved.deleted ? await this.client.getProgress(saved) : null
    if (this.closed) throw new SaveError('Sesi progres ditutup.')
    this.maxBytes = list.usage.maxGameSaveBytes
    this.revision = saved?.revision ?? 0
    this.checksum = bytes ? saved!.checksum : ''
    this.latest = bytes
    this.initialized = true
    this.report('ready', bytes ? 'Progres server siap dipulihkan sebelum boot.' : 'Belum ada progres server. Game baru siap dimulai.')
    return { bytes, metadata: bytes ? saved!.metadata : null }
  }
  start(metadata: GameSaveMetadata) { this.metadata = metadata }
  snapshot() { return this.latest }
  async hold() { this.held = true; await this.operation }
  release() { this.held = false }
  async conflictSnapshot() {
    await this.hold()
    if (this.closed) throw new SaveError('Sesi progres ditutup.')
    const bytes = await this.capture()
    if (this.closed) throw new SaveError('Sesi progres ditutup.')
    if (!bytes) throw new SaveError('Progres sesi tidak tersedia. Gunakan ekspor native sebelum keluar.')
    this.latest = bytes
    return bytes
  }
  acceptDecision(save: ServerGameSave, bytes: Uint8Array) {
    if (this.closed) return
    this.revision = save.revision; this.checksum = save.checksum; this.latest = bytes
    this.pending = null; this.blocked = false; this.retries = 0; this.retryAt = 0
    this.report('saved', 'Keputusan progres dikonfirmasi server; versi sebelumnya dicadangkan.')
  }
  close(clear = true) { this.closed = true; this.client.close(); if (clear) { this.pending = null; this.latest = null } }
  // Captures are serialized with uploads. A changed core is sampled again on
  // the next tick/exit; a successful upload never acknowledges unseen changes.
  async sync(explicit = false): Promise<boolean> {
    if (this.operation) { await this.operation; return explicit ? this.sync(true) : false }
    if (this.closed || this.held || !this.initialized || !this.metadata) return false
    if (this.blocked || !explicit && this.retries > 3) return false
    if (!explicit && Date.now() < this.retryAt) return false
    this.operation = this.run(explicit)
    try { return await this.operation } finally { this.operation = null }
  }
  private async run(explicit: boolean, draining = false): Promise<boolean> {
    try {
      this.report('saving', 'Memeriksa progres terbaru…')
      const bytes = await this.capture()
      if (this.closed) return false
      if (bytes) {
        this.latest = bytes
        const checksum = await hashRom(new Blob([new Uint8Array(bytes)]))
        if (this.closed) return false
        if (checksum !== this.checksum && !this.pending) this.pending = { bytes, checksum, revision: this.revision, metadata: this.metadata! }
        else if (!this.pending) { this.report('saved', 'Progres tersinkron'); return true }
        // Keep an uncertain pending write even if the core returned to the old
        // checksum: resolve its revision before uploading the newer snapshot.
      }
      if (!bytes && this.checksum) throw new SaveError('Berkas progres aktif tidak tersedia. Save server tidak diganti; ekspor cadangan sebelum keluar.', 400)
      if (!this.pending) { this.report('ready', 'Game belum menghasilkan berkas save.'); return true }
      const pending = this.pending
      if (pending.bytes.length > this.maxBytes) throw new SaveError('Paket progres melebihi batas server. Unduh cadangan.', 413)
      this.report('saving', 'Menyinkronkan progres…')
      const saved = await this.client.putProgress(pending.bytes, { ...this.identity, expectedRevision: pending.revision, checksum: pending.checksum, metadata: pending.metadata })
      if (this.closed) return false
      this.revision = saved.revision; this.checksum = saved.checksum; this.pending = null; this.retries = 0; this.retryAt = 0
      const latestChecksum = this.latest ? await hashRom(new Blob([new Uint8Array(this.latest)])) : null
      if (this.closed) return false
      if (this.latest && latestChecksum && latestChecksum !== this.checksum) {
        this.pending = { bytes: this.latest, checksum: latestChecksum, revision: this.revision, metadata: this.metadata! }
        this.report('ready', 'Perubahan progres terbaru menunggu sinkronisasi.')
        return explicit && !draining ? this.run(true, true) : false
      }
      this.report('saved', 'Snapshot progres dikonfirmasi server. Perubahan berikutnya diperiksa berkala.')
      return true
    } catch (error) {
      if (this.closed) return false
      const e = error instanceof SaveError ? error : new SaveError(error instanceof Error ? error.message : 'Sinkronisasi gagal.')
      if (e.code === 'REVISION_CONFLICT') this.blocked = true
      if (e.status === 401 || e.code === 'ACCOUNT_CHANGED') { this.blocked = true; this.report('stopped', 'Sesi akun berakhir/berubah. Antrean progres dihentikan.'); return false }
      const transient = e.status === 0 || e.status === 429 || e.status >= 500
      this.retries = transient ? (explicit ? 1 : this.retries + 1) : 4
      this.retryAt = Date.now() + 2000 * 2 ** Math.min(this.retries - 1, 2)
      this.report(this.blocked ? 'conflict' : 'failed', `${e.message}${!this.blocked && transient && this.retries <= 3 ? ' Retry otomatis terbatas dijadwalkan.' : ' Unduh cadangan sebelum keluar.'}`)
      return false
    }
  }
}

export function downloadGameSave(bytes: Uint8Array, name: string) {
  const bundle = decodeGameSave(bytes)
  // Current layouts each represent exactly the core's active native .srm.
  const url = URL.createObjectURL(new Blob([new Uint8Array(bundle.files[0].bytes)], { type: 'application/octet-stream' }))
  const link = document.createElement('a')
  link.href = url; link.download = name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.srm'; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
