import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { ScreenScraperError } from '../server/metadata/screenscraper.mjs'
import { createMetadataWorker } from '../server/metadata/worker.mjs'
import { createApp } from '../server/app.mjs'
import { csrfToken, hashToken } from '../server/auth/crypto.mjs'
import { backendFixture } from './helpers/backend-fixture.mjs'

const enabledEnv = { MAIN_DULU_SCREENSCRAPER_ENABLED: 'true', MAIN_DULU_SCREENSCRAPER_DEV_ID: 'dummy', MAIN_DULU_SCREENSCRAPER_DEV_PASSWORD: 'dummy', MAIN_DULU_SCREENSCRAPER_USER: 'dummy', MAIN_DULU_SCREENSCRAPER_PASSWORD: 'dummy' }
async function adminFixture(t, metadataDependencies, enabled = false) {
  let app
  const root = await backendFixture(t, { beforeCleanup: () => app?.close() })
  app = await createApp({ root, env: enabled ? enabledEnv : {}, metadataDependencies })
  await app.catalog.worker.stop()
  const db = app.database
  const actor = randomUUID(), token = 'b'.repeat(64)
  db.prepare('INSERT INTO users (id, username, password_hash, recovery_code_hash, created_at, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(actor, 'm5admin', 'fixture', 'fixture', Date.now(), 'admin')
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(hashToken(token), actor, Date.now(), Date.now() + 600000)
  const headers = { host: 'localhost:7777', origin: 'http://localhost:7777', 'sec-fetch-site': 'same-origin',
    cookie: `maindulu_session=${token}`, 'x-csrf-token': csrfToken(token) }
  return { app, db, actor, headers }
}

async function publish(c, title = '', bytes = Buffer.from('abc')) {
  const stage = await c.app.catalog.storage.stage('games', (async function* () { yield bytes })())
  return c.app.catalog.repository.publish('games', c.actor, { title, description: '', license: 'rights', consoleId: 'nes', fileName: 'temporary_title.nes' }, stage)
}
function candidate(id = '123', title = 'Provider title') {
  const hash = alg => createHash(alg).update('abc').digest('hex')
  return { id, systemId: '3', notGame: false, rom: { id: '456', size: 3, md5: hash('md5'), sha1: hash('sha1'), totalSupports: 1 }, metadata: { title, description: 'Synopsis', genre: 'Action', media: [{ type: 'box-2D', region: 'us' }] } }
}
const post = (c, id, action, body = {}) => c.app.inject({ method: 'POST', url: `/api/admin/games/${id}/metadata/${action}`, headers: c.headers, payload: body })
const clearGate = c => c.db.prepare('UPDATE metadata_provider_state SET next_at = 0 WHERE id = 1').run()

test('M5 backend exposes sanitized metadata status and catalog revision', async t => {
  const { app, headers } = await adminFixture(t)
  const status = await app.inject({ method: 'GET', url: '/api/admin/metadata/status', headers })
  assert.equal(status.statusCode, 200)
  const statusBody = status.json()
  assert.equal(statusBody.ready, false)
  assert.equal(statusBody.screenscraper.enabled, false)
  assert.ok(statusBody.queue && typeof statusBody.queue.pending === 'number')

  const revision = await app.inject({ method: 'GET', url: '/api/catalog/revision' })
  assert.equal(revision.statusCode, 200)
  assert.equal(typeof revision.json().revision, 'number')
})

test('M5 backend scan requires ready ScreenScraper configuration', async t => {
  const { app, headers } = await adminFixture(t)
  const stage = await app.catalog.storage.stage('games', (async function* () { yield Buffer.from('abc') })())
  const game = await app.catalog.repository.publish('games', (await app.database.prepare('SELECT id FROM users LIMIT 1').get()).id, { title: 'Game', description: '', license: 'rights', consoleId: 'nes', fileName: 'game.nes' }, stage)
  const response = await app.inject({ method: 'POST', url: `/api/admin/games/${game.id}/metadata/scan`, headers: { ...headers, 'content-type': 'application/json' }, payload: {} })
  assert.equal(response.statusCode, 409)
  assert.equal(response.json().code, 'METADATA_DISABLED')
})

test('M5 fallback title is unlocked; explicit titles and empty manual description are locked', async t => {
  const c = await adminFixture(t)
  const game = await publish(c)
  assert.equal(game.title, 'temporary title')
  assert.deepEqual({ ...c.db.prepare("SELECT source, locked FROM game_metadata_field_sources WHERE game_id = ? AND field = 'title'").get(game.id) }, { source: 'filename', locked: 0 })
  const response = await c.app.inject({ method: 'PATCH', url: `/api/admin/games/${game.id}`, headers: c.headers, payload: { description: '', expectedRevision: 1 } })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(c.db.prepare("SELECT locked FROM game_metadata_field_sources WHERE game_id = ? AND field = 'description'").get(game.id).locked, 1)
  assert.equal((await c.app.inject({ method: 'PATCH', url: `/api/admin/games/${game.id}`, headers: c.headers, payload: { title: 'Old tab', expectedRevision: 1 } })).statusCode, 409)
  assert.equal(c.db.prepare("SELECT locked FROM game_metadata_field_sources WHERE game_id = ? AND field = 'title'").get(game.id).locked, 0)
})

test('M5 name search is queued, idempotent, shared across workers; manual candidate fields including cover apply with CAS', async t => {
  let calls = 0
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#00cc00' } }).png().toBuffer()
  const dependencies = { clientFactory: () => ({ searchByName: async () => { calls++; return { method: 'name', systemId: '3', candidates: [candidate(), candidate('124', 'Second candidate')] } } }), downloadCover: async () => ({ bytes: png, type: 'image/png' }) }
  const c = await adminFixture(t, dependencies, true)
  const game = await publish(c, 'Admin title')
  c.db.prepare("UPDATE metadata_jobs SET status = 'unsupported' WHERE game_id = ?").run(game.id)
  const search = await post(c, game.id, 'search', { query: 'Candidate' })
  assert.equal(search.statusCode, 200, search.body); assert.equal(calls, 0)
  assert.deepEqual((await post(c, game.id, 'search', { query: 'Candidate' })).json(), search.json())
  assert.equal(await c.app.catalog.worker.processOne(), true); assert.equal(calls, 1)
  const detail = (await c.app.inject({ url: `/api/admin/games/${game.id}/metadata`, headers: c.headers })).json()
  assert.equal(detail.candidates.length, 2); assert.equal(detail.status, 'needs_review')
  assert.equal(c.app.catalog.repository.get('games', game.id).title, 'Admin title')
  assert.equal((await post(c, game.id, 'apply', { generation: detail.generation, expectedRevision: 1, candidateId: '999', fields: ['title'] })).statusCode, 429)
  clearGate(c)
  assert.equal((await post(c, game.id, 'apply', { generation: detail.generation, expectedRevision: 1, candidateId: '999', fields: ['title'] })).statusCode, 409)
  const apply = await post(c, game.id, 'apply', { generation: detail.generation, expectedRevision: 1, candidateId: '124', fields: ['title', 'cover'] })
  assert.equal(apply.statusCode, 200, apply.body)
  await c.app.catalog.worker.processOne()
  const after = c.app.catalog.repository.get('games', game.id)
  assert.equal(after.title, 'Second candidate'); assert.equal(after.description, ''); assert.equal(after.license, game.license)
  assert.ok(after.cover_storage_key); assert.equal(after.sha256, game.sha256)
  assert.equal(c.db.prepare("SELECT locked FROM game_metadata_field_sources WHERE game_id = ? AND field = 'title'").get(game.id).locked, 1)
  assert.equal(c.db.prepare('SELECT match_method FROM game_metadata WHERE game_id = ?').get(game.id).match_method, 'manual')
  assert.equal((await post(c, game.id, 'apply', { generation: detail.generation, expectedRevision: 1, candidateId: '123', fields: ['title'] })).statusCode, 429)
})

test('M5 global quota cooldown cannot be bypassed by search, retries or a second worker', async t => {
  let calls = 0
  const dependencies = { clientFactory: () => ({ searchByHash: async () => { calls++; throw new ScreenScraperError('quota_exhausted') } }) }
  const c = await adminFixture(t, dependencies, true)
  const first = await publish(c), second = await publish(c, '', Buffer.from('xyz'))
  const worker2 = createMetadataWorker({ db: c.db, storage: c.app.catalog.storage, config: c.app.appConfig, ...dependencies, logger: { warn() {} } })
  await c.app.catalog.worker.processOne()
  assert.equal(await worker2.processOne(), false); assert.equal(calls, 1)
  assert.equal((await post(c, first.id, 'search', { query: 'Bypass' })).json().status, 'retry_wait')
  c.db.prepare("UPDATE metadata_jobs SET status = 'failed' WHERE game_id = ?").run(second.id)
  assert.equal((await post(c, second.id, 'scan')).statusCode, 429)
  assert.ok(c.db.prepare('SELECT next_at FROM metadata_provider_state').get().next_at > Date.now() + 23 * 3600000)
})

test('M5 metadata endpoints preserve authentication/CSRF, revoked roles, deleted games and safe public DTOs', async t => {
  const c = await adminFixture(t)
  const game = await publish(c)
  for (const action of ['scan', 'search', 'apply', 'unlock']) {
    assert.equal((await c.app.inject({ method: 'POST', url: `/api/admin/games/${game.id}/metadata/${action}`, headers: { ...c.headers, 'x-csrf-token': 'wrong' }, payload: {} })).statusCode, 403)
  }
  const publicBody = (await c.app.inject('/api/games')).body
  assert.doesNotMatch(publicBody, /lease|candidate|quota|cooldown|dummy|reason|request_json/)
  c.db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(c.actor)
  assert.equal((await c.app.inject({ url: '/api/admin/metadata/status', headers: c.headers })).statusCode, 403)
  c.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(c.actor)
  c.app.catalog.repository.delete('games', c.actor, game.id)
  assert.equal((await c.app.inject({ url: `/api/admin/games/${game.id}/metadata`, headers: c.headers })).statusCode, 404)
})
