import { isSafeLocalUrl, MAX_BIOS_SIZE, MAX_ROM_SIZE } from './domain.ts'

// Prepared backend bytes only: callers must first validate the current server
// descriptor, size and SHA-256. These helpers do not fetch or persist anything.
// Keep the URL's encoded basename, just as EmulatorJS's URL path does. Decoding
// it here would change existing SRAM/memcard paths for names containing spaces.
export function engineAssetFileName(url: string): string {
  if (!isSafeLocalUrl(url) || /[?#]/.test(url)) throw new Error('URL aset engine tidak valid.')
  const name = url.slice(url.lastIndexOf('/') + 1)
  let decoded: string
  try { decoded = decodeURIComponent(name) } catch { throw new Error('Nama aset engine tidak valid.') }
  if (!decoded || decoded === '.' || decoded === '..' || decoded.length > 240 || /[/\\\u0000-\u001f\u007f]/.test(decoded)) {
    throw new Error('Nama aset engine tidak valid.')
  }
  return name
}

function checkSize(blob: Blob, maximum: number) {
  if (!(blob instanceof Blob) || blob.size < 1 || blob.size > maximum) throw new Error('Ukuran aset engine tidak valid.')
}

export function preparedRomFile(blob: Blob, url: string): File {
  checkSize(blob, MAX_ROM_SIZE)
  // Pass this File directly to EJS_gameUrl, NOT through createObjectURL. The
  // native File path sets config.gameUrl = file.name before choosing fileName.
  return new File([blob], engineAssetFileName(url), { type: blob.type || 'application/octet-stream', lastModified: 0 })
}

// Construct INSIDE the iframe, after structured clone. File subclasses/methods
// do not survive postMessage. This is a per-input adapter, not a patch to the
// engine, File.prototype, fetch or XHR. 4.2.3 calls arrayBuffer for HEAD as well
// as GET; reuse that read until consumption finishes, then release explicitly.
export function engineRomInput(file: File): { file: File; release: () => void } {
  checkSize(file, MAX_ROM_SIZE)
  if (!(file instanceof File)) throw new Error('Input ROM engine harus berupa File.')
  class SessionRom extends File {
    private pending: Promise<ArrayBuffer> | undefined
    private released = false
    override arrayBuffer(): Promise<ArrayBuffer> {
      if (this.released) return Promise.reject(new Error('Input ROM engine sudah dilepas.'))
      return this.pending ??= super.arrayBuffer()
    }
    release() { this.released = true; this.pending = undefined }
  }
  const input = new SessionRom([file], file.name, { type: file.type, lastModified: file.lastModified })
  return { file: input, release: () => input.release() }
}

export async function preparedBiosBlob(blob: Blob, url: string): Promise<Blob> {
  checkSize(blob, MAX_BIOS_SIZE)
  const fileName = engineAssetFileName(url)
  if (/\.(zip|7z|rar)$/i.test(fileName)) return blob
  // Native BIOS File input hits assetUrl.split() before extraction in 4.2.3.
  // A stored ZIP served through a session-owned blob URL avoids that path and
  // preserves the exact firmware basename that the original URL would use.
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const name = new TextEncoder().encode(fileName)
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  crc = (crc ^ 0xffffffff) >>> 0
  const header = new Uint8Array(30 + name.length)
  const h = new DataView(header.buffer)
  h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true)
  h.setUint32(14, crc, true); h.setUint32(18, bytes.length, true); h.setUint32(22, bytes.length, true)
  h.setUint16(26, name.length, true); header.set(name, 30)
  const central = new Uint8Array(46 + name.length)
  const c = new DataView(central.buffer)
  c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true)
  c.setUint32(16, crc, true); c.setUint32(20, bytes.length, true); c.setUint32(24, bytes.length, true)
  c.setUint16(28, name.length, true); central.set(name, 46)
  const end = new Uint8Array(22), e = new DataView(end.buffer)
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, 1, true); e.setUint16(10, 1, true)
  e.setUint32(12, central.length, true); e.setUint32(16, header.length + bytes.length, true)
  return new Blob([header, bytes, central, end], { type: 'application/zip' })
}
