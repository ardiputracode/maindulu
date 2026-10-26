import { csrfToken, equalToken } from './crypto.mjs'
import { AuthError } from './limits.mjs'

export function protectRequest(request, config, current, contentTypes = ['application/json']) {
  let expected
  try { expected = new URL(config.publicOrigin ?? `http://${request.headers.host}`) }
  catch { throw new AuthError(403, 'Origin akun tidak valid.') }
  if (!config.publicOrigin && !['localhost', '127.0.0.1', '[::1]'].includes(expected.hostname)) throw new AuthError(403, 'Akses akun memerlukan HTTPS. Gunakan localhost atau konfigurasi MAIN_DULU_PUBLIC_ORIGIN.')
  if (new URL(`${expected.protocol}//${request.headers.host}`).host !== expected.host) throw new AuthError(403, 'Alamat akun tidak sesuai konfigurasi server.')
  if (request.headers.origin !== undefined && request.headers.origin !== expected.origin) throw new AuthError(403, 'Permintaan akun harus berasal dari situs yang sama.')
  if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) throw new AuthError(403, 'Permintaan akun harus berasal dari situs yang sama.')
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const type = request.headers['content-type']?.split(';')[0].trim().toLowerCase()
    if (request.headers.origin !== expected.origin || !contentTypes.includes(type)) throw new AuthError(403, 'Permintaan akun tidak valid. Muat ulang halaman dan coba lagi.')
    current(request)
    if (!equalToken(request.headers['x-csrf-token'], csrfToken(request.cookies.maindulu_session))) throw new AuthError(403, 'Token keamanan tidak valid. Muat ulang halaman dan coba lagi.')
  }
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
