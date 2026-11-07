import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import sharp from 'sharp'
import { createApp } from '../server/app.mjs'
import { createMetadataWorker } from '../server/metadata/worker.mjs'
import { applyVerifiedMetadata, metadataPreview } from '../server/metadata/apply.mjs'
import { CoverError, downloadScreenScraperCover, publicMediaAddress, selectScreenScraperCover } from '../server/metadata/cover.mjs'
import { csrfToken, hashToken } from '../server/auth/crypto.mjs'
import { backendFixture } from './helpers/backend-fixture.mjs'

const rom = Buffer.from('abc')
const hash = algorithm => createHash(algorithm).update(rom).digest('hex')
const candidate = { id: '123', systemId: '3', notGame: false,
  rom: { id: '456', size: rom.length, md5: hash('md5'), sha1: hash('sha1'), totalSupports: 1 },
  metadata: { title: 'Provider title', description: 'Provider description', genre: 'Action',
    media: [{ type: 'box-2D', region: 'us' }] } }

async function fixture(t) {
  let app
  const root = await backendFixture(t, { beforeCleanup: () => app?.close() })
  app = await createApp({ root, env: {} }) // No provider requests when disabled.
  const db = app.database, storage = app.catalog.storage
  const actor = randomUUID(), token = 'a'.repeat(64)
  db.prepare('INSERT INTO users (id, username, password_hash, recovery_code_hash, created_at, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(actor, 'm4admin', 'fixture', 'fixture', Date.now(), 'admin')
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(hashToken(token), actor, Date.now(), Date.now() + 600000)
  const headers = { host: 'localhost:7777', origin: 'http://localhost:7777', 'sec-fetch-site': 'same-origin',
    cookie: `maindulu_session=${token}`, 'x-csrf-token': csrfToken(token) }
  const stage = await storage.stage('games', (async function* () { yield rom })())
  const game = await app.catalog.repository.publish('games', actor, { title: 'Admin title', description: '', license: 'Admin rights',
    consoleId: 'nes', fileName: 'fixture.nes' }, stage)
  const job = db.prepare('SELECT * FROM metadata_jobs WHERE game_id = ?').get(game.id)
  return { app, db, storage, game, job, actor, headers }
}

test('M4 applies only eligible text on correct tables and preserves ID, ROM, license and manual title', async t => {
  const { db, storage, game, job } = await fixture(t)
  db.prepare(`UPDATE metadata_jobs SET status = 'running', lease_token = ?, lease_expires_at = ? WHERE id = ?`)
    .run('lease', Date.now() + 60000, job.id)
  const claimed = { ...job, lease_token: 'lease', storage_key: game.storage_key }
  const result = applyVerifiedMetadata(db, storage, { job: claimed, candidate, expectedRevision: 1 })
  assert.deepEqual(result.changes.sort(), ['description', 'genre'])
  const after = db.prepare('SELECT * FROM games WHERE id = ?').get(game.id)
  assert.equal(after.title, 'Admin title')
  assert.equal(after.description, 'Provider description')
  for (const field of ['id', 'storage_key', 'size', 'sha256', 'license', 'original_name', 'console_id']) assert.equal(after[field], game[field])
  assert.equal(db.prepare('SELECT genre FROM game_metadata WHERE game_id = ?').get(game.id).genre, 'Action')
  assert.equal(db.prepare(`SELECT source FROM game_metadata_field_sources WHERE game_id = ? AND field = 'title'`).get(game.id).source, 'manual')
  assert.equal(applyVerifiedMetadata(db, storage, { job: claimed, candidate, expectedRevision: 1 }), null)
})

test('M4 concurrent edit, delete, new generation and expired lease defeat stale apply', async t => {
  const { app, db, storage, game, job, actor } = await fixture(t)
  db.prepare(`UPDATE metadata_jobs SET status = 'running', lease_token = 'lease', lease_expires_at = ? WHERE id = ?`).run(Date.now() + 60000, job.id)
  const claimed = { ...job, lease_token: 'lease', storage_key: game.storage_key }
  await app.catalog.repository.update('games', actor, game.id, { description: 'Admin override' })
  assert.equal(applyVerifiedMetadata(db, storage, { job: claimed, candidate, expectedRevision: 1 }), null)
  const revision = db.prepare('SELECT metadata_revision FROM game_metadata WHERE game_id = ?').get(game.id).metadata_revision
  const applied = applyVerifiedMetadata(db, storage, { job: claimed, candidate, expectedRevision: revision })
  assert.ok(applied)
  assert.equal(db.prepare('SELECT description FROM games WHERE id = ?').get(game.id).description, 'Admin override')
  db.prepare('UPDATE metadata_jobs SET lease_expires_at = 1 WHERE id = ?').run(job.id)
  assert.equal(applyVerifiedMetadata(db, storage, { job: claimed, candidate, expectedRevision: applied.revision }), null)
  db.prepare('UPDATE metadata_jobs SET lease_expires_at = ? WHERE id = ?').run(Date.now() + 60000, job.id)
  await app.catalog.repository.delete('games', actor, game.id)
  assert.equal(applyVerifiedMetadata(db, storage, { job: claimed, candidate, expectedRevision: applied.revision }), null)
})

test('M4 worker applies verified metadata, persists same-origin cover, keeps text on failed cover', async t => {
  const { app, db, storage, game } = await fixture(t)
  const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#abcdef' } }).png().toBuffer()
  const worker = createMetadataWorker({ db, storage, maintenance: app.catalog.maintenance,
    config: { screenscraper: { enabled: true, missing: [], devId: 'dummy' } }, logger: { warn() {}, error() {} },
    clientFactory: () => ({ searchByHash: async () => ({ method: 'hash', systemId: '3', candidates: [candidate] }) }),
    downloadCover: async () => ({ bytes: png, type: 'image/png' }) })
  assert.equal(await worker.processOne(), true)
  const status = db.prepare('SELECT status, error_code FROM metadata_jobs WHERE game_id = ?').get(game.id)
  assert.equal(status.status, 'succeeded')
  assert.equal(status.error_code, null)
  const cover = await app.inject(`/games/${game.id}/cover`)
  assert.equal(cover.statusCode, 200)
  assert.deepEqual(cover.rawPayload, png)
  assert.equal(cover.headers['cache-control'], 'no-store')
  assert.equal(db.prepare('SELECT description FROM games WHERE id = ?').get(game.id).description, 'Provider description')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM catalog_uploads').get().n, 0)
})

test('M4 quota/cover failure leaves text successful without retrying lookup or publishing a cover', async t => {
  const { db, storage, game } = await fixture(t)
  let lookups = 0, mediaRequests = 0
  const worker = createMetadataWorker({ db, storage, maintenance: { reserve: async () => { throw new Error('quota') } },
    config: { screenscraper: { enabled: true, missing: [] } }, logger: { warn() {}, error() {} },
    clientFactory: () => ({ searchByHash: async () => { lookups++; return { method: 'hash', systemId: '3', candidates: [candidate] } } }),
    downloadCover: async () => { mediaRequests++ } })
  await worker.processOne()
  assert.equal(lookups, 1)
  assert.equal(mediaRequests, 0)
  assert.deepEqual({ ...db.prepare('SELECT status, error_code FROM metadata_jobs WHERE game_id = ?').get(game.id) },
    { status: 'succeeded', error_code: 'COVER_UNAVAILABLE' })
  assert.equal(db.prepare('SELECT description, cover_storage_key FROM games WHERE id = ?').get(game.id).description, 'Provider description')
  assert.equal(db.prepare('SELECT cover_storage_key FROM games WHERE id = ?').get(game.id).cover_storage_key, null)
})

test('M4 manual cover removal during download wins; late promoted cover is queued for cleanup', async t => {
  const { app, db, storage, game, actor } = await fixture(t)
  let releaseDownload, entered
  const started = new Promise(resolve => { entered = resolve })
  const hold = new Promise(resolve => { releaseDownload = resolve })
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#aabbcc' } }).png().toBuffer()
  const worker = createMetadataWorker({ db, storage, maintenance: app.catalog.maintenance,
    config: { screenscraper: { enabled: true, missing: [] } }, logger: { warn() {}, error() {} },
    clientFactory: () => ({ searchByHash: async () => ({ method: 'hash', systemId: '3', candidates: [candidate] }) }),
    downloadCover: async () => { entered(); await hold; return { bytes: png, type: 'image/png' } } })
  const work = worker.processOne()
  await started
  await app.catalog.repository.update('games', actor, game.id, {}, { cover: null })
  releaseDownload()
  await work
  const after = db.prepare('SELECT * FROM games WHERE id = ?').get(game.id)
  assert.equal(after.cover_storage_key, null)
  assert.equal(after.description, '')
  assert.equal(db.prepare(`SELECT locked FROM game_metadata_field_sources WHERE game_id = ? AND field = 'cover'`).get(game.id).locked, 1)
  assert.equal(db.prepare('SELECT status FROM metadata_jobs WHERE game_id = ?').get(game.id).status, 'needs_review')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM catalog_cleanup WHERE folder = 'covers'").get().n, 1)
})

test('M4 cover transport pins checked DNS and refuses private destinations and redirect', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.1.1', '192.168.1.2', '::1', '::ffff:127.0.0.1', '198.18.1.1']) {
    assert.equal(publicMediaAddress(address), false, address)
  }
  assert.equal(publicMediaAddress('8.8.8.8'), true)
  assert.equal(selectScreenScraperCover(candidate), 'us')
  assert.equal(selectScreenScraperCover({ metadata: { media: [candidate.metadata.media[0], candidate.metadata.media[0]] } }), null)
  const config = { devId: 'd', devPassword: 'private-secret', softname: 'maindulu', user: 'u', password: 'p' }
  let called = false
  await assert.rejects(downloadScreenScraperCover(config, { gameId: '123', systemId: '3', region: 'us' }, {
    lookup: async () => [{ address: '127.0.0.1' }], request: () => { called = true },
  }), error => error.code === 'COVER_DNS')
  assert.equal(called, false)
  await assert.rejects(downloadScreenScraperCover(config, { gameId: '123', systemId: '3', region: 'us' }, {
    lookup: async () => [{ address: '8.8.8.8' }], request: (url, options, response) => {
      assert.equal(url.hostname, 'api.screenscraper.fr')
      assert.equal(url.pathname, '/api2/mediaJeu.php')
      assert.equal(url.searchParams.get('jeuid'), '123')
      assert.equal(options.lookup('api.screenscraper.fr', {}, (_e, address) => assert.equal(address, '8.8.8.8')), undefined)
      const req = new EventEmitter(); req.end = () => {
        const res = new PassThrough(); res.statusCode = 302; res.headers = { location: 'http://localhost/private' }; response(res)
      }; req.destroy = () => {}; return req
    },
  }), error => error.code === 'COVER_HTTP' && !error.message.includes('private-secret'))
})

test('M4 admin review endpoints require session/CSRF; stale revision and unverified old candidates cannot apply', async t => {
  const { app, db, game, headers } = await fixture(t)
  const path = `/api/admin/games/${game.id}/metadata`
  assert.equal((await app.inject(path)).statusCode, 401)
  const view = await app.inject({ url: path, headers })
  assert.equal(view.statusCode, 200)
  assert.equal(view.json().preview.fields.title.locked, true)
  assert.equal((await app.inject({ method: 'POST', url: path + '/unlock', payload: { field: 'title', expectedRevision: 1 }, headers: { ...headers, 'x-csrf-token': 'invalid' } })).statusCode, 403)
  const unlock = await app.inject({ method: 'POST', url: path + '/unlock', payload: { field: 'title', expectedRevision: 1 }, headers })
  assert.equal(unlock.statusCode, 200, unlock.body)
  assert.equal((await app.inject({ method: 'POST', url: path + '/unlock', payload: { field: 'title', expectedRevision: 1 }, headers })).statusCode, 409)
  const apply = await app.inject({ method: 'POST', url: path + '/apply', payload: { generation: 1, expectedRevision: 2, fields: ['title'] }, headers })
  assert.equal(apply.statusCode, 409)
  assert.equal(db.prepare('SELECT title FROM games WHERE id = ?').get(game.id).title, 'Admin title')
})
