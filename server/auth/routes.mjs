import cookie from '@fastify/cookie'
import { randomUUID } from 'node:crypto'
import { csrfToken, dummyHash, equalToken, hashPassword, hashRecoveryCode, hashToken, normalizeRecoveryCode, normalizeUsername, randomToken, recoveryCode, validPassword, verifyPassword } from './crypto.mjs'
import { AuthError, createLimiter } from './limits.mjs'
import { replaceCredentials, transaction as dbTransaction } from './mutations.mjs'

const cookieName = 'maindulu_session'
const sessionAge = 7 * 24 * 60 * 60
const anonymousAge = 60 * 60
const publicUser = user => ({ id: user.user_id ?? user.id, username: user.username })

export function registerAuth(app, config) {
  const db = app.database
  const consume = createLimiter()
  let activeWork = 0
  async function passwordWork(work) {
    // Bound memory use instead of queueing arbitrary scrypt requests.
    if (activeWork >= 2) throw new AuthError(429, 'Server sedang memeriksa akun lain. Coba lagi sebentar.', 1)
    activeWork++
    try { return await work() }
    finally { activeWork-- }
  }
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: config.publicOrigin?.startsWith('https:') ?? false, path: '/api' }
  function findSession(request) {
    const token = request.cookies[cookieName]
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null
    return db.prepare(`SELECT s.token_hash, s.user_id, s.expires_at, u.username, u.password_hash
      FROM sessions s LEFT JOIN users u ON s.user_id = u.id
      WHERE s.token_hash = ? AND s.expires_at > ?`).get(hashToken(token), Date.now()) ?? null
  }
  function current(request) {
    const session = findSession(request)
    if (!session) throw new AuthError(401, 'Sesi berakhir. Silakan masuk lagi.')
    return session
  }
  function newSession(reply, userId = null, oldHash = null) {
    const token = randomToken()
    const age = userId ? sessionAge : anonymousAge
    const now = Date.now()
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
    if (oldHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(oldHash)
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(hashToken(token), userId, now, now + age * 1000)
    reply.setCookie(cookieName, token, { ...cookieOptions, maxAge: age })
    return csrfToken(token)
  }
  function sessionResult(request) {
    const session = findSession(request)
    return { user: session?.user_id ? publicUser(session) : null, csrfToken: session ? csrfToken(request.cookies[cookieName]) : null, registrationOpen: config.registrationOpen }
  }
  function transaction(work) {
    return dbTransaction(db, work)
  }
  app.register(cookie)
  app.register(async auth => {
    auth.addHook('onRequest', async request => {
      let expected
      try { expected = new URL(config.publicOrigin ?? `http://${request.headers.host}`) }
      catch { throw new AuthError(403, 'Origin akun tidak valid.') }
      if (!config.publicOrigin && !['localhost', '127.0.0.1', '[::1]'].includes(expected.hostname)) throw new AuthError(403, 'Akses akun memerlukan HTTPS. Gunakan localhost atau konfigurasi MAIN_DULU_PUBLIC_ORIGIN.')
      if (new URL(`${expected.protocol}//${request.headers.host}`).host !== expected.host) throw new AuthError(403, 'Alamat akun tidak sesuai konfigurasi server.')
      if (request.headers.origin !== undefined && request.headers.origin !== expected.origin) throw new AuthError(403, 'Permintaan akun harus berasal dari situs yang sama.')
      if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) throw new AuthError(403, 'Permintaan akun harus berasal dari situs yang sama.')
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        if (request.headers.origin !== expected.origin || !request.headers['content-type']?.startsWith('application/json')) throw new AuthError(403, 'Permintaan akun tidak valid. Muat ulang halaman dan coba lagi.')
        current(request)
        if (!equalToken(request.headers['x-csrf-token'], csrfToken(request.cookies[cookieName]))) throw new AuthError(403, 'Token keamanan tidak valid. Muat ulang halaman dan coba lagi.')
      }
    })
    auth.get('/session', async request => sessionResult(request))
    auth.get('/csrf', async (request, reply) => {
      consume('csrf:' + request.ip, 60, 60000)
      if (!findSession(request)) return { user: null, csrfToken: newSession(reply), registrationOpen: config.registrationOpen }
      return sessionResult(request)
    })
    auth.post('/register', async (request, reply) => {
      consume('register:' + request.ip, 10, 15 * 60000)
      if (!config.registrationOpen) throw new AuthError(403, 'Pendaftaran akun sedang ditutup oleh pengelola.')
      const session = current(request)
      if (session.user_id) throw new AuthError(409, 'Keluar dari akun saat ini sebelum membuat akun baru.')
      const { username, password, passwordConfirmation } = request.body ?? {}
      const name = normalizeUsername(username)
      if (!name) throw new AuthError(400, 'Username harus 3–24 karakter: huruf a–z, angka, atau garis bawah.')
      if (!validPassword(password)) throw new AuthError(400, 'Password harus 6–128 karakter.')
      if (password !== passwordConfirmation) throw new AuthError(400, 'Konfirmasi password tidak sama.')
      const passwordHash = await passwordWork(() => hashPassword(password))
      const code = recoveryCode()
      const user = { id: randomUUID(), username: name }
      const csrf = transaction(() => {
        current(request)
        if (db.prepare('SELECT id FROM users WHERE username = ?').get(name)) throw new AuthError(409, 'Username sudah digunakan. Pilih username lain.')
        db.prepare('INSERT INTO users (id, username, password_hash, recovery_code_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(user.id, name, passwordHash, hashRecoveryCode(code), Date.now())
        return newSession(reply, user.id, session.token_hash)
      })
      return reply.code(201).send({ user, csrfToken: csrf, registrationOpen: config.registrationOpen, recoveryCode: code })
    })
    auth.post('/login', async (request, reply) => {
      consume('login:' + request.ip, 30, 15 * 60000)
      const { username, password } = request.body ?? {}
      const name = normalizeUsername(username)
      consume('login-name:' + request.ip + ':' + (name ?? 'invalid'), 10, 15 * 60000)
      if (!name || !validPassword(password)) throw new AuthError(401, 'Username atau password tidak sesuai.')
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(name)
      const matches = await passwordWork(() => verifyPassword(password, user?.password_hash ?? dummyHash))
      if (!user || !matches) throw new AuthError(401, 'Username atau password tidak sesuai.')
      const csrf = transaction(() => {
        const session = current(request)
        if (db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id)?.password_hash !== user.password_hash) throw new AuthError(401, 'Username atau password tidak sesuai.')
        return newSession(reply, user.id, session.token_hash)
      })
      return { user: publicUser(user), csrfToken: csrf, registrationOpen: config.registrationOpen }
    })
    auth.post('/logout', async (request, reply) => {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(current(request).token_hash)
      reply.clearCookie(cookieName, cookieOptions)
      return { ok: true }
    })
    auth.post('/password', async (request, reply) => {
      const session = current(request)
      if (!session.user_id) throw new AuthError(401, 'Silakan masuk terlebih dahulu.')
      consume('password:' + request.ip + ':' + session.user_id, 10, 15 * 60000)
      const { currentPassword, newPassword, passwordConfirmation } = request.body ?? {}
      if (!validPassword(currentPassword)) throw new AuthError(401, 'Password saat ini tidak sesuai.')
      if (!validPassword(newPassword)) throw new AuthError(400, 'Password baru harus 6–128 karakter.')
      if (newPassword !== passwordConfirmation) throw new AuthError(400, 'Konfirmasi password tidak sama.')
      const passwordHash = await passwordWork(async () => {
        if (!await verifyPassword(currentPassword, session.password_hash)) throw new AuthError(401, 'Password saat ini tidak sesuai.')
        return hashPassword(newPassword)
      })
      transaction(() => {
        current(request)
        const changed = db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?').run(passwordHash, session.user_id, session.password_hash)
        if (changed.changes !== 1) throw new AuthError(401, 'Sesi berakhir. Silakan masuk lagi.')
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(session.user_id)
      })
      reply.clearCookie(cookieName, cookieOptions)
      return { ok: true }
    })
    auth.post('/recover', async (request, reply) => {
      consume('recover:' + request.ip, 30, 15 * 60000)
      const { username, recoveryCode: supplied, newPassword, passwordConfirmation } = request.body ?? {}
      const name = normalizeUsername(username)
      consume('recover-name:' + request.ip + ':' + (name ?? 'invalid'), 10, 15 * 60000)
      if (!validPassword(newPassword)) throw new AuthError(400, 'Password baru harus 6–128 karakter.')
      if (newPassword !== passwordConfirmation) throw new AuthError(400, 'Konfirmasi password tidak sama.')
      const code = normalizeRecoveryCode(supplied)
      const user = name ? db.prepare('SELECT * FROM users WHERE username = ?').get(name) : null
      // Equal expensive work for valid-shaped attempts, regardless of account/code.
      const passwordHash = await passwordWork(() => hashPassword(newPassword))
      if (!user || !code || !equalToken(hashRecoveryCode(code), user.recovery_code_hash)) throw new AuthError(401, 'Username atau kode pemulihan tidak sesuai.')
      const nextCode = recoveryCode()
      replaceCredentials(db, user, passwordHash, nextCode, () => {
        const session = current(request)
        if (session.user_id && session.user_id !== user.id) throw new AuthError(409, 'Keluar dari akun saat ini sebelum memulihkan akun lain.')
      })
      reply.clearCookie(cookieName, cookieOptions)
      return { ok: true, username: user.username, recoveryCode: nextCode }
    })
    auth.post('/recovery-code', async request => {
      const session = current(request)
      if (!session.user_id) throw new AuthError(401, 'Silakan masuk terlebih dahulu.')
      consume('recovery-code:' + request.ip, 30, 15 * 60000)
      consume('recovery-code-user:' + request.ip + ':' + session.user_id, 10, 15 * 60000)
      const { currentPassword } = request.body ?? {}
      if (!validPassword(currentPassword)) throw new AuthError(401, 'Password saat ini tidak sesuai.')
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id)
      await passwordWork(async () => {
        if (!await verifyPassword(currentPassword, user.password_hash)) throw new AuthError(401, 'Password saat ini tidak sesuai.')
      })
      const code = recoveryCode()
      transaction(() => {
        current(request)
        const changed = db.prepare('UPDATE users SET recovery_code_hash = ? WHERE id = ? AND password_hash = ? AND recovery_code_hash = ?')
          .run(hashRecoveryCode(code), user.id, user.password_hash, user.recovery_code_hash)
        if (changed.changes !== 1) throw new AuthError(401, 'Akun berubah. Periksa sesi dan coba lagi.')
      })
      return { username: user.username, recoveryCode: code }
    })
  }, { prefix: '/api/auth' })
}
