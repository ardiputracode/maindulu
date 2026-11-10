import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'
import { hashToken, normalizeUsername, validPassword, verifyPassword } from './crypto.mjs'
import { AuthError, createLimiter } from './limits.mjs'
import { resolveRequestOrigin } from './security.mjs'

const cookieName = 'maindulu_gate'
const digest = value => createHash('sha256').update(value).digest()
const equal = (a, b) => timingSafeEqual(digest(a), digest(b))

export function createGate(config, db) {
  const installation = db.prepare("SELECT value FROM app_metadata WHERE key = 'installation_id'").get().value
  const key = hkdfSync('sha256', JSON.stringify([config.gateUsername, config.gatePasswordHash ?? config.gatePassword]), installation, 'maindulu-gate-v1', 32)
  const age = config.gateSessionDays * 86400
  const consume = createLimiter()
  let activeWork = 0
  const sign = value => createHmac('sha256', key).update(value).digest('hex')
  function session(request) {
    const token = request.cookies[cookieName]
    if (typeof token !== 'string' || !/^v1\.[1-9][0-9]{0,11}\.[a-f0-9]{64}$/.test(token)) return { authenticated: false }
    const [version, expires, mac] = token.split('.')
    const expiresAt = Number(expires)
    if (!timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(sign(`${version}.${expires}`), 'hex')) || expiresAt <= Math.floor(Date.now() / 1000)) return { authenticated: false }
    return { authenticated: true, expiresAt }
  }
  function guard(request) {
    if (!session(request).authenticated) throw new AuthError(401, 'Pintunya terkunci lagi. Masuk sekali lagi, ya.', undefined, 'GATE_REQUIRED')
  }
  function protect(request) {
    const origin = resolveRequestOrigin(request, config)
    if (request.headers.origin !== origin.origin || (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) || request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new AuthError(403, 'Permintaan harus berasal dari ruang main yang sama.')
    return { httpOnly: true, sameSite: 'strict', secure: origin.protocol === 'https:', path: '/' }
  }
  async function login(request, reply) {
    const options = protect(request)
    consume('gate:' + request.ip, 10, 15 * 60000)
    if (activeWork >= 2) throw new AuthError(429, 'Pintu masuk sedang sibuk. Coba lagi sebentar.', 1)
    const { username, password } = request.body ?? {}
    const nameMatches = equal(normalizeUsername(username) ?? '', config.gateUsername)
    let passwordMatches = false
    activeWork++
    try {
      if (config.gatePasswordHash) passwordMatches = await verifyPassword(validPassword(password) ? password : '', config.gatePasswordHash)
      else passwordMatches = equal(typeof password === 'string' ? password : '', config.gatePassword)
    } finally { activeWork-- }
    if (!nameMatches || !passwordMatches || !validPassword(password)) throw new AuthError(401, 'Username atau password belum cocok. Coba lagi, ya.')
    const expiresAt = Math.floor(Date.now() / 1000) + age
    const value = `v1.${expiresAt}`
    reply.setCookie(cookieName, `${value}.${sign(value)}`, { ...options, maxAge: age })
    return { authenticated: true, expiresAt }
  }
  async function logout(request, reply) {
    const options = protect(request)
    const token = request.cookies.maindulu_session
    if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token))
    reply.clearCookie(cookieName, options)
    reply.clearCookie('maindulu_session', { ...options, path: '/api' })
    return { authenticated: false }
  }
  return { guard, requireSession: guard, login, logout, session }
}
