import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { createApp } from '../server/app.mjs'
import { openDatabase } from '../server/database.mjs'
import { createDataBackup, restoreDataBackup, verifyDataBackup } from '../server/data-backup.mjs'
import { csrfToken, hashToken } from '../server/auth/crypto.mjs'
import { ScreenScraperError } from '../server/metadata/screenscraper.mjs'
import { backendFixture } from './helpers/backend-fixture.mjs'
import { readMetadataControl, readMetadataJobs } from '../src/lib/metadata.ts'

const env = { MAIN_DULU_SCREENSCRAPER_ENABLED: 'true', MAIN_DULU_SCREENSCRAPER_DEV_ID: 'fixture', MAIN_DULU_SCREENSCRAPER_DEV_PASSWORD: 'fixture', MAIN_DULU_SCREENSCRAPER_USER: 'fixture', MAIN_DULU_SCREENSCRAPER_PASSWORD: 'fixture' }
async function setup(t, dependencies = {}, enabled = true) {
  let app
  const root = await backendFixture(t, { beforeCleanup: () => app?.close() })
  app = await createApp({ root, env: enabled ? env : {}, metadataDependencies: dependencies })
  await app.catalog.worker.stop()
  const db = app.database, actor = randomUUID(), token = 'c'.repeat(64)
  db.prepare('INSERT INTO users (id, username, password_hash, recovery_code_hash, created_at, role) VALUES (?, ?, ?, ?, ?, ?)').run(actor, 'controls_admin', 'fixture', 'fixture', Date.now(), 'admin')
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(hashToken(token), actor, Date.now(), Date.now() + 600000)
  const headers = { host: 'localhost:7777', origin: 'http://localhost:7777', cookie: `maindulu_session=${token}`, 'x-csrf-token': csrfToken(token) }
  const c = { app, db, actor, headers, root }
  c.post = (action, body = {}, override = headers) => app.inject({ method: 'POST', url: '/api/admin/metadata/' + action, headers: override, payload: body })
  c.publish = async (name, status = 'disabled', consoleId = 'nes') => {
    const stage = await app.catalog.storage.stage('games', [Buffer.from(name)])
    const game = await app.catalog.repository.publish('games', actor, { title: name, consoleId, fileName: name + (consoleId === 'snes' ? '.sfc' : '.nes') }, stage, { scanMetadata: false })
    db.prepare('UPDATE metadata_jobs SET status = ? WHERE game_id = ?').run(status, game.id)
    return game
  }
  return c
}
const gate = c => ({ ...c.db.prepare('SELECT next_at, paused_reason FROM metadata_provider_state').get() })

test('resume readiness/cooldown/idempotency and all controls enforce sessions, role, origin, CSRF and strict inputs', async t => {
  const c = await setup(t)
  c.db.exec("UPDATE metadata_provider_state SET paused_reason = 'auth_rejected', next_at = 0")
  assert.equal((await c.post('service/resume')).statusCode, 200)
  assert.equal((await c.post('service/resume')).statusCode, 200)
  c.db.prepare("UPDATE metadata_provider_state SET paused_reason = 'forbidden', next_at = ?").run(Date.now() + 60000)
  const before = gate(c)
  assert.equal((await c.post('service/resume')).json().code, 'METADATA_COOLDOWN')
  assert.deepEqual(gate(c), before)
  for (const action of ['service/resume', 'jobs/cancel', 'backfill']) {
    assert.equal((await c.post(action, {}, { host: 'localhost:7777' })).statusCode, 401)
    assert.equal((await c.post(action, {}, { ...c.headers, 'x-csrf-token': 'wrong' })).statusCode, 403)
    assert.equal((await c.post(action, {}, { ...c.headers, origin: 'https://invalid.test' })).statusCode, 403)
    assert.equal((await c.post(action, { unknown: true })).statusCode, 400)
    c.db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(c.actor)
    assert.equal((await c.post(action)).statusCode, 403)
    c.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(c.actor)
  }
  for (const body of [{ statuses: [] }, { statuses: ['disabled', 'disabled'] }, { statuses: ['succeeded'] }, { statuses: ['unsupported'] }, { statuses: 'disabled' }, { consoleId: 'unknown' }, { consoleId: 1 }, { replaceLocked: 'true' }]) assert.equal((await c.post('backfill', body)).statusCode, 400)
  for (const body of [{ statuses: ['disabled'] }, { consoleId: 'unknown' }, { replaceLocked: false }]) assert.equal((await c.post('jobs/cancel', body)).statusCode, 400)
  const off = await setup(t, {}, false)
  assert.equal((await off.post('service/resume')).json().code, 'METADATA_NOT_READY')
  assert.equal((await off.post('backfill')).json().code, 'METADATA_DISABLED')
})

test('cancel mixed states is scoped/idempotent, preserves provider gate and leaves completed metadata alone', async t => {
  const c = await setup(t)
  for (const status of ['queued', 'retry_wait', 'paused', 'running', 'succeeded', 'needs_review', 'failed']) await c.publish(status, status)
  await c.publish('other_console', 'queued', 'snes')
  c.db.prepare("UPDATE metadata_provider_state SET next_at = ?, paused_reason = 'forbidden'").run(Date.now() + 60000)
  const before = gate(c)
  const result = await c.post('jobs/cancel', { consoleId: 'nes' })
  assert.deepEqual(result.json(), { cancelled: 3, cancelling: 1, total: 4 })
  assert.deepEqual(gate(c), before)
  assert.equal(c.db.prepare("SELECT cancel_requested FROM metadata_jobs WHERE status = 'running'").get().cancel_requested, 1)
  assert.deepEqual((await c.post('jobs/cancel', { consoleId: 'nes' })).json(), { cancelled: 0, cancelling: 1, total: 1 })
  assert.equal((await c.post('jobs/cancel', { statuses: ['queued'] })).json().cancelled, 1)
  assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM metadata_jobs WHERE status IN ('succeeded', 'needs_review', 'failed')").get().n, 3)
  c.db.exec("UPDATE metadata_jobs SET status = 'cancelled' WHERE status = 'running'")
  assert.deepEqual((await c.post('jobs/cancel')).json(), { cancelled: 0, cancelling: 0, total: 0 })
})

test('control rate limit is shared across mutations and backfill accepts all five groups', async t => {
  const c = await setup(t)
  for (const status of ['disabled', 'not_found', 'failed', 'paused', 'cancelled']) await c.publish(status, status)
  assert.equal((await c.post('backfill', { statuses: ['disabled', 'not_found', 'failed', 'paused', 'cancelled'] })).json().queued, 5)
  // Cancel also retires the superseded paused generation, not just the five
  // newly queued generations. Historical terminal results stay untouched.
  assert.equal((await c.post('jobs/cancel')).json().cancelled, 6)
  for (let i = 0; i < 238; i++) assert.equal((await c.post('service/resume')).statusCode, 200)
  const limited = await c.post('jobs/cancel')
  assert.equal(limited.statusCode, 429)
  assert.ok(Number(limited.headers['retry-after']) > 0)
})

test('backfill cancelled group requeues admin-cancelled scans and leaves other terminal results alone', async t => {
  const c = await setup(t)
  const cancelled = await c.publish('cancelled', 'cancelled'), succeeded = await c.publish('succeeded', 'succeeded')
  assert.deepEqual((await c.post('backfill', { statuses: ['cancelled'] })).json(), { queued: 1, skipped: 0, capacity: 1000 })
  const latest = c.db.prepare('SELECT status, generation FROM metadata_jobs WHERE game_id = ? ORDER BY generation DESC LIMIT 1').get(cancelled.id)
  assert.deepEqual({ ...latest }, { status: 'queued', generation: 2 })
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM metadata_jobs WHERE game_id = ?').get(succeeded.id).n, 1)
  assert.equal((await c.post('backfill', { statuses: ['cancelled'] })).json().queued, 0)
})

test('backfill includes legacy rows and selected groups, excludes deleted/active, preserves locks and increments revision once', async t => {
  const c = await setup(t)
  const first = await c.publish('first'), legacy = await c.publish('legacy'), failed = await c.publish('failed', 'failed')
  const deleted = await c.publish('deleted'), active = await c.publish('active', 'queued')
  await c.publish('snes', 'disabled', 'snes')
  c.db.prepare('DELETE FROM metadata_jobs WHERE game_id = ?').run(legacy.id)
  c.db.prepare('DELETE FROM game_metadata_field_sources WHERE game_id = ?').run(legacy.id)
  c.db.prepare('DELETE FROM game_metadata WHERE game_id = ?').run(legacy.id)
  c.db.prepare('UPDATE games SET deleted_at = ? WHERE id = ?').run(Date.now(), deleted.id)
  const get = query => c.app.inject({ url: '/api/admin/metadata/jobs' + query, headers: c.headers })
  assert.equal((await get('')).json().total, 2)
  const unscanned = (await get('?status=disabled&console=nes')).json()
  assert.equal(unscanned.total, 2); assert.equal(unscanned.counts.disabled, 3)
  assert.ok(readMetadataJobs(unscanned))
  assert.equal(readMetadataJobs({ ...unscanned, counts: { ...unscanned.counts, disabled: -1 } }), null)
  assert.equal(readMetadataJobs({ ...unscanned, items: [{ ...unscanned.items[0], attempts: -1 }] }), null)
  const revision = c.db.prepare('SELECT revision FROM catalog_revision').get().revision
  assert.deepEqual((await c.post('backfill', { statuses: ['disabled', 'failed'], consoleId: 'nes' })).json(), { queued: 3, skipped: 0, capacity: 999 })
  assert.equal(c.db.prepare('SELECT revision FROM catalog_revision').get().revision, revision + 1)
  for (const game of [first, legacy, failed]) {
    const job = c.db.prepare('SELECT * FROM metadata_jobs WHERE game_id = ? ORDER BY generation DESC LIMIT 1').get(game.id)
    assert.equal(job.status, 'queued'); assert.equal(job.attempts, 0)
    assert.deepEqual(JSON.parse(job.request_json), { replaceLocked: false, expectedRevision: 1 })
  }
  assert.equal(c.db.prepare("SELECT locked FROM game_metadata_field_sources WHERE game_id = ? AND field = 'title'").get(legacy.id).locked, 1)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM metadata_jobs WHERE game_id = ?').get(active.id).n, 1)
  assert.equal((await c.post('backfill', { consoleId: 'snes', replaceLocked: true })).json().queued, 1)
  c.db.exec("UPDATE metadata_provider_state SET paused_reason = 'auth_rejected'")
  assert.equal((await c.post('backfill')).json().code, 'METADATA_PAUSED')
  c.db.prepare('UPDATE metadata_provider_state SET paused_reason = NULL, next_at = ?').run(Date.now() + 60000)
  const cooldown = await c.post('backfill')
  assert.equal(cooldown.statusCode, 429); assert.equal(cooldown.json().code, 'METADATA_COOLDOWN')
})

test('backfill capacity 1000, deterministic oldest-first selection, honest skipped count and active-job exclusion', async t => {
  const c = await setup(t)
  const game = await c.publish('seed')
  const insertGame = c.db.prepare(`INSERT INTO games (id, console_id, title, description, license, storage_key, original_name, size, sha256, created_at, updated_at)
    SELECT ?, console_id, ?, description, license, ?, ?, size, ?, ?, updated_at FROM games WHERE id = ?`)
  c.db.exec('BEGIN IMMEDIATE')
  for (let i = 0; i < 1002; i++) insertGame.run(randomUUID(), 'bulk' + i, randomUUID() + '.nes', 'bulk' + i + '.nes', createHash('sha256').update(String(i)).digest('hex'), i, game.id)
  c.db.exec('COMMIT')
  const result = (await c.post('backfill')).json()
  assert.deepEqual(result, { queued: 1000, skipped: 3, capacity: 1000 })
  assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM metadata_jobs WHERE status = 'queued'").get().n, 1000)
  assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM games g JOIN metadata_jobs j ON j.game_id = g.id WHERE g.created_at >= 1000 AND j.status = 'queued'").get().n, 0)
  assert.deepEqual((await c.post('backfill')).json(), { queued: 0, skipped: 3, capacity: 0 })
})

for (const mode of ['stop', 'cancel', 'config', 'delete', 'generation', 'lease']) test(`held provider ${mode} does not pause provider gate or accept late results`, async t => {
  let entered, release
  const started = new Promise(resolve => { entered = resolve })
  const hold = new Promise(resolve => { release = resolve })
  const c = await setup(t, { clientFactory: () => ({ searchByHash: async () => { entered(); await hold; throw new ScreenScraperError('auth_rejected') } }) })
  const game = await c.publish('held', 'queued')
  const work = c.app.catalog.worker.processOne()
  await started
  if (mode === 'stop') await c.app.catalog.worker.stop()
  if (mode === 'cancel') assert.equal((await c.post('jobs/cancel')).json().cancelling, 1)
  if (mode === 'config') c.app.appConfig.screenscraper.enabled = false
  if (mode === 'delete') c.db.prepare('UPDATE games SET deleted_at = ? WHERE id = ?').run(Date.now(), game.id)
  if (mode === 'generation') c.db.prepare(`INSERT INTO metadata_jobs (id, game_id, asset_fingerprint, generation, phase, status, next_at, created_at, updated_at) VALUES (?, ?, ?, 2, 'identifying', 'disabled', 0, 0, 0)`).run(randomUUID(), game.id, `${game.sha256}:${game.size}`)
  if (mode === 'lease') c.db.exec("UPDATE metadata_provider_state SET lease_token = 'another-worker'")
  await work
  assert.deepEqual(gate(c), { next_at: 0, paused_reason: null })
  const job = c.db.prepare('SELECT * FROM metadata_jobs WHERE game_id = ? AND generation = 1').get(game.id)
  assert.equal(job.status, mode === 'stop' ? 'retry_wait' : 'cancelled')
  if (mode === 'stop') {
    assert.equal(job.attempts, 0); assert.ok(job.next_at <= Date.now())
    release(); await c.app.close()
    const restarted = await createApp({ root: c.root, env, metadataDependencies: { clientFactory: () => ({ searchByHash: async () => ({ method: 'hash', systemId: '3', candidates: [] }) }) } })
    await restarted.catalog.worker.stop()
    try { assert.equal(await restarted.catalog.worker.processOne(), true) } finally { await restarted.close() }
  } else release()
})

test('schema 18 migrates once, clears only disabled pause; schema-18 backup verifies and restores without operational jobs', async t => {
  const c = await setup(t)
  await c.publish('legacy_schema')
  const config = c.app.appConfig
  await c.app.close()
  const path = join(config.dataDir, 'maindulu.sqlite'), old = new DatabaseSync(path)
  old.exec("ALTER TABLE metadata_jobs DROP COLUMN cancel_requested; DELETE FROM schema_migrations WHERE version = 19; PRAGMA user_version = 18; UPDATE metadata_provider_state SET paused_reason = 'disabled'")
  old.close()
  const target = join(c.root, 'backup18'), restored = join(c.root, 'restore18')
  // Upgrade source first, then reconstruct an actual v18 snapshot for restore.
  const upgraded = await openDatabase(config.dataDir)
  assert.equal(upgraded.prepare('SELECT paused_reason FROM metadata_provider_state').get().paused_reason, null)
  upgraded.exec("UPDATE metadata_provider_state SET paused_reason = 'forbidden'"); upgraded.close()
  const reopened = await openDatabase(config.dataDir)
  assert.equal(reopened.prepare('SELECT paused_reason FROM metadata_provider_state').get().paused_reason, 'forbidden'); reopened.close()
  const manifest = await createDataBackup(config, target)
  const snapshot = new DatabaseSync(join(target, 'maindulu.sqlite'))
  snapshot.exec('ALTER TABLE metadata_jobs DROP COLUMN cancel_requested; DELETE FROM schema_migrations WHERE version = 19; PRAGMA user_version = 18;'); snapshot.close()
  const bytes = await readFile(join(target, 'maindulu.sqlite'))
  manifest.schemaVersion = 18
  Object.assign(manifest.files.find(f => f.path === 'maindulu.sqlite'), { size: bytes.length, checksum: createHash('sha256').update(bytes).digest('hex') })
  await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest))
  await verifyDataBackup(config, target); await restoreDataBackup(config, target, restored)
  const db = await openDatabase(restored)
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 19)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM metadata_jobs').get().n, 0)
    assert.equal(db.prepare('SELECT next_at FROM metadata_provider_state').get().next_at, 0)
  } finally { db.close() }
})

test('control response validators reject malformed counts and disabled DTO still validates every field', () => {
  assert.ok(readMetadataControl('backfill', { queued: 2, skipped: 1, capacity: 10 }))
  for (const value of [{ queued: 1001, skipped: 0, capacity: 1000 }, { queued: 2, skipped: -1, capacity: 10 }, { queued: 2, skipped: 0, capacity: 1 }]) assert.equal(readMetadataControl('backfill', value), null)
  assert.equal(readMetadataControl('cancel', { cancelled: 1, cancelling: 2, total: 2 }), null)
  assert.equal(readMetadataControl('resume', { pausedReason: 'disabled', cooldownUntil: 0 }), null)
})
