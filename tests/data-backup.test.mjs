import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { cp, link, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { watch, mkdirSync, writeFileSync } from 'node:fs'
import { createApp } from '../server/app.mjs'
import { readConfig } from '../server/config.mjs'
import { acquireDataLock } from '../server/data-lock.mjs'
import { createDataBackup, restoreDataBackup, verifyDataBackup } from '../server/data-backup.mjs'
import { backendFixture } from './helpers/backend-fixture.mjs'
import { encodeGameSave } from '../src/lib/game-save-format.ts'

const origin = { host: 'localhost:7777', origin: 'http://localhost:7777', 'sec-fetch-site': 'same-origin' }
const metadata = { formatVersion: 1, engineVersion: '4.2.3', coreBuild: 'a'.repeat(64), runtimeBuild: 'b'.repeat(64), variant: 'legacy' }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const cookie = r => String(r.headers['set-cookie']).split(';')[0]
async function authenticate(app, username = 'backup_owner', action = 'register') {
  const b = await app.inject({ url: '/api/auth/csrf', headers: origin })
  const r = await app.inject({ method: 'POST', url: '/api/auth/' + action, headers: { ...origin, cookie: cookie(b), 'x-csrf-token': b.json().csrfToken }, payload: { username, password: 'Backup123', passwordConfirmation: 'Backup123' } })
  assert.equal(r.statusCode, action === 'register' ? 201 : 200, r.body)
  return { ...origin, cookie: cookie(r), 'x-csrf-token': r.json().csrfToken, 'x-save-user': r.json().user.id }
}
async function setup(t) {
  const c = { app: null }
  c.root = await backendFixture(t, { beforeCleanup: () => c.app?.close() })
  c.config = await readConfig({}, c.root)
  c.backup = join(c.root, 'backup')
  c.restored = join(c.root, 'restored')
  c.app = await createApp({ root: c.root, env: {} })
  c.headers = await authenticate(c.app)
  c.put = async (kind, n, rev = 0, operation, slot = 1, headers = c.headers) => {
    const native = new Uint8Array(700).fill(n)
    const bytes = kind === 'state' ? Buffer.from(native) : Buffer.from(encodeGameSave({ layout: 'nes-sram-v1', files: [{ key: 'sram', bytes: native }] }))
    if (kind === 'state') bytes.write('RASTATE')
    const v = { gameId: 'backup-game', title: 'Backup proof', consoleId: 'nes', core: 'fceumm', ...(kind === 'state' ? { slot } : {}), expectedRevision: rev, checksum: digest(bytes), metadata: { ...metadata, ...(kind === 'progress' ? { layout: 'nes-sram-v1' } : {}) }, operation }
    const r = await c.app.inject({ method: 'PUT', url: kind === 'state' ? '/api/saves/' : '/api/game-saves/', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-save-metadata': encodeURIComponent(JSON.stringify(v)) }, payload: bytes })
    assert.ok([200, 201].includes(r.statusCode), r.body)
    return { result: r.json(), bytes, v }
  }
  c.stop = async () => { await c.app.close(); c.app = null }
  return c
}

test('M8 restores accounts, all save types, tombstones, archives, receipts and quotas without reviving sessions', async t => {
  const c = await setup(t)
  const state = await c.put('state', 1)
  const operation = { id: randomUUID(), action: 'replace', reason: 'import' }
  const replaced = await c.put('state', 2, 1, operation)
  await c.put('state', 3, 0, undefined, 99)
  const removed = await c.put('state', 4, 0, undefined, 2)
  await c.app.inject({ method: 'POST', url: '/api/saves/' + removed.result.save.id + '/delete', headers: c.headers, payload: { expectedRevision: 1 } })
  const progress = await c.put('progress', 5)
  await c.put('progress', 6, 1, { id: randomUUID(), action: 'replace', reason: 'conflict' })
  const stranger = await authenticate(c.app, 'backup_stranger')
  await c.put('state', 7, 0, undefined, 1, stranger)
  const tables = ['users', 'app_metadata', 'schema_migrations', 'saves', 'game_saves', 'save_backups', 'save_decisions']
  const before = Object.fromEntries(tables.map(table => [table, c.app.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
  const usage = (await c.app.inject({ url: '/api/save-backups/', headers: c.headers })).json().usage
  await c.stop()
  const manifest = await createDataBackup(c.config, c.backup)
  assert.equal(manifest.counts.users, 2)
  assert.equal(manifest.counts.save_backups, 2)
  assert.equal(manifest.files.length, 7) // database, 4 states (incl. archive), 2 progress blobs
  assert.equal(manifest.configuration.saveQuotaBytes, 256 * 1024 * 1024)
  assert.ok(!JSON.stringify(manifest).includes(c.root))
  const backupDatabase = await readFile(join(c.backup, 'maindulu.sqlite'))
  assert.deepEqual(await verifyDataBackup(c.config, c.backup), manifest)
  await restoreDataBackup(c.config, c.backup, c.restored)
  assert.deepEqual(await readFile(join(c.backup, 'maindulu.sqlite')), backupDatabase)
  assert.deepEqual((await readdir(c.restored)).sort(), ['game-saves', 'maindulu.sqlite', 'saves'])
  c.app = await createApp({ root: c.root, env: { MAIN_DULU_DATA_DIR: c.restored } })
  for (const table of tables) assert.deepEqual(c.app.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), before[table], table)
  assert.equal(c.app.database.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0)
  assert.equal((await c.app.inject({ url: '/api/saves/', headers: c.headers })).statusCode, 401)
  const fresh = await authenticate(c.app, 'backup_owner', 'login')
  assert.equal(fresh['x-save-user'], c.headers['x-save-user'])
  assert.deepEqual((await c.app.inject({ url: '/api/save-backups/', headers: fresh })).json().usage, usage)
  assert.deepEqual((await c.app.inject({ url: '/api/saves/' + state.result.save.id, headers: fresh })).rawPayload, replaced.bytes)
  assert.equal((await c.app.inject({ url: '/api/game-saves/' + progress.result.save.id, headers: fresh })).statusCode, 200)
  assert.equal((await c.app.inject({ url: '/api/saves/' + state.result.save.id, headers: { ...fresh, 'x-save-user': stranger['x-save-user'] } })).statusCode, 409)
  const replay = await c.put('state', 2, 1, operation, 1, fresh)
  assert.equal(replay.result.backupId, replaced.result.backupId)
  assert.equal(replay.result.save.revision, 2)
  assert.equal(c.app.database.prepare('SELECT COUNT(*) AS n FROM save_backups').get().n, 2)
})

test('M8 exclusive maintenance excludes live server/admin connections in this and another process', async t => {
  const c = await setup(t)
  await assert.rejects(createDataBackup(c.config, c.backup), /Data sedang dipakai/)
  const cli = spawnSync(process.execPath, ['scripts/data-backup.mjs', 'backup', c.backup], { encoding: 'utf8', env: { ...process.env, MAIN_DULU_DATA_DIR: c.config.dataDir }, timeout: 15000 })
  assert.equal(cli.status, 1, cli.stderr)
  assert.match(cli.stderr, /Data sedang dipakai/)
  await c.stop()
  const release = await acquireDataLock(c.config.dataDir, true)
  try { await assert.rejects(createApp({ root: c.root, env: {} }), /Data sedang dipakai/) }
  finally { release() }
  await createDataBackup(c.config, c.backup)
  c.app = await createApp({ root: c.root, env: {} })
  await assert.rejects(restoreDataBackup(c.config, c.backup, c.restored), /Data sedang dipakai/)
  await c.stop()
  const target = await acquireDataLock(c.restored, true)
  try {
    await assert.rejects(restoreDataBackup(c.config, c.backup, c.restored), /Data sedang dipakai/)
    await assert.rejects(createApp({ root: c.root, env: { MAIN_DULU_DATA_DIR: c.restored } }), /Data sedang dipakai/)
    await assert.rejects(readdir(c.restored), { code: 'ENOENT' })
  }
  finally { target() }
})

test('M8 dead process leases are reclaimed but malformed/live-owner locks fail closed', async t => {
  const c = await setup(t)
  await c.stop()
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { openDatabase } from './server/database.mjs'; await openDatabase(${JSON.stringify(c.config.dataDir)}); console.log('locked'); setInterval(() => {}, 1000)`], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await once(child.stdout, 'data')
    await assert.rejects(createDataBackup(c.config, c.backup), /Data sedang dipakai/)
  } finally { const exited = once(child, 'exit'); child.kill(); await exited }
  await createDataBackup(c.config, c.backup)
  const lock = join(c.root, '.data.maindulu-lock', randomUUID() + '.json')
  for (const contents of ['{bad', 'null', '{}', '{"pid":0,"exclusive":true}']) {
    await writeFile(lock, contents)
    await assert.rejects(createDataBackup(c.config, join(c.root, 'other')), /Lock data rusak/)
  }
  await rm(lock)
  const release = await acquireDataLock(c.config.dataDir)
  release()
})

test('M8 backup consumes committed WAL and skips unreferenced crash leftovers without changing the source schema', async t => {
  const c = await setup(t)
  await c.stop()
  // Simulate a legacy process crash leaving committed pages in WAL. Such an old
  // process does not participate in leases; it MUST be stopped by the operator.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(${JSON.stringify(join(c.config.dataDir, 'maindulu.sqlite'))}); db.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO app_metadata VALUES ('wal-proof','retained')"); process.exit(0)`], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  await writeFile(join(c.config.dataDir, 'saves', randomUUID() + '.bin'), 'orphan')
  await createDataBackup(c.config, c.backup)
  assert.equal((await readdir(c.backup)).some(n => /wal|shm/.test(n)), false)
  const db = new DatabaseSync(join(c.backup, 'maindulu.sqlite'), { readOnly: true })
  try { assert.equal(db.prepare("SELECT value FROM app_metadata WHERE key='wal-proof'").get().value, 'retained') }
  finally { db.close() }
  assert.equal((await readdir(join(c.backup, 'saves'))).length, 0)
})

test('M8 missing/corrupt source blobs and unsupported schema fail without publishing partial backups or migrating', async t => {
  const c = await setup(t)
  await c.put('state', 1)
  const row = c.app.database.prepare('SELECT * FROM saves').get()
  await c.stop()
  const blob = join(c.config.dataDir, 'saves', row.blob_key)
  await writeFile(blob, 'corrupt')
  await assert.rejects(createDataBackup(c.config, c.backup), /Blob sumber/)
  await assert.rejects(readFile(join(c.backup, 'manifest.json')), { code: 'ENOENT' })
  assert.equal((await readdir(c.root)).some(n => n.includes('.partial-')), false)
  await rm(blob)
  await assert.rejects(createDataBackup(c.config, c.backup), { code: 'ENOENT' })
  for (const version of [5, 999]) {
    const db = new DatabaseSync(join(c.config.dataDir, 'maindulu.sqlite'))
    db.exec(`PRAGMA user_version=${version}`); db.close()
    await assert.rejects(createDataBackup(c.config, c.backup), /Versi skema/)
    const check = new DatabaseSync(join(c.config.dataDir, 'maindulu.sqlite'), { readOnly: true })
    try { assert.equal(check.prepare('PRAGMA user_version').get().user_version, version) } finally { check.close() }
  }
})

test('M8 verify/restore rejects tampering, missing files, unexpected files, invalid references and traversal manifests', async t => {
  const c = await setup(t)
  await c.put('state', 1)
  await c.stop()
  const manifest = await createDataBackup(c.config, c.backup)
  for (const mutation of ['checksum', 'missing', 'extra', 'traversal', 'duplicate', 'future', 'reference']) {
    const bad = join(c.root, mutation)
    await cp(c.backup, bad, { recursive: true })
    const m = structuredClone(manifest)
    if (mutation === 'checksum') await writeFile(join(bad, m.files[1].path), 'bad')
    if (mutation === 'missing') await rm(join(bad, m.files[1].path))
    if (mutation === 'extra') await writeFile(join(bad, 'maindulu.sqlite-wal'), 'bad')
    if (mutation === 'traversal') m.files[1].path = '../outside.bin'
    if (mutation === 'duplicate') m.files.push(m.files[1])
    if (mutation === 'future') m.formatVersion = 99
    if (mutation === 'reference') {
      const path = join(bad, 'maindulu.sqlite')
      const db = new DatabaseSync(path)
      db.prepare('UPDATE saves SET checksum = ?').run('f'.repeat(64)); db.close()
      const bytes = await readFile(path)
      m.files[0] = { path: 'maindulu.sqlite', size: bytes.length, checksum: digest(bytes) }
    }
    await writeFile(join(bad, 'manifest.json'), JSON.stringify(m))
    await assert.rejects(verifyDataBackup(c.config, bad), undefined, mutation)
    await assert.rejects(restoreDataBackup(c.config, bad, c.restored), undefined, mutation)
    await assert.rejects(readdir(c.restored), { code: 'ENOENT' })
  }
  assert.deepEqual(await verifyDataBackup(c.config, c.backup), manifest)
})

test('M8 refuses public/nested paths, existing targets and symlink/junction/hardlinked contents', async t => {
  const c = await setup(t)
  await c.put('state', 1)
  await c.stop()
  for (const path of [join(c.root, 'public/backup'), join(c.root, 'dist/backup'), join(c.config.dataDir, 'backup'), c.root]) await assert.rejects(createDataBackup(c.config, path))
  await symlink(join(c.root, 'public'), join(c.root, 'public-alias'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(createDataBackup(c.config, join(c.root, 'public-alias/backup')), /publik/)
  await createDataBackup(c.config, c.backup)
  await assert.rejects(createDataBackup(c.config, c.backup), /sudah ada/)
  await mkdir(c.restored)
  await writeFile(join(c.restored, 'keep'), 'unchanged')
  await assert.rejects(restoreDataBackup(c.config, c.backup, c.restored), /sudah ada/)
  assert.equal(await readFile(join(c.restored, 'keep'), 'utf8'), 'unchanged')
  const bad = join(c.root, 'linked-backup')
  await cp(c.backup, bad, { recursive: true })
  const file = (await readdir(join(bad, 'saves')))[0]
  await rm(join(bad, 'saves'), { recursive: true })
  await symlink(join(c.backup, 'saves'), join(bad, 'saves'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(verifyDataBackup(c.config, bad), /tidak aman/)
  await rm(join(bad, 'saves'))
  await mkdir(join(bad, 'saves'))
  await link(join(c.backup, 'saves', file), join(bad, 'saves', file))
  await assert.rejects(verifyDataBackup(c.config, bad), /tidak aman/)
  await rm(join(bad, 'saves', file))
})

test('M8 CLI creates/verifies/restores offline and returns safe nonzero errors', async t => {
  const c = await setup(t)
  await c.stop()
  const env = { ...process.env, MAIN_DULU_DATA_DIR: c.config.dataDir }
  for (const args of [['backup', c.backup], ['verify', c.backup], ['restore', c.backup, '--to', c.restored]]) {
    const r = spawnSync(process.execPath, ['scripts/data-backup.mjs', ...args], { encoding: 'utf8', env, timeout: 15000 })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /selesai|terverifikasi/)
  }
  for (const args of [[], ['restore', c.backup], ['verify', join(c.root, 'missing')], ['backup', c.backup]]) {
    const r = spawnSync(process.execPath, ['scripts/data-backup.mjs', ...args], { encoding: 'utf8', env, timeout: 15000 })
    assert.equal(r.status, 1, r.stderr)
    assert.doesNotMatch(r.stderr, /\n\s+at |password_hash|recovery_code_hash|CREATE TABLE/)
  }
})

test('M8 competing backup operations fail safely and publication failure preserves a new destination', async t => {
  const c = await setup(t)
  await c.put('state', 1)
  await c.stop()
  const results = await Promise.allSettled([createDataBackup(c.config, c.backup), createDataBackup(c.config, join(c.root, 'second'))])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.match(results.find(r => r.status === 'rejected').reason.message, /Data sedang dipakai/)
  const source = results[0].status === 'fulfilled' ? c.backup : join(c.root, 'second')
  // A real filesystem publication failure after staging, without test hooks in
  // production: another operator creates the destination while we copy.
  let occupied = false
  const watcher = watch(c.root, (_event, name) => {
    if (name?.startsWith('.restored.partial-') && !occupied) {
      occupied = true
      mkdirSync(c.restored)
      writeFileSync(join(c.restored, 'operator-file'), 'keep')
    }
  })
  try { await assert.rejects(restoreDataBackup(c.config, source, c.restored), /sudah ada/) }
  finally { watcher.close() }
  assert.equal(occupied, true)
  assert.equal(await readFile(join(c.restored, 'operator-file'), 'utf8'), 'keep')
  assert.equal((await readdir(c.root)).some(n => n.includes('.partial-')), false)
  await verifyDataBackup(c.config, source)
  // The failed restore released both locks; a new destination can be restored.
  await restoreDataBackup(c.config, source, join(c.root, 'retry'))
})
