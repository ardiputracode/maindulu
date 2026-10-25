import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createApp } from '../server/app.mjs'
import { openDatabase } from '../server/database.mjs'
import { readConfig } from '../server/config.mjs'
import { hashPassword, verifyPassword, normalizeUsername, normalizeRecoveryCode, validPassword, hashRecoveryCode, hashToken, randomToken } from '../server/auth/crypto.mjs'
import { createLimiter } from '../server/auth/limits.mjs'
import { replaceCredentials, resetAccountByAdmin } from '../server/auth/mutations.mjs'
import { backendFixture } from './helpers/backend-fixture.mjs'

const password = 'Correct horse battery 42!'
const nextPassword = 'Another long password 77!'
const headers = { host: 'localhost:7777', origin: 'http://localhost:7777', 'sec-fetch-site': 'same-origin' }

async function setup(t, env = {}, logger = false) {
  const context = { app: null }
  context.root = await backendFixture(t, { beforeCleanup: () => context.app?.close() })
  context.app = await createApp({ root: context.root, env, logger })
  return context
}

function cookieFrom(response) {
  const header = response.headers['set-cookie']
  return (Array.isArray(header) ? header[0] : header)?.split(';')[0] ?? ''
}

async function bootstrap(app, remoteAddress = '127.0.0.1') {
  const response = await app.inject({ url: '/api/auth/csrf', headers, remoteAddress })
  assert.equal(response.statusCode, 200)
  return { cookie: cookieFrom(response), csrf: response.json().csrfToken, remoteAddress }
}

function post(app, action, client, payload, extra = {}) {
  const requestHeaders = Object.fromEntries(Object.entries({ ...headers, cookie: client.cookie, 'x-csrf-token': client.csrf, ...extra.headers }).filter(([, value]) => value !== undefined))
  return app.inject({ method: 'POST', url: '/api/auth/' + action, payload, remoteAddress: client.remoteAddress, ...extra, headers: requestHeaders })
}

async function register(app, username = 'player_one', client) {
  client ??= await bootstrap(app)
  const response = await post(app, 'register', client, { username, password, passwordConfirmation: password })
  assert.equal(response.statusCode, 201, response.body)
  return { response, cookie: cookieFrom(response), csrf: response.json().csrfToken, remoteAddress: client.remoteAddress }
}

function session(app, client) {
  return app.inject({ url: '/api/auth/session', headers: { ...headers, cookie: client.cookie } })
}

test('username and password policy is bounded and does not normalize password contents', async () => {
  assert.equal(normalizeUsername('  Player_ONE  '), 'player_one')
  for (const name of ['a', 'a b', 'a/b', 'éclair', 'Kelvin', null, 'a'.repeat(25)]) assert.equal(normalizeUsername(name), null)
  assert.equal(validPassword('x'.repeat(6)), true)
  assert.equal(validPassword('x'.repeat(12)), true)
  assert.equal(validPassword('🔑'.repeat(6)), true)
  assert.equal(validPassword('x'.repeat(128)), true)
  for (const value of [null, 99, '', 'x'.repeat(5), '🔑'.repeat(5), 'x'.repeat(129)]) assert.equal(validPassword(value), false)
  const encoded = await hashPassword(password)
  assert.match(encoded, /^scrypt\$32768\$8\$3\$/)
  assert.notEqual(encoded, await hashPassword(password))
  assert.equal(await verifyPassword(password, encoded), true)
  assert.equal(await verifyPassword(password + ' ', encoded), false)
  assert.equal(await verifyPassword(password, 'malformed'), false)
})

test('registration rotates the anonymous cookie and reveals the recovery code once, with hashes only in SQLite', async t => {
  const { app } = await setup(t)
  const guest = await app.inject({ url: '/api/auth/session', headers })
  assert.deepEqual(guest.json(), { user: null, csrfToken: null, registrationOpen: true })
  assert.equal(guest.headers['set-cookie'], undefined)
  const before = await bootstrap(app)
  const created = await register(app, ' Player_ONE ', before)
  const { user, recoveryCode, csrfToken } = created.response.json()
  assert.equal(user.username, 'player_one')
  assert.match(recoveryCode, /^(?:[A-F0-9]{8}-){7}[A-F0-9]{8}$/)
  assert.match(csrfToken, /^[a-f0-9]{64}$/)
  assert.notEqual(created.cookie, before.cookie)
  const cookie = String(created.response.headers['set-cookie'])
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
  assert.match(cookie, /Path=\/api/)
  assert.match(cookie, /Max-Age=604800/)
  assert.doesNotMatch(cookie, /Secure|Domain=/)
  const stored = app.database.prepare('SELECT * FROM users WHERE id = ?').get(user.id)
  assert.notEqual(stored.password_hash, password)
  assert.equal(stored.recovery_code_hash, hashRecoveryCode(recoveryCode))
  const sessionRow = app.database.prepare('SELECT * FROM sessions WHERE user_id = ?').get(user.id)
  assert.equal(sessionRow.token_hash, hashToken(created.cookie.split('=')[1]))
  assert.notEqual(sessionRow.token_hash, created.cookie.split('=')[1])
  assert.equal((await session(app, before)).json().user, null)
  const refreshed = await session(app, created)
  assert.deepEqual(refreshed.json().user, user)
  assert.doesNotMatch(refreshed.body, /recoveryCode|password_hash|recovery_code_hash/)
  assert.equal(refreshed.headers['cache-control'], 'no-store')
})

test('registration validates confirmation and normalized uniqueness; operators can close registration', async t => {
  const { app } = await setup(t)
  const before = await bootstrap(app)
  for (const payload of [{ username: 'ab', password, passwordConfirmation: password }, { username: 'valid', password: 'short', passwordConfirmation: 'short' }, { username: 'valid', password, passwordConfirmation: 'different' }]) assert.equal((await post(app, 'register', before, payload)).statusCode, 400)
  await register(app, 'Same_Name')
  const duplicate = await post(app, 'register', before, { username: ' SAME_NAME ', password, passwordConfirmation: password })
  assert.equal(duplicate.statusCode, 409)
  assert.equal(app.database.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1)
  const closed = await setup(t, { MAIN_DULU_REGISTRATION_OPEN: 'false' })
  const client = await bootstrap(closed.app)
  assert.equal((await session(closed.app, client)).json().registrationOpen, false)
  assert.equal((await post(closed.app, 'register', client, { username: 'player', password, passwordConfirmation: password })).statusCode, 403)
})

test('known and unknown usernames have the same login error; logout revokes the cookie in the database', async t => {
  const { app } = await setup(t)
  const created = await register(app)
  assert.equal((await post(app, 'logout', created, {})).statusCode, 200)
  assert.equal((await session(app, created)).json().user, null)
  const guest = await bootstrap(app)
  const known = await post(app, 'login', guest, { username: 'PLAYER_ONE', password: nextPassword })
  const unknown = await post(app, 'login', guest, { username: 'unknown_user', password: nextPassword })
  assert.equal(known.statusCode, 401)
  assert.deepEqual(known.json(), unknown.json())
  const login = await post(app, 'login', guest, { username: '  PLAYER_ONE ', password })
  assert.equal(login.statusCode, 200)
  assert.notEqual(cookieFrom(login), guest.cookie)
  assert.equal(login.json().user.id, created.response.json().user.id)
  assert.equal((await session(app, guest)).json().user, null)
  assert.doesNotMatch(login.body, /recoveryCode|password_hash|recovery_code_hash/)
})

test('password change preserves identity and recovery hash while revoking every authenticated session', async t => {
  const { app } = await setup(t)
  const a = await register(app)
  const user = a.response.json().user
  const recovery = app.database.prepare('SELECT recovery_code_hash FROM users WHERE id = ?').get(user.id).recovery_code_hash
  const guest = await bootstrap(app)
  const login = await post(app, 'login', guest, { username: user.username, password })
  const b = { cookie: cookieFrom(login), csrf: login.json().csrfToken }
  const wrong = await post(app, 'password', a, { currentPassword: nextPassword, newPassword: nextPassword, passwordConfirmation: nextPassword })
  assert.equal(wrong.statusCode, 401)
  assert.ok((await session(app, b)).json().user)
  const changed = await post(app, 'password', a, { currentPassword: password, newPassword: nextPassword, passwordConfirmation: nextPassword })
  assert.equal(changed.statusCode, 200)
  assert.match(String(changed.headers['set-cookie']), /Max-Age=0|Expires=Thu, 01 Jan 1970/)
  for (const old of [a, b]) assert.equal((await session(app, old)).json().user, null)
  assert.equal(app.database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(user.id).count, 0)
  assert.equal(app.database.prepare('SELECT recovery_code_hash FROM users WHERE id = ?').get(user.id).recovery_code_hash, recovery)
  const fresh = await bootstrap(app)
  assert.equal((await post(app, 'login', fresh, { username: user.username, password })).statusCode, 401)
  const restored = await post(app, 'login', fresh, { username: user.username, password: nextPassword })
  assert.equal(restored.statusCode, 200)
  assert.deepEqual(restored.json().user, user)
})

test('expired or forged sessions cannot mutate accounts or silently extend their expiration', async t => {
  const { app } = await setup(t)
  const created = await register(app)
  app.database.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1)
  assert.equal((await session(app, created)).json().user, null)
  assert.equal((await post(app, 'logout', created, {})).statusCode, 401)
  assert.equal((await session(app, { cookie: 'maindulu_session=' + randomToken() })).json().user, null)
  assert.equal(app.database.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1)
})

test('CSRF protection rejects missing/wrong Origin, cross-site fetch, non-JSON bodies, and wrong tokens', async t => {
  const { app } = await setup(t)
  const client = await bootstrap(app)
  const payload = { username: 'protected_user', password, passwordConfirmation: password }
  for (const overrides of [{ origin: undefined }, { origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'x-csrf-token': undefined }, { 'x-csrf-token': 'f'.repeat(64) }, { 'content-type': 'text/plain' }]) {
    const response = await post(app, 'register', client, payload, { headers: overrides })
    assert.equal(response.statusCode, 403, response.body)
    assert.doesNotMatch(response.body, new RegExp(password))
  }
  assert.equal(app.database.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0)
  assert.equal((await post(app, 'register', client, payload)).statusCode, 201)
})

test('network accounts require an explicit secure public origin and use Secure cookies behind HTTPS', async t => {
  const { app, root } = await setup(t)
  const insecure = await app.inject({ url: '/api/auth/session', headers: { host: '192.168.1.5:7777' } })
  assert.equal(insecure.statusCode, 403)
  assert.equal((await app.inject('/api/health')).statusCode, 200)
  for (const origin of ['http://192.168.1.5:7777', 'https://example.com/path', 'https://user:secret@example.com', 'garbage']) await assert.rejects(readConfig({ MAIN_DULU_PUBLIC_ORIGIN: origin }, root), /MAIN_DULU_PUBLIC_ORIGIN/)
  const secure = await setup(t, { MAIN_DULU_PUBLIC_ORIGIN: 'https://games.example.com' })
  const response = await secure.app.inject({ url: '/api/auth/csrf', headers: { host: 'games.example.com', origin: 'https://games.example.com', 'sec-fetch-site': 'same-origin' } })
  assert.equal(response.statusCode, 200)
  assert.match(String(response.headers['set-cookie']), /; Secure/)
  assert.equal((await secure.app.inject({ url: '/api/auth/session', headers: { host: 'games.example.com', origin: 'https://evil.example' } })).statusCode, 403)
})

test('rate limits are bounded windows per source/account pair, not permanent account lockouts', async t => {
  const { app } = await setup(t)
  const created = await register(app)
  const client = await bootstrap(app)
  for (let i = 0; i < 10; i++) assert.equal((await post(app, 'login', client, { username: 'player_one', password: 'bad' })).statusCode, 401)
  const limited = await post(app, 'login', client, { username: 'player_one', password })
  assert.equal(limited.statusCode, 429)
  assert.ok(Number(limited.headers['retry-after']) > 0)
  const otherSource = await bootstrap(app, '127.0.0.2')
  assert.equal((await post(app, 'login', otherSource, { username: created.response.json().user.username, password })).statusCode, 200)
  let now = 0
  const consume = createLimiter(() => now)
  consume('test', 1, 1000)
  assert.throws(() => consume('test', 1, 1000), /Terlalu banyak/)
  now = 1001
  assert.doesNotThrow(() => consume('test', 1, 1000))
})

test('concurrent login requests cannot reuse the same pre-auth session to mint two authenticated cookies', async t => {
  const { app } = await setup(t)
  await register(app)
  const guest = await bootstrap(app)
  const responses = await Promise.all([post(app, 'login', guest, { username: 'player_one', password }), post(app, 'login', guest, { username: 'player_one', password })])
  assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 401])
})

test('accounts and sessions persist across server recreation without storing raw session tokens', async t => {
  const context = await setup(t)
  const created = await register(context.app)
  const user = created.response.json().user
  await context.app.close()
  context.app = await createApp({ root: context.root, env: {} })
  assert.deepEqual((await session(context.app, created)).json().user, user)
  assert.equal(context.app.database.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').get(user.id).token_hash, hashToken(created.cookie.split('=')[1]))
})

test('M2 databases migrate to accounts without losing installation metadata', async t => {
  const root = await backendFixture(t)
  const dir = join(root, 'data')
  await mkdir(dir)
  const old = new DatabaseSync(join(dir, 'maindulu.sqlite'))
  old.exec(`CREATE TABLE app_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT;
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;
    INSERT INTO app_metadata VALUES ('installation_id', 'existing-m2-installation');
    INSERT INTO schema_migrations VALUES (1, 'application-metadata', '2026-10-24');
    PRAGMA user_version = 1;`)
  old.close()
  const db = await openDatabase(dir)
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6)
    assert.equal(db.prepare("SELECT value FROM app_metadata WHERE key = 'installation_id'").get().value, 'existing-m2-installation')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0)
  } finally { db.close() }
})

test('normal request logging never contains passwords, recovery codes, cookies or CSRF tokens', async t => {
  const logs = []
  const { app } = await setup(t, {}, { level: 'info', stream: { write: value => logs.push(value) } })
  const created = await register(app)
  await session(app, created)
  const output = logs.join('')
  for (const secret of [password, created.response.json().recoveryCode, created.cookie.split('=')[1], created.csrf]) assert.ok(!output.includes(secret))
})

const resetPayload = (username, recoveryCode, secret = nextPassword) => ({ username, recoveryCode, newPassword: secret, passwordConfirmation: secret })

test('recovery code parser accepts only bounded hex codes with exact optional grouping', () => {
  const hex = 'ab12cd34'.repeat(8)
  assert.equal(normalizeRecoveryCode(' ' + hex + ' '), hex.toUpperCase())
  assert.equal(normalizeRecoveryCode(hex.match(/.{8}/g).join('-')), hex.toUpperCase())
  for (const value of [null, {}, '', 'a'.repeat(63), 'g'.repeat(64), hex + '-', hex.slice(0, 32) + '-' + hex.slice(32), 'a'.repeat(1000)]) assert.equal(normalizeRecoveryCode(value), null)
})

test('recovery preserves account/owned records, rotates code, rejects old credentials and revokes every session', async t => {
  const { app } = await setup(t)
  const created = await register(app)
  const { user, recoveryCode } = created.response.json()
  const guest = await bootstrap(app)
  const login = await post(app, 'login', guest, { username: user.username, password })
  const second = { cookie: cookieFrom(login), csrf: login.json().csrfToken }
  // Ownership sentinel, not a claim that server saves already exist in M4.
  app.database.exec('CREATE TABLE owned_fixture (user_id TEXT REFERENCES users(id), content TEXT)')
  app.database.prepare('INSERT INTO owned_fixture VALUES (?, ?)').run(user.id, 'existing-progress')
  const client = await bootstrap(app)
  const response = await post(app, 'recover', client, resetPayload('  PLAYER_ONE ', recoveryCode.toLowerCase().replaceAll('-', '')))
  assert.equal(response.statusCode, 200, response.body)
  assert.match(String(response.headers['set-cookie']), /Max-Age=0|Expires=Thu, 01 Jan 1970/)
  assert.equal(response.json().username, user.username)
  assert.notEqual(response.json().recoveryCode, recoveryCode)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.doesNotMatch(response.body, /password_hash|recovery_code_hash|csrfToken/)
  for (const old of [created, second]) {
    assert.equal((await session(app, old)).json().user, null)
    assert.equal((await post(app, 'logout', old, {})).statusCode, 401)
  }
  const row = app.database.prepare('SELECT * FROM users WHERE id = ?').get(user.id)
  assert.equal(row.recovery_code_hash, hashRecoveryCode(response.json().recoveryCode))
  assert.equal(await verifyPassword(nextPassword, row.password_hash), true)
  assert.deepEqual({ ...app.database.prepare('SELECT * FROM owned_fixture').get() }, { user_id: user.id, content: 'existing-progress' })
  assert.equal((await post(app, 'login', client, { username: user.username, password })).statusCode, 401)
  assert.equal((await post(app, 'recover', client, resetPayload(user.username, recoveryCode))).statusCode, 401)
  const loggedIn = await post(app, 'login', client, { username: user.username, password: nextPassword })
  assert.deepEqual(loggedIn.json().user, user)
  const fresh = await bootstrap(app)
  assert.equal((await post(app, 'recover', fresh, resetPayload(user.username, response.json().recoveryCode, password))).statusCode, 200)
})

test('wrong, cross-account, malformed and unknown recovery attempts share one error without changing accounts', async t => {
  const { app } = await setup(t)
  const a = await register(app, 'player_a')
  const b = await register(app, 'player_b')
  const before = app.database.prepare('SELECT * FROM users ORDER BY id').all()
  const client = await bootstrap(app)
  let expected
  for (const [name, code] of [['player_a', b.response.json().recoveryCode], ['player_a', '00'.repeat(32)], ['missing_user', a.response.json().recoveryCode], ['player_a', {}], ['bad/name', a.response.json().recoveryCode]]) {
    const response = await post(app, 'recover', client, resetPayload(name, code))
    assert.equal(response.statusCode, 401)
    expected ??= response.json()
    assert.deepEqual(response.json(), expected)
  }
  assert.deepEqual(app.database.prepare('SELECT * FROM users ORDER BY id').all(), before)
  assert.ok((await session(app, a)).json().user)
  assert.ok((await session(app, b)).json().user)
  assert.equal((await post(app, 'recover', b, resetPayload('player_a', a.response.json().recoveryCode))).statusCode, 409)
  for (const payload of [resetPayload('player_a', a.response.json().recoveryCode, 'short'), { ...resetPayload('player_a', a.response.json().recoveryCode), passwordConfirmation: 'different' }]) assert.equal((await post(app, 'recover', client, payload)).statusCode, 400)
})

test('one code succeeds at most once across independent sessions and database connections', async t => {
  const { app, root } = await setup(t)
  const other = await createApp({ root, env: {} })
  try {
    const created = await register(app)
    const a = await bootstrap(app)
    const b = await bootstrap(other)
    const payload = resetPayload('player_one', created.response.json().recoveryCode)
    const responses = await Promise.all([post(app, 'recover', a, payload), post(other, 'recover', b, payload)])
    assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 401])
    assert.equal(app.database.prepare('SELECT recovery_code_hash FROM users').get().recovery_code_hash, hashRecoveryCode(responses.find(r => r.statusCode === 200).json().recoveryCode))
  } finally { await other.close() }
})

test('reissuing a code requires current password, keeps sessions and password, and invalidates the previous code', async t => {
  const { app } = await setup(t)
  const created = await register(app)
  const user = created.response.json().user
  const before = app.database.prepare('SELECT * FROM users').get()
  const guest = await bootstrap(app)
  assert.equal((await post(app, 'recovery-code', guest, { currentPassword: password })).statusCode, 401)
  assert.equal((await post(app, 'recovery-code', created, { currentPassword: nextPassword })).statusCode, 401)
  assert.equal(app.database.prepare('SELECT recovery_code_hash FROM users').get().recovery_code_hash, before.recovery_code_hash)
  const response = await post(app, 'recovery-code', created, { currentPassword: password })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().username, user.username)
  assert.equal((await session(app, created)).json().user.id, user.id)
  assert.equal(app.database.prepare('SELECT password_hash FROM users').get().password_hash, before.password_hash)
  assert.equal((await post(app, 'recover', guest, resetPayload(user.username, created.response.json().recoveryCode))).statusCode, 401)
  assert.equal((await post(app, 'recover', guest, resetPayload(user.username, response.json().recoveryCode))).statusCode, 200)
})

test('concurrent code reissues cannot both return apparently-current codes', async t => {
  const { app } = await setup(t)
  const created = await register(app)
  const responses = await Promise.all([post(app, 'recovery-code', created, { currentPassword: password }), post(app, 'recovery-code', created, { currentPassword: password })])
  assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 401])
})

test('recovery and reissue endpoints retain CSRF/origin protections and bounded source/name attempts', async t => {
  const { app } = await setup(t)
  const created = await register(app)
  const client = await bootstrap(app)
  for (const action of ['recover', 'recovery-code']) {
    for (const override of [{ origin: 'https://evil.example' }, { 'x-csrf-token': undefined }, { 'content-type': 'text/plain' }, { 'sec-fetch-site': 'cross-site' }]) {
      assert.equal((await post(app, action, created, { ...resetPayload('player_one', created.response.json().recoveryCode), currentPassword: password }, { headers: override })).statusCode, 403)
    }
  }
  for (let i = 0; i < 10; i++) assert.equal((await post(app, 'recover', client, resetPayload(' PLAYER_ONE ', '00'.repeat(32)))).statusCode, 401)
  const limited = await post(app, 'recover', client, resetPayload('player_one', created.response.json().recoveryCode))
  assert.equal(limited.statusCode, 429)
  assert.ok(Number(limited.headers['retry-after']) > 0)
  const other = await bootstrap(app, '127.0.0.2')
  assert.equal((await post(app, 'recover', other, resetPayload('player_one', created.response.json().recoveryCode))).statusCode, 200)
})

test('credential replacement rolls back password, code and sessions together if session revocation fails', async t => {
  const { app } = await setup(t)
  await register(app)
  const before = app.database.prepare('SELECT * FROM users').get()
  app.database.exec("CREATE TRIGGER fail_revoke BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
  await assert.rejects(resetAccountByAdmin(app.database, 'player_one', nextPassword, nextPassword), /fixture failure/)
  assert.deepEqual(app.database.prepare('SELECT * FROM users').get(), before)
  assert.equal(app.database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(before.id).count, 1)
})

test('admin reset preserves identity/data, revokes sessions/codes and prevents stale operations committing', async t => {
  const { app, root } = await setup(t)
  const created = await register(app)
  const before = app.database.prepare('SELECT * FROM users').get()
  const result = await resetAccountByAdmin(app.database, ' PLAYER_ONE ', nextPassword, nextPassword)
  assert.equal(result.username, before.username)
  assert.notEqual(hashRecoveryCode(result.recoveryCode), before.recovery_code_hash)
  const after = app.database.prepare('SELECT * FROM users').get()
  assert.equal(after.id, before.id)
  assert.equal(after.created_at, before.created_at)
  assert.equal(await verifyPassword(nextPassword, after.password_hash), true)
  assert.equal((await session(app, created)).json().user, null)
  assert.throws(() => replaceCredentials(app.database, before, before.password_hash, created.response.json().recoveryCode), /Username atau kode/)
  const client = await bootstrap(app)
  assert.equal((await post(app, 'recover', client, resetPayload(before.username, created.response.json().recoveryCode))).statusCode, 401)
  assert.equal((await post(app, 'login', client, { username: before.username, password })).statusCode, 401)
  assert.equal((await post(app, 'login', client, { username: before.username, password: nextPassword })).statusCode, 200)
  const other = await createApp({ root, env: {} })
  try {
    const fresh = await bootstrap(other)
    assert.equal((await post(other, 'recover', fresh, resetPayload(before.username, result.recoveryCode, password))).statusCode, 200)
  } finally { await other.close() }
  for (const args of [['absent', password, password], ['player_one', 'short', 'short'], ['player_one', password, nextPassword]]) await assert.rejects(resetAccountByAdmin(app.database, ...args))
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/reset', payload: {} })).statusCode, 404)
})

test('recovery and code renewal do not leak secrets to request logs or session responses', async t => {
  const logs = []
  const { app } = await setup(t, {}, { level: 'info', stream: { write: value => logs.push(value) } })
  const created = await register(app)
  const renewed = await post(app, 'recovery-code', created, { currentPassword: password })
  const client = await bootstrap(app)
  const reset = await post(app, 'recover', client, resetPayload('player_one', renewed.json().recoveryCode))
  assert.equal(reset.statusCode, 200)
  const output = logs.join('')
  for (const secret of [password, nextPassword, created.response.json().recoveryCode, renewed.json().recoveryCode, reset.json().recoveryCode, client.csrf, created.cookie.split('=')[1]]) assert.ok(!output.includes(secret))
  assert.doesNotMatch((await session(app, client)).body, /recoveryCode|password_hash|recovery_code_hash/)
})

test('closing registration still permits recovery and expired sessions cannot reissue codes', async t => {
  const { app, root } = await setup(t)
  const created = await register(app)
  app.database.prepare('UPDATE sessions SET expires_at = ? WHERE user_id IS NOT NULL').run(Date.now() - 1)
  assert.equal((await post(app, 'recovery-code', created, { currentPassword: password })).statusCode, 401)
  const closed = await createApp({ root, env: { MAIN_DULU_REGISTRATION_OPEN: 'false' } })
  try {
    const client = await bootstrap(closed)
    assert.equal((await session(closed, client)).json().registrationOpen, false)
    const response = await post(closed, 'recover', client, resetPayload('player_one', created.response.json().recoveryCode))
    assert.equal(response.statusCode, 200)
  } finally { await closed.close() }
})

test('reissue attempts are limited without logging out the legitimate session', async t => {
  const { app } = await setup(t)
  const created = await register(app)
  for (let i = 0; i < 10; i++) assert.equal((await post(app, 'recovery-code', created, { currentPassword: 'bad' })).statusCode, 401)
  const limited = await post(app, 'recovery-code', created, { currentPassword: password })
  assert.equal(limited.statusCode, 429)
  assert.ok(Number(limited.headers['retry-after']) > 0)
  assert.ok((await session(app, created)).json().user)
  assert.equal(app.database.prepare('SELECT recovery_code_hash FROM users').get().recovery_code_hash, hashRecoveryCode(created.response.json().recoveryCode))
  assert.equal((await post(app, 'recovery-code', { ...created, remoteAddress: '127.0.0.2' }, { currentPassword: password })).statusCode, 200)
})
