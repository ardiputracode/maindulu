import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectRoot = fileURLToPath(new URL('../', import.meta.url))

export function isWithin(path, parent) {
  const suffix = relative(parent, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep))
}

// Resolve symlinked ancestors even when the final data directory is new.
export async function canonicalPath(path) {
  try { return await realpath(path) }
  catch (error) {
    if (error.code !== 'ENOENT' || dirname(path) === path) throw error
    return join(await canonicalPath(dirname(path)), basename(path))
  }
}

export async function readConfig(env = process.env, root = projectRoot) {
  function bytes(name, fallback, maximum) {
    const value = env[name] ?? String(fallback)
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1024 || Number(value) > maximum) throw new Error(`${name} harus bilangan byte 1024–${maximum}.`)
    return Number(value)
  }
  function integer(name, fallback, min, max) {
    const value = env[name] ?? String(fallback)
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`${name} harus bilangan ${min}–${max}.`)
    return Number(value)
  }
  const registration = env.MAIN_DULU_REGISTRATION_OPEN ?? 'true'
  if (!['true', 'false'].includes(registration)) throw new Error('MAIN_DULU_REGISTRATION_OPEN harus true atau false.')
  const insecureHttp = env.MAIN_DULU_ALLOW_INSECURE_HTTP ?? 'false'
  if (!['true', 'false'].includes(insecureHttp)) throw new Error('MAIN_DULU_ALLOW_INSECURE_HTTP harus true atau false.')
  const allowInsecureHttp = insecureHttp === 'true'
  // Opt-in never permits deriving a network account origin from an arbitrary Host.
  if (allowInsecureHttp && env.MAIN_DULU_PUBLIC_ORIGIN === undefined) throw new Error('MAIN_DULU_PUBLIC_ORIGIN wajib diatur saat MAIN_DULU_ALLOW_INSECURE_HTTP=true.')
  let publicOrigin = null
  if (env.MAIN_DULU_PUBLIC_ORIGIN !== undefined) {
    try {
      const url = new URL(env.MAIN_DULU_PUBLIC_ORIGIN)
      if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && (allowInsecureHttp || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))) throw new Error()
      publicOrigin = url.origin
    } catch { throw new Error('MAIN_DULU_PUBLIC_ORIGIN harus origin HTTPS atau HTTP localhost, tanpa path, kredensial, query, atau fragment. HTTP jaringan memerlukan MAIN_DULU_ALLOW_INSECURE_HTTP=true (hanya LAN tepercaya).') }
  }
  const rawPort = env.MAIN_DULU_PORT ?? '7777'
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw new Error('MAIN_DULU_PORT harus berupa angka 1–65535.')
  const host = env.MAIN_DULU_HOST ?? '127.0.0.1'
  if (!host.trim()) throw new Error('MAIN_DULU_HOST tidak boleh kosong.')
  if (env.MAIN_DULU_DATA_DIR !== undefined && !env.MAIN_DULU_DATA_DIR.trim()) throw new Error('MAIN_DULU_DATA_DIR tidak boleh kosong.')
  if (env.MAIN_DULU_DIST_DIR !== undefined && !env.MAIN_DULU_DIST_DIR.trim()) throw new Error('MAIN_DULU_DIST_DIR tidak boleh kosong.')
  const distDir = await canonicalPath(resolve(root, env.MAIN_DULU_DIST_DIR ?? 'dist'))
  const dataDir = await canonicalPath(resolve(root, env.MAIN_DULU_DATA_DIR ?? 'data'))
  const publicDir = await canonicalPath(resolve(root, 'public'))
  for (const served of [distDir, publicDir]) {
    if (isWithin(dataDir, served) || isWithin(served, dataDir)) throw new Error('Folder data harus terpisah dari folder public dan hasil build, termasuk target symlink.')
  }
  return { host, port: Number(rawPort), distDir, publicDir, dataDir, registrationOpen: registration === 'true', publicOrigin, allowInsecureHttp,
    stateMaxBytes: bytes('MAIN_DULU_STATE_MAX_BYTES', 32 * 1024 * 1024, 64 * 1024 * 1024),
    gameSaveMaxBytes: bytes('MAIN_DULU_GAME_SAVE_MAX_BYTES', 8 * 1024 * 1024, 8 * 1024 * 1024),
    saveQuotaBytes: bytes('MAIN_DULU_SAVE_QUOTA_BYTES', 256 * 1024 * 1024, 16 * 1024 * 1024 * 1024),
    catalogQuotaBytes: bytes('MAIN_DULU_CATALOG_QUOTA_BYTES', 20 * 1024 ** 3, 1024 * 1024 ** 3),
    catalogMinFreeBytes: integer('MAIN_DULU_CATALOG_MIN_FREE_BYTES', 256 * 1024 * 1024, 0, 1024 * 1024 ** 3),
    catalogUploadLimit: integer('MAIN_DULU_CATALOG_UPLOAD_LIMIT', 2, 1, 16),
    catalogUploadTimeoutMs: integer('MAIN_DULU_CATALOG_UPLOAD_TIMEOUT_MS', 30 * 60 * 1000, 1000, 60 * 60 * 1000) }
}
