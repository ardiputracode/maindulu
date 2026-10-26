import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase, schemaVersion } from '../server/database.mjs'
import { readConfig } from '../server/config.mjs'
import { createApp } from '../server/app.mjs'
import { createCatalogStorage, catalogLimits, storageKeyPattern } from '../server/catalog/storage.mjs'
import { createCatalogRepository, safeOriginalName } from '../server/catalog/repository.mjs'
import { recoverCatalogStorage } from '../server/catalog/recovery.mjs'
import { backendFixture } from './helpers/backend-fixture.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const bytes = Buffer.from('synthetic catalog bytes, not a playable ROM or BIOS')
const metadata = (kind = 'games', extra = {}) => ({ [kind === 'games' ? 'title' : 'name']: 'Katalog uji', consoleId: 'nes', fileName: kind === 'games' ? 'contoh.nes' : 'disksys.rom', ...extra })
async function setup(t) {
  const c = { db: null }
  c.root = await backendFixture(t, { beforeCleanup: () => { if (c.db?.isOpen) c.db.close() } })
  c.config = await readConfig({ MAIN_DULU_DATA_DIR: 'private-data' }, c.root)
  c.db = await openDatabase(c.config.dataDir)
  c.actor = randomUUID()
  c.db.prepare('INSERT INTO users (id, username, password_hash, recovery_code_hash, created_at, role) VALUES (?, ?, ?, ?, ?, ?)').run(c.actor, 'catalog_admin', 'test-only', 'test-only', Date.now(), 'admin')
  c.storage = await createCatalogStorage(c.config)
  c.repo = createCatalogRepository(c.db, c.storage)
  c.stage = (kind = 'games', data = bytes) => c.storage.stage(kind, Readable.from([data]))
  c.publish = async (kind = 'games', data = bytes, v = {}, options) => c.repo.publish(kind, c.actor, metadata(kind, v), await c.stage(kind, data), options)
  c.close = () => { c.db.close(); c.db = null }
  return c
}

test('catalog migration from schema 7 preserves accounts, roles, sessions and every save table', async t => {
  const c = await setup(t)
  c.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('test-token', c.actor, 1, Date.now() + 100000)
  c.db.prepare('INSERT INTO saves VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), c.actor, 'old-server-game', 'nes', 'fceumm', 1, 'old title', '{}', 2, 0, 'a'.repeat(64), null, 3)
  c.db.prepare('INSERT INTO game_saves VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), c.actor, 'local-nes-' + 'b'.repeat(64), 'nes', 'fceumm', 'old local', '{}', 1, 0, 'a'.repeat(64), null, 3)
  c.db.prepare('INSERT INTO save_backups VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), c.actor, 'state', 'old-server-game', 'nes', 'fceumm', 1, 'old', '{}', 1, 30, 'a'.repeat(64), randomUUID() + '.bin', 'import', 3)
  c.db.prepare('INSERT INTO save_decisions VALUES (?, ?, ?, ?)').run(c.actor, 'decision', 'fingerprint', '{}')
  const tables = ['users', 'sessions', 'saves', 'game_saves', 'save_backups', 'save_decisions', 'app_metadata']
  const before = Object.fromEntries(tables.map(name => [name, c.db.prepare(`SELECT * FROM ${name}`).all()]))
  c.db.exec('DROP TABLE games; DROP TABLE bios; DELETE FROM schema_migrations WHERE version = 8; PRAGMA user_version = 7;')
  c.close()
  c.db = await openDatabase(c.config.dataDir)
  assert.equal(schemaVersion, 8)
  assert.equal(c.db.prepare('PRAGMA user_version').get().user_version, 8)
  for (const name of tables) assert.deepEqual(c.db.prepare(`SELECT * FROM ${name}`).all(), before[name], name)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM games').get().n, 0)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM bios').get().n, 0)
})

test('failed catalog migration rolls back new tables and schema version without changing old accounts', async t => {
  const c = await setup(t)
  const before = c.db.prepare('SELECT * FROM users').get()
  c.db.exec("DROP TABLE games; DROP TABLE bios; DELETE FROM schema_migrations WHERE version = 8; PRAGMA user_version = 7; CREATE TABLE bios (marker TEXT); INSERT INTO bios VALUES ('operator-owned');")
  c.close()
  await assert.rejects(openDatabase(c.config.dataDir), /already exists/)
  const check = new DatabaseSync(join(c.config.dataDir, 'maindulu.sqlite'))
  try {
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 7)
    assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name = 'games'").get(), undefined)
    assert.equal(check.prepare('SELECT marker FROM bios').get().marker, 'operator-owned')
    assert.deepEqual(check.prepare('SELECT * FROM users').get(), before)
    check.exec('DROP TABLE bios') // Only the deliberate collision in this disposable fixture.
  } finally { check.close() }
  c.db = await openDatabase(c.config.dataDir)
  assert.equal(c.db.prepare('PRAGMA user_version').get().user_version, 8)
})

test('game IDs and immutable bytes survive metadata/cover edits, deletion, restart and build removal', async t => {
  const c = await setup(t)
  const cover = { stage: await c.stage('covers', Buffer.from('trusted internal raster fixture')), type: 'image/png' }
  const row = await c.publish('games', bytes, { description: 'Awal', license: 'Fixture sintetis' }, { cover })
  assert.match(row.storage_key, storageKeyPattern)
  assert.notEqual(row.id, digest(bytes))
  assert.equal(row.sha256, digest(bytes))
  assert.equal(row.original_name, 'contoh.nes')
  assert.equal(row.created_by, c.actor)
  assert.equal(row.cover_sha256, cover.stage.sha256)
  c.db.prepare('INSERT INTO saves VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), c.actor, row.id, 'nes', 'fceumm', 1, 'save title', '{}', 1, 0, digest(bytes), null, 1)
  const saved = c.db.prepare('SELECT * FROM saves').get()
  const changed = await c.repo.update('games', c.actor, row.id, { title: 'Judul baru', description: 'Baru' }, { cover: null })
  for (const key of ['id', 'sha256', 'storage_key', 'size', 'console_id', 'created_at', 'created_by']) assert.equal(changed[key], row[key], key)
  assert.equal(changed.title, 'Judul baru')
  assert.equal(changed.cover_storage_key, null)
  const replaced = await c.repo.update('games', c.actor, row.id, {}, { cover: { stage: await c.stage('covers', Buffer.from('replacement raster')), type: 'image/webp' } })
  assert.equal(replaced.id, row.id)
  assert.equal(replaced.cover_type, 'image/webp')
  c.close()
  await rm(join(c.root, 'dist'), { recursive: true }) // Only this test's disposable build fixture.
  c.db = await openDatabase(c.config.dataDir)
  c.repo = createCatalogRepository(c.db, await createCatalogStorage(c.config))
  assert.equal(c.repo.get('games', row.id).title, 'Judul baru')
  await c.storage.verify('games', { key: row.storage_key, size: row.size, sha256: row.sha256 })
  c.repo.delete('games', c.actor, row.id)
  assert.equal(c.repo.get('games', row.id), null)
  assert.equal(c.repo.list('games').length, 0)
  assert.notEqual(c.repo.get('games', row.id, { includeDeleted: true }).deleted_at, null)
  assert.deepEqual(c.db.prepare('SELECT * FROM saves').get(), saved)
  assert.deepEqual(await readFile(join(c.config.dataDir, 'games', row.storage_key)), bytes)
})

test('duplicates are separate by console and kind; tombstones require explicit same-ID restoration', async t => {
  const c = await setup(t)
  const game = await c.publish()
  for (const kind of ['games', 'bios']) {
    if (kind === 'bios') await c.publish(kind)
    await assert.rejects(c.publish(kind), error => error.code === 'CATALOG_DUPLICATE')
    await c.publish(kind, bytes, { consoleId: 'snes' })
  }
  await c.publish('bios', Buffer.from('second firmware option'))
  assert.equal(c.repo.list('bios').filter(row => row.console_id === 'nes').length, 2)
  c.repo.delete('games', c.actor, game.id)
  await assert.rejects(c.publish(), error => error.code === 'CATALOG_RESTORE_REQUIRED' && error.id === game.id)
  await assert.rejects(c.publish('games', bytes, {}, { restoreId: randomUUID() }), error => error.code === 'CATALOG_RESTORE_REQUIRED')
  await assert.rejects(c.publish('games', Buffer.from('different byte identity'), {}, { restoreId: game.id }), error => error.code === 'INVALID_CATALOG')
  const restored = await c.publish('games', bytes, {}, { restoreId: game.id })
  assert.equal(restored.id, game.id)
  assert.equal(restored.sha256, game.sha256)
  assert.equal(restored.created_at, game.created_at)
  assert.notEqual(restored.storage_key, game.storage_key)
  assert.equal(restored.deleted_at, null)
})

test('catalog mutations validate metadata, immutable fields, SQL constraints and latest admin role', async t => {
  const c = await setup(t)
  const stage = await c.stage()
  for (const extra of [{ title: '' }, { title: 'x'.repeat(201) }, { consoleId: 'other' }, { description: 'x'.repeat(10001) }, { license: 'x'.repeat(2001) }, { role: 'admin' }, { createdBy: c.actor }, { storage_key: '../db' }, { fileName: '../firmware.bin' }]) {
    await assert.rejects(c.repo.publish('games', c.actor, metadata('games', extra), stage), error => error.code === 'INVALID_CATALOG')
  }
  const row = await c.repo.publish('games', c.actor, metadata(), stage)
  for (const patch of [{ id: randomUUID() }, { sha256: 'b'.repeat(64) }, { consoleId: 'snes' }, { fileName: 'changed.nes' }, { storageKey: 'other' }]) await assert.rejects(c.repo.update('games', c.actor, row.id, patch), error => error.code === 'INVALID_CATALOG')
  for (const sql of ["UPDATE games SET size = 0", "UPDATE games SET size = 805306369", "UPDATE games SET sha256 = 'invalid'", "UPDATE games SET cover_type = 'image/png'", "UPDATE games SET console_id = 'other'"]) assert.throws(() => c.db.exec(sql))
  assert.throws(() => c.db.prepare(`INSERT INTO games (id, title, console_id, original_name, storage_key, size, sha256, created_at, updated_at)
    SELECT ?, title, console_id, original_name, ?, size, sha256, created_at, updated_at FROM games WHERE id = ?`).run(randomUUID(), randomUUID() + '.bin', row.id), /UNIQUE/)
  c.db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(c.actor)
  await assert.rejects(c.publish('games', Buffer.from('denied')), error => error.code === 'ADMIN_REQUIRED')
  await assert.rejects(c.repo.update('games', c.actor, row.id, { title: 'denied' }), error => error.code === 'ADMIN_REQUIRED')
  assert.throws(() => c.repo.delete('games', c.actor, row.id), error => error.code === 'ADMIN_REQUIRED')
  assert.notEqual(c.repo.get('games', row.id), null)
})

test('deleting a creator account does not cascade into either catalog', async t => {
  const c = await setup(t)
  const game = await c.publish()
  const bios = await c.publish('bios')
  c.db.prepare('DELETE FROM users WHERE id = ?').run(c.actor)
  for (const [kind, row] of [['games', game], ['bios', bios]]) {
    assert.equal(c.repo.get(kind, row.id).created_by, null)
    assert.equal(c.repo.get(kind, row.id).deleted_at, null)
  }
})

test('role revocation during promotion cannot publish an active row', async t => {
  const c = await setup(t)
  const promote = c.storage.promote.bind(c.storage)
  c.storage.promote = async stage => {
    const file = await promote(stage)
    c.db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(c.actor)
    return file
  }
  await assert.rejects(c.publish(), error => error.code === 'ADMIN_REQUIRED')
  assert.equal(c.repo.list('games').length, 0)
  assert.equal((await c.storage.entries('games')).length, 1) // Safe orphan, no broken active entry.
})

test('firmware names stay metadata, never paths; unsafe and reserved basenames are rejected', async t => {
  const c = await setup(t)
  for (const name of ['disksys.rom', 'SCPH1001.bin', 'firmware archive.zip', 'boot.7z', 'boot.rar']) assert.equal(safeOriginalName(name), name)
  for (const name of ['', '.', '..', '../save.bin', 'a\\b.bin', '/etc/passwd', 'C:boot.bin', 'boot.bin\n', 'NUL.bin', 'com1', 'boot.bin.', ' boot.bin']) assert.throws(() => safeOriginalName(name))
  const bios = await c.publish('bios', bytes, { fileName: 'SCPH1001.bin' })
  assert.equal(bios.original_name, 'SCPH1001.bin')
  assert.match(bios.storage_key, storageKeyPattern)
  assert.equal((await readdir(join(c.config.dataDir, 'bios'))).includes('SCPH1001.bin'), false)
})

test('storage hashes exact stream bytes and rejects empty, interrupted, excessive and forged uploads', async t => {
  const c = await setup(t)
  async function* chunks() { yield bytes.subarray(0, 7); yield bytes.subarray(7) }
  const staged = await c.storage.stage('bios', chunks())
  assert.equal(staged.sha256, digest(bytes))
  assert.equal(staged.size, bytes.length)
  assert.equal(Object.isFrozen(staged), true)
  await c.storage.discard(staged)
  await assert.rejects(c.stage('bios', Buffer.alloc(0)), /kosong/)
  async function* broken() { yield bytes; throw new Error('connection aborted') }
  await assert.rejects(c.storage.stage('games', broken()), /connection aborted/)
  async function* excessive() { const chunk = Buffer.alloc(1024 * 1024); for (let i = 0; i <= catalogLimits.bios / chunk.length; i++) yield chunk }
  await assert.rejects(c.storage.stage('bios', excessive()), /batas ukuran/)
  await assert.rejects(c.storage.stage('bios', ['not bytes']), /harus berupa byte/)
  await assert.rejects(c.repo.publish('games', c.actor, metadata(), { kind: 'games', key: '../maindulu.sqlite', size: 1, sha256: 'a'.repeat(64) }), error => error.code === 'INVALID_CATALOG')
  assert.deepEqual(await c.storage.entries('uploads'), [])
  assert.equal(c.repo.list('games').length, 0)
})

test('changed or missing staging and failed database commits never publish partial entries', async t => {
  const c = await setup(t)
  const damaged = await c.stage()
  await writeFile(join(c.config.dataDir, 'uploads', damaged.key), Buffer.alloc(bytes.length, 1))
  await assert.rejects(c.repo.publish('games', c.actor, metadata(), damaged), /berubah\/rusak/)
  const missing = await c.stage()
  await rm(join(c.config.dataDir, 'uploads', missing.key))
  await assert.rejects(c.repo.publish('games', c.actor, metadata(), missing), { code: 'ENOENT' })
  c.db.exec("CREATE TRIGGER fail_catalog_insert BEFORE INSERT ON games BEGIN SELECT RAISE(ABORT, 'controlled insert failure'); END;")
  await assert.rejects(c.publish(), /controlled insert failure/)
  assert.equal(c.repo.list('games').length, 0)
  c.db.exec('DROP TRIGGER fail_catalog_insert')
  const good = await c.publish()
  await c.storage.verify('games', { key: good.storage_key, size: good.size, sha256: good.sha256 })
})

test('storage rejects traversal, directory substitutions and hardlinked files', async t => {
  const c = await setup(t)
  for (const key of ['../maindulu.sqlite', 'a/b.bin', 'a\\b.bin', '..', 'maindulu.sqlite', randomUUID() + '.bin\n', randomUUID() + '.bin\r', randomUUID() + '.bin\u2028']) await assert.rejects(c.storage.pathFor('games', key), /tidak aman/)
  await assert.rejects(c.storage.pathFor('../saves', randomUUID() + '.bin'), /tidak aman/)
  const stage = await c.stage()
  const target = join(c.config.dataDir, 'uploads', stage.key)
  await link(target, join(c.root, 'linked-byte-file'))
  await assert.rejects(c.storage.promote(stage), /tidak aman/)
  await rm(join(c.root, 'linked-byte-file'))
  await c.storage.discard(stage)
  for (const kind of ['games', 'bios', 'covers', 'uploads']) {
    const folder = join(c.config.dataDir, kind)
    await rm(folder, { recursive: true })
    await symlink(join(c.root, 'public'), folder, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(createCatalogStorage(c.config), /tidak aman/)
    await assert.rejects(c.storage.pathFor(kind, randomUUID() + (kind === 'uploads' ? '.tmp' : '.bin')), /tidak aman/)
    await rm(folder)
    await mkdir(folder)
  }
  assert.deepEqual(await readdir(join(c.root, 'public')), [])
})

test('catalog publication is unique across connections and separate competing processes', { timeout: 30000 }, async t => {
  const c = await setup(t)
  const second = await openDatabase(c.config.dataDir)
  try {
    const storage = await createCatalogStorage(c.config)
    const repo = createCatalogRepository(second, storage)
    const results = await Promise.allSettled([c.publish(), repo.publish('games', c.actor, metadata(), await storage.stage('games', Readable.from([bytes])))])
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'CATALOG_DUPLICATE')
  } finally { second.close() }
  for (const kind of ['games', 'bios']) {
    const children = [0, 1].map(() => spawn(process.execPath, ['tests/helpers/catalog-publisher.mjs', JSON.stringify([c.config, c.actor, kind])], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }))
    const exits = children.map(child => once(child, 'exit'))
    const errors = children.map(() => '')
    children.forEach((child, i) => child.stderr.on('data', data => { errors[i] += data }))
    const ready = children.map(child => new Promise((resolve, reject) => {
      child.once('message', message => message.phase === 'ready' ? resolve() : reject(new Error('Unexpected child message')))
      child.once('error', reject)
      child.once('exit', code => reject(new Error('Publisher exited before ready: ' + code)))
    }))
    try {
      await Promise.all(ready)
      const results = children.map(child => once(child, 'message').then(([message]) => message))
      for (const child of children) child.send('publish')
      const messages = await Promise.all(results)
      assert.deepEqual(messages.map(m => m.code).sort(), ['CATALOG_DUPLICATE', 'created'].sort())
      assert.equal(messages[0].id, messages[1].id)
      for (const [i, exit] of exits.entries()) assert.equal((await exit)[0], 0, errors[i])
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill()
      await Promise.all(exits)
    }
  }
})

test('offline recovery preserves active files and saves, reports damage/unknown/unsafe files, and retries safely', async t => {
  const c = await setup(t)
  const active = await c.publish()
  const firmware = await c.publish('bios')
  const deleted = await c.publish('games', Buffer.from('deleted game'))
  c.repo.delete('games', c.actor, deleted.id)
  const staging = await c.stage()
  const orphan = randomUUID() + '.bin'
  await writeFile(join(c.config.dataDir, 'covers', orphan), 'orphan')
  await writeFile(join(c.config.dataDir, 'covers', 'operator-note.txt'), 'keep')
  const unsafe = randomUUID() + '.bin'
  await link(join(c.config.dataDir, 'games', active.storage_key), join(c.config.dataDir, 'covers', unsafe))
  for (const folder of ['saves', 'game-saves']) { await mkdir(join(c.config.dataDir, folder)); await writeFile(join(c.config.dataDir, folder, 'keep.bin'), 'keep save') }
  await assert.rejects(recoverCatalogStorage(c.config, { remove: true }), /Data sedang dipakai/)
  c.close()
  const inspection = await recoverCatalogStorage(c.config)
  assert.equal(inspection.removed.length, 0)
  assert.equal(inspection.candidates.length, 3)
  assert.equal(inspection.unsafe.length, 1)
  assert.equal(inspection.damaged.length, 1) // Active inode has an unsafe hard link.
  await rm(join(c.config.dataDir, 'covers', unsafe))
  await rm(join(c.config.dataDir, 'bios', firmware.storage_key))
  const report = await recoverCatalogStorage(c.config, { remove: true })
  assert.equal(report.removed.length, 3)
  assert.equal(report.failed.length, 0)
  assert.deepEqual(report.damaged.map(r => r.key), [firmware.storage_key])
  assert.deepEqual(report.unknown, [{ folder: 'covers', key: 'operator-note.txt' }])
  assert.deepEqual(await readFile(join(c.config.dataDir, 'games', active.storage_key)), bytes)
  assert.equal(await readFile(join(c.config.dataDir, 'covers', 'operator-note.txt'), 'utf8'), 'keep')
  for (const folder of ['saves', 'game-saves']) assert.equal(await readFile(join(c.config.dataDir, folder, 'keep.bin'), 'utf8'), 'keep save')
  for (const [folder, key] of [['uploads', staging.key], ['games', deleted.storage_key], ['covers', orphan]]) await assert.rejects(readFile(join(c.config.dataDir, folder, key)), { code: 'ENOENT' })
  assert.equal((await recoverCatalogStorage(c.config, { remove: true })).removed.length, 0)
  c.db = await openDatabase(c.config.dataDir)
  assert.notEqual(c.db.prepare('SELECT * FROM games WHERE id = ?').get(deleted.id), undefined)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1)
})

test('recovery CLI defaults to inspection and refuses live server leases', async t => {
  const c = await setup(t)
  const orphan = await c.stage()
  const run = args => spawnSync(process.execPath, ['scripts/recover-catalog.mjs', ...args], { encoding: 'utf8', env: { ...process.env, MAIN_DULU_DATA_DIR: c.config.dataDir }, timeout: 15000 })
  const live = run(['--apply'])
  assert.equal(live.status, 1)
  assert.match(live.stderr, /Data sedang dipakai/)
  c.close()
  const inspection = run([])
  assert.equal(inspection.status, 0, inspection.stderr)
  assert.equal(JSON.parse(inspection.stdout).mode, 'inspect')
  assert.equal(JSON.parse(inspection.stdout).candidates[0].key, orphan.key)
  assert.equal((await readdir(join(c.config.dataDir, 'uploads'))).length, 1)
  const cleaned = run(['--apply'])
  assert.equal(cleaned.status, 0, cleaned.stderr)
  assert.equal(JSON.parse(cleaned.stdout).removed.length, 1)
  assert.equal(run(['--unknown']).status, 1)
})

test('invalid database references abort recovery before deleting any staging or orphan', async t => {
  const c = await setup(t)
  const active = await c.publish()
  const staging = await c.stage()
  c.db.prepare('UPDATE games SET storage_key = ? WHERE id = ?').run('../saves/keep.bin', active.id)
  c.close()
  await assert.rejects(recoverCatalogStorage(c.config, { remove: true }), /Referensi katalog recovery tidak valid/)
  assert.equal((await readFile(join(c.config.dataDir, 'uploads', staging.key))).length, bytes.length)
  assert.deepEqual(await readFile(join(c.config.dataDir, 'games', active.storage_key)), bytes)
})

test('real process termination leaves staging/final orphans recoverable and committed assets untouched', { timeout: 30000 }, async t => {
  const c = await setup(t)
  c.close()
  for (const phase of ['staging', 'final', 'committed']) {
    const script = `
      import { Readable } from 'node:stream';
      import { openDatabase } from './server/database.mjs';
      import { createCatalogStorage } from './server/catalog/storage.mjs';
      import { createCatalogRepository } from './server/catalog/repository.mjs';
      const config = ${JSON.stringify(c.config)};
      const db = await openDatabase(config.dataDir);
      const storage = await createCatalogStorage(config);
      const stage = await storage.stage('games', Readable.from([Buffer.from(${JSON.stringify(phase)})]));
      let result = stage;
      if (${JSON.stringify(phase)} === 'final') result = await storage.promote(stage);
      if (${JSON.stringify(phase)} === 'committed') result = await createCatalogRepository(db, storage).publish('games', ${JSON.stringify(c.actor)}, { title: 'Crash proof', consoleId: 'nes', fileName: 'fixture.nes' }, stage);
      process.send(result);
      setInterval(() => {}, 1000);
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const exit = once(child, 'exit')
    let message
    try { [message] = await once(child, 'message') }
    finally { child.kill(); await exit }
    const result = await recoverCatalogStorage(c.config, { remove: true })
    assert.equal(result.removed.length, phase === 'committed' ? 0 : 1)
    assert.equal(result.damaged.length, 0)
    if (phase === 'committed') assert.equal(await readFile(join(c.config.dataDir, 'games', message.storage_key), 'utf8'), phase)
  }
})

test('backend initializes private catalog folders but exposes no catalog capability or private assets', async t => {
  let app
  const root = await backendFixture(t, { beforeCleanup: () => app?.close() })
  app = await createApp({ root, env: {} })
  const capabilities = (await app.inject('/api/health')).json().capabilities
  assert.equal(capabilities.gameCatalog, false)
  assert.equal(capabilities.biosCatalog, false)
  for (const folder of ['games', 'bios', 'covers', 'uploads']) assert.deepEqual(await readdir(join(root, 'data', folder)), [])
  for (const url of ['/api/games', '/api/bios', '/data/maindulu.sqlite', '/uploads/test.tmp', '/games/maindulu.sqlite', '/bios/maindulu.sqlite']) assert.equal((await app.inject(url)).statusCode, 404, url)
})
