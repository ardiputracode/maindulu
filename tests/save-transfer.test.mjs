import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { writeFile, readdir } from 'node:fs/promises'
import { createApp } from '../server/app.mjs'
import { schemaVersion } from '../server/database.mjs'
import { backendFixture } from './helpers/backend-fixture.mjs'
import { encodeGameSave } from '../src/lib/game-save-format.ts'
import { browserSaveBytes, validateImport } from '../src/lib/save-transfer.ts'
import { GameSaveSync } from '../src/lib/game-saves.ts'
import { readStateMetadata } from '../src/lib/saves.ts'

const origin = { host: 'localhost:7777', origin: 'http://localhost:7777', 'sec-fetch-site': 'same-origin' }
const metadata = { formatVersion: 1, engineVersion: '4.2.3', coreBuild: 'a'.repeat(64), runtimeBuild: 'b'.repeat(64), variant: 'legacy' }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const cookie = r => String(r.headers['set-cookie']).split(';')[0]
async function register(app, username = 'transfer_owner') {
  const b = await app.inject({ url: '/api/auth/csrf', headers: origin })
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { ...origin, cookie: cookie(b), 'x-csrf-token': b.json().csrfToken }, payload: { username, password: 'Save123', passwordConfirmation: 'Save123' } })
  assert.equal(r.statusCode, 201, r.body)
  return { ...origin, cookie: cookie(r), 'x-csrf-token': r.json().csrfToken, 'x-save-user': r.json().user.id }
}
async function setup(t, kind, env = {}) {
  const c = { app: null, env, kind }
  c.root = await backendFixture(t, { beforeCleanup: () => c.app?.close() })
  c.app = await createApp({ root: c.root, env })
  c.headers = await register(c.app)
  c.path = kind === 'state' ? '/api/saves/' : '/api/game-saves/'
  c.folder = join(c.root, 'data', kind === 'state' ? 'saves' : 'game-saves')
  c.bytes = n => {
    const native = new Uint8Array(700).fill(n)
    if (kind === 'progress') return Buffer.from(encodeGameSave({ layout: 'nes-sram-v1', files: [{ key: 'sram', bytes: native }] }))
    const state = Buffer.from(native); state.write('RASTATE'); return state
  }
  c.put = (n, rev = 0, operation, overrides = {}, app = c.app) => {
    const bytes = c.bytes(n)
    const v = { gameId: 'transfer-proof', title: 'Proof', consoleId: 'nes', core: 'fceumm', ...(kind === 'state' ? { slot: 1 } : {}), expectedRevision: rev, checksum: digest(bytes), metadata: { ...metadata, ...(kind === 'progress' ? { layout: 'nes-sram-v1' } : {}) }, operation, ...overrides }
    return app.inject({ method: 'PUT', url: c.path, headers: { ...c.headers, 'content-type': 'application/octet-stream', 'x-save-metadata': encodeURIComponent(JSON.stringify(v)) }, payload: bytes })
  }
  c.backups = () => c.app.inject({ url: '/api/save-backups/', headers: c.headers })
  c.getBackup = id => c.app.inject({ url: '/api/save-backups/' + id, headers: c.headers })
  c.op = (action = 'replace', reason = 'conflict') => ({ id: randomUUID(), action, reason })
  return c
}
for (const kind of ['state', 'progress']) {
  test(`M7 ${kind}: replacement retains bytes, restart preserves backups, replay is idempotent and restore creates a new revision`, async t => {
    const c = await setup(t, kind)
    const first = (await c.put(1)).json().save
    const op = c.op('replace', 'import')
    const r = await c.put(2, 1, op)
    assert.equal(r.statusCode, 200, r.body)
    assert.equal(r.json().save.revision, 2)
    const backupId = r.json().backupId
    assert.deepEqual((await c.getBackup(backupId)).rawPayload, c.bytes(1))
    assert.equal((await c.put(2, 1, op)).json().backupId, backupId)
    assert.equal((await c.put(3, 1, op)).json().code, 'OPERATION_CONFLICT')
    assert.equal((await c.backups()).json().backups.length, 1)
    assert.equal((await c.backups()).json().usage.usedBytes, c.bytes(1).length * 2)
    await c.app.close(); c.app = await createApp({ root: c.root, env: c.env })
    assert.deepEqual((await c.getBackup(backupId)).rawPayload, c.bytes(1))
    const restore = await c.put(1, 2, c.op('replace', 'restore'))
    assert.equal(restore.json().save.id, first.id)
    assert.equal(restore.json().save.revision, 3)
    assert.equal((await c.backups()).json().backups.length, 2)
    // Normal updates/deletion retain all archive references, never auto-prune.
    assert.equal((await c.put(4, 3)).statusCode, 200)
    assert.deepEqual((await c.getBackup(backupId)).rawPayload, c.bytes(1))
    await c.app.inject({ method: 'POST', url: c.path + first.id + '/delete', headers: c.headers, payload: { expectedRevision: 4 } })
    assert.equal((await c.backups()).json().backups.length, 2)
    const b = (await c.backups()).json().backups[0]
    assert.equal((await c.app.inject({ method: 'POST', url: '/api/save-backups/' + b.id + '/delete', headers: c.headers, payload: { checksum: b.checksum } })).statusCode, 200)
    assert.deepEqual((await c.getBackup(backupId)).rawPayload, c.bytes(1))
  })
  test(`M7 ${kind}: keeping server archives the local candidate without changing active or tombstone revision`, async t => {
    const c = await setup(t, kind)
    const first = (await c.put(1)).json().save
    const op = c.op('preserve')
    const r = await c.put(2, 1, op)
    assert.equal(r.statusCode, 200, r.body)
    assert.equal(r.json().save.revision, 1)
    assert.equal(r.json().save.checksum, digest(c.bytes(1)))
    assert.deepEqual((await c.getBackup(r.json().backupId)).rawPayload, c.bytes(2))
    assert.equal((await c.put(2, 1, op)).json().backupId, r.json().backupId)
    assert.equal((await c.backups()).json().backups.length, 1)
    await c.app.inject({ method: 'POST', url: c.path + first.id + '/delete', headers: c.headers, payload: { expectedRevision: 1 } })
    const preserved = await c.put(3, 2, c.op('preserve'))
    assert.equal(preserved.json().save.deleted, true)
    assert.equal(preserved.json().save.revision, 2)
    assert.equal((await c.put(3, 1, c.op())).json().code, 'REVISION_CONFLICT')
    assert.equal((await c.put(3, 2, c.op())).json().save.revision, 3)
  })
  test(`M7 ${kind}: combined quota, stale two-connection decisions, rollback and damaged source never destroy active`, async t => {
    const c = await setup(t, kind, { MAIN_DULU_SAVE_QUOTA_BYTES: '2048' })
    const first = (await c.put(1)).json().save
    const other = await createApp({ root: c.root, env: c.env })
    try {
      const responses = await Promise.all([c.put(2, 1, c.op()), c.put(3, 1, c.op(), {}, other)])
      assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 409])
      assert.equal((await c.backups()).json().backups.length, 1)
      assert.equal((await c.put(4, 2, c.op())).json().code, 'QUOTA_EXCEEDED')
      assert.equal((await c.backups()).json().backups.length, 1)
    } finally { await other.close() }
    const table = kind === 'state' ? 'saves' : 'game_saves'
    const active = c.app.database.prepare(`SELECT * FROM ${table}`).get()
    // Release quota for the deliberate rollback fixture, not by automatic pruning.
    const b = (await c.backups()).json().backups[0]
    await c.app.inject({ method: 'POST', url: '/api/save-backups/' + b.id + '/delete', headers: c.headers, payload: { checksum: b.checksum } })
    c.app.database.exec(`CREATE TRIGGER fail_m7 BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'fixture'); END`)
    assert.equal((await c.put(5, 2, c.op())).statusCode, 500)
    assert.equal((await c.backups()).json().backups.length, 0)
    assert.equal(digest((await c.app.inject({ url: c.path + first.id, headers: c.headers })).rawPayload), active.checksum)
    assert.equal((await readdir(c.folder)).length, 1)
    c.app.database.exec('DROP TRIGGER fail_m7')
    await writeFile(join(c.folder, active.blob_key), 'corrupt')
    assert.equal((await c.put(6, 2, c.op())).json().code, 'SAVE_DAMAGED')
  })
  test(`M7 ${kind}: backup ownership, CSRF and invalid operations/provenance`, async t => {
    const c = await setup(t, kind)
    await c.put(1)
    const r = await c.put(2, 1, c.op())
    const id = r.json().backupId
    const stranger = await register(c.app, 'other_owner')
    assert.equal((await c.app.inject({ url: '/api/save-backups/' + id, headers: stranger })).statusCode, 404)
    assert.equal((await c.app.inject('/api/save-backups/')).statusCode, 401)
    assert.equal((await c.app.inject({ url: '/api/save-backups/', headers: { ...stranger, 'x-save-user': c.headers['x-save-user'] } })).json().code, 'ACCOUNT_CHANGED')
    assert.equal((await c.app.inject({ method: 'POST', url: '/api/save-backups/' + id + '/delete', headers: { ...c.headers, 'x-csrf-token': 'wrong' }, payload: { checksum: digest(c.bytes(1)) } })).statusCode, 403)
    assert.equal((await c.put(3, 2, { id: '../bad', action: 'replace', reason: 'import' })).statusCode, 400)
    assert.equal((await c.put(3, 2, { id: [randomUUID()], action: 'replace', reason: 'import' })).statusCode, 400)
    if (kind === 'state') assert.equal((await c.put(3, 0, c.op('replace', 'import'), { slot: 99 })).statusCode, 400)
    const m = { ...metadata, ...(kind === 'progress' ? { layout: 'nes-sram-v1' } : {}), provenance: { source: 'file', sourceBuild: 'unknown', confirmedForTarget: true } }
    assert.equal((await c.put(3, 2, c.op('replace', 'import'), { metadata: m })).json().save.metadata.provenance.sourceBuild, 'unknown')
    assert.equal((await c.put(4, 3, c.op(), { metadata: { ...m, provenance: { source: 'file', sourceBuild: 'verified' } } })).statusCode, 400)
  })
}
test('M7 file validation distinguishes native data and state without claiming full binary compatibility', () => {
  assert.ok(validateImport(new Uint8Array(8192), 'progress', 'fceumm'))
  assert.ok(validateImport(new Uint8Array(131072), 'progress', 'pcsx_rearmed'))
  for (const bytes of [Buffer.from('NES\x1a rom'), Buffer.from('RASTATE ...'), Buffer.from('PK\x03\x04 zip'), new Uint8Array()]) assert.throws(() => validateImport(bytes, 'progress', 'fceumm'))
  assert.throws(() => validateImport(new Uint8Array(8192), 'progress', 'pcsx_rearmed'))
  assert.throws(() => validateImport(new Uint8Array(8192), 'state', 'fceumm'))
  assert.equal(readStateMetadata({ ...metadata, provenance: { source: 'file', sourceBuild: 'invented', confirmedForTarget: true } }), null)
})

test('M7 migrates a populated M6 database without changing accounts, game bytes or installation identity', async t => {
  const c = await setup(t, 'progress')
  const save = (await c.put(1)).json().save
  const installation = c.app.database.prepare("SELECT value FROM app_metadata WHERE key = 'installation_id'").get().value
  c.app.database.exec('ALTER TABLE users DROP COLUMN role; DROP TABLE save_backups; DROP TABLE save_decisions; DELETE FROM schema_migrations WHERE version >= 6; PRAGMA user_version = 5;')
  await c.app.close(); c.app = await createApp({ root: c.root, env: c.env })
  assert.equal(c.app.database.prepare('PRAGMA user_version').get().user_version, schemaVersion)
  assert.equal(c.app.database.prepare("SELECT value FROM app_metadata WHERE key = 'installation_id'").get().value, installation)
  assert.deepEqual((await c.app.inject({ url: c.path + save.id, headers: c.headers })).rawPayload, c.bytes(1))
  assert.equal((await c.backups()).json().backups.length, 0)
})

test('M7 browser binary copies preserve signed bytes, offsets and original storage without accepting arbitrary views', () => {
  const signed = new Int8Array([7, -1, -128, 0, 127, 9])
  const bytes = browserSaveBytes(signed.subarray(1, 5), 'progress')
  assert.deepEqual(bytes, new Uint8Array([255, 128, 0, 127]))
  bytes[0] = 3
  assert.equal(signed[1], -1)
  for (const value of [null, {}, [], new Uint8Array(), new Uint16Array([1]), new Uint8Array(8 * 1024 * 1024 + 1)]) assert.equal(browserSaveBytes(value, 'progress'), null)
})

test('M7 held progress cannot upload and an accepted decision discards stale pending baseline', async () => {
  let value = 1
  const calls = []
  const bytes = () => encodeGameSave({ layout: 'nes-sram-v1', files: [{ key: 'sram', bytes: new Uint8Array(32).fill(value) }] })
  const client = { close() {}, listProgress: async () => ({ saves: [], usage: { maxGameSaveBytes: 8192 } }), putProgress: async (_b, v) => { calls.push(v); return { revision: v.expectedRevision + 1, checksum: v.checksum } } }
  const sync = new GameSaveSync(client, { gameId: 'proof', consoleId: 'nes', core: 'fceumm', title: 'Proof' }, async () => bytes(), () => {})
  await sync.prepare(); sync.start({ ...metadata, layout: 'nes-sram-v1' })
  await sync.hold()
  assert.equal(await sync.sync(true), false)
  assert.equal(calls.length, 0)
  const captured = await sync.conflictSnapshot()
  sync.acceptDecision({ revision: 7, checksum: digest(captured) }, captured)
  sync.release()
  assert.equal(await sync.sync(true), true)
  assert.equal(calls.length, 0)
  value = 2
  await sync.sync(true)
  assert.equal(calls.at(-1).expectedRevision, 7)
  sync.close()
})
