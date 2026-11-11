import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { createApp } from './helpers/gated-backend.mjs'
import { readConfig } from './helpers/gated-backend.mjs'
import { resetAccountByAdmin } from '../server/auth/mutations.mjs'
import { backendFixture } from './helpers/backend-fixture.mjs'
import { compatibleState, readSaveList, readServerSave, readStateMetadata } from '../src/lib/saves.ts'

const origin = { host: 'localhost:7777', origin: 'http://localhost:7777', 'sec-fetch-site': 'same-origin' }
const password = 'Save123'
const metadata = { formatVersion: 1, engineVersion: '4.2.3', coreBuild: 'a'.repeat(64), runtimeBuild: 'b'.repeat(64), variant: 'normal' }
const checksum = bytes => createHash('sha256').update(bytes).digest('hex')
const state = (size = 700, value = 1) => { const bytes = Buffer.alloc(size, value); bytes.write('RASTATE'); return bytes }
async function setup(t, env = {}) {
  const context = { app: null }
  context.root = await backendFixture(t, { beforeCleanup: () => context.app?.close() })
  context.app = await createApp({ root: context.root, env })
  return context
}
const cookie = r => String(r.headers['set-cookie']).split(';')[0]
async function register(app, username = 'save_owner') {
  const bootstrap = await app.inject({ url: '/api/auth/csrf', headers: origin })
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { ...origin, cookie: cookie(bootstrap), 'x-csrf-token': bootstrap.json().csrfToken }, payload: { username, password, passwordConfirmation: password } })
  assert.equal(response.statusCode, 201, response.body)
  return { headers: { ...origin, cookie: cookie(response), 'x-csrf-token': response.json().csrfToken, 'x-save-user': response.json().user.id }, user: response.json().user }
}
function put(app, owner, bytes = state(), overrides = {}, headers = {}) {
  const v = { gameId: 'jalan-pulang', title: 'Jalan Pulang', consoleId: 'nes', core: 'fceumm', slot: 1, expectedRevision: 0, metadata, checksum: checksum(bytes), ...overrides }
  return app.inject({ method: 'PUT', url: '/api/saves/', headers: { ...owner.headers, 'content-type': 'application/octet-stream', 'x-save-metadata': encodeURIComponent(JSON.stringify(v)), ...headers }, payload: bytes })
}
const list = (app, owner) => app.inject({ url: '/api/saves/', headers: owner.headers })
const get = (app, owner, id) => app.inject({ url: '/api/saves/' + id, headers: owner.headers })
const remove = (app, owner, save, revision = save.revision) => app.inject({ method: 'POST', url: '/api/saves/' + save.id + '/delete', headers: owner.headers, payload: { expectedRevision: revision } })

test('server state round-trip persists file/checksum/metadata across restart and never exposes private blobs', async t => {
  const c = await setup(t)
  const owner = await register(c.app)
  const response = await put(c.app, owner)
  assert.equal(response.statusCode, 201, response.body)
  const { save, usage } = response.json()
  assert.equal(save.revision, 1)
  assert.equal(save.size, 700)
  assert.equal(usage.usedBytes, 700)
  assert.equal(usage.slots, 3)
  assert.deepEqual(save.metadata, metadata)
  const row = c.app.database.prepare('SELECT * FROM saves').get()
  assert.deepEqual(await readFile(join(c.root, 'data/saves', row.blob_key)), state())
  const downloaded = await get(c.app, owner, save.id)
  assert.deepEqual(downloaded.rawPayload, state())
  assert.equal(downloaded.headers['cache-control'], 'no-store')
  assert.equal(JSON.parse(decodeURIComponent(downloaded.headers['x-save-metadata'])).checksum, checksum(state()))
  for (const url of ['/data/saves/' + row.blob_key, '/saves/' + row.blob_key, '/assets/../data/saves/' + row.blob_key]) assert.equal((await c.app.inject(url)).statusCode, 404)
  await c.app.close()
  c.app = await createApp({ root: c.root, env: {} })
  assert.deepEqual((await get(c.app, owner, save.id)).rawPayload, state())
  assert.ok(readSaveList((await list(c.app, owner)).json()))
})

test('v20 to v21 rebuild preserves revisions and tombstones, then enables the dedicated Save & exit slot', async t => {
  const c = await setup(t)
  const owner = await register(c.app)
  const manual = (await put(c.app, owner, state(700, 1), { slot: 1 })).json().save
  const autosave = (await put(c.app, owner, state(700, 3), { slot: 99 })).json().save
  const deleted = (await put(c.app, owner, state(700, 4), { slot: 2 })).json().save
  assert.equal((await remove(c.app, owner, deleted)).statusCode, 200)
  const before = c.app.database.prepare('SELECT * FROM saves ORDER BY slot').all()

  // A real v20 database has no slot-100 row: rewind the table and migration log.
  await c.app.close()
  const snapshot = new DatabaseSync(join(c.root, 'data', 'maindulu.sqlite'))
  snapshot.exec(`CREATE TABLE saves_v20 (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id TEXT NOT NULL, console_id TEXT NOT NULL, core TEXT NOT NULL,
    slot INTEGER NOT NULL CHECK(slot = 99 OR slot BETWEEN 1 AND 3),
    title TEXT NOT NULL, metadata TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    size INTEGER NOT NULL CHECK(size >= 0), checksum TEXT NOT NULL,
    blob_key TEXT, updated_at INTEGER NOT NULL,
    UNIQUE(user_id, game_id, console_id, core, slot)
  ) STRICT;
  INSERT INTO saves_v20 SELECT id, user_id, game_id, console_id, core, slot, title, metadata,
    revision, size, checksum, blob_key, updated_at FROM saves;
  DROP TABLE saves;
  ALTER TABLE saves_v20 RENAME TO saves;
  CREATE INDEX saves_owner ON saves(user_id);
  DELETE FROM schema_migrations WHERE version >= 21;
  PRAGMA user_version = 20;`)
  snapshot.close()
  c.app = await createApp({ root: c.root, env: {} })

  assert.equal(c.app.database.prepare('PRAGMA user_version').get().user_version, 21)
  assert.equal(c.app.database.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 21').get().n, 1)
  assert.deepEqual(c.app.database.prepare('SELECT * FROM saves ORDER BY slot').all(), before)
  assert.deepEqual((await get(c.app, owner, manual.id)).rawPayload, state(700, 1))
  assert.deepEqual((await get(c.app, owner, autosave.id)).rawPayload, state(700, 3))
  const tombstone = (await list(c.app, owner)).json().saves.find(s => s.slot === 2)
  assert.equal(tombstone.deleted, true)
  assert.equal(tombstone.revision, deleted.revision + 1)

  const exit = await put(c.app, owner, state(700, 2), { slot: 100, title: 'Keluar' })
  assert.equal(exit.statusCode, 201, exit.body)
  assert.equal(exit.json().save.slot, 100)
  assert.deepEqual((await get(c.app, owner, exit.json().save.id)).rawPayload, state(700, 2))
  assert.deepEqual((await list(c.app, owner)).json().saves.find(s => s.slot === 1), { ...manual, deleted: false })
})

test('two accounts cannot list/read/delete another owner; identity header never selects an owner', async t => {
  const { app } = await setup(t)
  const a = await register(app, 'owner_a')
  const b = await register(app, 'owner_b')
  const save = (await put(app, a)).json().save
  assert.deepEqual((await list(app, b)).json().saves, [])
  assert.equal((await get(app, b, save.id)).statusCode, 404)
  assert.equal((await remove(app, b, save)).statusCode, 404)
  assert.equal((await get(app, { headers: { ...b.headers, 'x-save-user': a.user.id } }, save.id)).statusCode, 409)
  assert.equal((await app.inject('/api/saves/')).statusCode, 401)
  assert.equal((await put(app, b)).statusCode, 201)
  assert.equal((await list(app, a)).json().saves.length, 1)
})

test('quota counts only replacement delta; rejects excess without destroying old saves and recovers after chosen deletion', async t => {
  const { app } = await setup(t, { MAIN_DULU_SAVE_QUOTA_BYTES: '2048', MAIN_DULU_STATE_MAX_BYTES: '2048' })
  const owner = await register(app)
  const first = (await put(app, owner, state(1000))).json().save
  const second = (await put(app, owner, state(1000), { slot: 2 })).json().save
  const excess = await put(app, owner, state(1100), { expectedRevision: 1 })
  assert.equal(excess.statusCode, 409)
  assert.equal(excess.json().code, 'QUOTA_EXCEEDED')
  assert.deepEqual((await get(app, owner, first.id)).rawPayload, state(1000))
  const smaller = await put(app, owner, state(900), { expectedRevision: 1 })
  assert.equal(smaller.statusCode, 200)
  assert.equal(smaller.json().usage.usedBytes, 1900)
  assert.equal((await remove(app, owner, second)).statusCode, 200)
  const retry = await put(app, owner, state(1800), { expectedRevision: 2 })
  assert.equal(retry.statusCode, 200)
  assert.equal(retry.json().usage.usedBytes, 1800)
  assert.equal((await list(app, owner)).json().saves.find(s => s.slot === 2).deleted, true)
})

test('revision checks include deletion tombstones so stale retries cannot recreate a deleted slot', async t => {
  const { app } = await setup(t)
  const owner = await register(app)
  const save = (await put(app, owner)).json().save
  assert.equal((await put(app, owner)).json().code, 'REVISION_CONFLICT')
  assert.equal((await remove(app, owner, save, 0)).json().code, 'REVISION_CONFLICT')
  assert.equal((await remove(app, owner, save)).statusCode, 200)
  assert.equal((await put(app, owner, state(), { expectedRevision: 1 })).json().code, 'REVISION_CONFLICT')
  const restored = await put(app, owner, state(), { expectedRevision: 2 })
  assert.equal(restored.statusCode, 201)
  assert.equal(restored.json().save.id, save.id)
  assert.equal(restored.json().save.revision, 3)
})

test('concurrent connections cannot overwrite one revision or oversubscribe account quota', async t => {
  const c = await setup(t, { MAIN_DULU_SAVE_QUOTA_BYTES: '1024' })
  const owner = await register(c.app)
  const other = await createApp({ root: c.root, env: { MAIN_DULU_SAVE_QUOTA_BYTES: '1024' } })
  try {
    const responses = await Promise.all([put(c.app, owner), put(other, owner, state(), { slot: 2 })])
    assert.deepEqual(responses.map(r => r.statusCode).sort(), [201, 409])
    assert.equal((await list(c.app, owner)).json().usage.usedBytes, 700)
    const winning = responses.find(r => r.statusCode === 201).json().save
    const repeated = await Promise.all([put(c.app, owner, state(), { slot: winning.slot, expectedRevision: 1 }), put(other, owner, state(), { slot: winning.slot, expectedRevision: 1 })])
    assert.deepEqual(repeated.map(r => r.statusCode).sort(), [200, 409])
  } finally { await other.close() }
})

test('unsafe identifiers, kinds/slots, malformed metadata/checksums, non-state and oversized uploads are rejected', async t => {
  const { app, root } = await setup(t, { MAIN_DULU_STATE_MAX_BYTES: '1024' })
  const owner = await register(app)
  for (const overrides of [{ gameId: '../escape' }, { gameId: 'local-nes-title' }, { consoleId: 'nes', core: 'pcsx_rearmed' }, { consoleId: 'unknown' }, { gameId: null }, { slot: 0 }, { slot: 4 }, { expectedRevision: -1 }, { metadata: {} }, { checksum: 'a'.repeat(64) }, { title: '<x>\n' }]) assert.equal((await put(app, owner, state(), overrides)).statusCode, 400)
  assert.equal((await put(app, owner, Buffer.from('NES not a state'))).statusCode, 400)
  assert.equal((await put(app, owner, state(1025))).statusCode, 413)
  assert.equal((await put(app, owner, state(), {}, { 'x-save-metadata': '%invalid' })).statusCode, 400)
  assert.equal((await put(app, owner, state(), {}, { 'x-csrf-token': 'a'.repeat(64) })).statusCode, 403)
  assert.equal((await put(app, owner, state(), {}, { origin: 'https://evil.example' })).statusCode, 403)
  assert.deepEqual(await readdir(join(root, 'data/saves')), [])
})

test('failed metadata commit keeps old blob; coordinated restart cleans only crash leftovers and detects damaged content', async t => {
  const c = await setup(t)
  const owner = await register(c.app)
  const save = (await put(c.app, owner)).json().save
  const oldKey = c.app.database.prepare('SELECT blob_key FROM saves').get().blob_key
  c.app.database.exec("CREATE TRIGGER fail_save BEFORE UPDATE ON saves BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
  assert.equal((await put(c.app, owner, state(800), { expectedRevision: 1 })).statusCode, 500)
  assert.deepEqual((await get(c.app, owner, save.id)).rawPayload, state())
  assert.deepEqual(await readdir(join(c.root, 'data/saves')), [oldKey])
  await writeFile(join(c.root, 'data/saves', '11111111-1111-4111-8111-111111111111.tmp'), 'crash-leftover')
  await c.app.close()
  c.app = await createApp({ root: c.root, env: {} })
  assert.deepEqual(await readdir(join(c.root, 'data/saves')), [oldKey])
  await writeFile(join(c.root, 'data/saves', oldKey), state(700, 9))
  const damaged = await get(c.app, owner, save.id)
  assert.equal(damaged.statusCode, 503)
  assert.equal(damaged.json().code, 'SAVE_DAMAGED')
})

test('password change, recovery and admin reset revoke sessions but preserve real state ownership and bytes', async t => {
  const { app } = await setup(t)
  const owner = await register(app)
  const save = (await put(app, owner)).json().save
  const adminReset = await resetAccountByAdmin(app.database, owner.user.username, 'Next123', 'Next123')
  assert.equal((await get(app, owner, save.id)).statusCode, 401)
  const bootstrap = await app.inject({ url: '/api/auth/csrf', headers: origin })
  const logged = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...origin, cookie: cookie(bootstrap), 'x-csrf-token': bootstrap.json().csrfToken }, payload: { username: owner.user.username, password: 'Next123' } })
  const fresh = { user: logged.json().user, headers: { ...origin, cookie: cookie(logged), 'x-csrf-token': logged.json().csrfToken, 'x-save-user': logged.json().user.id } }
  assert.equal(fresh.user.id, owner.user.id)
  assert.deepEqual((await get(app, fresh, save.id)).rawPayload, state())
  const changed = await app.inject({ method: 'POST', url: '/api/auth/password', headers: fresh.headers, payload: { currentPassword: 'Next123', newPassword: password, passwordConfirmation: password } })
  assert.equal(changed.statusCode, 200)
  assert.equal((await get(app, fresh, save.id)).statusCode, 401)
  assert.equal(app.database.prepare('SELECT user_id FROM saves').get().user_id, owner.user.id)
  const guest = await app.inject({ url: '/api/auth/csrf', headers: origin })
  const guestHeaders = { ...origin, cookie: cookie(guest), 'x-csrf-token': guest.json().csrfToken }
  const recovered = await app.inject({ method: 'POST', url: '/api/auth/recover', headers: guestHeaders, payload: { username: owner.user.username, recoveryCode: adminReset.recoveryCode, newPassword: 'After123', passwordConfirmation: 'After123' } })
  assert.equal(recovered.statusCode, 200)
  const relogged = await app.inject({ method: 'POST', url: '/api/auth/login', headers: guestHeaders, payload: { username: owner.user.username, password: 'After123' } })
  assert.equal(relogged.statusCode, 200)
  const restored = { headers: { ...origin, cookie: cookie(relogged), 'x-save-user': relogged.json().user.id } }
  assert.equal(relogged.json().user.id, owner.user.id)
  assert.deepEqual((await get(app, restored, save.id)).rawPayload, state())
})

test('save contracts reject malformed responses and compare every compatibility field', async t => {
  const { app, root } = await setup(t)
  const config = await readConfig({}, root)
  assert.equal(config.saveQuotaBytes, 256 * 1024 * 1024)
  assert.equal(config.stateMaxBytes, 32 * 1024 * 1024)
  for (const v of ['', '-1', '0', '1.5', 'Infinity', '99999999999999']) await assert.rejects(readConfig({ MAIN_DULU_SAVE_QUOTA_BYTES: v }, root))
  assert.deepEqual(readStateMetadata(metadata), metadata)
  assert.equal(compatibleState(metadata, metadata), true)
  for (const key of ['formatVersion', 'engineVersion', 'coreBuild', 'runtimeBuild', 'variant']) assert.equal(compatibleState(metadata, { ...metadata, [key]: 'different' }), false)
  const owner = await register(app)
  const valid = (await list(app, owner)).json()
  assert.ok(readSaveList(valid))
  const autosaveSample = { id: '0123abcd-0000-4000-8000-000000000000', gameId: 'jalan-pulang', consoleId: 'nes', core: 'fceumm', title: 'Jalan Pulang', revision: 3, size: 5000, checksum: 'a'.repeat(64), updatedAt: Date.now(), deleted: false, metadata }
  assert.equal(readServerSave({ ...autosaveSample, slot: 99 })?.slot, 99)
  assert.equal(readServerSave({ ...autosaveSample, slot: 100 })?.slot, 100)
  assert.equal(readServerSave({ ...autosaveSample, slot: 4 }), null)
  for (const v of [null, {}, { ...valid, usage: { ...valid.usage, slots: 9 } }, { ...valid, saves: [{}] }]) assert.equal(readSaveList(v), null)
})
