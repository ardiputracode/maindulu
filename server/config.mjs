import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectRoot = fileURLToPath(new URL('../', import.meta.url))

export function isWithin(path, parent) {
  const suffix = relative(parent, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep))
}

// Resolve symlinked ancestors even when the final data directory is new.
async function canonicalPath(path) {
  try { return await realpath(path) }
  catch (error) {
    if (error.code !== 'ENOENT' || dirname(path) === path) throw error
    return join(await canonicalPath(dirname(path)), basename(path))
  }
}

export async function readConfig(env = process.env, root = projectRoot) {
  const registration = env.MAIN_DULU_REGISTRATION_OPEN ?? 'true'
  if (!['true', 'false'].includes(registration)) throw new Error('MAIN_DULU_REGISTRATION_OPEN harus true atau false.')
  let publicOrigin = null
  if (env.MAIN_DULU_PUBLIC_ORIGIN !== undefined) {
    try {
      const url = new URL(env.MAIN_DULU_PUBLIC_ORIGIN)
      if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error()
      publicOrigin = url.origin
    } catch { throw new Error('MAIN_DULU_PUBLIC_ORIGIN harus origin HTTPS atau HTTP localhost, tanpa path, kredensial, atau query.') }
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
  return { host, port: Number(rawPort), distDir, dataDir, registrationOpen: registration === 'true', publicOrigin }
}
