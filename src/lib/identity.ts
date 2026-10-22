import { sha256 } from '@noble/hashes/sha2.js'

type BrowserCrypto = Partial<Pick<Crypto, 'subtle' | 'randomUUID' | 'getRandomValues'>>

const HASH_CHUNK_SIZE = 1024 * 1024
const MAX_NATIVE_HASH_SIZE = 16 * 1024 * 1024

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

// Both implementations produce the same SHA-256 so existing game/save IDs stay valid.
// Web Crypto is unavailable on HTTP LAN origins, but hashing a local file need not be.
export async function hashRom(file: Blob, provider: BrowserCrypto | undefined = globalThis.crypto): Promise<string> {
  if (file.size <= MAX_NATIVE_HASH_SIZE && typeof provider?.subtle?.digest === 'function') {
    const buffer = await file.arrayBuffer()
    try {
      return toHex(new Uint8Array(await provider.subtle.digest('SHA-256', buffer)))
    } catch {
      // A browser may expose the API but reject its use. Keep the local fallback.
    }
  }

  const hash = sha256.create()
  try {
    for (let offset = 0; offset < file.size; offset += HASH_CHUNK_SIZE) {
      const buffer = await file.slice(offset, offset + HASH_CHUNK_SIZE).arrayBuffer()
      hash.update(new Uint8Array(buffer))
      // Bound memory and give mobile browsers time to render between chunks.
      if (offset + HASH_CHUNK_SIZE < file.size) await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    return toHex(hash.digest())
  } finally {
    hash.destroy()
  }
}

export function createSessionId(provider: BrowserCrypto | undefined = globalThis.crypto): string {
  if (typeof provider?.randomUUID === 'function') {
    try { return provider.randomUUID() } catch { /* Use getRandomValues on HTTP or restricted browsers. */ }
  }
  if (typeof provider?.getRandomValues !== 'function') {
    throw new Error('Browser ini tidak menyediakan generator ID sesi yang aman. Coba browser yang lebih baru.')
  }

  // getRandomValues is also available in insecure contexts; do not use Math.random.
  const bytes = provider.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = toHex(bytes)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
