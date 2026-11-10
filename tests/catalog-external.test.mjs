import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase, schemaVersion } from '../server/database.mjs'
import { createApp } from '../server/app.mjs'
import { readConfig } from '../server/config.mjs'
import { csrfToken, hashToken } from '../server/auth/crypto.mjs'
import { createDataBackup, restoreDataBackup } from '../server/data-backup.mjs'
import { recoverCatalogStorage } from '../server/catalog/recovery.mjs'
import { backendFixture } from './helpers/backend-fixture.mjs'

async function setup(t, { writable = false } = {}) {
  const c = { app: null }
  c.root = await backendFixture(t, { beforeCleanup: () => c.app?.close() })
  c.roms = join(c.root, 'external-roms'); c.bios = join(c.root, 'external-bios')
  await mkdir(c.roms); await mkdir(c.bios)
  c.env = { MAIN_DULU_EXTERNAL_ROM_DIR: c.roms, MAIN_DULU_EXTERNAL_BIOS_DIR: c.bios }
  if (writable) c.env.MAIN_DULU_EXTERNAL_WRITABLE = 'true'
  c.start = async (extra = {}) => {
    c.app = await createApp({ root: c.root, env: { ...c.env, ...extra } })
    await c.app.catalog.worker.stop()
    c.db = c.app.database; c.storage = c.app.catalog.storage
    const adopt = c.storage.adoption.bind(c.storage)
    c.storage.adoption = (...args) => adopt(...args, 0)
  }
  await c.start()
  c.actor = randomUUID()
  c.db.prepare('INSERT INTO users (id, username, password_hash, recovery_code_hash, created_at, role) VALUES (?, ?, ?, ?, ?, ?)').run(c.actor, 'external_admin', 'fixture', 'fixture', Date.now(), 'admin')
  const token = 'c'.repeat(64)
  c.login = () => c.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(hashToken(token), c.actor, Date.now(), Date.now() + 600000)
  c.login()
  c.headers = { host: 'localhost:7777', origin: 'http://localhost:7777', cookie: `maindulu_session=${token}`, 'x-csrf-token': csrfToken(token) }
  c.upload = (kind, name, bytes, fields = {}) => {
    const boundary = 'shared-' + randomUUID(), chunks = []
    for (const [key, value] of Object.entries({ consoleId: 'nes', [kind === 'games' ? 'title' : 'name']: name, ...fields })) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`))
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${kind === 'games' ? 'rom' : 'bios'}"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--\r\n`))
    return c.app.inject({ method: 'POST', url: '/api/admin/' + kind, headers: { ...c.headers, 'content-type': 'multipart/form-data; boundary=' + boundary }, payload: Buffer.concat(chunks) })
  }
  c.put = async (kind, platform, name, content = name) => {
    const directory = join(kind === 'games' ? c.roms : c.bios, platform)
    await mkdir(directory, { recursive: true })
    const path = join(directory, name); await writeFile(path, content); return path
  }
  c.scan = async (payload = {}) => {
    const response = await c.app.inject({ method: 'POST', url: '/api/admin/catalog-scans', headers: c.headers, payload })
    assert.equal(response.statusCode, 202, response.body)
    const id = response.json().job.id
    for (let i = 0; i < 500; i++) {
      const job = c.db.prepare('SELECT * FROM catalog_scans WHERE id = ?').get(id)
      if (!['queued', 'running'].includes(job.status)) return { job, results: c.db.prepare('SELECT * FROM catalog_scan_results WHERE job_id = ? ORDER BY ordinal').all(id) }
      await delay(10)
    }
    assert.fail('External scan did not finish')
  }
  return c
}

test('external ROM/BIOS scan serves exact bytes without copying, preserves IDs on repeat/restart and exposes no absolute paths', async t => {
  const c = await setup(t)
  const rom = await c.put('games', 'nes', 'external.nes', 'external ROM')
  const bios = await c.put('bios', 'psx', 'boot.bin', 'external BIOS')
  for (const [platform, name] of [['snes', 'a.sfc'], ['gb', 'a.gb'], ['gbc', 'a.gbc'], ['gba', 'a.gba'], ['genesis', 'a.md'], ['psx', 'a.chd']]) await c.put('games', platform, name)
  const scan = await c.scan()
  assert.equal(scan.job.status, 'completed'); assert.equal(scan.job.added, 8)
  assert.equal(await c.storage.physicalUsage(), 0)
  assert.deepEqual(await readdir(join(c.app.appConfig.dataDir, 'roms')), [])
  assert.deepEqual(await readdir(join(c.app.appConfig.dataDir, 'bios')), [])
  const game = c.db.prepare("SELECT * FROM games WHERE original_name = 'external.nes'").get()
  assert.equal(await c.storage.pathFor('games', game.storage_key), rom)
  const list = await c.app.inject({ url: '/api/admin/games', headers: c.headers })
  assert.equal(list.json().items[0].storageMode, 'external')
  assert.equal(list.json().items[0].fileStatus, 'available')
  assert.ok(!list.body.includes(c.root)); assert.ok(!list.body.includes('source_root'))
  const sources = await c.app.inject({ url: '/api/admin/catalog-scans/sources', headers: c.headers })
  assert.deepEqual(sources.json(), { sources: { games: { mode: 'external' }, bios: { mode: 'external' } } })
  assert.equal((await c.app.inject({ url: '/api/admin/catalog-scans/sources' })).statusCode, 401)
  const url = `/games/${game.id}/rom/external.nes`
  const response = await c.app.inject({ url })
  assert.equal(response.body, 'external ROM'); assert.equal(response.headers.etag, `"${game.sha256}"`)
  assert.equal((await c.app.inject({ method: 'HEAD', url })).statusCode, 200)
  assert.equal((await c.app.inject({ url, headers: { 'if-none-match': response.headers.etag } })).statusCode, 304)
  const firmware = c.db.prepare('SELECT * FROM bios').get()
  assert.equal((await c.app.inject({ url: `/bios/${firmware.id}/boot.bin` })).body, 'external BIOS')
  assert.equal((await c.scan()).job.skipped, 8)
  await c.app.close(); await c.start()
  assert.equal(c.db.prepare("SELECT id FROM games WHERE original_name = 'external.nes'").get().id, game.id)
  assert.equal((await c.app.inject({ url })).body, 'external ROM')
  assert.equal(await readFile(bios, 'utf8'), 'external BIOS')
})

test('external source cannot be deleted by API, cleanup or recovery; uploads and metadata remain internal', async t => {
  const c = await setup(t)
  const path = await c.put('games', 'nes', 'protected.nes', 'protected')
  await c.scan()
  const game = c.db.prepare('SELECT * FROM games').get()
  const response = await c.app.inject({ method: 'DELETE', url: `/api/admin/games/${game.id}`, headers: c.headers, payload: {} })
  assert.equal(response.statusCode, 409); assert.equal(response.json().code, 'EXTERNAL_READ_ONLY')
  await c.storage.remove('games', game.storage_key)
  await c.storage.removeUnreferenced('games', game.storage_key)
  c.db.prepare('INSERT INTO catalog_cleanup(folder, storage_key) VALUES (?, ?)').run('games', game.storage_key)
  await c.app.catalog.maintenance.cleanup()
  assert.equal(await readFile(path, 'utf8'), 'protected')
  const stage = await c.storage.stage('games', Readable.from([Buffer.from('uploaded')]))
  const uploaded = await c.app.catalog.repository.publish('games', c.actor, { title: '', consoleId: 'nes', fileName: 'upload.nes' }, stage, { scanMetadata: false })
  assert.equal(c.storage.isExternal('games', uploaded.storage_key), false)
  assert.equal(await readFile(join(c.app.appConfig.dataDir, 'roms/nes/upload.nes'), 'utf8'), 'uploaded')
  await c.app.catalog.repository.update('games', c.actor, game.id, { title: 'Edited locally' })
  assert.equal(await readFile(path, 'utf8'), 'protected')
  const config = c.app.appConfig
  await c.app.close(); c.app = null
  const report = await recoverCatalogStorage(config, { remove: true })
  assert.equal(report.damaged.length, 0)
  assert.equal(await readFile(path, 'utf8'), 'protected')
})

test('external changes never receive stale ETags; same bytes can refresh and missing/renamed files retain ID/metadata', async t => {
  const c = await setup(t)
  const path = await c.put('games', 'nes', 'original.nes', 'original')
  await c.scan()
  const game = c.db.prepare('SELECT * FROM games').get()
  await c.app.catalog.repository.update('games', c.actor, game.id, { title: 'Keep title' })
  const jobs = c.db.prepare('SELECT * FROM metadata_jobs').all()
  const url = `/games/${game.id}/rom/original.nes`
  // Same size, different bytes: reject BEFORE conditional 304 handling.
  await writeFile(path, 'modified')
  await utimes(path, new Date(100000), new Date(100000))
  const invalid = await c.app.inject({ url, headers: { 'if-none-match': `"${game.sha256}"` } })
  assert.equal(invalid.statusCode, 503); assert.equal(invalid.headers.etag, undefined)
  assert.equal((await c.scan()).results[0].status, 'conflict')
  await writeFile(path, 'original')
  assert.equal((await c.scan()).job.skipped, 1)
  assert.equal((await c.app.inject({ url })).body, 'original')
  await rename(path, join(c.roms, 'nes/renamed.nes'))
  assert.equal((await c.app.inject({ url })).statusCode, 404)
  const missing = (await c.app.inject({ url: '/api/admin/games', headers: c.headers })).json().items[0]
  assert.equal(missing.fileStatus, 'missing')
  assert.equal((await c.scan()).job.skipped, 1)
  const renamed = c.db.prepare('SELECT * FROM games').get()
  assert.equal(renamed.id, game.id); assert.equal(renamed.title, 'Keep title'); assert.equal(renamed.original_name, 'renamed.nes')
  assert.deepEqual(c.db.prepare('SELECT * FROM metadata_jobs').all(), jobs)
  assert.equal((await c.app.inject({ url: `/games/${game.id}/rom/renamed.nes` })).body, 'original')
  await unlink(join(c.roms, 'nes/renamed.nes'))
  await c.scan()
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM games WHERE deleted_at IS NULL').get().n, 1)
})

test('external backup excludes source paths/files; rescan after restore reconnects exact bytes to old IDs', async t => {
  const c = await setup(t)
  const path = await c.put('games', 'nes', 'backup.nes', 'external backup')
  await c.scan()
  const before = c.db.prepare('SELECT * FROM games').get(), config = c.app.appConfig
  await c.app.close(); c.app = null
  const target = join(c.root, 'backup'), restored = join(c.root, 'restored')
  const manifest = await createDataBackup(config, target)
  assert.equal(manifest.counts.catalog_external_files, 0)
  const snapshot = new DatabaseSync(join(target, 'maindulu.sqlite'))
  try { assert.equal(snapshot.prepare('SELECT COUNT(*) AS n FROM catalog_external_files').get().n, 0) } finally { snapshot.close() }
  await restoreDataBackup(config, target, restored)
  await c.start({ MAIN_DULU_DATA_DIR: restored }); c.login()
  assert.equal((await c.scan()).job.skipped, 1)
  assert.equal(c.db.prepare('SELECT id FROM games').get().id, before.id)
  assert.equal(await readFile(path, 'utf8'), 'external backup')
})

test('external roots reject unsafe/overlapping paths and do not create missing sources', async t => {
  const c = await setup(t)
  for (const path of ['', 'relative', c.root, join(c.root, 'data'), join(c.root, 'dist/roms'), c.bios]) {
    await assert.rejects(readConfig({ ...c.env, MAIN_DULU_EXTERNAL_ROM_DIR: path }, c.root))
  }
  await assert.rejects(createApp({ root: c.root, env: { MAIN_DULU_EXTERNAL_ROM_DIR: join(c.root, 'absent') } }))
  await assert.rejects(readFile(join(c.root, 'absent')), { code: 'ENOENT' })
  await assert.rejects(createDataBackup(c.app.appConfig, join(c.roms, 'backup')), /sumber eksternal/)
})

test('external symlinks and nested directories are not followed', async t => {
  const c = await setup(t)
  const path = await c.put('games', 'nes', 'safe.nes', 'safe')
  await mkdir(join(c.roms, 'nes/nested'))
  await writeFile(join(c.roms, 'nes/nested/hidden.nes'), 'hidden')
  let linked = false
  try { await symlink(path, join(c.roms, 'nes/link.nes')); linked = true }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error }
  const scan = await c.scan()
  assert.equal(scan.job.added, 1)
  assert.equal(scan.results.find(row => row.path.endsWith('/nested')).status, 'invalid')
  if (linked) assert.equal(scan.results.find(row => row.path.endsWith('/link.nes')).status, 'unsafe')
})

test('schema-16 catalogs migrate without changing existing games or account/session identity', async t => {
  const c = await setup(t)
  const stage = await c.storage.stage('games', Readable.from([Buffer.from('existing upload')]))
  const row = await c.app.catalog.repository.publish('games', c.actor, { title: 'Existing', consoleId: 'nes', fileName: 'existing.nes' }, stage, { scanMetadata: false })
  const config = c.app.appConfig
  await c.app.close(); c.app = null
  const old = new DatabaseSync(join(config.dataDir, 'maindulu.sqlite'))
  old.exec('ALTER TABLE metadata_jobs DROP COLUMN cancel_requested; DROP TABLE catalog_external_files; DELETE FROM schema_migrations WHERE version > 16; PRAGMA user_version = 16;')
  old.close()
  await c.start()
  assert.equal(c.db.prepare('PRAGMA user_version').get().user_version, schemaVersion)
  assert.deepEqual(c.db.prepare('SELECT * FROM games').get(), row)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1)
  assert.equal((await c.app.inject({ url: `/games/${row.id}/rom/existing.nes` })).body, 'existing upload')
})

test('schema-16 metadata backups still verify and restore before migration', async t => {
  const c = await setup(t)
  await c.put('games', 'nes', 'legacy.nes', 'legacy')
  await c.scan()
  const config = c.app.appConfig, id = c.db.prepare('SELECT id FROM games').get().id
  await c.app.close(); c.app = null
  const target = join(c.root, 'backup16')
  const manifest = await createDataBackup(config, target)
  const path = join(target, 'maindulu.sqlite'), snapshot = new DatabaseSync(path)
  snapshot.exec('ALTER TABLE metadata_jobs DROP COLUMN cancel_requested; DROP TABLE catalog_external_files; DELETE FROM schema_migrations WHERE version > 16; PRAGMA user_version = 16;')
  snapshot.close()
  const bytes = await readFile(path)
  manifest.schemaVersion = 16; delete manifest.counts.catalog_external_files
  Object.assign(manifest.files.find(file => file.path === 'maindulu.sqlite'), { size: bytes.length, checksum: createHash('sha256').update(bytes).digest('hex') })
  await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest))
  const restored = join(c.root, 'restore16')
  await restoreDataBackup(config, target, restored)
  const db = await openDatabase(restored)
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, schemaVersion)
    assert.equal(db.prepare('SELECT id FROM games').get().id, id)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0)
  } finally { db.close() }
})

test('shared uploads and scans use the SAME ROM/BIOS folders; deleting either removes the physical source', async t => {
  const c = await setup(t, { writable: true })
  const scannedPath = await c.put('games', 'nes', 'romm.nes', 'from RomM')
  assert.equal((await c.scan()).job.added, 1)
  const scanned = c.db.prepare('SELECT * FROM games').get()
  for (const [kind, name, bytes] of [['games', 'upload.nes', 'shared ROM'], ['bios', 'boot.bin', 'shared BIOS']]) {
    const response = await c.upload(kind, name, bytes)
    assert.equal(response.statusCode, 201, response.body)
    const row = response.json().item
    const path = join(kind === 'games' ? c.roms : c.bios, 'nes', name)
    assert.equal(await readFile(path, 'utf8'), bytes)
    assert.equal((await c.app.inject({ url: row.url })).body, bytes)
    const admin = (await c.app.inject({ url: '/api/admin/' + kind, headers: c.headers })).json()
    assert.equal(admin.items.find(item => item.id === row.id).storageMode, 'shared')
    assert.equal((await c.app.inject({ method: 'DELETE', url: `/api/admin/${kind}/${row.id}`, headers: c.headers, payload: {} })).statusCode, 200)
    await c.app.catalog.maintenance.cleanup()
    await assert.rejects(readFile(path), { code: 'ENOENT' })
    assert.equal((await c.app.inject({ url: row.url })).statusCode, 404)
  }
  const sources = (await c.app.inject({ url: '/api/admin/catalog-scans/sources', headers: c.headers })).json()
  assert.equal(sources.sources.games.mode, 'shared'); assert.equal(sources.sources.bios.mode, 'shared')
  assert.deepEqual(await readdir(join(c.app.appConfig.dataDir, 'roms')), [])
  assert.deepEqual(await readdir(join(c.app.appConfig.dataDir, 'bios')), [])
  assert.equal((await c.app.inject({ method: 'DELETE', url: `/api/admin/games/${scanned.id}`, headers: c.headers, payload: {} })).statusCode, 200)
  await c.app.catalog.maintenance.cleanup()
  await assert.rejects(readFile(scannedPath), { code: 'ENOENT' })
})

test('RomM deletion is immediately unavailable to GET/HEAD, while missing IDs and user data survive scan/restart', async t => {
  const c = await setup(t, { writable: true })
  const response = await c.upload('games', 'delete-in-romm.nes', 'ROM to delete')
  assert.equal(response.statusCode, 201, response.body)
  const game = response.json().item
  await unlink(join(c.roms, 'nes/delete-in-romm.nes'))
  for (const method of ['GET', 'HEAD']) assert.equal((await c.app.inject({ method, url: game.url })).statusCode, 404)
  assert.equal((await c.app.inject({ url: '/api/admin/games', headers: c.headers })).json().items[0].fileStatus, 'missing')
  await c.scan()
  await c.app.close(); await c.start()
  assert.equal(c.db.prepare('SELECT id FROM games WHERE deleted_at IS NULL').get().id, game.id)
  assert.equal(c.db.prepare('SELECT id FROM users').get().id, c.actor)
  // Byte-identical reupload into the same folder explicitly restores the ID.
  const repair = await c.upload('games', 'delete-in-romm.nes', 'ROM to delete', { restoreId: game.id })
  assert.equal(repair.statusCode, 200, repair.body)
  assert.equal(repair.json().item.id, game.id)
})

test('shared uploads cannot overwrite unindexed files, case aliases, indexed names or duplicate contents', async t => {
  const c = await setup(t, { writable: true })
  const path = await c.put('games', 'nes', 'Existing.nes', 'original bytes')
  for (const name of ['Existing.nes', 'existing.nes']) {
    const response = await c.upload('games', name, 'different bytes')
    assert.equal(response.statusCode, 409, response.body)
    assert.equal(response.json().code, 'CATALOG_FILENAME_CONFLICT')
  }
  await c.scan()
  const duplicate = await c.upload('games', 'another.nes', 'original bytes')
  assert.equal(duplicate.statusCode, 409); assert.equal(duplicate.json().code, 'CATALOG_DUPLICATE')
  assert.equal((await c.upload('games', 'Existing.nes', 'different bytes')).statusCode, 409)
  assert.equal(await readFile(path, 'utf8'), 'original bytes')
  assert.deepEqual(await readdir(join(c.roms, 'nes')), ['Existing.nes'])
  assert.deepEqual(await c.storage.entries('uploads'), [])
})

test('shared cleanup retries without deleting RomM replacements; stale tokens cannot delete a newer owner', async t => {
  const c = await setup(t, { writable: true })
  const path = await c.put('games', 'nes', 'reuse.nes', 'old content')
  await c.scan()
  const old = c.db.prepare('SELECT * FROM games').get()
  c.app.catalog.repository.delete('games', c.actor, old.id)
  await writeFile(path, 'replacement from RomM')
  await c.app.catalog.maintenance.cleanup()
  assert.equal(await readFile(path, 'utf8'), 'replacement from RomM')
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM catalog_cleanup').get().n, 1)
  await unlink(path)
  await c.storage.removeUnreferenced('games', old.storage_key)
  await c.put('games', 'nes', 'reuse.nes', 'new owner bytes')
  await c.scan()
  const current = c.db.prepare('SELECT * FROM games WHERE deleted_at IS NULL').get()
  assert.notEqual(current.id, old.id)
  await c.storage.remove('games', old.storage_key)
  assert.equal(await readFile(path, 'utf8'), 'new owner bytes')
})

test('shared adoption failure, cancellation and publication failure never erase unowned sources', async t => {
  const c = await setup(t, { writable: true })
  const path = await c.put('games', 'nes', 'manual.nes', 'manual source')
  const { createCatalogRepository } = await import('../server/catalog/repository.mjs')
  const repo = createCatalogRepository(c.db, c.storage, { onPublished: () => { throw new Error('controlled publication failure') } })
  const candidate = await c.storage.adoption('games', 'nes', 'manual.nes', () => {})
  await assert.rejects(repo.adopt('games', c.actor, { title: '', consoleId: 'nes', fileName: 'manual.nes' }, candidate), /controlled publication/)
  assert.equal(await readFile(path, 'utf8'), 'manual source')
  const stage = await c.storage.stage('games', Readable.from([Buffer.alloc(2 * 1024 * 1024, 1)]))
  let calls = 0
  await assert.rejects(c.storage.promote(stage, { consoleId: 'nes', fileName: 'cancelled.nes', check: () => { if (++calls === 3) throw new Error('controlled cancel') } }), /controlled cancel/)
  await assert.rejects(readFile(join(c.roms, 'nes/cancelled.nes')), { code: 'ENOENT' })
  const failing = await c.storage.stage('games', Readable.from([Buffer.from('owned upload')]))
  await assert.rejects(repo.publish('games', c.actor, { title: '', consoleId: 'nes', fileName: 'failed.nes' }, failing), /controlled publication/)
  const orphan = c.db.prepare("SELECT storage_key FROM catalog_external_files WHERE file_name = 'failed.nes'").get()
  await c.storage.removeUnreferenced('games', orphan.storage_key)
  await assert.rejects(readFile(join(c.roms, 'nes/failed.nes')), { code: 'ENOENT' })
  assert.equal(await readFile(path, 'utf8'), 'manual source')
})

test('shared quota includes source bytes and enforces admission without modifying the collection', async t => {
  const c = await setup(t, { writable: true })
  const path = await c.put('games', 'nes', 'quota.nes', 'count external bytes')
  assert.equal(await c.storage.physicalUsage(), 'count external bytes'.length)
  assert.deepEqual(c.storage.capacityRoots('games'), [c.app.appConfig.dataDir, c.roms])
  c.app.appConfig.catalogQuotaBytes = 1
  const response = await c.upload('games', 'rejected.nes', 'new bytes')
  assert.equal(response.statusCode, 507, response.body)
  assert.equal(await readFile(path, 'utf8'), 'count external bytes')
  assert.deepEqual(await readdir(join(c.roms, 'nes')), ['quota.nes'])
})

test('shared deletion rejects guests/CSRF and does not grant deletion through an abandoned scan', async t => {
  const c = await setup(t, { writable: true })
  const path = await c.put('games', 'nes', 'guard.nes', 'guarded shared source')
  await c.scan()
  const row = c.db.prepare('SELECT * FROM games').get()
  for (const headers of [{}, { ...c.headers, 'x-csrf-token': 'wrong' }]) {
    const result = await c.app.inject({ method: 'DELETE', url: `/api/admin/games/${row.id}`, headers, payload: {} })
    assert.ok([401, 403].includes(result.statusCode), result.body)
  }
  assert.equal(c.db.prepare('SELECT delete_intent FROM catalog_external_files').get().delete_intent, 'none')
  // Even orphan/recovery cleanup cannot turn mere scan ownership into unlink.
  c.db.prepare('UPDATE games SET deleted_at = ? WHERE id = ?').run(Date.now(), row.id)
  await c.storage.removeUnreferenced('games', row.storage_key)
  assert.equal(await readFile(path, 'utf8'), 'guarded shared source')
})

test('shared delete retries across restart, backup/restore reattaches old IDs, and readonly downgrade cannot unlink pending files', async t => {
  const c = await setup(t, { writable: true })
  const path = await c.put('games', 'nes', 'restart.nes', 'shared restart')
  await c.scan()
  const row = c.db.prepare('SELECT * FROM games').get()
  const config = c.app.appConfig
  await c.app.close(); c.app = null
  const target = join(c.root, 'shared-backup'), restored = join(c.root, 'shared-restore')
  await createDataBackup(config, target)
  await restoreDataBackup(config, target, restored)
  await c.start({ MAIN_DULU_DATA_DIR: restored }); c.login()
  assert.equal((await c.scan()).job.skipped, 1)
  assert.equal(c.db.prepare('SELECT id FROM games').get().id, row.id)
  c.app.catalog.repository.delete('games', c.actor, row.id)
  await c.app.close(); await c.start({ MAIN_DULU_DATA_DIR: restored, MAIN_DULU_EXTERNAL_WRITABLE: 'false' })
  await assert.rejects(c.storage.removeUnreferenced('games', c.db.prepare('SELECT storage_key FROM games').get().storage_key), error => error.code === 'EXTERNAL_READ_ONLY')
  assert.equal(await readFile(path, 'utf8'), 'shared restart')
  await c.app.close(); await c.start({ MAIN_DULU_DATA_DIR: restored })
  c.db.exec('UPDATE catalog_cleanup SET next_at = 0')
  await c.app.catalog.maintenance.cleanup()
  await assert.rejects(readFile(path), { code: 'ENOENT' })
})

// Reconstruct the actual v17 mapping shape, rather than relabel a v18 database.
function schema17(db) {
  db.exec(`ALTER TABLE metadata_jobs DROP COLUMN cancel_requested; CREATE TABLE external_v17 (
    storage_key TEXT PRIMARY KEY, folder TEXT NOT NULL CHECK(folder IN ('games', 'bios')), source_root TEXT NOT NULL,
    platform TEXT NOT NULL CHECK(platform IN ('nes', 'snes', 'gb', 'gbc', 'gba', 'genesis', 'psx')),
    file_name TEXT NOT NULL, name_identity TEXT NOT NULL, size INTEGER NOT NULL CHECK(size > 0), sha256 TEXT NOT NULL,
    mtime_ms REAL NOT NULL, ctime_ms REAL NOT NULL, UNIQUE(folder, source_root, platform, name_identity)
  ) STRICT;
  INSERT INTO external_v17 SELECT storage_key, folder, source_root, platform, file_name, name_identity, size, sha256, mtime_ms, ctime_ms FROM catalog_external_files;
  DROP TABLE catalog_external_files; ALTER TABLE external_v17 RENAME TO catalog_external_files;
  DELETE FROM schema_migrations WHERE version > 17; PRAGMA user_version = 17;`)
}

test('schema-17 readonly mappings migrate without touching sources and writable mode explicitly enables deletion', async t => {
  const c = await setup(t)
  const path = await c.put('games', 'nes', 'v17.nes', 'v17 source')
  await c.scan()
  const row = c.db.prepare('SELECT * FROM games').get(), data = c.app.appConfig.dataDir
  await c.app.close(); c.app = null
  const old = new DatabaseSync(join(data, 'maindulu.sqlite'))
  schema17(old); old.close()
  await c.start()
  assert.deepEqual(c.db.prepare('SELECT * FROM games').get(), row)
  assert.equal(c.db.prepare('SELECT delete_intent FROM catalog_external_files').get().delete_intent, 'none')
  assert.equal(c.storage.storageMode('games', row.storage_key), 'external')
  assert.throws(() => c.app.catalog.repository.delete('games', c.actor, row.id), error => error.code === 'EXTERNAL_READ_ONLY')
  await c.app.close(); await c.start({ MAIN_DULU_EXTERNAL_WRITABLE: 'true' })
  c.app.catalog.repository.delete('games', c.actor, row.id)
  await c.app.catalog.maintenance.cleanup()
  await assert.rejects(readFile(path), { code: 'ENOENT' })
})

test('schema-17 backups verify/restore before migration and shared opt-in validation is strict', async t => {
  const c = await setup(t)
  const config = c.app.appConfig
  for (const value of ['', '1', 'yes']) await assert.rejects(readConfig({ ...c.env, MAIN_DULU_EXTERNAL_WRITABLE: value }, c.root), /true atau false/)
  await assert.rejects(readConfig({ MAIN_DULU_EXTERNAL_WRITABLE: 'true' }, c.root), /memerlukan/)
  await c.app.close(); c.app = null
  const target = join(c.root, 'backup17'), restored = join(c.root, 'restored17')
  const manifest = await createDataBackup(config, target)
  const path = join(target, 'maindulu.sqlite'), db = new DatabaseSync(path)
  schema17(db); db.close()
  const bytes = await readFile(path)
  manifest.schemaVersion = 17
  Object.assign(manifest.files.find(file => file.path === 'maindulu.sqlite'), { size: bytes.length, checksum: createHash('sha256').update(bytes).digest('hex') })
  await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest))
  await restoreDataBackup(config, target, restored)
  const check = await openDatabase(restored)
  try { assert.equal(check.prepare('PRAGMA user_version').get().user_version, schemaVersion) } finally { check.close() }
})

test('shared uploads reserve a path across connections and offline recovery preserves unrelated sources', async t => {
  const c = await setup(t, { writable: true })
  const other = await createApp({ root: c.root, env: c.env })
  try {
    const one = await c.storage.stage('games', Readable.from([Buffer.from('first shared upload')]))
    const two = await other.catalog.storage.stage('games', Readable.from([Buffer.from('second shared upload')]))
    const results = await Promise.allSettled([
      c.app.catalog.repository.publish('games', c.actor, { title: '', consoleId: 'nes', fileName: 'race.nes' }, one),
      other.catalog.repository.publish('games', c.actor, { title: '', consoleId: 'nes', fileName: 'race.nes' }, two),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'CATALOG_FILENAME_CONFLICT')
    const row = c.db.prepare('SELECT * FROM games WHERE deleted_at IS NULL').get()
    assert.equal(createHash('sha256').update(await readFile(join(c.roms, 'nes/race.nes'))).digest('hex'), row.sha256)
  } finally { await other.close() }
  const unknown = await c.put('games', 'nes', 'unindexed.nes', 'operator source')
  const config = c.app.appConfig
  await c.app.close(); c.app = null
  const report = await recoverCatalogStorage(config, { remove: true })
  assert.ok(report.unknown.some(row => row.key.includes('unindexed.nes')))
  assert.equal(await readFile(unknown, 'utf8'), 'operator source')
})
