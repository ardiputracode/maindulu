import { readAccountSession } from './account.ts'

export type StateMetadata = { formatVersion: number; engineVersion: string; coreBuild: string; runtimeBuild: string; variant: 'normal' | 'legacy' }
export type ServerSave = { id: string; gameId: string; consoleId: string; core: string; slot: number; title: string; revision: number; size: number; checksum: string; updatedAt: number; deleted: boolean; metadata: StateMetadata }
export type SaveUsage = { usedBytes: number; quotaBytes: number; maxStateBytes: number; slots: number }
export type SaveList = { saves: ServerSave[]; usage: SaveUsage }
export class SaveError extends Error {
  status: number
  code: string
  constructor(message: string, status = 0, code = '') { super(message); this.status = status; this.code = code }
}
const hex = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
export function readStateMetadata(value: unknown): StateMetadata | null {
  if (!value || typeof value !== 'object') return null
  const v = value as StateMetadata
  return v.formatVersion === 1 && typeof v.engineVersion === 'string' && /^\d+\.\d+\.\d+$/.test(v.engineVersion) && hex(v.coreBuild) && hex(v.runtimeBuild) && ['normal', 'legacy'].includes(v.variant) ? { formatVersion: 1, engineVersion: v.engineVersion, coreBuild: v.coreBuild, runtimeBuild: v.runtimeBuild, variant: v.variant } : null
}
export function compatibleState(a: StateMetadata, b: StateMetadata) {
  return a.formatVersion === b.formatVersion && a.engineVersion === b.engineVersion && a.coreBuild === b.coreBuild && a.runtimeBuild === b.runtimeBuild && a.variant === b.variant
}
export function readServerSave(value: unknown): ServerSave | null {
  if (!value || typeof value !== 'object') return null
  const v = value as ServerSave
  const metadata = readStateMetadata(v.metadata)
  if (!metadata || typeof v.id !== 'string' || !/^[a-f0-9-]{36}$/.test(v.id) || typeof v.gameId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(v.gameId) || typeof v.consoleId !== 'string' || typeof v.core !== 'string' || typeof v.title !== 'string' || v.title.length > 200 || !Number.isSafeInteger(v.revision) || v.revision < 1 || !Number.isInteger(v.slot) || (v.slot !== 99 && (v.slot < 1 || v.slot > 3)) || !Number.isSafeInteger(v.size) || v.size < 0 || !hex(v.checksum) || !Number.isSafeInteger(v.updatedAt) || typeof v.deleted !== 'boolean') return null
  return { id: v.id, gameId: v.gameId, consoleId: v.consoleId, core: v.core, title: v.title, slot: v.slot, revision: v.revision, size: v.size, checksum: v.checksum, updatedAt: v.updatedAt, deleted: v.deleted, metadata }
}
export function readSaveList(value: unknown): SaveList | null {
  if (!value || typeof value !== 'object') return null
  const v = value as SaveList
  if (!Array.isArray(v.saves) || v.saves.length > 5000 || !v.usage) return null
  const u = v.usage
  if (![u.usedBytes, u.quotaBytes, u.maxStateBytes].every(Number.isSafeInteger) || u.usedBytes < 0 || u.quotaBytes < 1024 || u.maxStateBytes < 1024 || u.slots !== 3) return null
  const saves = v.saves.map(readServerSave)
  if (saves.some(s => !s)) return null
  return { saves: saves as ServerSave[], usage: { usedBytes: u.usedBytes, quotaBytes: u.quotaBytes, maxStateBytes: u.maxStateBytes, slots: u.slots } }
}
export const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString('id-ID', { maximumFractionDigits: 2 })} MiB`
export function downloadState(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }))
  const link = document.createElement('a')
  link.href = url; link.download = name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.state'; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Each client is bound to one launched account. There is no automatic account
// rebinding or persisted retry queue, even when the shared cookie changes.
export class SaveClient {
  private controllers = new Set<AbortController>()
  private closed = false
  readonly userId: string
  constructor(userId: string) { this.userId = userId }
  close() { this.closed = true; for (const c of this.controllers) c.abort() }
  private async fetch(path: string, init: RequestInit = {}) {
    if (this.closed) throw new SaveError('Sesi save dihentikan. Buka ulang permainan.', 401)
    const controller = new AbortController()
    this.controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      const response = await fetch(path, { ...init, signal: controller.signal, cache: 'no-store', credentials: 'same-origin' })
      // Consume bodies inside the timeout/abort boundary, not after releasing it.
      const type = response.headers.get('content-type') ?? ''
      const data: unknown = type.includes('application/json') ? await response.json() : type.includes('application/octet-stream') ? new Uint8Array(await response.arrayBuffer()) : null
      if (!response.ok) {
        const e = data as { error?: unknown; code?: unknown } | null
        throw new SaveError(typeof e?.error === 'string' ? e.error : 'Permintaan save ditolak server.', response.status, typeof e?.code === 'string' ? e.code : '')
      }
      if (this.closed) throw new SaveError('Sesi save dihentikan.', 401)
      if (data === null) throw new SaveError('Respons save tidak sesuai. Jangan timpa simpanan; coba muat ulang daftar.')
      return { response, data }
    } catch (error) {
      if (error instanceof SaveError) throw error
      throw new SaveError('Gagal sinkron — coba lagi. Koneksi terputus atau terlalu lama. Unduh cadangan sebelum keluar.')
    } finally { clearTimeout(timer); this.controllers.delete(controller) }
  }
  private async headers(binary = false) {
    const { data } = await this.fetch('/api/auth/csrf')
    const session = readAccountSession(data)
    if (session?.user?.id !== this.userId || !session.csrfToken) throw new SaveError('Sesi berakhir atau akun berubah. Masuk kembali lalu buka ulang permainan.', 401, 'ACCOUNT_CHANGED')
    return { 'Content-Type': binary ? 'application/octet-stream' : 'application/json', 'X-CSRF-Token': session.csrfToken, 'X-Save-User': this.userId }
  }
  async list() {
    const { data } = await this.fetch('/api/saves/', { headers: { 'X-Save-User': this.userId } })
    const list = readSaveList(data)
    if (!list) throw new SaveError('Daftar save tidak valid. Penyimpanan dinonaktifkan sampai daftar berhasil dimuat.')
    return list
  }
  async put(bytes: Uint8Array, metadata: Record<string, unknown>) {
    const headers = await this.headers(true)
    const { data } = await this.fetch('/api/saves/', { method: 'PUT', headers: { ...headers, 'X-Save-Metadata': encodeURIComponent(JSON.stringify(metadata)) }, body: new Uint8Array(bytes) })
    const save = readServerSave((data as { save?: unknown }).save)
    if (!save) throw new SaveError('Hasil penyimpanan belum dapat dipastikan. Muat ulang daftar sebelum mencoba lagi.')
    return save
  }
  async get(save: ServerSave) {
    const { data, response } = await this.fetch('/api/saves/' + save.id, { headers: { 'X-Save-User': this.userId } })
    let actual: ServerSave | null = null
    try { actual = readServerSave(JSON.parse(decodeURIComponent(response.headers.get('x-save-metadata') ?? ''))) } catch { /* invalid metadata */ }
    if (!(data instanceof Uint8Array) || !actual || actual.id !== save.id || actual.revision !== save.revision || actual.checksum !== save.checksum || data.length !== save.size) throw new SaveError('Save berubah atau respons tidak valid. Muat ulang daftar sebelum memuat.', 409, 'REVISION_CONFLICT')
    return data
  }
  async remove(save: ServerSave) {
    await this.fetch('/api/saves/' + save.id + '/delete', { method: 'POST', headers: await this.headers(), body: JSON.stringify({ expectedRevision: save.revision }) })
  }
}
