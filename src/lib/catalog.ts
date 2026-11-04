import { isSafeLocalUrl } from './domain.ts'
import type { Bios, Game } from './domain.ts'

export type CatalogKind = 'games' | 'bios'
export type CatalogEntry = {
  id: string; consoleId: string; fileName: string; size: number; sha256: string;
  description: string; createdAt: number; updatedAt: number; url: string;
  title?: string; name?: string; license?: string; distributionRights?: string; cover?: string;
}
export type CatalogPage = { items: CatalogEntry[]; page: number; pageSize: number; total: number }
export class CatalogRequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.name = 'CatalogRequestError'; this.status = status }
}
export const catalogId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0

export function readCatalogEntry(value: unknown, kind: CatalogKind): CatalogEntry | null {
  if (!record(value) || typeof value.id !== 'string' || !catalogId.test(value.id) || typeof value.consoleId !== 'string' ||
    typeof value.fileName !== 'string' || !integer(value.size) || value.size < 1 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.description !== 'string' || !integer(value.createdAt) || !integer(value.updatedAt) || !isSafeLocalUrl(value.url) ||
    (value.cover !== undefined && !isSafeLocalUrl(value.cover))) return null
  const label = kind === 'games' ? value.title : value.name
  if (typeof label !== 'string' || !label.trim() || label.length > 200 ||
    (kind === 'games' ? typeof value.license !== 'string' : typeof value.distributionRights !== 'string')) return null
  return value as CatalogEntry
}

export function readCatalogPage(value: unknown, kind: CatalogKind): CatalogPage | null {
  if (!record(value) || !Array.isArray(value.items) || !integer(value.page) || value.page < 1 ||
    !integer(value.pageSize) || value.pageSize < 1 || value.pageSize > 100 || !integer(value.total) ||
    value.items.length > value.pageSize || value.items.length > value.total) return null
  if (value.items.some(item => !readCatalogEntry(item, kind))) return null
  return value as CatalogPage
}

export async function catalogRequest(path: string, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(15000)
  try {
    const response = await fetch(path, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', redirect: 'error' })
    if (response.status === 404 || response.status === 410) throw new CatalogRequestError(response.status, 'Game atau BIOS sudah dihapus atau tidak lagi tersedia. Pilih entri lain.')
    if (!response.ok) throw new CatalogRequestError(response.status, `Katalog server belum dapat dimuat (HTTP ${response.status}). Coba lagi.`)
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Respons katalog bukan JSON. Periksa backend dan coba lagi.')
    try { return await response.json() }
    catch { throw new Error('Respons katalog rusak atau tidak lengkap. Coba muat ulang katalog.') }
  } catch (error) {
    if (signal?.aborted) throw error
    if (timeout.aborted) throw new Error('Permintaan katalog terlalu lama. Coba lagi.')
    if (error instanceof TypeError) throw new Error('Koneksi katalog terputus. Periksa koneksi dan coba lagi.')
    throw error
  }
}

// Fetch metadata only, in bounded API pages. Never reuse the 100-item saved-list
// parser, nor download/hash ROM or firmware bytes to build the library.
export async function loadCatalog(kind: CatalogKind, query = '', signal?: AbortSignal): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = [], ids = new Set<string>()
  let total: number | undefined
  for (let page = 1; ; page++) {
    const params = new URLSearchParams(query)
    params.set('page', String(page)); params.set('pageSize', '100')
    const result = readCatalogPage(await catalogRequest(`/api/${kind}?${params}`, signal), kind)
    if (!result || result.page !== page || result.pageSize !== 100 || (total !== undefined && total !== result.total)) throw new Error('Katalog berubah atau respons tidak sesuai. Muat ulang katalog.')
    total = result.total
    for (const item of result.items) {
      if (ids.has(item.id)) throw new Error('Katalog berubah saat dimuat. Muat ulang katalog.')
      ids.add(item.id); entries.push(item)
    }
    if (entries.length === total) return entries
    if (result.items.length !== 100) throw new Error('Halaman katalog tidak lengkap. Muat ulang katalog.')
  }
}

export const catalogGame = (item: CatalogEntry): Game => ({ ...item, title: item.title!, source: 'server' })
export const catalogBios = (item: CatalogEntry): Bios => ({ ...item, name: item.name! })

export async function latestCatalogEntry(kind: CatalogKind, id: string, signal?: AbortSignal) {
  if (!catalogId.test(id)) throw new Error('Identitas katalog tidak valid.')
  const data = await catalogRequest(`/api/${kind}/${encodeURIComponent(id)}`, signal)
  const entry = record(data) ? readCatalogEntry(data.item, kind) : null
  if (!entry || entry.id !== id) throw new Error('Metadata katalog tidak sesuai. Coba lagi.')
  return entry
}

export function readManifestGames(value: unknown): Game[] {
  if (!Array.isArray(value)) throw new Error('Manifest game tidak valid.')
  return value.filter((g): g is Game => record(g) && typeof g.id === 'string' && g.id.length < 160 &&
    typeof g.title === 'string' && g.title.length <= 200 && typeof g.consoleId === 'string' && g.source === 'server' &&
    isSafeLocalUrl(g.url) && (g.cover === undefined || isSafeLocalUrl(g.cover)))
}

export function mergeCatalog<T extends { id: string }>(builtin: T[], uploaded: T[]): T[] {
  // Built-in IDs win. In particular, jalan-pulang-v1 must never become an upload.
  return [...new Map([...uploaded, ...builtin].map(item => [item.id, item])).values()]
}

export function libraryGames(games: Game[], q: string, consoleId: string, sort: string): Game[] {
  const search = q.trim().toLocaleLowerCase('id')
  return games.filter(g => (!consoleId || g.consoleId === consoleId) && g.title.toLocaleLowerCase('id').includes(search))
    .sort((a, b) => (sort === 'newest' ? (b.createdAt ?? 0) - (a.createdAt ?? 0) : 0) || a.title.localeCompare(b.title, 'id') || a.id.localeCompare(b.id))
}
