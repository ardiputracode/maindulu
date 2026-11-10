import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, hkdfSync } from 'node:crypto'
import { createApp } from '../server/app.mjs'
import { readConfig } from '../server/config.mjs'
import { hashPassword, hashToken, verifyPassword } from '../server/auth/crypto.mjs'
import { backendFixture } from './helpers/backend-fixture.mjs'
import { symlink, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gateEnv } from './helpers/gated-backend.mjs'

const headers = { host: 'localhost:7777', origin: 'http://localhost:7777', 'sec-fetch-site': 'same-origin' }
const credentials = { username: gateEnv.MAIN_DULU_GATE_USERNAME, password: gateEnv.MAIN_DULU_GATE_PASSWORD }
const login = (app, payload = credentials, extra = {}) => app.inject({ method: 'POST', url: '/api/gate/login', payload, ...extra, headers: Object.fromEntries(Object.entries(extra.headers ?? headers).filter(([, value]) => value !== undefined)) })
const cookieFrom = response => response.headers['set-cookie'].split(';')[0]
async function setup(t, env = {}) {
  let app
  const root = await backendFixture(t, { beforeCleanup: () => app?.close() })
  app = await createApp({ root, env: { ...gateEnv, ...env } })
  return { app, root }
}

test('gate configuration is mandatory, bounded and rejects malformed hashes even with plaintext fallback', async t => {
  const root = await backendFixture(t)
  for (const env of [{}, { MAIN_DULU_GATE_USERNAME: 'player' }, { ...gateEnv, MAIN_DULU_GATE_USERNAME: '' }, { ...gateEnv, MAIN_DULU_GATE_PASSWORD: 'short' }, { ...gateEnv, MAIN_DULU_GATE_PASSWORD_HASH: 'bad' }, { ...gateEnv, MAIN_DULU_GATE_SESSION_DAYS: '0' }]) await assert.rejects(readConfig(env, root), /MAIN_DULU_GATE/)
  await assert.rejects(createApp({ root, env: {} }), /MAIN_DULU_GATE/)
  assert.equal((await readConfig(gateEnv, root)).gateSessionDays, 7)
})

test('default-deny protects every data family including unknown routes, encoded paths, HEAD and range requests', async t => {
  const { app } = await setup(t)
  assert.deepEqual((await app.inject('/api/gate/session')).json(), { authenticated: false })
  const paths = ['/catalog/games.json', '/api/games', '/api/bios', '/api/catalog/revision', '/games/sample.chd', '/bios/firmware.bin', '/covers/test.png', '/api/auth/session', '/api/auth/login', '/api/saves/', '/api/game-saves/', '/api/save-backups/', '/api/admin/anything', '/unknown', '/assets/../catalog/games.json', '/assets/%2e%2e/catalog/games.json', '/assets/%2e%2e%2fcatalog%2fgames.json', '/%63atalog/games.json', '/api/gate/session/extra']
  for (const url of paths) {
    const response = await app.inject(url)
    assert.equal(response.statusCode, 401, url)
    assert.equal(response.json().code, 'GATE_REQUIRED', url)
    assert.equal(response.headers['cache-control'], 'no-store')
  }
  assert.equal((await app.inject({ method: 'HEAD', url: '/games/sample.chd' })).statusCode, 401)
  assert.equal((await app.inject({ url: '/games/sample.chd', headers: { range: 'bytes=1-3' } })).statusCode, 401)
  assert.equal((await app.inject({ url: '/games/sample.chd', headers: { 'if-none-match': '*' } })).statusCode, 401)
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: credentials })).statusCode, 401)
  for (const url of ['/', '/console', '/library', '/pengaturan', '/admin/metadata', '/assets/app.js', '/vendor/sample.wasm', '/api/health']) assert.equal((await app.inject(url)).statusCode, 200, url)
  const response = await login(app)
  assert.equal(response.statusCode, 200, response.body)
  const cookie = cookieFrom(response)
  assert.match(response.headers['set-cookie'], /Path=\/; HttpOnly; SameSite=Strict/)
  assert.match(response.headers['set-cookie'], /Max-Age=604800/)
  assert.equal((await app.inject({ url: '/catalog/games.json', headers: { cookie } })).statusCode, 200)
  assert.equal((await app.inject({ url: '/api/games', headers: { cookie } })).statusCode, 200)
  assert.equal((await app.inject({ url: '/api/bios', headers: { cookie } })).statusCode, 200)
  assert.equal((await app.inject({ url: '/games/sample.chd', headers: { cookie, range: 'bytes=1-3' } })).statusCode, 206)
  for (const url of ['/api/saves/', '/api/game-saves/', '/api/save-backups/']) assert.equal((await app.inject({ url, headers: { ...headers, cookie } })).statusCode, 401)
  assert.equal(app.database.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0)
})

test('HMAC rejects malformed, expired, tampered, foreign-installation and rotated credential cookies', async t => {
  const { app } = await setup(t)
  const valid = cookieFrom(await login(app))
  assert.equal((await app.inject({ url: '/api/gate/session', headers: { cookie: valid } })).json().authenticated, true)
  const installation = app.database.prepare("SELECT value FROM app_metadata WHERE key='installation_id'").get().value
  function signed(expires, salt = installation, username = credentials.username, password = credentials.password) {
    const key = hkdfSync('sha256', JSON.stringify([username, password]), salt, 'maindulu-gate-v1', 32)
    const value = `v1.${expires}`
    return 'maindulu_gate=' + value + '.' + createHmac('sha256', key).update(value).digest('hex')
  }
  const future = Math.floor(Date.now() / 1000) + 3600
  for (const cookie of ['maindulu_gate=garbage', valid.slice(0, -4), valid + 'x', valid.replace('v1.', 'v2.'), signed(Math.floor(Date.now() / 1000)), signed(1), signed(future, 'other-installation'), signed(future, installation, 'other_user'), signed(future, installation, credentials.username, 'rotated-password')]) assert.equal((await app.inject({ url: '/catalog/games.json', headers: { cookie } })).statusCode, 401)
  const { app: rotated } = await setup(t, { MAIN_DULU_GATE_PASSWORD: 'rotated-password' })
  assert.equal((await rotated.inject({ url: '/catalog/games.json', headers: { cookie: valid } })).statusCode, 401)
})

test('gate login has generic failures, per-IP rate limits, same-origin enforcement and HTTPS cookies', async t => {
  const { app } = await setup(t, { MAIN_DULU_PUBLIC_ORIGINS: 'http://localhost:7777,https://main.example' })
  for (const override of [{ origin: undefined }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { 'content-type': 'text/plain' }]) assert.equal((await login(app, credentials, { headers: { ...headers, ...override } })).statusCode, 403)
  const wrongName = await login(app, { ...credentials, username: 'unknown' })
  const wrongPassword = await login(app, { ...credentials, password: 'wrong-password' })
  assert.deepEqual(wrongName.json(), wrongPassword.json())
  for (let i = 0; i < 8; i++) assert.equal((await login(app, {})).statusCode, 401)
  const limited = await login(app)
  assert.equal(limited.statusCode, 429)
  assert.ok(Number(limited.headers['retry-after']) > 0)
  const secure = await login(app, credentials, { remoteAddress: '127.0.0.2', headers: { host: 'main.example', origin: 'https://main.example' } })
  assert.equal(secure.statusCode, 200)
  assert.match(secure.headers['set-cookie'], /; Secure/)
  assert.doesNotMatch(secure.body, /password|test_gate|Gate-test/)
})

test('scrypt gate and admin seed remain independent; gate logout revokes only this account session', async t => {
  const encoded = await hashPassword(credentials.password)
  const { app } = await setup(t, { MAIN_DULU_GATE_PASSWORD: '', MAIN_DULU_GATE_PASSWORD_HASH: encoded, MAIN_DULU_DEFAULT_USERNAME: 'first_admin', MAIN_DULU_DEFAULT_PASSWORD: 'Admin-123!' })
  const cookie = cookieFrom(await login(app))
  const admin = app.database.prepare('SELECT * FROM users').get()
  assert.equal(admin.role, 'admin')
  assert.equal(await verifyPassword('Admin-123!', admin.password_hash), true)
  const bootstrap = await app.inject({ url: '/api/auth/csrf', headers: { ...headers, cookie } })
  const preauth = cookieFrom(bootstrap)
  const account = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...headers, cookie: cookie + '; ' + preauth, 'x-csrf-token': bootstrap.json().csrfToken }, payload: { username: 'first_admin', password: 'Admin-123!' } })
  assert.equal(account.statusCode, 200, account.body)
  const accountCookie = cookieFrom(account)
  const tokenHash = hashToken(accountCookie.split('=')[1])
  assert.ok(app.database.prepare('SELECT 1 FROM sessions WHERE token_hash=?').get(tokenHash))
  const otherHash = hashToken('b'.repeat(64))
  app.database.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(otherHash, admin.id, Date.now(), Date.now() + 60000)
  const logout = await app.inject({ method: 'POST', url: '/api/gate/logout', headers: { ...headers, cookie: cookie + '; ' + accountCookie }, payload: {} })
  assert.equal(logout.statusCode, 200)
  assert.equal(logout.headers['set-cookie'].length, 2)
  assert.equal(app.database.prepare('SELECT 1 FROM sessions WHERE token_hash=?').get(tokenHash), undefined)
  assert.ok(app.database.prepare('SELECT 1 FROM sessions WHERE token_hash=?').get(otherHash))
  assert.equal((await app.inject({ url: '/api/auth/session', headers: { ...headers, cookie: cookie + '; ' + accountCookie } })).json().user, null)
  assert.equal((await app.inject({ method: 'POST', url: '/api/gate/logout', headers: { ...headers, origin: 'https://evil.example' }, payload: {} })).statusCode, 403)
})

test('same-installation restart retains tokens, credential rotation revokes them and seed never overwrites accounts', async t => {
  let app
  const root = await backendFixture(t, { beforeCleanup: () => app?.close() })
  const env = { ...gateEnv, MAIN_DULU_DEFAULT_USERNAME: 'first_admin', MAIN_DULU_DEFAULT_PASSWORD: 'Admin-123!' }
  app = await createApp({ root, env })
  const old = cookieFrom(await login(app))
  const original = app.database.prepare('SELECT * FROM users').get()
  await app.close()
  app = await createApp({ root, env: { ...env, MAIN_DULU_DEFAULT_PASSWORD: 'Different-123!' } })
  assert.equal((await app.inject({ url: '/catalog/games.json', headers: { cookie: old } })).statusCode, 200)
  assert.deepEqual(app.database.prepare('SELECT * FROM users').get(), original)
  for (const replacement of [{ MAIN_DULU_GATE_PASSWORD: 'Rotated-123!' }, { MAIN_DULU_GATE_USERNAME: 'new_door' }, { MAIN_DULU_GATE_PASSWORD_HASH: await hashPassword(credentials.password) }]) {
    await app.close()
    app = await createApp({ root, env: { ...env, ...replacement } })
    assert.equal((await app.inject({ url: '/catalog/games.json', headers: { cookie: old } })).statusCode, 401)
    assert.deepEqual(app.database.prepare('SELECT * FROM users').get(), original)
  }
})

test('public shell directories cannot alias protected catalog files; normal request logs contain no gate secrets', async t => {
  let app
  const root = await backendFixture(t, { beforeCleanup: () => app?.close() })
  const logs = []
  app = await createApp({ root, env: gateEnv, logger: { level: 'info', stream: { write: value => logs.push(value) } } })
  await symlink(join(root, 'dist/catalog'), join(root, 'dist/assets/alias'), process.platform === 'win32' ? 'junction' : 'dir')
  const alias = await app.inject('/assets/alias/games.json')
  assert.equal(alias.statusCode, 404)
  const result = await login(app)
  const cookie = cookieFrom(result)
  await app.inject({ url: '/catalog/games.json', headers: { cookie } })
  await login(app, { ...credentials, password: 'Wrong-secret-123!' })
  for (const secret of [credentials.password, cookie.split('=')[1]]) {
    const malformed = await app.inject({ method: 'POST', url: '/api/gate/login', headers: { ...headers, 'content-type': 'application/json' }, payload: secret })
    assert.equal(malformed.statusCode, 400)
    assert.ok(!logs.join('').includes(secret.slice(0, 12)))
  }
  for (const secret of [credentials.password, 'Wrong-secret-123!', cookie.split('=')[1]]) assert.ok(!logs.join('').includes(secret))
  // A normal shell asset still works independently of the gate.
  await mkdir(join(root, 'dist/player'), { recursive: true })
  await writeFile(join(root, 'dist/player/test.js'), 'console.log("shell")')
  assert.equal((await app.inject('/player/test.js')).statusCode, 200)
})
