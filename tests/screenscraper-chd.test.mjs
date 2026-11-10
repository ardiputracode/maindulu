import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createApp } from '../server/app.mjs'
import { identifyCatalogRom, isIdentifiableChd } from '../server/metadata/identification.mjs'
import { createMetadataWorker } from '../server/metadata/worker.mjs'
import { enqueueMetadata, metadataDetail } from '../server/metadata/queue.mjs'
import { metadataSerialCacheKey } from '../server/metadata/cache.mjs'
import { ScreenScraperError } from '../server/metadata/screenscraper.mjs'
import { backendFixture } from './helpers/backend-fixture.mjs'

const serial = 'SLUS-12345'
const title = 'CHD title'

test('CHD identification is limited to a plain PS1 .chd and the safe target resolver', () => {
  assert.equal(isIdentifiableChd('psx', 'game.chd'), true)
  assert.equal(isIdentifiableChd('psx', 'GAME.CHD'), true)
  for (const [consoleId, fileName] of [['nes', 'game.chd'], ['psx', 'game.iso'], ['psx', 'game.cue'],
    ['psx', 'game.zip'], ['psx', 'game.chd.zip'], ['psx', '../game.chd'], ['psx', 'C:\\game.chd'],
    ['psx', 'game\n.chd'], ['psx', null], ['psx', undefined], ['__proto__', 'game.chd']]) {
    assert.equal(isIdentifiableChd(consoleId, fileName), false, `${consoleId}/${fileName}`)
  }
})

test('CHD identification requires a safe file path and injects no bytes into the probe contract', async () => {
  const file = { createReadStream() { assert.fail('CHD must not hash or read ROM bytes') } }
  let captured
  const readSerial = async input => { captured = input; return { serial } }
  const found = await identifyCatalogRom(file, { consoleId: 'psx', fileName: 'game.chd', size: 10, sha256: 'a'.repeat(64),
    filePath: 'C:\\safe\\disc.chd', chdBinary: 'C:\\tools\\rom-converto.exe', timeoutMs: 9_000, readSerial })
  assert.deepEqual(found, { fileName: 'game.chd', hashes: {}, serial, identification: { kind: 'chd-serial', version: 1 } })
  assert.equal(captured.filePath, 'C:\\safe\\disc.chd')
  assert.equal(captured.binary, 'C:\\tools\\rom-converto.exe')
  assert.equal(captured.timeoutMs, 9_000)
  assert.equal(captured.file, undefined)

  await assert.rejects(identifyCatalogRom(file, { consoleId: 'psx', fileName: 'game.chd', size: 10,
    sha256: 'a'.repeat(64), readSerial }), { code: 'invalid_target' })
  await assert.rejects(identifyCatalogRom(file, { consoleId: 'psx', fileName: 'game.chd', size: 10,
    sha256: 'a'.repeat(64), filePath: 'safe.chd', readSerial: async () => { throw new ScreenScraperError('chd_invalid') } }), { code: 'chd_invalid' })
})

test('serial cache keys are isolated by system, serial and filename', () => {
  const base = metadataSerialCacheKey('57', serial, 'Game.chd')
  assert.notEqual(base.key, metadataSerialCacheKey('57', 'SLUS-12346', 'Game.chd').key)
  assert.notEqual(base.key, metadataSerialCacheKey('9', serial, 'Game.chd').key)
  assert.notEqual(base.key, metadataSerialCacheKey('57', serial, 'Other.chd').key)
  assert.equal(base.key, metadataSerialCacheKey('57', serial, 'Game.chd').key)
})

const candidate = (patch = {}, metadata = {}) => ({ id: '123', systemId: '57', notGame: false, rom: null,
  metadata: { title, description: 'CHD description', media: [], ...metadata }, ...patch })

async function chdFixture(t, { autoapply = true, readSerial, searchBySerial, downloadCover } = {}) {
  let app
  const root = await backendFixture(t, { beforeCleanup: () => app?.close() })
  app = await createApp({ root, env: {} })
  const db = app.database, storage = app.catalog.storage, actor = randomUUID()
  db.prepare('INSERT INTO users (id, username, password_hash, recovery_code_hash, created_at, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(actor, 'chdadmin', 'fixture', 'fixture', Date.now(), 'admin')
  const bytes = Buffer.from('Synthetic CHD fixture bytes; not a commercial disc image.')
  const stage = await storage.stage('games', (async function* () { yield bytes })())
  const game = await app.catalog.repository.publish('games', actor, { description: '', license: 'Manual license', consoleId: 'psx', fileName: 'Game.chd' }, stage)
  const config = { screenscraper: { enabled: true, missing: [], chdSerialAutoapply: autoapply,
    romConvertoPath: 'C:\\tools\\rom-converto.exe', romConvertoTimeoutMs: 30_000 } }
  const calls = [], coverCalls = []
  const worker = createMetadataWorker({ db, storage, config, logger: { warn() {}, error() {} },
    readSerial: readSerial ?? (async () => ({ serial })),
    clientFactory: () => ({ searchBySerial: searchBySerial ?? (async input => {
      calls.push(input)
      return { method: 'serial', systemId: '57', candidates: [candidate()] }
    }) }),
    downloadCover: downloadCover ?? (async () => { coverCalls.push(1); return null }) })
  t.after(() => worker.stop())
  return { app, db, storage, actor, game, bytes, worker, calls, coverCalls, config }
}

test('worker applies one serial candidate, records serial provenance and never rewrites asset identity', async t => {
  const { app, db, storage, game, bytes, worker, calls, coverCalls } = await chdFixture(t)
  const beforeRevision = db.prepare('SELECT metadata_revision FROM game_metadata WHERE game_id = ?').get(game.id).metadata_revision
  await worker.processOne()
  const job = db.prepare('SELECT * FROM metadata_jobs WHERE game_id = ?').get(game.id)
  assert.equal(job.status, 'succeeded')
  assert.equal(job.error_code, null)
  assert.equal(calls.length, 1)
  assert.deepEqual(Object.keys(calls[0]).sort(), ['consoleId', 'fileName', 'serial', 'signal'])
  assert.equal(calls[0].consoleId, 'psx')
  assert.equal(calls[0].fileName, 'Game.chd')
  assert.equal(calls[0].serial, serial)
  assert.equal(coverCalls.length, 0)

  const after = db.prepare('SELECT * FROM games WHERE id = ?').get(game.id)
  assert.equal(after.title, title)
  assert.equal(after.description, 'CHD description')
  for (const field of ['id', 'sha256', 'size', 'original_name', 'storage_key', 'license', 'console_id', 'cover_storage_key']) assert.equal(after[field], game[field], field)
  assert.deepEqual(await readFile(await storage.pathFor('games', game.storage_key)), bytes)
  assert.equal(db.prepare('SELECT metadata_revision FROM game_metadata WHERE game_id = ?').get(game.id).metadata_revision, beforeRevision + 1)
  assert.equal(db.prepare('SELECT match_method FROM game_metadata WHERE game_id = ?').get(game.id).match_method, 'serial')
  assert.equal(db.prepare('SELECT provider_game_id FROM game_metadata WHERE game_id = ?').get(game.id).provider_game_id, '123')
  assert.equal(metadataDetail(db, after).matchMethod, 'serial')

  const payload = JSON.parse(job.candidate_json)
  assert.deepEqual(payload.fingerprint, { serial })
  assert.deepEqual(payload.identification, { kind: 'chd-serial', version: 1 })
  assert.equal(payload.systemId, '57')
  assert.equal(payload.method, 'serial')
  assert.doesNotMatch(job.candidate_json, /Synthetic CHD fixture|rom-converto|C:\\\\tools/i)
  assert.doesNotMatch(JSON.stringify(payload), /md5|sha1/)
  assert.equal((await app.inject(`/api/games/${game.id}`)).json().item.sha256, game.sha256)
})

for (const [label, candidates] of [
  ['two candidates', [candidate(), candidate({ id: '124' })]],
  ['a non-game candidate', [candidate({ notGame: true })]],
  ['a candidate on another system', [candidate({ systemId: '3' })]],
]) test(`worker sends ${label} to review without changing metadata`, async t => {
  const { db, game, worker, calls } = await chdFixture(t, { searchBySerial: async input => {
    calls.push(input)
    return { method: 'serial', systemId: '57', candidates }
  } })
  const before = db.prepare('SELECT title FROM games WHERE id = ?').get(game.id)
  await worker.processOne()
  const job = db.prepare('SELECT * FROM metadata_jobs WHERE game_id = ?').get(game.id)
  assert.equal(job.status, 'needs_review')
  assert.ok(['non_unique_result', 'unconfirmed_game', 'system_mismatch'].includes(job.error_code))
  assert.deepEqual(db.prepare('SELECT title FROM games WHERE id = ?').get(game.id), before)
  assert.equal(db.prepare('SELECT match_method FROM game_metadata WHERE game_id = ?').get(game.id).match_method, null)
  assert.equal(calls.length, 1)
})

test('worker reports a missing CHD tool as unsupported while leaving the game playable', async t => {
  const { app, db, game, worker, calls } = await chdFixture(t, { readSerial: async () => { throw new ScreenScraperError('chd_tool_unavailable') } })
  await worker.processOne()
  const job = db.prepare('SELECT * FROM metadata_jobs WHERE game_id = ?').get(game.id)
  assert.equal(job.status, 'unsupported')
  assert.equal(job.error_code, 'chd_tool_unavailable')
  assert.equal(calls.length, 0)
  const publicGame = (await app.inject(`/api/games/${game.id}`)).json().item
  assert.equal((await app.inject(publicGame.url)).statusCode, 200)
})

test('CHD kill switch still looks up the serial but always stops at review without a cover download', async t => {
  const { db, game, worker, calls, coverCalls } = await chdFixture(t, { autoapply: false,
    searchBySerial: async input => {
      calls.push(input)
      return { method: 'serial', systemId: '57', candidates: [candidate({}, { media: [{ type: 'box-2D', region: 'us' }] })] }
    } })
  await worker.processOne()
  const job = db.prepare('SELECT * FROM metadata_jobs WHERE game_id = ?').get(game.id)
  assert.equal(job.status, 'needs_review')
  assert.equal(job.error_code, 'serial_autoapply_disabled')
  assert.equal(calls.length, 1)
  assert.equal(coverCalls.length, 0)
  assert.equal(db.prepare('SELECT title FROM games WHERE id = ?').get(game.id).title, game.title)
})

test('locked fields survive serial auto-apply while provenance still records serial', async t => {
  const { db, game, worker } = await chdFixture(t)
  db.prepare("UPDATE game_metadata_field_sources SET locked = 1 WHERE game_id = ? AND field IN ('title', 'description')").run(game.id)
  await worker.processOne()
  const job = db.prepare('SELECT * FROM metadata_jobs WHERE game_id = ?').get(game.id)
  assert.equal(job.status, 'succeeded')
  const after = db.prepare('SELECT title, description FROM games WHERE id = ?').get(game.id)
  assert.deepEqual({ ...after }, { title: game.title, description: game.description })
  assert.equal(db.prepare('SELECT match_method FROM game_metadata WHERE game_id = ?').get(game.id).match_method, 'serial')
})

test('a second scan with the same serial uses the cache and never repeats the provider request', async t => {
  const { db, game, worker, calls, config } = await chdFixture(t)
  await worker.processOne()
  assert.equal(calls.length, 1)
  db.prepare('UPDATE metadata_provider_state SET next_at = 0').run()
  enqueueMetadata(db, config, game, { method: 'hash' })
  await worker.processOne()
  const jobs = db.prepare('SELECT status FROM metadata_jobs WHERE game_id = ? ORDER BY generation').all(game.id)
  assert.deepEqual(jobs.map(job => job.status), ['succeeded', 'succeeded'])
  assert.equal(calls.length, 1)
  assert.equal(db.prepare('SELECT match_method FROM game_metadata WHERE game_id = ?').get(game.id).match_method, 'serial')
})

test('an admin edit made while the serial probe is held wins over a late auto-apply', async t => {
  let release, entered
  const enteredPromise = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const { app, db, actor, game, worker } = await chdFixture(t, { readSerial: async () => {
    entered()
    await gate
    return { serial }
  } })
  const pending = worker.processOne()
  await enteredPromise
  await app.catalog.repository.update('games', actor, game.id, { title: 'Admin wins' })
  release()
  await pending
  const job = db.prepare('SELECT * FROM metadata_jobs WHERE game_id = ?').get(game.id)
  assert.equal(job.status, 'needs_review')
  assert.equal(job.error_code, 'STALE_RESULT')
  assert.equal(db.prepare('SELECT title FROM games WHERE id = ?').get(game.id).title, 'Admin wins')
  assert.notEqual(db.prepare('SELECT match_method FROM game_metadata WHERE game_id = ?').get(game.id).match_method, 'serial')
})

test('a changed asset fingerprint fences the job after the serial probe', async t => {
  let release, entered
  const enteredPromise = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const { db, game, worker } = await chdFixture(t, { readSerial: async () => {
    entered()
    await gate
    return { serial }
  } })
  const pending = worker.processOne()
  await enteredPromise
  db.prepare('UPDATE games SET size = size + 1 WHERE id = ?').run(game.id)
  release()
  await pending
  const job = db.prepare('SELECT * FROM metadata_jobs WHERE game_id = ?').get(game.id)
  assert.notEqual(job.status, 'succeeded')
  assert.equal(job.error_code, 'stale')
  assert.equal(db.prepare('SELECT match_method FROM game_metadata WHERE game_id = ?').get(game.id).match_method, null)
})

test('stopping the worker aborts a held serial probe and releases the shared lease', async t => {
  let entered
  const enteredPromise = new Promise(resolve => { entered = resolve })
  const { db, worker } = await chdFixture(t, { readSerial: ({ signal }) => new Promise((_, reject) => {
    entered()
    signal.addEventListener('abort', () => reject(new ScreenScraperError('disabled')), { once: true })
  }) })
  const pending = worker.processOne()
  await enteredPromise
  await worker.stop()
  await pending
  const job = db.prepare('SELECT status, lease_token FROM metadata_jobs LIMIT 1').get()
  assert.notEqual(job.status, 'succeeded')
  assert.equal(job.lease_token, null)
  assert.equal(db.prepare('SELECT lease_token, lease_expires_at FROM metadata_provider_state WHERE id = 1').get().lease_token, null)
})
