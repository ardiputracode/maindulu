import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { link, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { backendFixture } from './helpers/backend-fixture.mjs'
import { readConfig } from '../server/config.mjs'
import { openDatabase, schemaVersion } from '../server/database.mjs'
import { createCatalogStorage } from '../server/catalog/storage.mjs'
import { createCatalogRepository } from '../server/catalog/repository.mjs'
import { createDataBackup, restoreDataBackup, verifyDataBackup } from '../server/data-backup.mjs'
import { recoverCatalogStorage } from '../server/catalog/recovery.mjs'
import { metadataDetail } from '../server/metadata/queue.mjs'

async function setup(t) {
  const c = { db: null }
  c.root = await backendFixture(t, { beforeCleanup: () => { if (c.db?.isOpen) c.db.close() } })
  c.config = await readConfig({}, c.root)
  c.db = await openDatabase(c.config.dataDir)
  c.actor = randomUUID()
  c.db.prepare('INSERT INTO users (id, username, password_hash, recovery_code_hash, created_at, role) VALUES (?, ?, ?, ?, ?, ?)').run(c.actor, 'backup_admin', 'test-only', 'test-only', Date.now(), 'admin')
  c.storage = await createCatalogStorage(c.config, c.db)
  c.repo = createCatalogRepository(c.db, c.storage)
  c.publish = async (kind = 'games') => c.repo.publish(kind, c.actor, { [kind === 'games' ? 'title' : 'name']: 'Fixture', consoleId: 'nes', fileName: 'fixture.zip' }, await c.storage.stage(kind, Readable.from([Buffer.from('test bytes')])))
  c.close = () => { c.db.close(); c.db = null }
  return c
}

test('empty current catalogs preserve account/save backup behavior and include explicit zero counts', async t => {
  const c = await setup(t)
  c.close()
  const target = join(c.root, 'empty-backup')
  const manifest = await createDataBackup(c.config, target)
  assert.equal(manifest.schemaVersion, schemaVersion)
  assert.equal(manifest.formatVersion, 2)
  assert.equal(manifest.catalogAssets, 'excluded')
  assert.equal(manifest.counts.games, 0)
  assert.equal(manifest.counts.bios, 0)
  assert.deepEqual(await verifyDataBackup(c.config, target), manifest)
  const restored = join(c.root, 'empty-restored')
  await restoreDataBackup(c.config, target, restored)
  c.db = await openDatabase(restored)
  assert.equal(c.db.prepare('SELECT role FROM users').get().role, 'admin')
  assert.equal(c.db.prepare('PRAGMA user_version').get().user_version, schemaVersion)
})

test('M5 backup normalizes provider gate only in snapshot and still accepts schema-12 backups before migration', async t => {
  const c = await setup(t)
  await c.publish()
  c.db.prepare("UPDATE metadata_provider_state SET lease_token = 'old-worker', lease_expires_at = ?, next_at = ?, paused_reason = 'quota_exhausted' WHERE id = 1").run(Date.now() + 60000, Date.now() + 86400000)
  c.close()
  const target = join(c.root, 'm5-backup')
  const manifest = await createDataBackup(c.config, target)
  await verifyDataBackup(c.config, target)
  const source = new DatabaseSync(join(c.config.dataDir, 'maindulu.sqlite'))
  assert.equal(source.prepare('SELECT lease_token FROM metadata_provider_state').get().lease_token, 'old-worker')
  source.close()
  const path = join(target, 'maindulu.sqlite')
  const legacy = new DatabaseSync(path)
  assert.deepEqual({ ...legacy.prepare('SELECT * FROM metadata_provider_state').get() }, { id: 1, lease_token: null, lease_expires_at: null, next_at: 0, paused_reason: null })
  legacy.exec('DROP TABLE catalog_asset_files; DROP TABLE metadata_provider_state; ALTER TABLE metadata_jobs DROP COLUMN request_method; ALTER TABLE metadata_jobs DROP COLUMN request_json; DELETE FROM schema_migrations WHERE version > 12; PRAGMA user_version = 12;')
  legacy.close()
  const bytes = await readFile(path)
  manifest.schemaVersion = 12
  delete manifest.counts.metadata_provider_state
  delete manifest.counts.catalog_asset_files
  manifest.files.find(file => file.path === 'maindulu.sqlite').size = bytes.length
  manifest.files.find(file => file.path === 'maindulu.sqlite').checksum = createHash('sha256').update(bytes).digest('hex')
  await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest))
  await verifyDataBackup(c.config, target)
  const restored = join(c.root, 'm5-restored')
  await restoreDataBackup(c.config, target, restored)
  c.db = await openDatabase(restored)
  assert.equal(c.db.prepare('PRAGMA user_version').get().user_version, schemaVersion)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM metadata_jobs').get().n, 0)
  assert.equal(c.db.prepare('SELECT next_at FROM metadata_provider_state').get().next_at, 0)
})

test('schema-15 backup round-trips serial match provenance without changing catalog assets', async t => {
  const c = await setup(t)
  const game = await c.publish()
  c.db.prepare("UPDATE game_metadata SET match_method = 'serial', provider_game_id = '123' WHERE game_id = ?").run(game.id)
  c.close()
  const target = join(c.root, 'serial-backup')
  const manifest = await createDataBackup(c.config, target)
  assert.equal(manifest.schemaVersion, 15)
  assert.equal(manifest.counts.game_metadata, 1)
  assert.deepEqual(await verifyDataBackup(c.config, target), manifest)
  const restored = join(c.root, 'serial-restored')
  await restoreDataBackup(c.config, target, restored)
  c.db = await openDatabase(restored)
  assert.equal(c.db.prepare('PRAGMA user_version').get().user_version, 15)
  assert.deepEqual({ ...c.db.prepare('SELECT match_method, provider_game_id FROM game_metadata WHERE game_id = ?').get(game.id) },
    { match_method: 'serial', provider_game_id: '123' })
  assert.equal(c.db.prepare('SELECT title FROM games WHERE id = ?').get(game.id).title, game.title)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM catalog_asset_files').get().n, 0)
})

test('schema-14 backups verify before migration, then migrate and accept serial provenance', async t => {
  const c = await setup(t)
  const game = await c.publish()
  c.db.prepare("UPDATE game_metadata SET match_method = 'name' WHERE game_id = ?").run(game.id)
  c.close()
  const target = join(c.root, 'schema14-serial-backup')
  const manifest = await createDataBackup(c.config, target)
  const path = join(target, 'maindulu.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE game_metadata_v14 (
    game_id TEXT PRIMARY KEY NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    release_date TEXT CHECK(release_date IS NULL OR length(release_date) BETWEEN 1 AND 32),
    release_precision TEXT CHECK(release_precision IS NULL OR release_precision IN ('year', 'month', 'day')),
    genre TEXT NOT NULL DEFAULT '' CHECK(length(genre) <= 200),
    developer TEXT NOT NULL DEFAULT '' CHECK(length(developer) <= 200),
    publisher TEXT NOT NULL DEFAULT '' CHECK(length(publisher) <= 200),
    players TEXT NOT NULL DEFAULT '' CHECK(length(players) <= 32),
    region_language TEXT NOT NULL DEFAULT '' CHECK(length(region_language) <= 64),
    provider_game_id TEXT CHECK(provider_game_id IS NULL OR length(provider_game_id) BETWEEN 1 AND 64),
    match_method TEXT CHECK(match_method IS NULL OR match_method IN ('hash', 'name', 'game_id', 'manual')),
    fetched_at INTEGER,
    applied_at INTEGER,
    metadata_revision INTEGER NOT NULL DEFAULT 1 CHECK(metadata_revision > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  INSERT INTO game_metadata_v14 SELECT * FROM game_metadata;
  DROP TABLE game_metadata;
  ALTER TABLE game_metadata_v14 RENAME TO game_metadata;
  DELETE FROM schema_migrations WHERE version > 14;
  PRAGMA user_version = 14;`)
  db.close()
  const bytes = await readFile(path)
  manifest.schemaVersion = 14
  manifest.files.find(file => file.path === 'maindulu.sqlite').size = bytes.length
  manifest.files.find(file => file.path === 'maindulu.sqlite').checksum = createHash('sha256').update(bytes).digest('hex')
  await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest))
  assert.deepEqual(await verifyDataBackup(c.config, target), manifest)
  const restored = join(c.root, 'schema14-serial-restored')
  await restoreDataBackup(c.config, target, restored)
  const old = new DatabaseSync(join(restored, 'maindulu.sqlite'))
  try {
    assert.equal(old.prepare('PRAGMA user_version').get().user_version, 14)
    assert.throws(() => old.prepare("UPDATE game_metadata SET match_method = 'serial' WHERE game_id = ?").run(game.id), /constraint/i)
  } finally { old.close() }
  c.db = await openDatabase(restored)
  assert.equal(c.db.prepare('PRAGMA user_version').get().user_version, 15)
  assert.equal(c.db.prepare('SELECT match_method FROM game_metadata WHERE game_id = ?').get(game.id).match_method, 'name')
  assert.doesNotThrow(() => c.db.prepare("UPDATE game_metadata SET match_method = 'serial' WHERE game_id = ?").run(game.id))
  assert.equal(c.db.prepare('SELECT match_method FROM game_metadata WHERE game_id = ?').get(game.id).match_method, 'serial')
})

// Reconstruct historical source shape, never migrate a backup just to verify it.
async function historicalMetadataBackup(c, version, name) {
  const target = join(c.root, name)
  const manifest = await createDataBackup(c.config, target)
  const path = join(target, 'maindulu.sqlite')
  const db = new DatabaseSync(path)
  db.exec('DROP TABLE catalog_asset_files; DROP TABLE metadata_provider_state;')
  if (version === 9) {
    db.exec('DROP TABLE game_metadata_field_sources; DROP TABLE game_metadata; DROP TABLE metadata_jobs; DROP TABLE provider_cache; DROP TABLE catalog_revision;')
    for (const table of ['game_metadata_field_sources', 'game_metadata', 'metadata_jobs', 'provider_cache']) delete manifest.counts[table]
  } else {
    db.exec('ALTER TABLE metadata_jobs DROP COLUMN request_method; ALTER TABLE metadata_jobs DROP COLUMN request_json;')
    if (version === 10) db.exec('ALTER TABLE metadata_jobs DROP COLUMN candidate_json; ALTER TABLE metadata_jobs DROP COLUMN candidate_at;')
  }
  db.exec(`DELETE FROM schema_migrations WHERE version > ${version}; PRAGMA user_version = ${version};`)
  db.close()
  manifest.schemaVersion = version
  delete manifest.counts.metadata_provider_state
  delete manifest.counts.catalog_asset_files
  const updateManifest = async () => {
    const bytes = await readFile(path)
    const entry = manifest.files.find(file => file.path === 'maindulu.sqlite')
    entry.size = bytes.length; entry.checksum = createHash('sha256').update(bytes).digest('hex')
    await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest))
    return bytes
  }
  await updateManifest()
  return { target, path, manifest, updateManifest }
}

for (const version of [9, 10, 11, 12]) test(`M6 format-2 schema-${version} catalog backup verifies before migration and restores stable IDs without scan`, async t => {
  const c = await setup(t)
  const game = await c.publish()
  c.close()
  const old = await historicalMetadataBackup(c, version, `schema${version}-metadata`)
  const original = await readFile(old.path)
  assert.deepEqual(await verifyDataBackup(c.config, old.target), old.manifest)
  const restored = join(c.root, `restored-${version}`)
  await restoreDataBackup(c.config, old.target, restored)
  const check = new DatabaseSync(join(restored, 'maindulu.sqlite'), { readOnly: true })
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, version)
  assert.equal(check.prepare('SELECT id FROM games').get().id, game.id)
  check.close()
  c.db = await openDatabase(restored)
  assert.equal(c.db.prepare('PRAGMA user_version').get().user_version, schemaVersion)
  assert.equal(c.db.prepare('SELECT title FROM games').get().title, game.title)
  const detail = metadataDetail(c.db, game)
  assert.equal(detail.status, 'disabled')
  assert.equal(detail.preview.fields.title.current, game.title)
  if (version === 9) for (const field of ['title', 'description', 'cover']) {
    assert.equal(detail.preview.fields[field].source, 'manual')
    assert.equal(detail.preview.fields[field].locked, true)
  }
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM metadata_jobs').get().n, 0)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM provider_cache').get().n, 0)
  assert.equal(c.db.prepare('SELECT lease_token FROM metadata_provider_state').get().lease_token, null)
  assert.deepEqual(await readFile(old.path), original)
})

for (const version of [9, 12]) test(`M6 schema-${version} verification rejects hidden newer metadata tables before restore`, async t => {
  const c = await setup(t)
  c.close()
  const old = await historicalMetadataBackup(c, version, `hidden-${version}`)
  const db = new DatabaseSync(old.path)
  db.exec(`CREATE TABLE ${version === 9 ? 'metadata_jobs' : 'metadata_provider_state'} (secret TEXT);`)
  db.close()
  await old.updateManifest()
  await assert.rejects(verifyDataBackup(c.config, old.target), /tidak sesuai versi skema/)
  await assert.rejects(restoreDataBackup(c.config, old.target, join(c.root, 'must-not-restore')), /tidak sesuai versi skema/)
})

for (const version of [10, 12]) test(`M6 schema-${version} verification rejects hidden newer job request columns`, async t => {
  const c = await setup(t)
  c.close()
  const old = await historicalMetadataBackup(c, version, `hidden-column-${version}`)
  const db = new DatabaseSync(old.path)
  db.exec('ALTER TABLE metadata_jobs ADD COLUMN request_json TEXT;')
  db.close()
  await old.updateManifest()
  await assert.rejects(verifyDataBackup(c.config, old.target), /kolom yang tidak sesuai versi skema/)
})

test('M6 format-1 schema-9 backup cannot hide pending catalog cleanup', async t => {
  const c = await setup(t)
  c.close()
  const old = await historicalMetadataBackup(c, 9, 'format1-cleanup-9')
  old.manifest.formatVersion = 1
  delete old.manifest.catalogAssets
  const db = new DatabaseSync(old.path)
  db.prepare('INSERT INTO catalog_cleanup (folder, storage_key, next_at) VALUES (?, ?, ?)').run('games', randomUUID() + '.bin', 1)
  db.close()
  old.manifest.counts.catalog_cleanup = 1
  await old.updateManifest()
  await assert.rejects(verifyDataBackup(c.config, old.target), /reservasi\/cleanup/)
})

test('metadata-only backups include active/deleted catalog metadata but deliberately exclude all catalog asset bytes and orphans', async t => {
  for (const scenario of ['games', 'bios', 'tombstone', 'metadata-only', 'orphan-game', 'orphan-bios', 'orphan-cover']) {
    await t.test(scenario, async t => {
      const c = await setup(t)
      if (['games', 'bios', 'tombstone', 'metadata-only'].includes(scenario)) {
        const row = await c.publish(scenario === 'bios' ? 'bios' : 'games')
        if (scenario === 'tombstone') c.repo.delete('games', c.actor, row.id)
        if (scenario === 'metadata-only') {
          // Missing ROM bytes do not prevent saving accounts/progress/metadata.
          await unlink(await c.storage.pathFor('games', row.storage_key))
        }
      } else {
        const folder = { 'orphan-game': 'games', 'orphan-bios': 'bios', 'orphan-cover': 'covers' }[scenario]
        await writeFile(join(c.config.dataDir, folder, randomUUID() + '.bin'), 'orphan')
      }
      c.close()
      const destination = join(c.root, 'metadata-backup')
      const manifest = await createDataBackup(c.config, destination)
      assert.equal(manifest.formatVersion, 2)
      assert.equal(manifest.catalogAssets, 'excluded')
      assert.equal(manifest.files.length, 1)
      assert.deepEqual((await readdir(destination)).sort(), ['game-saves', 'maindulu.sqlite', 'manifest.json', 'saves'])
      await verifyDataBackup(c.config, destination)
      const restored = join(c.root, 'restored')
      await restoreDataBackup(c.config, destination, restored)
      const check = new DatabaseSync(join(restored, 'maindulu.sqlite'), { readOnly: true })
      try {
        assert.equal(check.prepare('SELECT COUNT(*) AS n FROM games').get().n, manifest.counts.games)
        assert.equal(check.prepare('SELECT COUNT(*) AS n FROM bios').get().n, manifest.counts.bios)
        if (scenario === 'tombstone') assert.notEqual(check.prepare('SELECT deleted_at FROM games').get().deleted_at, null)
      } finally { check.close() }
      assert.equal((await readdir(c.root)).some(name => name.includes('.partial-')), false)
      const cli = spawnSync(process.execPath, ['scripts/data-backup.mjs', 'verify', destination], { encoding: 'utf8', env: { ...process.env, MAIN_DULU_DATA_DIR: c.config.dataDir }, timeout: 15000 })
      assert.equal(cli.status, 0, cli.stderr)
      assert.match(cli.stdout, /ROM, BIOS, dan cover tidak disertakan/)
    })
  }
})

test('schema-7 backups verify and restore without source migration; application upgrades restored data only', async t => {
  const c = await setup(t)
  c.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('old-session', c.actor, 1, Date.now() + 100000)
  c.close()
  const source = join(c.root, 'legacy-backup')
  const manifest = await createDataBackup(c.config, source)
  // Reconstruct the real milestone-1 shape: no catalog tables/migration/counts.
  const path = join(source, 'maindulu.sqlite')
  const legacy = new DatabaseSync(path)
  legacy.exec('DROP TABLE catalog_asset_files; DROP TABLE metadata_provider_state;')
  legacy.exec('DROP TABLE catalog_cleanup; DROP TABLE catalog_uploads; DROP TABLE catalog_capacity; DROP TABLE IF EXISTS game_metadata_field_sources; DROP TABLE IF EXISTS game_metadata; DROP TABLE IF EXISTS metadata_jobs; DROP TABLE IF EXISTS provider_cache; DROP TABLE IF EXISTS catalog_revision; DROP TABLE games; DROP TABLE bios; DELETE FROM schema_migrations WHERE version >= 8; PRAGMA user_version = 7;')
  legacy.close()
  const original = await readFile(path)
  manifest.schemaVersion = 7
  manifest.formatVersion = 1
  delete manifest.catalogAssets
  delete manifest.counts.games
  delete manifest.counts.bios
  delete manifest.counts.catalog_cleanup
  delete manifest.counts.catalog_uploads
  delete manifest.counts.game_metadata
  delete manifest.counts.game_metadata_field_sources
  delete manifest.counts.metadata_jobs
  delete manifest.counts.provider_cache
  delete manifest.counts.metadata_provider_state
  delete manifest.counts.catalog_asset_files
  manifest.files[0] = { path: 'maindulu.sqlite', size: original.length, checksum: createHash('sha256').update(original).digest('hex') }
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))
  assert.deepEqual(await verifyDataBackup(c.config, source), manifest)
  const restored = join(c.root, 'legacy-restored')
  await restoreDataBackup(c.config, source, restored)
  const check = new DatabaseSync(join(restored, 'maindulu.sqlite'), { readOnly: true })
  try {
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 7)
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0)
    assert.equal(check.prepare('SELECT role FROM users').get().role, 'admin')
  } finally { check.close() }
  c.db = await openDatabase(restored)
  assert.equal(c.db.prepare('PRAGMA user_version').get().user_version, schemaVersion)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM games').get().n, 0)
  assert.deepEqual(await readFile(path), original)
  const sourceDb = new DatabaseSync(join(c.config.dataDir, 'maindulu.sqlite'))
  sourceDb.exec('DROP TABLE catalog_asset_files; DROP TABLE metadata_provider_state;')
  sourceDb.exec('DROP TABLE catalog_cleanup; DROP TABLE catalog_uploads; DROP TABLE catalog_capacity; DROP TABLE IF EXISTS game_metadata_field_sources; DROP TABLE IF EXISTS game_metadata; DROP TABLE IF EXISTS metadata_jobs; DROP TABLE IF EXISTS provider_cache; DROP TABLE IF EXISTS catalog_revision; DROP TABLE games; DROP TABLE bios; DELETE FROM schema_migrations WHERE version >= 8; PRAGMA user_version = 7;')
  sourceDb.close()
  await assert.rejects(createDataBackup(c.config, join(c.root, 'legacy-source-refused')), /Versi skema backup/)
})

test('legacy format 1 cannot disguise populated catalog metadata; schema and excluded-assets declarations are verified', async t => {
  const c = await setup(t)
  c.close()
  const source = join(c.root, 'tampered-backup')
  const manifest = await createDataBackup(c.config, source)
  manifest.formatVersion = 1
  delete manifest.catalogAssets
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))
  assert.deepEqual(await verifyDataBackup(c.config, source), manifest)
  manifest.schemaVersion = 7
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))
  await assert.rejects(verifyDataBackup(c.config, source), /Metadata manifest/)
  manifest.schemaVersion = schemaVersion
  const path = join(source, 'maindulu.sqlite')
  const db = new DatabaseSync(path)
  db.prepare(`INSERT INTO bios (id, name, console_id, original_name, storage_key, size, sha256, created_at, updated_at)
    VALUES (?, 'Fixture', 'nes', 'boot.bin', ?, 1, ?, 1, 1)`).run(randomUUID(), randomUUID() + '.bin', 'a'.repeat(64))
  db.close()
  const bytes = await readFile(path)
  manifest.files[0] = { path: 'maindulu.sqlite', size: bytes.length, checksum: createHash('sha256').update(bytes).digest('hex') }
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))
  await assert.rejects(verifyDataBackup(c.config, source), /Katalog backup/)
  await assert.rejects(restoreDataBackup(c.config, source, join(c.root, 'must-not-restore')), /Katalog backup/)
})

test('schema-8 empty backups verify/restore without migration or ignoring new coordination tables', async t => {
  const c = await setup(t)
  c.close()
  const source = join(c.root, 'schema8-backup')
  const manifest = await createDataBackup(c.config, source)
  const path = join(source, 'maindulu.sqlite')
  const legacy = new DatabaseSync(path)
  legacy.exec('DROP TABLE catalog_asset_files; DROP TABLE metadata_provider_state;')
  legacy.exec('DROP TABLE catalog_cleanup; DROP TABLE catalog_uploads; DROP TABLE catalog_capacity; DROP TABLE IF EXISTS game_metadata_field_sources; DROP TABLE IF EXISTS game_metadata; DROP TABLE IF EXISTS metadata_jobs; DROP TABLE IF EXISTS provider_cache; DROP TABLE IF EXISTS catalog_revision; DELETE FROM schema_migrations WHERE version >= 9; PRAGMA user_version = 8;')
  legacy.close()
  const original = await readFile(path)
  manifest.schemaVersion = 8
  manifest.formatVersion = 1
  delete manifest.catalogAssets
  delete manifest.counts.catalog_cleanup
  delete manifest.counts.catalog_uploads
  delete manifest.counts.game_metadata
  delete manifest.counts.game_metadata_field_sources
  delete manifest.counts.metadata_jobs
  delete manifest.counts.provider_cache
  delete manifest.counts.metadata_provider_state
  delete manifest.counts.catalog_asset_files
  manifest.files[0] = { path: 'maindulu.sqlite', size: original.length, checksum: createHash('sha256').update(original).digest('hex') }
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))
  assert.deepEqual(await verifyDataBackup(c.config, source), manifest)
  const restored = join(c.root, 'schema8-restored')
  await restoreDataBackup(c.config, source, restored)
  c.db = await openDatabase(restored)
  assert.equal(c.db.prepare('PRAGMA user_version').get().user_version, schemaVersion)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM catalog_cleanup').get().n, 0)
  assert.deepEqual(await readFile(path), original)
})

test('metadata backup drops stale coordination only in its snapshot, without changing the source or copying staging', async t => {
  const c = await setup(t)
  c.db.prepare('INSERT INTO catalog_uploads VALUES (?, ?, ?)').run(randomUUID(), 1024, Date.now() + 60000)
  c.db.prepare('INSERT INTO catalog_cleanup (folder, storage_key) VALUES (?, ?)').run('games', randomUUID() + '.bin')
  c.db.exec('UPDATE catalog_capacity SET generation = 57 WHERE id = 1')
  c.close()
  const initial = await createDataBackup(c.config, join(c.root, 'with-stale-coordination'))
  assert.equal(initial.counts.catalog_uploads, 0)
  assert.equal(initial.counts.catalog_cleanup, 0)
  await recoverCatalogStorage(c.config)
  c.db = await openDatabase(c.config.dataDir)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM catalog_uploads').get().n, 1)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM catalog_cleanup').get().n, 1)
  assert.equal(c.db.prepare('SELECT generation FROM catalog_capacity WHERE id = 1').get().generation, 57)
  c.close()
  await recoverCatalogStorage(c.config, { remove: true })
  const manifest = await createDataBackup(c.config, join(c.root, 'recovered-backup'))
  assert.equal(manifest.counts.catalog_uploads, 0)
  assert.equal(manifest.counts.catalog_cleanup, 0)
})

test('restoring catalog metadata keeps save IDs and cover references; explicit matching uploads repair missing active files without replacing healthy files', async t => {
  const c = await setup(t)
  const bytes = Buffer.from('exact original ROM bytes')
  const firmware = Buffer.from('exact original BIOS bytes')
  const cover = { stage: await c.storage.stage('covers', Readable.from([Buffer.from('internal raster fixture')])), type: 'image/png' }
  const game = await c.repo.publish('games', c.actor, { title: 'Original title', consoleId: 'nes', fileName: 'original.nes', license: 'Original fixture' }, await c.storage.stage('games', Readable.from([bytes])), { cover })
  const bios = await c.repo.publish('bios', c.actor, { name: 'Firmware', consoleId: 'nes', fileName: 'disksys.rom' }, await c.storage.stage('bios', Readable.from([firmware])))
  await mkdir(join(c.config.dataDir, 'saves'))
  const savedBytes = Buffer.from('RASTATE saved data'), key = randomUUID() + '.bin'
  await writeFile(join(c.config.dataDir, 'saves', key), savedBytes)
  c.db.prepare('INSERT INTO saves VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), c.actor, game.id, 'nes', 'fceumm', 1, 'save title', '{}', 1, savedBytes.length, createHash('sha256').update(savedBytes).digest('hex'), key, 1)
  const saved = c.db.prepare('SELECT * FROM saves').get()
  c.close()
  const source = join(c.root, 'populated-backup')
  const manifest = await createDataBackup(c.config, source)
  assert.equal(manifest.files.length, 2)
  const restored = join(c.root, 'restored')
  await restoreDataBackup(c.config, source, restored)
  c.db = await openDatabase(restored)
  c.storage = await createCatalogStorage({ ...c.config, dataDir: restored }, c.db)
  c.repo = createCatalogRepository(c.db, c.storage)
  assert.deepEqual(c.repo.get('games', game.id), game)
  assert.deepEqual(c.repo.get('bios', bios.id), bios)
  assert.deepEqual(c.db.prepare('SELECT * FROM saves').get(), saved)
  assert.deepEqual(await readFile(join(restored, 'saves', key)), savedBytes)
  for (const [kind, row, data] of [['games', game, bytes], ['bios', bios, firmware]]) {
    const fields = { [kind === 'games' ? 'title' : 'name']: 'Ignored replacement metadata', consoleId: 'nes', fileName: kind === 'games' ? 'renamed.nes' : 'renamed.bin' }
    const stage = () => c.storage.stage(kind, Readable.from([data]))
    await assert.rejects(c.repo.publish(kind, c.actor, fields, await stage()), error => error.code === 'CATALOG_RESTORE_REQUIRED' && error.id === row.id)
    await assert.rejects(c.repo.publish(kind, c.actor, fields, await c.storage.stage(kind, Readable.from([Buffer.from('wrong bytes')])), { restoreId: row.id }), error => error.code === 'INVALID_CATALOG')
    const recovered = await c.repo.publish(kind, c.actor, fields, await stage(), { restoreId: row.id })
    assert.equal(recovered.id, row.id)
    assert.equal(recovered.original_name, row.original_name)
    assert.equal(recovered.sha256, row.sha256)
    assert.equal(recovered.created_at, row.created_at)
    assert.equal(recovered[kind === 'games' ? 'title' : 'name'], row[kind === 'games' ? 'title' : 'name'])
    if (kind === 'games') assert.equal(recovered.cover_storage_key, game.cover_storage_key)
    await assert.rejects(c.repo.publish(kind, c.actor, fields, await stage(), { restoreId: row.id }), error => error.code === 'CATALOG_DUPLICATE')
  }
  assert.deepEqual(c.db.prepare('SELECT * FROM saves').get(), saved)
})

test('format 2 requires its explicit scope, refuses injected asset files and validates metadata paths even though assets are excluded', async t => {
  const c = await setup(t)
  const game = await c.publish()
  c.close()
  const source = join(c.root, 'backup')
  const manifest = await createDataBackup(c.config, source)
  for (const catalogAssets of [undefined, 'included', true]) {
    await writeFile(join(source, 'manifest.json'), JSON.stringify({ ...manifest, catalogAssets }))
    await assert.rejects(verifyDataBackup(c.config, source), /Format\/versi manifest/)
  }
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))
  await mkdir(join(source, 'games'))
  await assert.rejects(verifyDataBackup(c.config, source), /Isi folder backup/)
  // Unsafe catalog keys must fail backup without touching source assets/saves.
  c.db = await openDatabase(c.config.dataDir)
  c.db.prepare('UPDATE games SET storage_key = ? WHERE id = ?').run('../maindulu.sqlite', game.id)
  c.close()
  await assert.rejects(createDataBackup(c.config, join(c.root, 'bad-metadata')), /Katalog backup/)
  c.db = await openDatabase(c.config.dataDir)
  c.db.prepare('UPDATE games SET storage_key = ?, original_name = ? WHERE id = ?').run(game.storage_key, 'unsupported.txt', game.id)
  c.close()
  await assert.rejects(createDataBackup(c.config, join(c.root, 'bad-extension')), /Katalog backup/)
})

test('concurrent repairs of one missing active asset publish exactly once and cannot overwrite a healthy or unsafe file', async t => {
  const c = await setup(t)
  const row = await c.publish()
  const path = await c.storage.pathFor('games', row.storage_key)
  await unlink(path)
  const args = { title: 'Ignored', consoleId: 'nes', fileName: 'fixture.zip' }
  const stage = () => c.storage.stage('games', Readable.from([Buffer.from('test bytes')]))
  c.db.prepare('UPDATE games SET size = ? WHERE id = ?').run(row.size + 1, row.id)
  await assert.rejects(c.repo.publish('games', c.actor, args, await stage(), { restoreId: row.id }), error => error.code === 'INVALID_CATALOG')
  c.db.prepare('UPDATE games SET size = ? WHERE id = ?').run(row.size, row.id)
  const other = await openDatabase(c.config.dataDir)
  let results
  try {
    const storage = await createCatalogStorage(c.config, other), repo = createCatalogRepository(other, storage)
    const stages = await Promise.all([stage(), storage.stage('games', Readable.from([Buffer.from('test bytes')]))])
    results = await Promise.allSettled([c.repo.publish('games', c.actor, args, stages[0], { restoreId: row.id }), repo.publish('games', c.actor, args, stages[1], { restoreId: row.id })])
  } finally { other.close() }
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.ok(['CATALOG_DUPLICATE', 'CATALOG_FILENAME_CONFLICT'].includes(results.find(r => r.status === 'rejected').reason.code))
  const repaired = c.repo.get('games', row.id)
  assert.notEqual(repaired.storage_key, row.storage_key)
  await link(await c.storage.pathFor('games', repaired.storage_key), join(c.root, 'hardlink'))
  await assert.rejects(c.repo.publish('games', c.actor, args, await stage(), { restoreId: row.id }), /tidak aman/)
  assert.equal(c.repo.get('games', row.id).storage_key, repaired.storage_key)
})

test('metadata inspection is finalized before a multi-page native SQLite backup under forced garbage collection', async t => {
  const c = await setup(t)
  const insert = c.db.prepare(`INSERT INTO games (id, title, console_id, description, original_name, storage_key, size, sha256, created_at, updated_at)
    VALUES (?, 'GC fixture', 'nes', ?, 'fixture.nes', ?, 1, ?, 1, 1)`)
  c.db.exec('BEGIN IMMEDIATE')
  for (let n = 0; n < 2000; n++) insert.run(randomUUID(), 'x'.repeat(2000), randomUUID() + '.bin', n.toString(16).padStart(64, '0'))
  c.db.exec('COMMIT')
  assert.ok(c.db.prepare('PRAGMA page_count').get().page_count > 100)
  c.close()
  const target = join(c.root, 'gc-backup')
  const script = `import { createDataBackup } from './server/data-backup.mjs';
    const timer = setInterval(() => globalThis.gc(), 1);
    try { await createDataBackup(${JSON.stringify(c.config)}, ${JSON.stringify(target)}); console.log('complete'); }
    finally { clearInterval(timer); }`
  const child = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000 })
  assert.equal(child.status, 0, child.stderr || child.error?.message)
  assert.match(child.stdout, /complete/)
  const manifest = await verifyDataBackup(c.config, target)
  assert.equal(manifest.counts.games, 2000)
  assert.equal(manifest.files.length, 1)
})
