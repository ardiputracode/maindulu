import sharp from 'sharp'
import { safeOriginalName } from './repository.mjs'
import { invalidCatalog } from './errors.mjs'

export const consoleExtensions = Object.freeze({
  nes: ['nes', 'fds', 'unf', 'unif'], snes: ['sfc', 'smc', 'fig', 'swc'],
  gb: ['gb', 'gbc'], gba: ['gba'], megadrive: ['md', 'gen', 'smd', 'bin'],
  psx: ['bin', 'cue', 'chd', 'pbp', 'iso'],
})
export const validId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(value)
export function fileName(kind, name, consoleId) {
  try { safeOriginalName(name) } catch { throw invalidCatalog('Nama berkas harus berupa basename yang aman.') }
  const ext = name.split('.').pop().toLowerCase()
  if (kind === 'bios') {
    if (!['bin', 'rom', 'bios', 'img', 'zip', '7z', 'rar'].includes(ext)) throw invalidCatalog('Format BIOS tidak didukung.')
    // EmulatorJS uses the URL basename verbatim (without URL decoding) for raw
    // firmware. Reject names that would change when encoded, rather than silently
    // renaming firmware. Archive member names remain untouched.
    if (!['zip', '7z', 'rar'].includes(ext) && !/^[a-zA-Z0-9_.-]+$/.test(name)) throw invalidCatalog('Nama BIOS raw hanya boleh huruf ASCII, angka, titik, garis bawah, dan tanda minus.')
  } else if (!Object.hasOwn(consoleExtensions, consoleId) || ![...consoleExtensions[consoleId], 'zip', '7z', 'rar'].includes(ext)) {
    throw invalidCatalog('Format ROM tidak sesuai console.')
  }
  return name
}

export function metadataFields(kind, input, patch = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidCatalog()
  const title = kind === 'games' ? 'title' : 'name'
  const rights = kind === 'games' ? 'license' : 'distributionRights'
  const allowed = patch ? [title, rights, 'description', ...(kind === 'games' ? ['removeCover'] : [])] : [title, rights, 'description', 'consoleId', 'restoreId']
  if (Object.keys(input).some(key => !allowed.includes(key))) throw invalidCatalog('Field metadata tidak dikenal atau tidak dapat diubah.')
  const result = {}
  for (const [key, max] of [[title, 200], ['description', 10000], [rights, 2000]]) {
    if (patch && !Object.hasOwn(input, key)) continue
    const value = input[key] ?? (key === title ? null : '')
    if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || (key === title && (!value.trim() || /[\r\n\t]/.test(value)))) throw invalidCatalog(`Field ${key} tidak valid atau terlalu panjang.`)
    result[key] = value.trim()
  }
  if (!patch) {
    if (typeof input.consoleId !== 'string' || !Object.hasOwn(consoleExtensions, input.consoleId)) throw invalidCatalog('Console tidak didukung.')
    result.consoleId = input.consoleId
    if (input.restoreId !== undefined && !validId(input.restoreId)) throw invalidCatalog('ID pemulihan tidak valid.')
  }
  if (input.removeCover !== undefined && ![true, false, 'true', 'false'].includes(input.removeCover)) throw invalidCatalog('Pilihan penghapusan cover tidak valid.')
  return { metadata: result, restoreId: input.restoreId, removeCover: input.removeCover === true || input.removeCover === 'true' }
}

export async function validateCover(storage, stage) {
  const file = await storage.open('uploads', stage.key)
  let bytes
  try { bytes = await file.readFile() } finally { await file.close() }
  try {
    const image = sharp(bytes, { limitInputPixels: 4096 * 4096, animated: true, failOn: 'warning' })
    const meta = await image.metadata()
    if (!['png', 'jpeg', 'webp'].includes(meta.format) || !meta.width || !meta.height || meta.width > 4096 || meta.height > 4096 || (meta.pages ?? 1) !== 1) throw new Error('Raster only')
    if (meta.format === 'png') {
      // libvips can decode APNG's first frame as an ordinary PNG without exposing
      // pages. Explicitly reject its animation-control chunk too.
      for (let offset = 8; offset < bytes.length;) {
        if (offset + 12 > bytes.length) throw new Error('Truncated PNG chunk')
        const length = bytes.readUInt32BE(offset)
        if (length > bytes.length - offset - 12 || bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') throw new Error('Invalid or animated PNG')
        offset += 12 + length
      }
    }
    // Metadata alone accepts some truncated images. Force a complete bounded
    // decode; encoded bytes/checksum remain those originally uploaded.
    await image.raw().toBuffer()
    return `image/${meta.format}`
  } catch { throw invalidCatalog('Cover harus PNG/JPEG/WebP valid, tidak beranimasi, maksimum 4096 × 4096 piksel.') }
}

export function listQuery(query, admin = false) {
  if (Object.keys(query).some(key => !['q', 'console', 'sort', 'page', 'pageSize', ...(admin ? ['status'] : [])].includes(key))) throw invalidCatalog('Parameter katalog tidak dikenal.')
  const q = query.q ?? ''
  if (typeof q !== 'string' || q.length > 200 || /[\x00-\x1f\x7f]/.test(q)) throw invalidCatalog('Pencarian tidak valid.')
  if (query.console !== undefined && !Object.hasOwn(consoleExtensions, query.console)) throw invalidCatalog('Filter console tidak valid.')
  const sort = query.sort ?? 'newest', status = admin ? query.status ?? 'active' : 'active'
  if (!['newest', 'title'].includes(sort) || !['active', 'deleted', 'all'].includes(status)) throw invalidCatalog()
  function number(value, fallback, max) {
    if (value === undefined) return fallback
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw invalidCatalog('Pagination tidak valid.')
    return Number(value)
  }
  return { q: q.trim(), consoleId: query.console, sort, status, page: number(query.page, 1, 1000000), pageSize: number(query.pageSize, 24, 100) }
}
