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
