import { adminRequest, adminToken } from './admin-catalog.ts'

export const metadataLabels: Record<string, string> = { disabled: 'Scan nonaktif', queued: 'Menunggu scan', running: 'Sedang diproses', retry_wait: 'Menunggu percobaan ulang', paused: 'Dijeda', needs_review: 'Perlu ditinjau', succeeded: 'Metadata selesai', not_found: 'Tidak ditemukan', unsupported: 'Format belum didukung', failed: 'Scan gagal', cancelled: 'Dibatalkan' }
export const fieldLabels: Record<string, string> = { title: 'Judul', description: 'Deskripsi', releaseDate: 'Tanggal rilis', genre: 'Genre', developer: 'Developer', publisher: 'Publisher', players: 'Jumlah pemain', regionLanguage: 'Region / bahasa', cover: 'Cover' }
export type MetadataField = { current: string | boolean | null; proposed: string | boolean | null; locked: boolean; source: string }
export type MetadataPreview = { revision: number; fields: Record<string, MetadataField> }
export type MetadataDetail = { gameId: string; generation: number | null; status: string; phase: string | null; reason: string | null; nextAt: number | null; cooldownUntil?: number; matchMethod?: 'hash' | 'serial' | 'manual'; preview: MetadataPreview; candidates: { id: string; title: string; systemId: string; preview: MetadataPreview }[] }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
function preview(v: unknown): v is MetadataPreview {
  return object(v) && Number.isSafeInteger(v.revision) && Number(v.revision) > 0 && object(v.fields) &&
    Object.keys(fieldLabels).every(key => { const f = v.fields && (v.fields as Record<string, unknown>)[key]; return object(f) && typeof f.locked === 'boolean' && ['filename', 'manual', 'screenscraper'].includes(String(f.source)) && [f.current, f.proposed].every(x => x === null || typeof x === 'boolean' || (typeof x === 'string' && x.length <= 10000)) })
}
export function readMetadata(v: unknown): MetadataDetail | null {
  if (!object(v) || typeof v.gameId !== 'string' || !(v.generation === null || Number.isSafeInteger(v.generation)) || !Object.hasOwn(metadataLabels, String(v.status)) || !preview(v.preview) || !Array.isArray(v.candidates) || v.candidates.length > 30) return null
  if (v.matchMethod !== undefined && v.matchMethod !== null && !['hash', 'serial', 'manual'].includes(String(v.matchMethod))) return null
  if (v.candidates.some(c => !object(c) || typeof c.id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(c.id) || typeof c.title !== 'string' || c.title.length > 200 || !preview(c.preview))) return null
  return v as MetadataDetail
}
export async function getMetadata(id: string, signal: AbortSignal) {
  const result = readMetadata(await adminRequest(`/api/admin/games/${encodeURIComponent(id)}/metadata`, { signal }))
  if (!result || result.gameId !== id) throw new Error('Respons metadata tidak sesuai.')
  return result
}
export async function metadataAction(id: string, userId: string, action: 'scan' | 'search' | 'apply' | 'unlock', body: Record<string, unknown>, signal: AbortSignal) {
  const token = await adminToken(userId, signal)
  return adminRequest(`/api/admin/games/${encodeURIComponent(id)}/metadata/${action}`, { method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify(body) })
}
export async function metadataReady(signal: AbortSignal) {
  const data = await adminRequest('/api/admin/metadata/status', { signal })
  if (!object(data) || typeof data.ready !== 'boolean') throw new Error('Respons kesiapan metadata tidak sesuai.')
  return data.ready
}
