import { csrfToken, equalToken } from './crypto.mjs'
import { AuthError } from './limits.mjs'

export function resolveRequestOrigin(request, config) {
  const host = request.headers.host
  // Host must be an authority, never a URL, credentials or a forwarded header.
  if (typeof host !== 'string' || !host || /[\s/\\@?#]/.test(host)) throw new AuthError(403, 'Origin akun tidak valid.')
  const origins = config.publicOrigins?.length ? config.publicOrigins : config.publicOrigin ? [config.publicOrigin] : []
  try {
    if (!origins.length) {
      const local = new URL(`http://${host}`)
      if (!['localhost', '127.0.0.1', '[::1]'].includes(local.hostname)) throw new AuthError(403, 'Akses akun memerlukan HTTPS. Gunakan localhost atau konfigurasi MAIN_DULU_PUBLIC_ORIGINS.')
      return local
    }
    const matches = origins.map(origin => new URL(origin)).filter(origin => new URL(`${origin.protocol}//${host}`).host === origin.host)
    if (!matches.length) throw new AuthError(403, 'Alamat akun tidak sesuai konfigurasi server.')
    // If both schemes share a Host, use the validated Origin header. Without
    // Origin (e.g. GET session), prefer HTTPS so cookies never downgrade by order.
    return matches.find(origin => origin.origin === request.headers.origin) ?? matches.find(origin => origin.protocol === 'https:') ?? matches[0]
  } catch (error) {
    if (error instanceof AuthError) throw error
    throw new AuthError(403, 'Origin akun tidak valid.')
  }
}

export function protectRequest(request, config, current, contentTypes = ['application/json']) {
  const expected = resolveRequestOrigin(request, config)
  if (request.headers.origin !== undefined && request.headers.origin !== expected.origin) throw new AuthError(403, 'Permintaan akun harus berasal dari situs yang sama.')
  if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) throw new AuthError(403, 'Permintaan akun harus berasal dari situs yang sama.')
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const type = request.headers['content-type']?.split(';')[0].trim().toLowerCase()
    if (request.headers.origin !== expected.origin || !contentTypes.includes(type)) throw new AuthError(403, 'Permintaan akun tidak valid. Muat ulang halaman dan coba lagi.')
    current(request)
    if (!equalToken(request.headers['x-csrf-token'], csrfToken(request.cookies.maindulu_session))) throw new AuthError(403, 'Token keamanan tidak valid. Muat ulang halaman dan coba lagi.')
  }
  return expected
}

export function createAdminSecurity(config, current) {
  // current queries sessions JOIN users on every call: never trust a role from
  // cookies, request bodies, or a previous request. Recheck at mutation commit
  // too if an operation awaits asynchronous work after its onRequest guard.
  function requireAdmin(request) {
    const session = current(request)
    if (!session.user_id) throw new AuthError(401, 'Silakan masuk terlebih dahulu.')
    if (session.role !== 'admin') throw new AuthError(403, 'Akses ini hanya untuk admin.')
    return session
  }
  function protectAdmin(request, { multipart = false } = {}) {
    const session = requireAdmin(request)
    // Opt in only on upload routes; account/save APIs retain their own types
    // and limits. This runs before body parsing or multipart file processing.
    protectRequest(request, config, current, multipart ? ['application/json', 'multipart/form-data'] : ['application/json'])
    return session
  }
  return { requireAdmin, protectAdmin }
}
