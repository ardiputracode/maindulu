import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { backendFixture } from './helpers/backend-fixture.mjs'
import { readConfig } from '../server/config.mjs'
import { openDatabase } from '../server/database.mjs'
import { createCatalogStorage } from '../server/catalog/storage.mjs'
import { createCatalogRepository } from '../server/catalog/repository.mjs'
import { createDataBackup, restoreDataBackup, verifyDataBackup } from '../server/data-backup.mjs'

async function setup(t) {
  const c = { db: null }
  c.root = await backendFixture(t, { beforeCleanup: () => { if (c.db?.isOpen) c.db.close() } })
  c.config = await readConfig({}, c.root)
  c.db = await openDatabase(c.config.dataDir)
  c.actor = randomUUID()
  c.db.prepare('INSERT INTO users (id, username, password_hash, recovery_code_hash, created_at, role) VALUES (?, ?, ?, ?, ?, ?)').run(c.actor, 'backup_admin', 'test-only', 'test-only', Date.now(), 'admin')
  c.storage = await createCatalogStorage(c.config)
  c.repo = createCatalogRepository(c.db, c.storage)
  c.publish = async (kind = 'games') => c.repo.publish(kind, c.actor, { [kind === 'games' ? 'title' : 'name']: 'Fixture', consoleId: 'nes', fileName: 'fixture.zip' }, await c.storage.stage(kind, Readable.from([Buffer.from('test bytes')])))
  c.close = () => { c.db.close(); c.db = null }
  return c
}

test('empty schema-8 catalogs preserve account/save backup behavior and include explicit zero counts', async t => {
  const c = await setup(t)
  c.close()
  const target = join(c.root, 'empty-backup')
  const manifest = await createDataBackup(c.config, target)
  assert.equal(manifest.schemaVersion, 8)
  assert.equal(manifest.counts.games, 0)
  assert.equal(manifest.counts.bios, 0)
  assert.deepEqual(await verifyDataBackup(c.config, target), manifest)
  const restored = join(c.root, 'empty-restored')
  await restoreDataBackup(c.config, target, restored)
  c.db = await openDatabase(restored)
  assert.equal(c.db.prepare('SELECT role FROM users').get().role, 'admin')
  assert.equal(c.db.prepare('PRAGMA user_version').get().user_version, 8)
})

test('backup fails closed for game/BIOS metadata, tombstones and orphan assets without publishing partial backups', async t => {
  for (const scenario of ['games', 'bios', 'tombstone', 'metadata-only', 'orphan-game', 'orphan-bios', 'orphan-cover']) {
    await t.test(scenario, async t => {
      const c = await setup(t)
      if (['games', 'bios', 'tombstone', 'metadata-only'].includes(scenario)) {
        const row = await c.publish(scenario === 'bios' ? 'bios' : 'games')
        if (scenario === 'tombstone') c.repo.delete('games', c.actor, row.id)
        if (scenario === 'metadata-only') {
          // A catalog with lost bytes must not be mislabeled an account-only backup.
          await unlink(join(c.config.dataDir, 'games', row.storage_key))
        }
      } else {
        const folder = { 'orphan-game': 'games', 'orphan-bios': 'bios', 'orphan-cover': 'covers' }[scenario]
        await writeFile(join(c.config.dataDir, folder, randomUUID() + '.bin'), 'orphan')
      }
      c.close()
      const destination = join(c.root, 'must-not-publish')
      await assert.rejects(createDataBackup(c.config, destination), /Katalog backup.*Milestone 7/)
      await assert.rejects(readFile(join(destination, 'manifest.json')), { code: 'ENOENT' })
      assert.equal((await readdir(c.root)).some(name => name.includes('.partial-')), false)
      const cli = spawnSync(process.execPath, ['scripts/data-backup.mjs', 'backup', destination], { encoding: 'utf8', env: { ...process.env, MAIN_DULU_DATA_DIR: c.config.dataDir }, timeout: 15000 })
      assert.equal(cli.status, 1)
      assert.match(cli.stderr, /Katalog backup.*Milestone 7/)
      assert.doesNotMatch(cli.stderr, /\n\s+at |SELECT|password_hash/)
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
  legacy.exec('DROP TABLE games; DROP TABLE bios; DELETE FROM schema_migrations WHERE version = 8; PRAGMA user_version = 7;')
  legacy.close()
  const original = await readFile(path)
  manifest.schemaVersion = 7
  delete manifest.counts.games
  delete manifest.counts.bios
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
  assert.equal(c.db.prepare('PRAGMA user_version').get().user_version, 8)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM games').get().n, 0)
  assert.deepEqual(await readFile(path), original)
  const sourceDb = new DatabaseSync(join(c.config.dataDir, 'maindulu.sqlite'))
  sourceDb.exec('DROP TABLE games; DROP TABLE bios; DELETE FROM schema_migrations WHERE version = 8; PRAGMA user_version = 7;')
  sourceDb.close()
  await assert.rejects(createDataBackup(c.config, join(c.root, 'legacy-source-refused')), /Versi skema backup/)
})

test('manifest schema cannot disguise a database version mismatch or unsupported catalog-bearing backup', async t => {
  const c = await setup(t)
  c.close()
  const source = join(c.root, 'tampered-backup')
  const manifest = await createDataBackup(c.config, source)
  manifest.schemaVersion = 7
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))
  await assert.rejects(verifyDataBackup(c.config, source), /Metadata manifest/)
  manifest.schemaVersion = 8
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
