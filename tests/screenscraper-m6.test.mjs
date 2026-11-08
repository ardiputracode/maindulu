import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createApp } from '../server/app.mjs'
import { createMetadataWorker } from '../server/metadata/worker.mjs'
import { ScreenScraperClient, ScreenScraperError, readScreenScraperConfig } from '../server/metadata/screenscraper.mjs'
import { screenScraperQuota } from '../server/metadata/quota.mjs'
import { metadataCacheKey, readMetadataCache, writeMetadataCache, pruneMetadata } from '../server/metadata/cache.mjs'
import { screenScraperLimits as limits } from '../server/metadata/screenscraper-policy.mjs'
import { downloadScreenScraperCover } from '../server/metadata/cover.mjs'
import { csrfToken, hashToken } from '../server/auth/crypto.mjs'
import { backendFixture } from './helpers/backend-fixture.mjs'

const hash = alg => createHash(alg).update('abc').digest('hex')
const candidate = { id: '123', systemId: '3', notGame: false, rom: { id: '456', size: 3, md5: hash('md5'), sha1: hash('sha1'), totalSupports: 1 },
  metadata: { title: 'Provider title', description: 'Plain synopsis', media: [] } }
const config = { screenscraper: { enabled: true, missing: [] } }
const result = { method: 'hash', systemId: '3', candidates: [candidate] }
const silent = { warn() {}, error() {} }
const hold = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

async function fixture(t, dependencies = {}) {
  let app
  const root = await backendFixture(t, { beforeCleanup: () => app?.close() })
  app = await createApp({ root, env: {} })
  await app.catalog.worker.stop()
  const db = app.database, actor = randomUUID(), token = 'c'.repeat(64)
  db.prepare('INSERT INTO users (id, username, password_hash, recovery_code_hash, created_at, role) VALUES (?, ?, ?, ?, ?, ?)').run(actor, 'm6admin', 'fixture', 'fixture', Date.now(), 'admin')
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(hashToken(token), actor, Date.now(), Date.now() + 600000)
  const headers = { host: 'localhost:7777', origin: 'http://localhost:7777', cookie: `maindulu_session=${token}`, 'x-csrf-token': csrfToken(token) }
  const publish = async (name = 'fixture.nes', bytes = 'abc') => app.catalog.repository.publish('games', actor, { title: '', consoleId: 'nes', fileName: name },
    await app.catalog.storage.stage('games', (async function* () { yield Buffer.from(bytes) })()))
  const game = await publish()
  const workerConfig = structuredClone(config)
  const worker = createMetadataWorker({ db, storage: app.catalog.storage, maintenance: app.catalog.maintenance, config: workerConfig, logger: silent, ...dependencies })
  t.after(() => worker.stop())
  return { app, db, actor, headers, game, worker, workerConfig, publish }
}

test('M6 quota parses strictest minute allowance and fails closed without valid counters', () => {
  const user = { maxthreads: '2', requeststoday: '10', requestskotoday: '1', maxrequestsperday: '100', maxrequestskoperday: '20', maxrequestspermin: '60', maxrequestsperdmin: '12' }
  assert.equal(screenScraperQuota(user).intervalMs, 5000)
  assert.equal(screenScraperQuota(user).remaining, 90)
  for (const field of Object.keys(user)) assert.throws(() => screenScraperQuota({ ...user, [field]: 'SECRET' }), e => e.code === 'quota_unknown')
  for (const field of ['maxthreads', 'maxrequestspermin', 'maxrequestsperday', 'maxrequestskoperday']) assert.throws(() => screenScraperQuota({ ...user, [field]: 0 }), e => e.code === 'quota_exhausted')
})

test('M6 production client reads quota using fixed account endpoint and redacts arbitrary details/code/cause', async () => {
  const client = new ScreenScraperClient({ enabled: true, missing: [], devId: 'dummy', devPassword: 'SECRET', user: 'dummy', password: 'SECRET' }, { fetch: async url => {
    assert.equal(url.pathname, '/api2/ssuserInfos.php')
    return Response.json({ response: { ssuser: { maxthreads: 1, requeststoday: 1, requestskotoday: 0, maxrequestsperday: 10, maxrequestskoperday: 10, maxrequestspermin: 60 } } })
  } })
  assert.equal((await client.accountQuota()).remaining, 9)
  const error = new ScreenScraperError('SECRET', { arbitrary: { cause: 'SECRET' }, retryAfterMs: 4000, httpStatus: 429 })
  assert.doesNotMatch(JSON.stringify(error), /SECRET|arbitrary|cause/)
  assert.equal(error.code, 'provider_error')
})

test('M6 client timeout bounds ignored abort, stalled body, late response and excessive stream without secret echoes', async () => {
  const c = { enabled: true, missing: [], devId: 'dummy', maxResponseBytes: 8 }
  const input = { consoleId: 'nes', fileName: 'fixture.nes', size: 3, md5: hash('md5'), sha1: hash('sha1') }
  for (const mode of ['headers', 'body', 'late', 'oversize', 'throw', 'redirect']) {
    let cancelled = false
    const client = new ScreenScraperClient(c, { timeoutMs: 20, fetch: async () => {
      if (mode === 'headers') return new Promise(() => {})
      if (mode === 'late') await new Promise(r => setTimeout(r, 40))
      if (mode === 'throw') throw new Error('https://evil/?password=SECRET', { cause: 'SECRET' })
      if (mode === 'redirect') return { redirected: true, body: new ReadableStream({ cancel() { cancelled = true } }) }
      return new Response(new ReadableStream({ start(controller) { if (mode === 'oversize') controller.enqueue(new Uint8Array(9)) }, cancel() { cancelled = true } }))
    } })
    await assert.rejects(client.searchByHash(input), e => ['timeout', 'transport', 'response_too_large'].includes(e.code) && !JSON.stringify(e).includes('SECRET'))
    if (mode === 'late') await new Promise(r => setTimeout(r, 50))
    if (['body', 'late', 'oversize', 'redirect'].includes(mode)) assert.equal(cancelled, true, mode)
  }
})

test('M6 cache keys isolate systems, filenames, queries; TTL, invalid JSON, entry cap and pruning are bounded', async t => {
  const c = await fixture(t)
  const hashes = { size: 3, md5: hash('md5'), sha1: hash('sha1') }, now = Date.now()
  const key = metadataCacheKey('3', hashes, 'fixture.nes')
  for (const other of [metadataCacheKey('9', hashes, 'fixture.nes'), metadataCacheKey('3', hashes, 'other.nes'), metadataCacheKey('3', hashes, 'fixture.nes', 'name')]) assert.notEqual(other.key, key.key)
  writeMetadataCache(c.db, key, result, now)
  assert.deepEqual(readMetadataCache(c.db, key, now + limits.positiveCacheTtlMs - 1), result)
  assert.equal(readMetadataCache(c.db, key, now + limits.positiveCacheTtlMs), null)
  writeMetadataCache(c.db, key, { ...result, candidates: [] }, now)
  assert.equal(readMetadataCache(c.db, key, now + limits.negativeCacheTtlMs), null)
  c.db.prepare("UPDATE provider_cache SET payload = 'invalid'").run()
  assert.equal(readMetadataCache(c.db, key, now), null)
  for (let i = 0; i <= limits.maxCacheEntries; i++) writeMetadataCache(c.db, metadataCacheKey('3', hashes, `${i}.nes`), result, now + i)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM provider_cache').get().n, limits.maxCacheEntries)
  const old = now - limits.terminalJobRetentionMs - 1
  c.db.prepare("UPDATE metadata_jobs SET status = 'needs_review', candidate_at = ?, candidate_json = ?, updated_at = ?").run(old, JSON.stringify(result), old)
  pruneMetadata(c.db, now + limits.positiveCacheTtlMs + 2000)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM provider_cache').get().n, 0)
  assert.equal(c.db.prepare('SELECT candidate_json FROM metadata_jobs').get().candidate_json, null)
  assert.equal(c.db.prepare('SELECT generation FROM metadata_jobs').get().generation, 1)
})

test('M6 worker consumes positive/negative cache without provider calls and records safe metrics', async t => {
  let calls = 0
  const c = await fixture(t, { clientFactory: () => ({ searchByHash: async () => { calls++; return result } }) })
  await c.worker.processOne()
  c.db.prepare('UPDATE metadata_provider_state SET next_at = 0').run()
  c.db.prepare("UPDATE metadata_jobs SET status = 'queued'").run()
  await c.worker.processOne()
  assert.equal(calls, 1)
  assert.equal(c.worker.status().metrics.cacheHits, 1)
  assert.equal(c.worker.status().metrics.completed, 2)
  assert.equal(c.worker.status().metrics.phases.lookup.count, 2)
  const key = metadataCacheKey('3', { size: 3, md5: hash('md5'), sha1: hash('sha1') }, 'fixture.nes')
  writeMetadataCache(c.db, key, { ...result, candidates: [] })
  c.db.exec("UPDATE metadata_provider_state SET next_at = 0; UPDATE metadata_jobs SET status = 'queued';")
  await c.worker.processOne()
  assert.equal(calls, 1)
  assert.equal(c.db.prepare('SELECT status FROM metadata_jobs').get().status, 'not_found')
  assert.doesNotMatch(JSON.stringify(c.worker.status()), /fixture|Provider|password|md5|sha1/)
})

for (const action of ['disable', 'stop', 'delete', 'restore', 'lease']) test(`M6 ${action} fences a held lookup even when transport ignores abort`, async t => {
  const started = hold(), release = hold()
  const c = await fixture(t, { clientFactory: () => ({ searchByHash: async () => { started.resolve(); await release.promise; return result } }) })
  const work = c.worker.processOne()
  await started.promise
  if (action === 'disable') c.workerConfig.screenscraper.enabled = false
  if (action === 'stop') await c.worker.stop()
  if (['delete', 'restore'].includes(action)) {
    c.app.catalog.repository.delete('games', c.actor, c.game.id)
    if (action === 'restore') {
      await c.app.catalog.repository.publish('games', c.actor, { title: 'Restored admin', consoleId: 'nes', fileName: 'fixture.nes' },
        await c.app.catalog.storage.stage('games', (async function* () { yield Buffer.from('abc') })()), { restoreId: c.game.id })
    }
  }
  if (action === 'lease') c.db.exec("UPDATE metadata_jobs SET lease_token = 'replacement'; UPDATE metadata_provider_state SET lease_token = 'replacement';")
  release.resolve()
  await work
  const row = c.db.prepare('SELECT * FROM games WHERE id = ?').get(c.game.id)
  assert.notEqual(row.title, 'Provider title')
  assert.equal(row.description, '')
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM provider_cache').get().n, 0)
  if (action === 'lease') assert.equal(c.db.prepare('SELECT lease_token FROM metadata_jobs').get().lease_token, 'replacement')
})

test('M6 SQLite shared lease excludes a separate process then crash-expired lease recovers idempotently', async t => {
  const started = hold(), release = hold()
  const c = await fixture(t, { clientFactory: () => ({ searchByHash: async () => { started.resolve(); await release.promise; return result } }) })
  const work = c.worker.processOne(); await started.promise
  const script = `import { DatabaseSync } from 'node:sqlite'; import { createMetadataWorker } from './server/metadata/worker.mjs';
    const db = new DatabaseSync(${JSON.stringify(join(c.app.appConfig.dataDir, 'maindulu.sqlite'))}); db.exec('PRAGMA busy_timeout=5000');
    const worker = createMetadataWorker({ db, config: ${JSON.stringify(config)}, storage: {}, logger: { warn() {} }, clientFactory: () => ({}) });
    console.log(await worker.processOne()); db.close();`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout.trim(), 'false')
  c.db.exec('UPDATE metadata_jobs SET lease_expires_at = 1; UPDATE metadata_provider_state SET lease_expires_at = 1;')
  const replacement = createMetadataWorker({ db: c.db, storage: c.app.catalog.storage, config, logger: silent, clientFactory: () => ({ searchByHash: async () => result }) })
  await replacement.processOne()
  release.resolve(); await work
  assert.equal(c.db.prepare('SELECT status FROM metadata_jobs').get().status, 'succeeded')
  assert.equal(c.db.prepare('SELECT metadata_revision FROM game_metadata').get().metadata_revision, 2)
  assert.equal(c.db.prepare('SELECT title FROM games').get().title, 'Provider title')
})

test('M6 auth/config/quota isolation pauses shared queue; health, ROM and uploads remain available', async t => {
  let calls = 0
  const c = await fixture(t, { clientFactory: () => ({ accountQuota: async () => { throw new ScreenScraperError('quota_unknown') }, searchByHash: async () => { calls++ } }) })
  await c.worker.processOne()
  assert.equal(calls, 0)
  assert.equal(c.db.prepare('SELECT paused_reason FROM metadata_provider_state').get().paused_reason, 'quota_unknown')
  await c.publish('other.nes', 'xyz')
  assert.equal(await c.worker.processOne(), false)
  assert.equal((await c.app.inject('/api/health')).statusCode, 200)
  assert.equal((await c.app.inject(`/games/${c.game.id}/rom/fixture.nes`)).statusCode, 200)
  const status = await c.app.inject({ url: '/api/admin/metadata/status', headers: c.headers })
  assert.equal(status.headers['cache-control'], 'no-store')
  assert.ok(status.json().queue.oldestPendingMs >= 0)
})

test('M6 all metadata routes reject guest, wrong CSRF, revoked role; forged candidates/generations/fields and replay conflict', async t => {
  const c = await fixture(t)
  c.app.appConfig.screenscraper = readScreenScraperConfig({ MAIN_DULU_SCREENSCRAPER_ENABLED: 'true', MAIN_DULU_SCREENSCRAPER_DEV_ID: 'dummy', MAIN_DULU_SCREENSCRAPER_DEV_PASSWORD: 'dummy', MAIN_DULU_SCREENSCRAPER_USER: 'dummy', MAIN_DULU_SCREENSCRAPER_PASSWORD: 'dummy' })
  const paths = ['/api/admin/metadata/status', `/api/admin/games/${c.game.id}/metadata`, ...['scan', 'search', 'apply', 'unlock'].map(x => `/api/admin/games/${c.game.id}/metadata/${x}`)]
  for (const url of paths) {
    const method = /\/(scan|search|apply|unlock)$/.test(url) ? 'POST' : 'GET'
    assert.equal((await c.app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) })).statusCode, 401)
    if (method === 'POST') assert.equal((await c.app.inject({ method, url, headers: { ...c.headers, 'x-csrf-token': 'bad' }, payload: {} })).statusCode, 403)
    c.db.prepare("UPDATE users SET role = 'user'").run()
    assert.equal((await c.app.inject({ method, url, headers: c.headers, ...(method === 'POST' ? { payload: {} } : {}) })).statusCode, 403)
    c.db.prepare("UPDATE users SET role = 'admin'").run()
  }
  c.db.prepare("UPDATE metadata_jobs SET status = 'needs_review', candidate_json = ?, candidate_at = ?").run(JSON.stringify(result), Date.now())
  const apply = payload => c.app.inject({ method: 'POST', url: `/api/admin/games/${c.game.id}/metadata/apply`, headers: c.headers, payload })
  const valid = { candidateId: '123', generation: 1, expectedRevision: 1, fields: ['title'] }
  for (const patch of [{ candidateId: '999' }, { generation: 0 }, { generation: 2 }, { expectedRevision: 999 }, { fields: ['license'] }, { fields: ['title', 'title'] }, { fields: ['__proto__'] }]) assert.ok([400, 409].includes((await apply({ ...valid, ...patch })).statusCode))
  c.db.prepare('UPDATE metadata_jobs SET candidate_at = ?').run(Date.now() - limits.reviewRetentionMs - 1)
  assert.equal((await apply(valid)).statusCode, 409)
  c.db.prepare('UPDATE metadata_jobs SET candidate_at = ?').run(Date.now())
  assert.equal((await apply(valid)).statusCode, 200)
  // Once a newer generation exists, replay cannot schedule a second task.
  const replay = await apply(valid)
  assert.equal(replay.json().generation, 2)
  assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM metadata_jobs WHERE status = 'queued'").get().n, 1)
})

test('M6 cover DNS timeout/private mixed answers/IPv6 fail closed before any socket', async () => {
  const input = { gameId: '123', systemId: '3', region: 'us' }
  let calls = 0
  const request = () => { calls++ }
  for (const addresses of [[{ address: '8.8.8.8' }, { address: '192.168.0.1' }], [{ address: '::ffff:8.8.8.8' }], [{ address: '169.254.169.254' }]]) {
    await assert.rejects(downloadScreenScraperCover({}, input, { lookup: async () => addresses, request }), e => e.code === 'COVER_DNS')
  }
  await assert.rejects(downloadScreenScraperCover({}, input, { lookup: () => new Promise(() => {}), request, timeoutMs: 20 }), e => e.code === 'COVER_TIMEOUT')
  assert.equal(calls, 0)
})

test('M6 deploy forwards runtime secrets only and packages metadata source without local credentials', async () => {
  const compose = await readFile('deploy/docker-compose.backend.yml', 'utf8')
  for (const key of ['DEV_ID', 'DEV_PASSWORD', 'USER', 'PASSWORD', 'SOFTNAME']) assert.match(compose, new RegExp(`^      - MAIN_DULU_SCREENSCRAPER_${key}$`, 'm'))
  assert.ok(compose.includes('MAIN_DULU_SCREENSCRAPER_ENABLED:-false'))
  const dockerfile = await readFile('deploy/Dockerfile.backend', 'utf8')
  assert.doesNotMatch(dockerfile, /SCREENSCRAPER|\.env/)
})
