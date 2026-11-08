import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, symlink, writeFile, unlink, link } from 'node:fs/promises'
import { join } from 'node:path'
import { createApp } from '../server/app.mjs'
import { openDatabase } from '../server/database.mjs'
import { createCatalogStorage } from '../server/catalog/storage.mjs'
import { createCatalogRepository } from '../server/catalog/repository.mjs'
import { storagePlatform, safeStorageName } from '../server/catalog/paths.mjs'
import { enqueueCleanup } from '../server/catalog/maintenance.mjs'
import { recoverCatalogStorage } from '../server/catalog/recovery.mjs'
import { createDataBackup, verifyDataBackup, restoreDataBackup } from '../server/data-backup.mjs'
import { backendFixture } from './helpers/backend-fixture.mjs'

const hash = data => createHash('sha256').update(data).digest('hex')
async function setup(t) {
  let app
  const root = await backendFixture(t, { beforeCleanup: () => app?.close() })
  app = await createApp({ root, env: {} })
  const db = app.database, storage = app.catalog.storage, repo = app.catalog.repository
  const actor = randomUUID()
  db.prepare('INSERT INTO users (id, username, password_hash, recovery_code_hash, created_at, role) VALUES (?, ?, ?, ?, ?, ?)').run(actor, 'pathsadmin', 'fixture', 'fixture', Date.now(), 'admin')
  const publish = async (kind, consoleId, fileName, data, options) => repo.publish(kind, actor,
    { [kind === 'games' ? 'title' : 'name']: 'Fixture', consoleId, fileName }, await storage.stage(kind, [Buffer.from(data)]), { scanMetadata: false, ...options })
  return { app, db, storage, repo, root, actor, publish, close: async () => { await app.close(); app = null } }
}

test('platform folders match RomM Folder Name slugs, preserving filenames, extensions and bytes', async t => {
  const c = await setup(t)
  for (const [consoleId, name, platform] of [['nes', 'Super Mario Bros.nes', 'nes'], ['snes', 'Game.sfc', 'snes'], ['gb', 'Game.gb', 'gb'], ['gb', 'Game.GBC', 'gbc'], ['gba', 'Game.gba', 'gba'], ['megadrive', 'Game.md', 'genesis'], ['psx', 'Crash Bandicoot.chd', 'psx']]) {
    const bytes = Buffer.from('synthetic ' + platform), row = await c.publish('games', consoleId, name, bytes)
    const path = await c.storage.pathFor('games', row.storage_key)
    assert.equal(path, join(c.root, 'data', 'roms', platform, name))
    assert.deepEqual(await readFile(path), bytes); assert.equal(row.sha256, hash(bytes)); assert.equal(row.original_name, name)
    assert.deepEqual(await readdir(join(c.root, 'data', 'roms', platform)), [name])
    assert.deepEqual((await c.app.inject(`/games/${row.id}/rom/${encodeURIComponent(name)}`)).rawPayload, bytes)
  }
  const bios = await c.publish('bios', 'psx', 'SCPH1001.bin', 'synthetic firmware')
  assert.equal(await c.storage.pathFor('bios', bios.storage_key), join(c.root, 'data', 'bios', 'psx', 'SCPH1001.bin'))
  assert.equal(storagePlatform('gb', 'archive.zip'), 'gb') // Do not guess GBC from an opaque archive.
  assert.equal(storagePlatform('gb', 'boot.bin', 'bios'), 'gb')
  assert.deepEqual(await readdir(join(c.root, 'data', 'games')), []) // Legacy folder is not used for new ROM uploads.
})

test('filename collision never overwrites: case/Unicode aliases conflict, different platform/kind is independent', async t => {
  const c = await setup(t)
  const first = await c.publish('games', 'nes', 'Pokémon.zip', 'first bytes')
  for (const name of ['Pokémon.zip', 'POKÉMON.ZIP', 'Poke\u0301mon.zip']) {
    await assert.rejects(c.publish('games', 'nes', name, 'different bytes'), { code: 'CATALOG_FILENAME_CONFLICT' })
    assert.equal(await readFile(await c.storage.pathFor('games', first.storage_key), 'utf8'), 'first bytes')
  }
  await c.publish('games', 'snes', 'Pokémon.zip', 'different platform')
  await c.publish('bios', 'nes', 'Pokémon.zip', 'different namespace')
  await assert.rejects(c.publish('games', 'nes', 'other.zip', 'first bytes'), { code: 'CATALOG_DUPLICATE' })
})

test('unsafe and oversized filesystem names are rejected, never renamed silently', () => {
  for (const name of ['a/b.nes', '..\\game.chd', 'C:a.zip', 'CON.nes', 'LPT¹.bin', 'COM².zip', 'a.zip.', ' game.zip', 'game.nes\n', '漢'.repeat(84) + '.zip', 'x'.repeat(241)]) assert.equal(safeStorageName(name), false, name)
  for (const name of ['漢'.repeat(83) + '.zip', 'a'.repeat(236) + '.nes', 'Crash Bandicoot.chd']) assert.equal(safeStorageName(name), true, name)
})

test('same-name simultaneous uploads on two SQLite connections have exactly one owner and no clobber', async t => {
  const c = await setup(t), other = await openDatabase(c.app.appConfig.dataDir)
  try {
    const storage = await createCatalogStorage(c.app.appConfig, other), repo = createCatalogRepository(other, storage)
    const left = await c.storage.stage('games', [Buffer.from('left')]), right = await storage.stage('games', [Buffer.from('right')])
    const value = { title: 'Fixture', consoleId: 'nes', fileName: 'same.nes' }
    const results = await Promise.allSettled([c.repo.publish('games', c.actor, value, left), repo.publish('games', c.actor, value, right)])
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'CATALOG_FILENAME_CONFLICT')
    const row = results.find(r => r.status === 'fulfilled').value
    const bytes = await readFile(await c.storage.pathFor('games', row.storage_key))
    assert.equal(hash(bytes), row.sha256); assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM catalog_asset_files').get().n, 1)
  } finally { other.close() }
})

test('unmanaged existing files and substituted platform directories are never overwritten or followed', async t => {
  const c = await setup(t), folder = join(c.root, 'data', 'roms', 'nes')
  await mkdir(folder); await writeFile(join(folder, 'manual.nes'), 'operator file')
  await assert.rejects(c.publish('games', 'nes', 'manual.nes', 'new'), { code: 'CATALOG_FILENAME_CONFLICT' })
  assert.equal(await readFile(join(folder, 'manual.nes'), 'utf8'), 'operator file')
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM catalog_asset_files').get().n, 0)
  const parked = folder + '-parked'; await rename(folder, parked)
  await symlink(join(c.root, 'public'), folder, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(c.publish('games', 'nes', 'escape.nes', 'new'), /tidak aman/)
  assert.deepEqual(await readdir(join(c.root, 'public')), [])
})

test('metadata edits and repeated stale cleanup do not rename or delete a newer owner of the same path', async t => {
  const c = await setup(t)
  const old = await c.publish('games', 'psx', 'Game.chd', 'old bytes')
  const path = await c.storage.pathFor('games', old.storage_key)
  await c.repo.update('games', c.actor, old.id, { title: 'Admin title' })
  assert.equal(await c.storage.pathFor('games', old.storage_key), path)
  c.repo.delete('games', c.actor, old.id); await c.app.catalog.maintenance.cleanup()
  const next = await c.publish('games', 'psx', 'Game.chd', 'new bytes')
  assert.notEqual(next.storage_key, old.storage_key); assert.equal(await c.storage.pathFor('games', next.storage_key), path)
  for (let n = 0; n < 2; n++) {
    enqueueCleanup(c.db, 'games', old.storage_key); await c.app.catalog.maintenance.cleanup()
    await c.storage.removeUnreferenced('games', old.storage_key)
    assert.equal(await readFile(path, 'utf8'), 'new bytes')
    await assert.rejects(c.storage.open('games', old.storage_key), { code: 'ENOENT' })
  }
  assert.equal(c.repo.get('games', next.id).title, 'Fixture')
})

test('copy cancellation discards only its own partial file and releases the path claim', async t => {
  const c = await setup(t)
  const stage = await c.storage.stage('games', [Buffer.alloc(2 * 1024 * 1024, 1)])
  let checks = 0
  await assert.rejects(c.storage.promote(stage, { consoleId: 'nes', fileName: 'cancel.nes', check() { if (++checks === 2) throw new Error('cancelled copy') } }), /cancelled copy/)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM catalog_asset_files').get().n, 0)
  await assert.rejects(readFile(join(c.root, 'data', 'roms', 'nes', 'cancel.nes')), { code: 'ENOENT' })
  assert.deepEqual(await c.storage.entries('uploads'), [stage.key])
  await c.storage.discard(stage)
  await c.publish('games', 'nes', 'cancel.nes', 'retry bytes')
})

test('legacy UUID assets remain readable on schema upgrade without renaming or resetting user data', async t => {
  const c = await setup(t)
  const stage = await c.storage.stage('games', [Buffer.from('legacy')]), legacy = await c.storage.promote(stage)
  const id = randomUUID()
  c.db.prepare("INSERT INTO games (id, title, console_id, original_name, storage_key, size, sha256, created_at, updated_at) VALUES (?, 'Legacy', 'nes', 'old.nes', ?, ?, ?, 1, 1)").run(id, legacy.key, legacy.size, legacy.sha256)
  assert.deepEqual((await c.app.inject(`/games/${id}/rom/old.nes`)).rawPayload, Buffer.from('legacy'))
  assert.equal(await c.storage.pathFor('games', legacy.key), join(c.root, 'data', 'games', legacy.key))
})

test('offline recovery releases crashed reserved/deleting claims without following unknown files', async t => {
  const c = await setup(t), config = c.app.appConfig
  const reserved = randomUUID() + '.bin', deleting = randomUUID() + '.bin'
  await mkdir(join(config.dataDir, 'roms', 'nes'))
  c.db.prepare("INSERT INTO catalog_asset_files VALUES (?, 'games', 'nes', 'reserved.nes', 'reserved.nes', 'reserved')").run(reserved)
  c.db.prepare("INSERT INTO catalog_asset_files VALUES (?, 'games', 'nes', 'partial.nes', 'partial.nes', 'deleting')").run(deleting)
  await writeFile(join(config.dataDir, 'roms', 'nes', 'partial.nes'), 'partial')
  await writeFile(join(config.dataDir, 'roms', 'nes', 'operator.nes'), 'keep')
  await c.close()
  const result = await recoverCatalogStorage(config, { remove: true })
  assert.equal(result.removed.length, 2); assert.equal(result.unknown.length, 1)
  assert.equal(await readFile(join(config.dataDir, 'roms', 'nes', 'operator.nes'), 'utf8'), 'keep')
  const db = await openDatabase(config.dataDir)
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM catalog_asset_files').get().n, 0) } finally { db.close() }
})

test('hardlinked named assets fail safe and cleanup does not remove external data', async t => {
  const c = await setup(t), row = await c.publish('bios', 'psx', 'SCPH1001.bin', 'firmware')
  const path = await c.storage.pathFor('bios', row.storage_key)
  await link(path, join(c.root, 'external-link'))
  await assert.rejects(c.storage.open('bios', row.storage_key), /tidak aman/)
  c.repo.delete('bios', c.actor, row.id)
  await assert.rejects(c.storage.removeUnreferenced('bios', row.storage_key), /tidak aman/)
  assert.equal(await readFile(join(c.root, 'external-link'), 'utf8'), 'firmware')
})

test('backup normalizes path ownership only in snapshot; restore repairs original filenames without asset bytes', async t => {
  const c = await setup(t), config = c.app.appConfig
  const game = await c.publish('games', 'psx', 'Exact Name.chd', 'disc bytes')
  const before = c.db.prepare('SELECT * FROM catalog_asset_files').all()
  await c.close()
  const backup = join(c.root, 'backup'), restored = join(c.root, 'restored')
  const manifest = await createDataBackup(config, backup)
  assert.equal(manifest.schemaVersion, 14); assert.equal(manifest.counts.catalog_asset_files, 0)
  await verifyDataBackup(config, backup); await restoreDataBackup(config, backup, restored)
  const original = await openDatabase(config.dataDir)
  try { assert.deepEqual(original.prepare('SELECT * FROM catalog_asset_files').all(), before) } finally { original.close() }
  const db = await openDatabase(restored)
  try {
    const storage = await createCatalogStorage({ ...config, dataDir: restored }, db), repo = createCatalogRepository(db, storage)
    const stage = await storage.stage('games', [Buffer.from('disc bytes')])
    const row = await repo.publish('games', c.actor, { title: 'ignored', consoleId: 'psx', fileName: 'renamed.chd' }, stage, { restoreId: game.id })
    assert.equal(row.id, game.id); assert.equal(row.original_name, 'Exact Name.chd')
    assert.equal(await storage.pathFor('games', row.storage_key), join(restored, 'roms', 'psx', 'Exact Name.chd'))
    assert.equal(await readFile(await storage.pathFor('games', row.storage_key), 'utf8'), 'disc bytes')
  } finally { db.close() }
})
