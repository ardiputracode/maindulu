import type { AssetPreparationProgress, PreparedServerAsset } from './server-assets.ts'

export function formatAssetBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(2)} KiB`
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(2)} MiB`
  return `${(bytes / 1073741824).toFixed(2)} GiB`
}

export function assetPreparationStatus(value: AssetPreparationProgress): string {
  const label = value.kind === 'rom' ? 'ROM' : 'BIOS'
  if (value.phase === 'downloading') return `Mengunduh ${label}: ${(value.receivedBytes / 1048576).toFixed(2)} / ${(value.totalBytes / 1048576).toFixed(2)} MiB…`
  if (value.phase === 'reading-cache') return `Membaca dan memverifikasi cache perangkat ${label}…`
  if (value.phase === 'verifying') return `Download ${label} selesai. Memverifikasi ${label}…`
  if (value.phase === 'saving') return `Menyimpan cache perangkat ${label}…`
  if (value.phase === 'ready') return `${label} siap untuk engine.`
  return `Memeriksa ${label} server…`
}

export function assetPersistenceNotice(value: Pick<PreparedServerAsset, 'descriptor' | 'persistence' | 'warnings'>): string {
  const label = value.descriptor.kind === 'rom' ? 'ROM' : 'BIOS'
  const status = value.persistence === 'reused' ? 'Cache perangkat dipakai' : value.persistence === 'stored' ? 'Tersimpan di perangkat' :
    `Dimainkan tanpa disimpan: ${value.warnings.map(warning => warning.message).join(' ') || 'penyimpanan cache tidak berhasil.'}`
  return `${label}: ${status}`
}

type StorageApi = {
  estimate?: () => Promise<{ quota?: number; usage?: number }>;
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
}
export type BrowserStorageInfo = { quota?: number; usage?: number; persisted?: boolean; canPersist: boolean }
function browserStorage(): StorageApi | undefined {
  try { return globalThis.navigator?.storage } catch { return undefined }
}
export async function readBrowserStorage(storage = browserStorage()): Promise<BrowserStorageInfo> {
  const info: BrowserStorageInfo = { canPersist: typeof storage?.persist === 'function' }
  await Promise.all([
    (async () => {
      try {
        const estimate = await storage?.estimate?.()
        if (Number.isFinite(estimate?.quota) && estimate!.quota! >= 0 && Number.isFinite(estimate?.usage) && estimate!.usage! >= 0) {
          info.quota = estimate!.quota; info.usage = estimate!.usage
        }
      } catch { /* Estimation is optional, not an admission guarantee. */ }
    })(),
    (async () => {
      try { const persisted = await storage?.persisted?.(); if (typeof persisted === 'boolean') info.persisted = persisted }
      catch { /* Includes insecure LAN origins and privacy restrictions. */ }
    })(),
  ])
  return info
}

export async function requestPersistentStorage(storage = browserStorage()): Promise<string> {
  try {
    if (typeof storage?.persist !== 'function') return 'Permintaan penyimpanan persisten tidak tersedia di browser/origin ini.'
    return await storage.persist() ? 'Penyimpanan persisten disetujui browser. Data masih dapat dihapus pengguna.' :
      'Penyimpanan persisten tidak disetujui browser. Cache tetap dapat dipakai, tetapi bisa dihapus otomatis.'
  } catch { return 'Permintaan penyimpanan persisten gagal. Cache tetap dapat dipakai sesuai kuota browser.' }
}
