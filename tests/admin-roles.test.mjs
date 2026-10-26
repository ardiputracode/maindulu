import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import Fastify from 'fastify'
import { createApp } from '../server/app.mjs'
import { openDatabase, schemaVersion } from '../server/database.mjs'
import { acquireDataLock } from '../server/data-lock.mjs'
import { readConfig } from '../server/config.mjs'
import { registerAuth } from '../server/auth/routes.mjs'
import { AuthError } from '../server/auth/limits.mjs'
import { setAccountRoleByAdmin, resetAccountByAdmin } from '../server/auth/mutations.mjs'
import { backendFixture } from './helpers/backend-fixture.mjs'
import { encodeGameSave } from '../src/lib/game-save-format.ts'

const origin = { host: 'localhost:7777', origin: 'http://localhost:7777', 'sec-fetch-site': 'same-origin' }
const password = 'Role123'
const nextPassword = 'Role789'
const cookie = r => String(r.headers['set-cookie']).split(';')[0]
const authHeaders = client => ({ ...origin, cookie: client.cookie, 'x-csrf-token': client.csrf ?? '' })
async function setup(t, uploadHarness = false) {
  const c = { app: null, parsed: 0, managed: 0 }
  c.root = await backendFixture(t, { beforeCleanup: () => c.app?.close() })
  c.config = await readConfig({}, c.root)
  if (!uploadHarness) c.app = await createApp({ root: c.root, env: {} })
  else {
    // Test-only operations use the real auth/session/guard; no upload endpoints
    // or multipart parser are enabled in the production milestone-1 app.
    const db = await openDatabase(c.config.dataDir)
    c.app = Fastify({ bodyLimit: 64 * 1024 })
    c.app.decorate('database', db)
    c.app.addHook('onClose', async () => db.close())
    c.app.setErrorHandler((error, _request, reply) => reply.code(error instanceof AuthError ? error.statusCode : error.statusCode ?? 500).send({ error: error.message }))
    c.security = registerAuth(c.app, c.config)
    c.app.addContentTypeParser('multipart/form-data', (_request, stream, done) => { c.parsed++; done(null, stream) })
    for (const multipart of [true, false]) c.app.post(multipart ? '/probe-upload' : '/probe-json', {
      onRequest: async request => { c.security.protectAdmin(request, { multipart }) },
    }, async request => {
      for await (const _chunk of request.body) { /* consume only after authorization */ }
      c.security.requireAdmin(request)
      c.managed++
      return { ok: true }
    })
    await c.app.ready()
  }
  return c
}
async function bootstrap(app) {
  const r = await app.inject({ url: '/api/auth/csrf', headers: origin })
  assert.equal(r.statusCode, 200, r.body)
  return { cookie: cookie(r), csrf: r.json().csrfToken }
}
function post(app, path, client, payload, headers = {}) {
  return app.inject({ method: 'POST', url: '/api/auth/' + path, headers: { ...authHeaders(client), ...headers }, payload })
}
async function register(app, username = 'role_user') {
  const guest = await bootstrap(app)
  const r = await post(app, 'register', guest, { username, password, passwordConfirmation: password, role: 'admin', user: { role: 'admin' }, isAdmin: true })
  assert.equal(r.statusCode, 201, r.body)
  assert.equal(r.json().user.role, 'user') // Includes the first registration.
  return { cookie: cookie(r), csrf: r.json().csrfToken, user: r.json().user, code: r.json().recoveryCode }
}
function session(app, client) { return app.inject({ url: '/api/auth/session', headers: authHeaders(client) }) }
function status(app, client = { cookie: '', csrf: '' }, headers = {}) {
  return app.inject({ url: '/api/admin/status', headers: { ...authHeaders(client), ...headers } })
}

test('admin guard returns 401 for guests, 403 for users, and reads role changes on active sessions', async t => {
  const c = await setup(t)
  assert.equal((await status(c.app)).statusCode, 401)
  assert.equal((await status(c.app, await bootstrap(c.app))).statusCode, 401)
  const owner = await register(c.app)
  assert.equal((await status(c.app, owner, { 'x-role': 'admin' })).statusCode, 403)
  assert.equal((await session(c.app, owner)).json().user.role, 'user')
  const before = c.app.database.prepare('SELECT * FROM users').get()
  assert.deepEqual(setAccountRoleByAdmin(c.app.database, ' ROLE_USER ', 'admin'), { username: 'role_user', previousRole: 'user', role: 'admin' })
  assert.equal((await status(c.app, owner)).statusCode, 200)
  assert.equal((await session(c.app, owner)).json().user.role, 'admin')
  const other = await createApp({ root: c.root, env: {} })
  try {
    assert.equal((await status(other, owner)).statusCode, 200)
    setAccountRoleByAdmin(other.database, 'role_user', 'user')
    for (const app of [c.app, other]) {
      assert.equal((await status(app, owner)).statusCode, 403)
      assert.equal((await session(app, owner)).json().user.role, 'user')
    }
  } finally { await other.close() }
  assert.deepEqual(c.app.database.prepare('SELECT * FROM users').get(), before)
  setAccountRoleByAdmin(c.app.database, 'role_user', 'admin')
  for (const headers of [{ origin: 'https://evil.example' }, { host: '192.168.1.4:7777' }, { 'sec-fetch-site': 'cross-site' }]) assert.equal((await status(c.app, owner, headers)).statusCode, 403)
  c.app.database.prepare('UPDATE sessions SET expires_at = 0 WHERE user_id = ?').run(owner.user.id)
  assert.equal((await status(c.app, owner)).statusCode, 401)
  assert.equal((await status(c.app, { cookie: 'maindulu_session=' + 'f'.repeat(64) })).statusCode, 401)
})

test('role cannot be selected through account payloads; recovery and terminal reset preserve admin role', async t => {
  const { app } = await setup(t)
  const owner = await register(app)
  assert.equal((await post(app, 'password', owner, { currentPassword: password, newPassword: nextPassword, passwordConfirmation: nextPassword, role: 'admin' })).statusCode, 200)
  const guest = await bootstrap(app)
  const login = await post(app, 'login', guest, { username: owner.user.username, password: nextPassword, role: 'admin' })
  assert.equal(login.statusCode, 200)
  assert.equal(login.json().user.role, 'user')
  const client = { cookie: cookie(login), csrf: login.json().csrfToken }
  const code = await post(app, 'recovery-code', client, { currentPassword: nextPassword, role: 'admin' })
  assert.equal(code.statusCode, 200)
  assert.equal((await session(app, client)).json().user.role, 'user')
  setAccountRoleByAdmin(app.database, owner.user.username, 'admin')
  const recovered = await post(app, 'recover', await bootstrap(app), { username: owner.user.username, recoveryCode: code.json().recoveryCode, newPassword: password, passwordConfirmation: password, role: 'user' })
  assert.equal(recovered.statusCode, 200, recovered.body)
  const fresh = await post(app, 'login', await bootstrap(app), { username: owner.user.username, password, role: 'user' })
  assert.equal(fresh.json().user.role, 'admin')
  await resetAccountByAdmin(app.database, owner.user.username, nextPassword, nextPassword)
  assert.equal(app.database.prepare('SELECT role FROM users').get().role, 'admin')
  for (const [username, role] of [['absent', 'admin'], ['role_user', 'owner'], ['bad/name', 'admin']]) assert.throws(() => setAccountRoleByAdmin(app.database, username, role))
  for (const role of ['owner', '', null]) assert.throws(() => app.database.prepare('UPDATE users SET role = ?').run(role))
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/role', headers: authHeaders(client), payload: { role: 'admin' } })).statusCode, 404)
})

test('multipart opt-in checks admin, origin and CSRF before parsing, without changing account limits', async t => {
  const c = await setup(t, true)
  const guest = await bootstrap(c.app)
  const owner = await register(c.app)
  const payload = '--fixture\r\nContent-Disposition: form-data; name="title"\r\n\r\nTest\r\n--fixture--\r\n'
  const upload = (client, extra = {}, url = '/probe-upload') => c.app.inject({ method: 'POST', url, headers: Object.fromEntries(Object.entries({ ...authHeaders(client), 'content-type': 'multipart/form-data; boundary=fixture', ...extra }).filter(([, v]) => v !== undefined)), payload })
  assert.equal((await upload(guest)).statusCode, 401)
  assert.equal((await upload(owner)).statusCode, 403)
  setAccountRoleByAdmin(c.app.database, owner.user.username, 'admin')
  for (const headers of [{ origin: undefined }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'x-csrf-token': undefined }, { 'x-csrf-token': 'f'.repeat(64) }, { 'content-type': 'text/plain' }]) assert.equal((await upload(owner, headers)).statusCode, 403)
  assert.equal((await upload(owner, {}, '/probe-json')).statusCode, 403)
  assert.equal(c.parsed, 0)
  assert.equal(c.managed, 0)
  assert.equal((await upload(owner)).statusCode, 200)
  assert.equal(c.parsed, 1)
  assert.equal(c.managed, 1)
  setAccountRoleByAdmin(c.app.database, owner.user.username, 'user')
  assert.equal((await upload(owner)).statusCode, 403)
  assert.equal(c.parsed, 1)
  assert.equal((await post(c.app, 'logout', owner, payload, { 'content-type': 'multipart/form-data; boundary=fixture' })).statusCode, 403)
  assert.equal((await post(c.app, 'logout', owner, { ignored: 'a'.repeat(65 * 1024) })).statusCode, 413)
})

test('version-6 migration preserves credentials, active sessions and both save types', async t => {
  const c = await setup(t)
  const owner = await register(c.app)
  const headers = { ...authHeaders(owner), 'x-save-user': owner.user.id, 'content-type': 'application/octet-stream' }
  const state = Buffer.alloc(700); state.write('RASTATE')
  const progress = Buffer.from(encodeGameSave({ layout: 'nes-sram-v1', files: [{ key: 'sram', bytes: new Uint8Array([1, 2, 3]) }] }))
  const saves = []
  for (const [url, bytes, extra] of [['/api/saves/', state, { slot: 1 }], ['/api/game-saves/', progress, {}]]) {
    const v = { gameId: 'old-game', consoleId: 'nes', core: 'fceumm', title: 'Old game', expectedRevision: 0, checksum: createHash('sha256').update(bytes).digest('hex'), ...extra,
      metadata: { formatVersion: 1, engineVersion: '4.2.3', coreBuild: 'a'.repeat(64), runtimeBuild: 'b'.repeat(64), variant: 'legacy', ...(url.includes('game-saves') ? { layout: 'nes-sram-v1' } : {}) } }
    const r = await c.app.inject({ method: 'PUT', url, headers: { ...headers, 'x-save-metadata': encodeURIComponent(JSON.stringify(v)) }, payload: bytes })
    assert.equal(r.statusCode, 201, r.body)
    saves.push({ url: url + r.json().save.id, bytes })
  }
  const before = c.app.database.prepare('SELECT * FROM users').get()
  c.app.database.exec('DROP TABLE games; DROP TABLE bios; ALTER TABLE users DROP COLUMN role; DELETE FROM schema_migrations WHERE version >= 7; PRAGMA user_version = 6;')
  await c.app.close()
  c.app = await createApp({ root: c.root, env: {} })
  assert.equal(c.app.database.prepare('PRAGMA user_version').get().user_version, schemaVersion)
  assert.deepEqual(c.app.database.prepare('SELECT * FROM users').get(), before)
  assert.deepEqual((await session(c.app, owner)).json().user, owner.user)
  for (const save of saves) assert.deepEqual((await c.app.inject({ url: save.url, headers })).rawPayload, save.bytes)
  const recovered = await post(c.app, 'recover', await bootstrap(c.app), { username: owner.user.username, recoveryCode: owner.code, newPassword: nextPassword, passwordConfirmation: nextPassword })
  assert.equal(recovered.statusCode, 200, recovered.body)
  const login = await post(c.app, 'login', await bootstrap(c.app), { username: owner.user.username, password: nextPassword })
  assert.equal(login.statusCode, 200)
  assert.deepEqual(login.json().user, owner.user)
  const fresh = { ...headers, cookie: cookie(login), 'x-csrf-token': login.json().csrfToken }
  for (const save of saves) assert.deepEqual((await c.app.inject({ url: save.url, headers: fresh })).rawPayload, save.bytes)
})

test('role CLI promotes/demotes live sessions, refuses missing accounts/data and respects maintenance locks', async t => {
  const c = await setup(t)
  const owner = await register(c.app)
  const run = (args, dataDir = c.config.dataDir) => spawnSync(process.execPath, ['scripts/set-account-role.mjs', ...args], { encoding: 'utf8', env: { ...process.env, MAIN_DULU_DATA_DIR: dataDir }, timeout: 15000 })
  for (const role of ['admin', 'admin', 'user']) {
    const r = run([' ROLE_USER ', role])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /Berlaku pada semua sesi aktif/)
    assert.equal((await session(c.app, owner)).json().user.role, role)
    assert.equal((await status(c.app, owner)).statusCode, role === 'admin' ? 200 : 403)
  }
  for (const args of [[], ['role_user', 'owner'], ['absent', 'admin'], ['role_user', 'admin', 'extra']]) {
    const r = run(args)
    assert.equal(r.status, 1, r.stderr)
    assert.doesNotMatch(r.stderr, /\n\s+at |password_hash|recovery_code_hash|UPDATE users/)
  }
  assert.equal(c.app.database.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1)
  const missing = join(c.root, 'missing')
  assert.match(run(['role_user', 'admin'], missing).stderr, /Database akun tidak ditemukan/)
  await assert.rejects(access(missing), { code: 'ENOENT' })
  await c.app.close(); c.app = null
  const release = await acquireDataLock(c.config.dataDir, true)
  try {
    const r = run(['role_user', 'admin'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /Data sedang dipakai/)
  } finally { release() }
  c.app = await createApp({ root: c.root, env: {} })
  assert.equal((await session(c.app, owner)).json().user.role, 'user')
})
