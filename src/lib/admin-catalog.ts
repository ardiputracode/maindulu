import { readAccountSession } from './account.ts'
import { readCatalogEntry } from './catalog.ts'
import type { CatalogEntry, CatalogKind } from './catalog.ts'
export { readCatalogEntry } from './catalog.ts'
export type { CatalogEntry, CatalogKind } from './catalog.ts'

export type AdminEntry = CatalogEntry & {
  deletedAt: number | null; fileStatus: string; coverStatus?: string; cleanupPending: boolean; storageMode?: 'external' | 'shared' | 'managed';
}
export type AdminPage = { items: AdminEntry[]; page: number; pageSize: number; total: number }
export type UploadProgress = { phase: 'preparing' | 'sending' | 'processing'; percent?: number }

export class CatalogClientError extends Error {
  status: number
  code: string
  existingId?: string
  fileMissing: boolean
  constructor(message: string, status = 0, code = '', existingId?: string, fileMissing = false) {
    super(message); this.status = status; this.code = code; this.existingId = existingId; this.fileMissing = fileMissing
  }
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
export const catalogLabel = (item: CatalogEntry) => item.title ?? item.name ?? 'Tanpa nama'

export function readAdminPage(value: unknown, kind: CatalogKind): AdminPage | null {
  if (!record(value) || !Array.isArray(value.items) || !integer(value.page) || value.page < 1 || !integer(value.pageSize) || value.pageSize < 1 || value.pageSize > 100 || !integer(value.total) || value.items.length > value.pageSize) return null
  for (const item of value.items) {
    if (!readCatalogEntry(item, kind) || !record(item) || !(item.deletedAt === null || integer(item.deletedAt)) ||
      !['none', 'available', 'damaged', 'missing', 'unsafe'].includes(String(item.fileStatus)) || typeof item.cleanupPending !== 'boolean' ||
      (item.storageMode !== undefined && !['external', 'shared', 'managed'].includes(String(item.storageMode))) ||
      (kind === 'games' && !['none', 'available', 'damaged', 'missing', 'unsafe'].includes(String(item.coverStatus)))) return null
  }
  return value as AdminPage
}

export function catalogResponseError(value: unknown, status: number): CatalogClientError {
  const data = record(value) ? value : {}
  const fallback = status === 401 ? 'Sesi berakhir. Masuk kembali untuk mengelola koleksi.' : status === 403 ? 'Akses admin atau pemeriksaan keamanan ditolak. Periksa kembali sesi akun.' :
    status === 413 ? 'Ukuran upload melebihi batas server.' : status === 429 ? 'Upload server sedang sibuk. Tunggu sebentar lalu coba lagi.' : status === 507 ? 'Storage server penuh. Upload tidak diterbitkan.' : 'Permintaan katalog gagal. Coba lagi.'
  return new CatalogClientError(typeof data.error === 'string' ? data.error : fallback, status, typeof data.code === 'string' ? data.code : '', typeof data.existingId === 'string' && uuid.test(data.existingId) ? data.existingId : undefined, data.fileMissing === true)
}

export async function adminRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  try {
    const response = await fetch(path, { ...init, cache: 'no-store', credentials: 'same-origin' })
    let data: unknown
    try { data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null } catch { data = null }
    if (!response.ok) throw catalogResponseError(data, response.status)
    if (!record(data)) throw new CatalogClientError('Respons katalog tidak sesuai. Muat ulang daftar untuk memeriksa hasilnya.')
    return data
  } catch (error) {
    if (init.signal?.aborted && init.signal.reason?.name === 'TimeoutError') throw new CatalogClientError('Permintaan terlalu lama. Muat ulang daftar untuk memeriksa hasilnya.')
    if (init.signal?.aborted || error instanceof CatalogClientError) throw error
    throw new CatalogClientError('Koneksi terputus. Hasil operasi belum dapat dipastikan; muat ulang daftar sebelum mencoba lagi.')
  }
}

export async function adminToken(userId: string, signal: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(10000)
  let data: unknown
  try { data = await adminRequest('/api/auth/session', { signal: AbortSignal.any([signal, timeout]) }) }
  catch (error) { if (timeout.aborted && !signal.aborted) throw new CatalogClientError('Pemeriksaan sesi terlalu lama. Coba lagi.'); throw error }
  const session = readAccountSession(data)
  if (!session?.user || !session.csrfToken || session.user.id !== userId) throw new CatalogClientError('Sesi akun berubah atau berakhir. Periksa kembali akun.', 401)
  if (session.user.role !== 'admin') throw new CatalogClientError('Role admin sudah dicabut. Pengelolaan koleksi tidak diizinkan.', 403)
  return session.csrfToken
}

export async function mutateCatalog(kind: CatalogKind, userId: string, method: 'POST' | 'PATCH' | 'DELETE', id: string | undefined,
  body: FormData | Record<string, unknown>, signal: AbortSignal, onProgress: (progress: UploadProgress) => void = () => {}) {
  onProgress({ phase: 'preparing' })
  const token = await adminToken(userId, signal)
  signal.throwIfAborted()
  const path = `/api/admin/${kind}${id ? '/' + encodeURIComponent(id) : ''}`
  if (!(body instanceof FormData)) {
    onProgress({ phase: 'processing' })
    return adminRequest(path, { method, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify(body) })
  }
  // Fetch has no portable upload progress. Never set Content-Type for FormData:
  // the browser must generate the matching multipart boundary.
  return new Promise<unknown>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const abort = () => xhr.abort()
    const cleanup = () => signal.removeEventListener('abort', abort)
    xhr.open(method, path)
    xhr.withCredentials = true
    xhr.setRequestHeader('X-CSRF-Token', token)
    xhr.upload.onprogress = event => onProgress({ phase: 'sending', percent: event.lengthComputable ? Math.min(100, Math.floor(event.loaded / event.total * 100)) : undefined })
    xhr.upload.onload = () => onProgress({ phase: 'processing' })
    xhr.onload = () => {
      cleanup()
      let data: unknown = null
      try { if (xhr.getResponseHeader('content-type')?.includes('application/json')) data = JSON.parse(xhr.responseText) } catch { /* Reject malformed success responses below. */ }
      if (xhr.status < 200 || xhr.status >= 300) reject(catalogResponseError(data, xhr.status))
      else if (!record(data)) reject(new CatalogClientError('Respons upload tidak sesuai. Muat ulang daftar untuk memeriksa hasilnya.'))
      else resolve(data)
    }
    xhr.onerror = () => { cleanup(); reject(new CatalogClientError('Koneksi upload terputus. Muat ulang daftar untuk memeriksa apakah berkas sudah diterbitkan.')) }
    xhr.onabort = () => { cleanup(); reject(new DOMException('Upload dibatalkan', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
    onProgress({ phase: 'sending', percent: 0 })
    try { xhr.send(body) }
    catch { cleanup(); reject(new CatalogClientError('Upload tidak dapat dimulai. Periksa koneksi dan coba lagi.')) }
  })
}
