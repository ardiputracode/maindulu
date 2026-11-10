import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { renameSync, writeFileSync } from 'node:fs'
import { link, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Readable } from 'node:stream'
import { createApp } from './helpers/gated-backend.mjs'
import { createCatalogRepository } from '../server/catalog/repository.mjs'
import { csrfToken, hashToken } from '../server/auth/crypto.mjs'
import { backendFixture } from './helpers/backend-fixture.mjs'
import { createDataBackup, restoreDataBackup } from '../server/data-backup.mjs'
import { openDatabase } from '../server/database.mjs'
import sharp from 'sharp'

async function setup(t, { age = false, metadata = false, metadataDependencies } = {}) {
  const c = { app: null }
  c.root = await backendFixture(t, { beforeCleanup: () => c.app?.close() })
  c.app = await createApp({ root: c.root, metadataDependencies, env: metadata ? { MAIN_DULU_SCREENSCRAPER_ENABLED: 'true', MAIN_DULU_SCREENSCRAPER_DEV_ID: 'fixture', MAIN_DULU_SCREENSCRAPER_DEV_PASSWORD: 'fixture', MAIN_DULU_SCREENSCRAPER_USER: 'fixture', MAIN_DULU_SCREENSCRAPER_PASSWORD: 'fixture' } : {} })
  // Pause the real provider worker: queue assertions must not depend on network.
  await c.app.catalog.worker.stop()
  c.db = c.app.database; c.storage = c.app.catalog.storage; c.actor = randomUUID()
  c.db.prepare('INSERT INTO users (id, username, password_hash, recovery_code_hash, created_at, role) VALUES (?, ?, ?, ?, ?, ?)').run(c.actor, 'scanner_admin', 'fixture', 'fixture', Date.now(), 'admin')
  const token = 'b'.repeat(64)
  c.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(hashToken(token), c.actor, Date.now(), Date.now() + 600000)
  c.headers = { host: 'localhost:7777', origin: 'http://localhost:7777', cookie: `maindulu_session=${token}`, 'x-csrf-token': csrfToken(token) }
  c.post = (path, payload = {}) => c.app.inject({ method: 'POST', url: '/api/admin/catalog-scans' + path, headers: c.headers, payload })
  c.get = path => c.app.inject({ url: '/api/admin/catalog-scans' + path, headers: c.headers })
  c.put = async (kind, platform, name, content = name) => {
    const dir = join(c.app.appConfig.dataDir, kind === 'games' ? 'roms' : 'bios', platform)
    await mkdir(dir, { recursive: true }); const path = join(dir, name); await writeFile(path, content); return path
  }
  if (!age) {
    const adoption = c.storage.adoption.bind(c.storage)
    c.storage.adoption = (...args) => adoption(...args, 0)
  }
  c.scan = async (body = {}) => {
    const response = await c.post('', body)
    assert.equal(response.statusCode, 202, response.body)
    const id = response.json().job.id
    for (let n = 0; n < 500; n++) {
      const job = (await c.get('/' + id)).json().job
      if (!['running', 'queued'].includes(job.status)) return { job, results: (await c.get('/' + id + '/results')).json().items }
      await delay(10)
    }
    assert.fail('Scan did not finish')
  }
  return c
}

test('scan adopts every platform and BIOS in place, queues disabled metadata, preserves hashes/IDs on repeat', async t => {
  const c = await setup(t)
  const specs = [['nes', 'a.nes', 'nes'], ['snes', 'a.sfc', 'snes'], ['gb', 'a.gb', 'gb'], ['gbc', 'a.gbc', 'gb'], ['gba', 'a.gba', 'gba'], ['genesis', 'a.md', 'megadrive'], ['psx', 'a.chd', 'psx']]
  for (const [platform, name] of specs) await c.put('games', platform, name)
  await c.put('bios', 'gb', 'boot.bin')
  const before = await c.storage.physicalUsage()
  const { job, results } = await c.scan()
  assert.equal(job.status, 'completed'); assert.equal(job.added, 8); assert.equal(job.processed, 8)
  assert.ok(results.every(r => r.status === 'added'))
  for (const [platform, name, consoleId] of specs) {
    const row = c.db.prepare('SELECT * FROM games WHERE original_name = ?').get(name)
    assert.equal(row.console_id, consoleId)
    assert.equal(await readFile(await c.storage.pathFor('games', row.storage_key), 'utf8'), name)
    assert.equal(c.db.prepare("SELECT source, locked FROM game_metadata_field_sources WHERE game_id = ? AND field = 'title'").get(row.id).source, 'filename')
    assert.equal(c.db.prepare('SELECT status FROM metadata_jobs WHERE game_id = ?').get(row.id).status, 'disabled')
    assert.equal(await c.storage.pathFor('games', row.storage_key), join(c.app.appConfig.dataDir, 'roms', platform, name))
  }
  assert.equal(await c.storage.physicalUsage(), before)
  const previous = c.db.prepare('SELECT * FROM games').all()
  const repeated = await c.scan()
  assert.equal(repeated.job.skipped, 8); assert.equal(repeated.job.added, 0)
  assert.deepEqual(c.db.prepare('SELECT * FROM games').all(), previous)
  const row = previous[0]
  const response = await c.app.inject({ url: `/games/${row.id}/rom/${row.original_name}` })
  assert.equal(response.statusCode, 200); assert.equal(response.body, row.original_name)
})

test('scan classifies duplicates, byte conflict, tombstones, busy paths, formats, hard links and subfolders without deleting sources', async t => {
  const c = await setup(t)
  const original = await c.put('games', 'nes', 'a.nes', 'same')
  const first = await c.scan({ platforms: ['nes'], kind: 'games' })
  const id = first.results[0].existingId
  await c.put('games', 'nes', 'duplicate.nes', 'same')
  let scan = await c.scan({ platforms: ['nes'], kind: 'games' })
  assert.equal(scan.results.find(r => r.path.endsWith('duplicate.nes')).status, 'duplicate')
  await writeFile(original, 'diff')
  scan = await c.scan({ platforms: ['nes'], kind: 'games' })
  assert.equal(scan.results.find(r => r.path.endsWith('/a.nes')).status, 'conflict')
  assert.equal(c.db.prepare('SELECT size FROM games WHERE id = ?').get(id).size, 4)
  c.db.prepare('UPDATE games SET deleted_at = ? WHERE id = ?').run(Date.now(), id)
  await c.put('games', 'nes', 'new.nes', 'same')
  c.db.prepare("INSERT INTO catalog_asset_files VALUES (?, 'games', 'nes', 'reserved.nes', 'reserved.nes', 'reserved')").run(randomUUID() + '.bin')
  await c.put('games', 'nes', 'reserved.nes')
  const hard = await c.put('games', 'nes', 'hard.nes')
  await link(hard, join(c.app.appConfig.dataDir, 'roms/nes/hard2.nes'))
  await mkdir(join(c.app.appConfig.dataDir, 'roms/nes/nested'))
  await c.put('games', 'gb', 'wrong.gbc')
  await c.put('games', 'gbc', 'wrong.zip')
  await c.put('bios', 'gbc', 'boot.bin')
  await c.put('games', 'psx', 'disc.cue'); await c.put('games', 'psx', 'track.bin'); await c.put('games', 'psx', 'list.m3u')
  scan = await c.scan()
  const status = suffix => scan.results.find(r => r.path.endsWith(suffix))?.status
  assert.equal(status('/new.nes'), 'restore_required'); assert.equal(status('/a.nes'), 'restore_required')
  assert.equal(status('/reserved.nes'), 'busy'); assert.equal(status('/hard.nes'), 'unsafe'); assert.equal(status('/nested'), 'invalid')
  assert.equal(status('/wrong.gbc'), 'invalid'); assert.equal(status('/wrong.zip'), 'invalid'); assert.equal(status('/boot.bin'), 'invalid')
  for (const suffix of ['/disc.cue', '/track.bin', '/list.m3u']) assert.equal(status(suffix), 'unsupported_multifile')
  assert.equal(await readFile(original, 'utf8'), 'diff')
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM games').get().n, 1)
})

test('adoption validates minimum age, rejects swaps during hashing and rolls back mapping/metadata without unlink', async t => {
  const c = await setup(t, { age: true })
  const path = await c.put('games', 'nes', 'a.nes', Buffer.alloc(3 * 1024 * 1024, 1))
  assert.equal((await c.scan()).results[0].status, 'not_ready')
  // Real minimum age is verified once rather than weakening production config.
  await delay(10100)
  let changed = false
  await assert.rejects(c.storage.adoption('games', 'nes', 'a.nes', () => {
    if (!changed) { changed = true; c.db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(c.actor); throw new Error('controlled abort') }
  }), /controlled abort/)
  c.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(c.actor)
  const file = await c.storage.adoption('games', 'nes', 'a.nes', () => {})
  const repo = createCatalogRepository(c.db, c.storage, { onPublished: () => { throw new Error('commit failure') } })
  await assert.rejects(repo.adopt('games', c.actor, { title: '', fileName: 'a.nes', consoleId: 'nes' }, file, { scanMetadata: false }), /commit failure/)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM catalog_asset_files').get().n, 0)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM metadata_jobs').get().n, 0)
  await rename(path, path + '.old'); await writeFile(path, Buffer.alloc(file.size, 1))
  assert.throws(() => c.storage.claimAdoption(file), /berubah|diganti/)
  assert.equal((await readFile(path)).length, file.size)
})

test('API guards scope, CSRF, role and metadata readiness; pagination/filtering and expired leases are persisted', async t => {
  const c = await setup(t)
  assert.equal((await c.app.inject({ url: '/api/admin/catalog-scans/active' })).statusCode, 401)
  assert.equal((await c.app.inject({ method: 'POST', url: '/api/admin/catalog-scans', headers: { ...c.headers, 'x-csrf-token': 'bad' }, payload: {} })).statusCode, 403)
  for (const body of [{ kind: null }, { platforms: ['../nes'] }, { platforms: [] }, { platforms: ['nes', 'nes'] }, { scanMetadata: 'true' }, { directory: '/tmp' }, { kind: 'bios', scanMetadata: true }, { scanMetadata: true }]) assert.equal((await c.post('', body)).statusCode, 400)
  c.db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(c.actor)
  assert.equal((await c.get('/active')).statusCode, 403)
  c.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(c.actor)
  const id = randomUUID()
  c.db.prepare("INSERT INTO catalog_scans(id, actor, scope, status, token, lease_until, created_at) VALUES (?, ?, '{}', 'running', 'stale', 1, 1)").run(id, c.actor)
  assert.equal((await c.get('/active')).json().job, null)
  assert.equal((await c.get('/' + id)).json().job.status, 'interrupted')
  await c.put('games', 'nes', 'hello.nes')
  const scan = await c.scan({ platforms: ['nes'] })
  const page = (await c.get(`/${scan.job.id}/results?status=added&q=hello&page=1`)).json()
  assert.equal(page.total, 1); assert.equal(page.items[0].path, 'roms/nes/hello.nes')
  assert.equal((await c.get(`/${scan.job.id}/results?status=invalid`)).json().total, 0)
  assert.equal((await c.get('/bad')).statusCode, 400)
})

test('cancel, lease loss, session revocation and demotion during hash all fence publication', async t => {
  for (const operation of ['cancel', 'lease', 'session', 'role']) await t.test(operation, async t => {
    const c = await setup(t)
    await c.put('games', 'nes', 'hold.nes')
    const adopt = c.storage.adoption
    let entered, release
    const waiting = new Promise(resolve => { entered = resolve })
    const held = new Promise(resolve => { release = resolve })
    c.storage.adoption = async (...args) => { const value = await adopt(...args); entered(); await held; return value }
    const start = await c.post('', {})
    const id = start.json().job.id
    await waiting
    assert.equal((await c.get('/active')).json().job.id, id)
    assert.equal((await c.post('', {})).statusCode, 409)
    if (operation === 'cancel') await c.post('/' + id + '/cancel')
    if (operation === 'lease') c.db.prepare('UPDATE catalog_scans SET lease_until = 0 WHERE id = ?').run(id)
    if (operation === 'session') c.db.exec('DELETE FROM sessions')
    if (operation === 'role') c.db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(c.actor)
    release()
    for (let n = 0; n < 100 && ['queued', 'running'].includes(c.db.prepare('SELECT status FROM catalog_scans WHERE id = ?').get(id).status); n++) await delay(10)
    assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM games').get().n, 0)
    assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM catalog_asset_files').get().n, 0)
    assert.equal(await readFile(join(c.app.appConfig.dataDir, 'roms/nes/hold.nes'), 'utf8'), 'hold.nes')
  })
})

test('only new games get one optional metadata job; repeat/BIOS/duplicates never enqueue again', async t => {
  const c = await setup(t, { metadata: true })
  await c.put('games', 'nes', 'a.nes')
  await c.put('bios', 'nes', 'boot.bin')
  const first = await c.scan({ scanMetadata: true })
  assert.equal(first.job.metadataQueued, 1)
  assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM metadata_jobs WHERE status = 'queued'").get().n, 1)
  await c.put('games', 'nes', 'duplicate.nes', 'a.nes')
  const repeat = await c.scan({ scanMetadata: true })
  assert.equal(repeat.job.metadataQueued, 0)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM metadata_jobs').get().n, 1)
})

test('backup excludes scan jobs/results/leases and restoring metadata requires old ID recovery', async t => {
  const c = await setup(t)
  await c.put('games', 'nes', 'a.nes')
  const scan = await c.scan()
  const gameId = scan.results[0].existingId
  const config = c.app.appConfig
  await c.app.close(); c.app = null
  const target = join(c.root, 'backup'), restored = join(c.root, 'restored')
  await createDataBackup(config, target)
  await restoreDataBackup(config, target, restored)
  const db = await openDatabase(restored)
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM catalog_scans').get().n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM catalog_scan_results').get().n, 0)
    assert.equal(db.prepare('SELECT id FROM games').get().id, gameId)
  } finally { db.close() }
  c.app = await createApp({ root: c.root, env: { MAIN_DULU_DATA_DIR: restored } })
  const stage = await c.app.catalog.storage.stage('games', Readable.from([Buffer.from('a.nes')]))
  await assert.rejects(c.app.catalog.repository.publish('games', c.actor, { title: '', consoleId: 'nes', fileName: 'a.nes' }, stage), error => error.code === 'CATALOG_RESTORE_REQUIRED' && error.id === gameId)
  c.db = c.app.database; c.storage = c.app.catalog.storage
  c.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(hashToken('b'.repeat(64)), c.actor, Date.now(), Date.now() + 600000)
  const adoption = c.storage.adoption.bind(c.storage)
  c.storage.adoption = (...args) => adoption(...args, 0)
  await c.put('games', 'nes', 'a.nes')
  const rescan = await c.scan()
  assert.equal(rescan.results[0].status, 'restore_required')
  assert.equal(rescan.results[0].existingId, gameId)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM games').get().n, 1)
})

test('pathname replacement during streaming hash is rejected, including identical replacement bytes', async t => {
  const c = await setup(t)
  const path = await c.put('games', 'nes', 'swap.nes', Buffer.alloc(2 * 1024 * 1024, 5))
  const adopt = c.storage.adoption.bind(c.storage)
  let swapped = false
  await assert.rejects(adopt('games', 'nes', 'swap.nes', () => {
    if (!swapped) { swapped = true; renameSync(path, path + '.old'); writeFileSync(path, Buffer.alloc(2 * 1024 * 1024, 5)) }
  }), /berubah|diganti/)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM games').get().n, 0)
})

test('active scan excludes another SQLite connection/process, upload cannot clobber its source, and cancel keeps an earlier commit', async t => {
  const c = await setup(t)
  await c.put('games', 'nes', 'a.nes')
  await c.put('games', 'nes', 'b.nes')
  const other = await createApp({ root: c.root, env: {} })
  let enter, release, calls = 0
  const entered = new Promise(resolve => { enter = resolve }), hold = new Promise(resolve => { release = resolve })
  const original = c.storage.adoption
  c.storage.adoption = async (...args) => { if (++calls === 2) { enter(); await hold }; return original(...args) }
  try {
    const response = await c.post('', { kind: 'games' }), id = response.json().job.id
    await entered
    assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM games').get().n, 1)
    const conflict = await other.inject({ method: 'POST', url: '/api/admin/catalog-scans', headers: c.headers, payload: {} })
    assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().activeJob.id, id)
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); try { db.exec("INSERT INTO catalog_scans(id, actor, scope, status, token, lease_until, created_at) VALUES ('other', 'other', '{}', 'queued', 'other', 9999999999999, 1)"); process.exitCode=1 } catch { process.exitCode=0 } finally { db.close() }`, join(c.app.appConfig.dataDir, 'maindulu.sqlite')], { encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    const stage = await other.catalog.storage.stage('games', Readable.from([Buffer.from('different')]))
    await assert.rejects(other.catalog.repository.publish('games', c.actor, { title: '', fileName: 'b.nes', consoleId: 'nes' }, stage), error => error.code === 'CATALOG_FILENAME_CONFLICT')
    await c.post('/' + id + '/cancel'); release()
    for (let n = 0; n < 100 && c.db.prepare('SELECT status FROM catalog_scans WHERE id = ?').get(id).status === 'running'; n++) await delay(10)
    assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM games').get().n, 1)
    assert.equal((await c.get('/' + id)).json().job.added, 1)
    assert.equal(await readFile(join(c.app.appConfig.dataDir, 'roms/nes/b.nes'), 'utf8'), 'b.nes')
  } finally { release(); await other.close() }
})

test('adopted game uses real metadata worker with fixture provider/cover while preserving file and save identity', async t => {
  const digest = algorithm => createHash(algorithm).update('abc').digest('hex')
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#00cc00' } }).png().toBuffer()
  let calls = 0
  const c = await setup(t, { metadata: true, metadataDependencies: {
    clientFactory: () => ({ searchByHash: async () => { calls++; return { method: 'hash', systemId: '3', candidates: [{ id: '123', systemId: '3', notGame: false, rom: { id: '456', size: 3, md5: digest('md5'), sha1: digest('sha1'), totalSupports: 1 }, metadata: { title: 'Fixture provider', description: 'Local fixture metadata', media: [{ type: 'box-2D', region: 'us' }] } }] } } }),
    downloadCover: async () => ({ bytes: png, type: 'image/png' }),
  } })
  const path = await c.put('games', 'nes', 'abc.nes', 'abc')
  const scan = await c.scan({ scanMetadata: true })
  const before = c.db.prepare('SELECT * FROM games').get()
  assert.equal(scan.job.metadataQueued, 1)
  assert.equal(await c.app.catalog.worker.processOne(), true)
  const after = c.db.prepare('SELECT * FROM games').get()
  assert.equal(after.title, 'Fixture provider'); assert.ok(after.cover_storage_key)
  for (const key of ['id', 'storage_key', 'sha256', 'size', 'console_id', 'license']) assert.equal(after[key], before[key])
  assert.equal(await readFile(path, 'utf8'), 'abc')
  assert.equal(c.db.prepare('SELECT status FROM metadata_jobs').get().status, 'succeeded')
  assert.equal((await c.scan({ scanMetadata: true })).job.metadataQueued, 0)
  assert.equal(calls, 1)
})

test('shutdown fences a pending publication, persists interrupted status and keeps source across server restart', async t => {
  const c = await setup(t)
  const path = await c.put('games', 'nes', 'shutdown.nes')
  const original = c.storage.adoption
  let stopping, entered
  const reached = new Promise(resolve => { entered = resolve })
  c.storage.adoption = async (...args) => {
    const file = await original(...args)
    stopping = c.app.close()
    entered()
    await delay(20)
    return file
  }
  const response = await c.post('', {})
  const id = response.json().job.id
  await reached; await stopping
  c.app = await createApp({ root: c.root, env: {} })
  assert.equal((await c.get('/' + id)).json().job.status, 'interrupted')
  assert.equal(c.app.database.prepare('SELECT COUNT(*) AS n FROM games').get().n, 0)
  assert.equal(await readFile(path, 'utf8'), 'shutdown.nes')
})

test('over-quota adoption keeps actual bytes visible and retention trims details without losing counters', async t => {
  const c = await setup(t)
  c.app.appConfig.catalogQuotaBytes = 1
  await c.put('games', 'nes', 'quota.nes', 'over-quota fixture')
  const scan = await c.scan()
  assert.equal(scan.job.added, 1)
  assert.equal(scan.job.physicalBytes, 'over-quota fixture'.length)
  assert.match(scan.job.usageWarning, /melewati kuota/)
  const oldId = randomUUID(), now = Date.now()
  c.db.prepare("INSERT INTO catalog_scans(id, actor, scope, status, token, lease_until, created_at, finished_at, discovered, processed, added) VALUES (?, ?, '{}', 'completed', 'old', 0, ?, ?, 1, 1, 1)").run(oldId, c.actor, now - 100000, now)
  c.db.prepare("INSERT INTO catalog_scan_results VALUES (?, 1, 'roms/nes/old.nes', 'added', 'fixture', NULL)").run(oldId)
  for (let n = 0; n < 21; n++) c.db.prepare("INSERT INTO catalog_scans(id, actor, scope, status, token, lease_until, created_at, finished_at) VALUES (?, ?, '{}', 'completed', 'retention', 0, ?, ?)").run(randomUUID(), c.actor, now + n, now)
  await c.get('/active')
  const retained = (await c.get('/' + oldId)).json().job
  assert.equal(retained.truncated, true); assert.equal(retained.added, 1)
  assert.equal((await c.get('/' + oldId + '/results')).json().total, 0)
})
