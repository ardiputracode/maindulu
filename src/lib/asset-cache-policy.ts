import { MAX_BIOS_SIZE, MAX_ROM_SIZE } from './domain.ts'
import { catalogId } from './catalog.ts'
import type { CatalogEntry } from './catalog.ts'

export const ASSET_CHUNK_SIZE = 4 * 1024 * 1024
export const DEFAULT_ASSET_BUDGET = 2 * 1024 * 1024 * 1024
export const ASSET_SPACE_RESERVE = 128 * 1024 * 1024
export const ASSET_LEASE_MS = 60 * 60 * 1000

export type AssetKind = 'rom' | 'bios'
export type AssetDescriptor = {
  kind: AssetKind; catalogId: string; sha256: string; size: number;
  fileName: string; url: string; consoleId: string; label: string;
}
export type AssetKey = [AssetKind, string, string]
export type AssetCacheErrorCode = 'unavailable' | 'quota' | 'corrupt' | 'aborted' | 'blocked' |
  'incompatible-version' | 'invalid' | 'budget' | 'disabled' | 'busy' | 'fenced'

export class AssetCacheError extends Error {
  readonly code: AssetCacheErrorCode
  constructor(code: AssetCacheErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AssetCacheError'
    this.code = code
  }
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max && !/[\x00-\x1f\x7f]/.test(v)

// Only canonical uploaded-asset endpoints qualify. Static manifests and local
// File inputs deliberately do not share this contract.
export function readAssetDescriptor(value: unknown): AssetDescriptor | null {
  if (!record(value) || (value.kind !== 'rom' && value.kind !== 'bios') ||
    typeof value.catalogId !== 'string' || value.catalogId.length !== 36 || !catalogId.test(value.catalogId) ||
    typeof value.sha256 !== 'string' || value.sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.size) || Number(value.size) < 1 ||
    Number(value.size) > (value.kind === 'rom' ? MAX_ROM_SIZE : MAX_BIOS_SIZE) ||
    !text(value.fileName, 255) || /[/\\]/.test(value.fileName) || value.fileName === '.' || value.fileName === '..' ||
    !text(value.consoleId, 100) || !/^[a-z0-9-]+$/.test(value.consoleId) || !text(value.label, 200)) return null
  const prefix = value.kind === 'rom' ? `/games/${value.catalogId}/rom/` : `/bios/${value.catalogId}/`
  try { if (value.url !== prefix + encodeURIComponent(value.fileName)) return null }
  catch { return null } // Malformed UTF-16 must not escape the unknown-data parser.
  return { kind: value.kind, catalogId: value.catalogId, sha256: value.sha256, size: Number(value.size),
    fileName: value.fileName, url: String(value.url), consoleId: value.consoleId, label: value.label }
}

export function requireAssetDescriptor(value: unknown): AssetDescriptor {
  const descriptor = readAssetDescriptor(value)
  if (!descriptor) throw new AssetCacheError('invalid', 'Descriptor cache ROM/BIOS tidak valid.')
  return descriptor
}

export function catalogAssetDescriptor(kind: AssetKind, entry: CatalogEntry): AssetDescriptor {
  return requireAssetDescriptor({ kind, catalogId: entry.id, sha256: entry.sha256, size: entry.size,
    fileName: entry.fileName, url: entry.url, consoleId: entry.consoleId, label: kind === 'rom' ? entry.title : entry.name })
}

export const assetKey = (value: AssetDescriptor): AssetKey => [value.kind, value.catalogId, value.sha256]
export const assetKeyString = (value: AssetDescriptor): string => JSON.stringify(assetKey(value))
export const assetChunkCount = (size: number): number => Math.ceil(size / ASSET_CHUNK_SIZE)
export const assetChunkSize = (size: number, index: number): number => Math.min(ASSET_CHUNK_SIZE, size - index * ASSET_CHUNK_SIZE)

export type AssetCacheSettings = { enabled: boolean; budget: number }
export function requireCacheSettings(value: unknown): AssetCacheSettings {
  if (!record(value) || typeof value.enabled !== 'boolean' || typeof value.budget !== 'number' || !Number.isSafeInteger(value.budget) || value.budget < 1) {
    throw new AssetCacheError('invalid', 'Pengaturan cache tidak valid.')
  }
  return { enabled: value.enabled, budget: value.budget }
}

export type LruCandidate = { generationId: string; size: number; lastUsedAt: number; createdAt: number }
export function planAssetAdmission(size: number, budget: number, committed: LruCandidate[], reserved: number,
  pinned: ReadonlySet<string>, availableBytes?: number): string[] {
  const used = committed.reduce((total, entry) => total + entry.size, 0) + reserved
  // Reservations also constrain the best-effort browser estimate, so two tabs
  // cannot both admit against the same unallocated space. Counting the full
  // reservation is intentionally conservative when some chunks already exist.
  let needed = Math.max(0, used + size - budget, availableBytes === undefined ? 0 : size + reserved - availableBytes)
  const victims: string[] = []
  for (const entry of [...committed].sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.createdAt - b.createdAt || a.generationId.localeCompare(b.generationId))) {
    if (needed <= 0) break
    if (pinned.has(entry.generationId)) continue
    victims.push(entry.generationId)
    needed -= entry.size
  }
  if (needed > 0) throw new AssetCacheError('budget', 'Ruang cache tidak cukup; aset dapat dimainkan tanpa disimpan.')
  return victims
}

export function cacheStorageError(error: unknown): AssetCacheError {
  if (error instanceof AssetCacheError) return error
  const name = error && typeof error === 'object' && 'name' in error ? error.name : ''
  const code = name === 'QuotaExceededError' ? 'quota' : name === 'VersionError' ? 'incompatible-version' :
    name === 'AbortError' ? 'aborted' : name === 'ConstraintError' ? 'corrupt' : 'unavailable'
  return new AssetCacheError(code, code === 'quota' ? 'Penyimpanan perangkat penuh.' :
    code === 'incompatible-version' ? 'Versi database cache lebih baru; cache tidak dipakai.' :
      code === 'aborted' ? 'Operasi cache dibatalkan.' : code === 'corrupt' ? 'Key chunk atau generation cache bertabrakan.' :
        'Penyimpanan cache perangkat tidak tersedia.', { cause: error })
}

export function checkCacheAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AssetCacheError('aborted', 'Operasi cache dibatalkan.')
}
