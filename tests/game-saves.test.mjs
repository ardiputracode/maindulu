import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createApp } from '../server/app.mjs'
import { schemaVersion } from '../server/database.mjs'
import { backendFixture } from './helpers/backend-fixture.mjs'
import { decodeGameSave, encodeGameSave, gameSaveLayout, MAX_GAME_SAVE_BYTES } from '../src/lib/game-save-format.ts'
import { GameSaveSync, readGameSave } from '../src/lib/game-saves.ts'
import { SaveError } from '../src/lib/saves.ts'
import { resetAccountByAdmin } from '../server/auth/mutations.mjs'

const origin = { host: 'localhost:7777', origin: 'http://localhost:7777', 'sec-fetch-site': 'same-origin' }
const metadata = { formatVersion: 1, engineVersion: '4.2.3', coreBuild: 'a'.repeat(64), runtimeBuild: 'b'.repeat(64), variant: 'legacy', layout: 'nes-sram-v1' }
const checksum = bytes => createHash('sha256').update(bytes).digest('hex')
const bundle = (n = 1, size = 8192, layout = 'nes-sram-v1') => encodeGameSave({ layout, files: [{ key: 'sram', bytes: new Uint8Array(size).fill(n) }] })
async function setup(t, env = {}) {
  const c = { app: null }
  c.root = await backendFixture(t, { beforeCleanup: () => c.app?.close() })
  c.env = env; c.app = await createApp({ root: c.root, env })
  return c
}
const cookie = r => String(r.headers['set-cookie']).split(';')[0]
async function register(app, username = 'progress_owner') {
  const boot = await app.inject({ url: '/api/auth/csrf', headers: origin })
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { ...origin, cookie: cookie(boot), 'x-csrf-token': boot.json().csrfToken }, payload: { username, password: 'Save123', passwordConfirmation: 'Save123' } })
  assert.equal(r.statusCode, 201, r.body)
  return { user: r.json().user, headers: { ...origin, cookie: cookie(r), 'x-csrf-token': r.json().csrfToken, 'x-save-user': r.json().user.id } }
}
function put(app, owner, bytes = bundle(), overrides = {}, headers = {}) {
  const v = { gameId: 'battery-proof', consoleId: 'nes', core: 'fceumm', title: 'Battery proof', expectedRevision: 0, checksum: checksum(bytes), metadata, ...overrides }
  return app.inject({ method: 'PUT', url: '/api/game-saves/', headers: { ...owner.headers, 'content-type': 'application/octet-stream', 'x-save-metadata': encodeURIComponent(JSON.stringify(v)), ...headers }, payload: Buffer.from(bytes) })
}
const list = (app, owner) => app.inject({ url: '/api/game-saves/', headers: owner.headers })
const get = (app, owner, id) => app.inject({ url: '/api/game-saves/' + id, headers: owner.headers })
const remove = (app, owner, save) => app.inject({ method: 'POST', url: '/api/game-saves/' + save.id + '/delete', headers: owner.headers, payload: { expectedRevision: save.revision } })

test('game save envelopes validate bounds/layout/components without accepting filesystem paths', () => {
  for (const layout of ['nes-sram-v1', 'ps1-active-memcard-v1']) {
    const bytes = bundle(0, 131072, layout)
    const decoded = decodeGameSave(bytes)
    assert.equal(decoded.layout, layout)
    assert.equal(decoded.files[0].key, 'sram')
    assert.deepEqual(decoded.files[0].bytes, new Uint8Array(131072)) // zeros can be valid
    assert.deepEqual(encodeGameSave(decoded), bytes)
  }
  assert.equal(gameSaveLayout('mgba'), null)
  for (const bytes of [new Uint8Array(), new Uint8Array(MAX_GAME_SAVE_BYTES + 1), bundle().subarray(0, 100), new TextEncoder().encode('RASTATE not an SRAM package')]) assert.throws(() => decodeGameSave(bytes))
  assert.throws(() => encodeGameSave({ layout: 'nes-sram-v1', files: [{ key: '../escape', bytes: new Uint8Array(1) }] }))
  assert.throws(() => encodeGameSave({ layout: 'nes-sram-v1', files: [] }))
  assert.throws(() => encodeGameSave({ layout: 'nes-sram-v1', files: [{ key: 'sram', bytes: new Uint8Array() }] }))
})

test('game progress persists separately from state, survives restart, validates checksum and remains private', async t => {
  const c = await setup(t)
  const owner = await register(c.app)
  const bytes = bundle()
  const r = await put(c.app, owner, bytes)
  assert.equal(r.statusCode, 201, r.body)
  const save = r.json().save
  assert.ok(readGameSave(save))
  assert.equal(save.revision, 1)
  assert.deepEqual((await get(c.app, owner, save.id)).rawPayload, Buffer.from(bytes))
  const row = c.app.database.prepare('SELECT * FROM game_saves').get()
  assert.deepEqual(await readFile(join(c.root, 'data/game-saves', row.blob_key)), Buffer.from(bytes))
  assert.equal((await c.app.inject('/game-saves/' + row.blob_key)).statusCode, 404)
  assert.equal((await get(c.app, owner, save.id)).headers['cache-control'], 'no-store')
  await c.app.close(); c.app = await createApp({ root: c.root, env: c.env })
  assert.deepEqual((await get(c.app, owner, save.id)).rawPayload, Buffer.from(bytes))
  assert.equal((await list(c.app, owner)).json().saves.length, 1)
  assert.equal(c.app.database.prepare('SELECT COUNT(*) AS n FROM saves').get().n, 0)
})

test('account ownership, CSRF, revoked sessions, invalid layouts and oversized game packages are rejected', async t => {
  const { app } = await setup(t, { MAIN_DULU_GAME_SAVE_MAX_BYTES: '16384' })
  const a = await register(app, 'progress_a'), b = await register(app, 'progress_b')
  const saved = (await put(app, a)).json().save
  assert.equal((await app.inject('/api/game-saves/')).statusCode, 401)
  assert.equal((await get(app, b, saved.id)).statusCode, 404)
  assert.equal((await remove(app, b, saved)).statusCode, 404)
  assert.deepEqual((await list(app, b)).json().saves, [])
  assert.equal((await put(app, b, bundle(), {}, { 'x-save-user': a.user.id })).json().code, 'ACCOUNT_CHANGED')
  for (const overrides of [{ gameId: '../escape' }, { gameId: 'local-nes-bad' }, { consoleId: 'psx' }, { core: 'mgba' }, { metadata: { ...metadata, layout: '../path' } }, { expectedRevision: -1 }, { checksum: 'a'.repeat(64) }]) assert.equal((await put(app, b, bundle(), overrides)).statusCode, 400)
  assert.equal((await put(app, b, bundle(), {}, { 'x-csrf-token': 'a'.repeat(64) })).statusCode, 403)
  assert.equal((await put(app, b, bundle(), {}, { origin: 'https://evil.example' })).statusCode, 403)
  assert.equal((await put(app, b, bundle(1, 16384))).statusCode, 413)
  await resetAccountByAdmin(app.database, a.user.username, 'Other123', 'Other123')
  assert.equal((await put(app, a, bundle(2), { expectedRevision: 1 })).statusCode, 401)
  assert.equal(app.database.prepare('SELECT user_id FROM game_saves').get().user_id, a.user.id)
})

test('PS1 active-card envelopes are accepted but not confused with NES layouts', async t => {
  const { app } = await setup(t)
  const a = await register(app)
  const bytes = bundle(0, 131072, 'ps1-active-memcard-v1')
  const r = await put(app, a, bytes, { consoleId: 'psx', core: 'pcsx_rearmed', metadata: { ...metadata, layout: 'ps1-active-memcard-v1' } })
  assert.equal(r.statusCode, 201, r.body)
  assert.equal((await put(app, a, bytes)).statusCode, 400)
})

test('game progress retry is idempotent only for the exact immediate write; deletion keeps revision', async t => {
  const { app } = await setup(t)
  const a = await register(app)
  const first = (await put(app, a)).json().save
  assert.equal((await put(app, a)).json().save.revision, 1)
  assert.equal((await put(app, a, bundle(2))).json().code, 'REVISION_CONFLICT')
  assert.equal((await remove(app, a, first)).statusCode, 200)
  assert.equal((await put(app, a)).json().code, 'REVISION_CONFLICT')
  assert.equal((await put(app, a, bundle(3), { expectedRevision: 2 })).json().save.revision, 3)
})

test('M5 and M6 share transactional quota including replacements across two server connections', async t => {
  const c = await setup(t, { MAIN_DULU_SAVE_QUOTA_BYTES: '2048' })
  const a = await register(c.app)
  const state = Buffer.alloc(900); state.write('RASTATE')
  const s = await c.app.inject({ method: 'PUT', url: '/api/saves/', headers: { ...a.headers, 'content-type': 'application/octet-stream', 'x-save-metadata': encodeURIComponent(JSON.stringify({ gameId: 'battery-proof', consoleId: 'nes', core: 'fceumm', title: 'Proof', slot: 1, expectedRevision: 0, checksum: checksum(state), metadata })) }, payload: state })
  assert.equal(s.statusCode, 201, s.body)
  const other = await createApp({ root: c.root, env: c.env })
  try {
    const responses = await Promise.all([put(c.app, a, bundle(1, 700)), put(other, a, bundle(2, 700), { gameId: 'other' })])
    assert.deepEqual(responses.map(r => r.statusCode).sort(), [201, 409])
    const saved = responses.find(r => r.statusCode === 201).json().save
    const oldUsage = (await c.app.inject({ url: '/api/saves/', headers: a.headers })).json().usage.usedBytes
    assert.equal(oldUsage, 900 + bundle(1, 700).length)
    assert.equal((await put(c.app, a, bundle(4, 600), { gameId: saved.gameId, expectedRevision: 1 })).statusCode, 200)
    const larger = Buffer.alloc(1400); larger.write('RASTATE')
    const r = await c.app.inject({ method: 'PUT', url: '/api/saves/', headers: { ...a.headers, 'content-type': 'application/octet-stream', 'x-save-metadata': encodeURIComponent(JSON.stringify({ gameId: 'battery-proof', consoleId: 'nes', core: 'fceumm', title: 'Proof', slot: 1, expectedRevision: 1, checksum: checksum(larger), metadata })) }, payload: larger })
    assert.equal(r.json().code, 'QUOTA_EXCEEDED')
  } finally { await other.close() }
})

test('M6 failed commit preserves bytes; restart cleanup is isolated and corrupted saves are not empty', async t => {
  const c = await setup(t)
  const a = await register(c.app)
  const save = (await put(c.app, a)).json().save
  const key = c.app.database.prepare('SELECT blob_key FROM game_saves').get().blob_key
  c.app.database.exec("CREATE TRIGGER fail_progress BEFORE UPDATE ON game_saves BEGIN SELECT RAISE(ABORT, 'fixture'); END")
  assert.equal((await put(c.app, a, bundle(2), { expectedRevision: 1 })).statusCode, 500)
  assert.deepEqual((await get(c.app, a, save.id)).rawPayload, Buffer.from(bundle()))
  assert.deepEqual(await readdir(join(c.root, 'data/game-saves')), [key])
  await writeFile(join(c.root, 'data/game-saves/11111111-1111-4111-8111-111111111111.tmp'), 'leftover')
  await c.app.close(); c.app = await createApp({ root: c.root, env: c.env })
  assert.deepEqual(await readdir(join(c.root, 'data/game-saves')), [key])
  await writeFile(join(c.root, 'data/game-saves', key), 'corrupt')
  assert.equal((await get(c.app, a, save.id)).json().code, 'SAVE_DAMAGED')
  assert.equal((await put(c.app, a)).json().code, 'SAVE_DAMAGED') // replay cannot acknowledge a missing/damaged blob
})

function fakeSync({ initial = null, capture = async () => bundle(), putProgress = async (_bytes, v) => ({ revision: v.expectedRevision + 1, checksum: v.checksum }) } = {}) {
  const calls = [], views = []
  const client = { listProgress: async () => ({ saves: initial ? [initial] : [], usage: { maxGameSaveBytes: MAX_GAME_SAVE_BYTES } }), getProgress: async () => bundle(), putProgress: async (bytes, v) => { calls.push({ bytes, ...v }); return putProgress(bytes, v) }, close() {} }
  const sync = new GameSaveSync(client, { gameId: 'proof', consoleId: 'nes', core: 'fceumm', title: 'Proof' }, capture, view => views.push(view))
  return { sync, calls, views, client }
}
test('sync requires initial fetch and actual capture, deduplicates checksums, and never changes conflict revisions', async () => {
  const c = fakeSync()
  c.sync.start(metadata)
  assert.equal(await c.sync.sync(), false)
  assert.equal(c.calls.length, 0)
  await c.sync.prepare(); c.sync.start(metadata)
  assert.equal(await c.sync.sync(), true)
  assert.equal(await c.sync.sync(), true)
  assert.equal(c.calls.length, 1)
  assert.equal(c.views.at(-1).status, 'saved')
  const conflict = fakeSync({ putProgress: async () => { throw new SaveError('conflict', 409, 'REVISION_CONFLICT') } })
  await conflict.sync.prepare(); conflict.sync.start(metadata)
  assert.equal(await conflict.sync.sync(true), false)
  assert.equal(await conflict.sync.sync(true), false)
  assert.equal(conflict.calls.length, 1)
  assert.equal(conflict.calls[0].expectedRevision, 0)
  assert.equal(conflict.views.at(-1).status, 'conflict')
})
test('failed initial fetch cannot upload, absent SRAM cannot erase server, and closed account ignores results', async () => {
  const c = fakeSync()
  c.client.listProgress = async () => { throw new Error('network') }
  await assert.rejects(c.sync.prepare())
  c.sync.start(metadata); await c.sync.sync(true)
  assert.equal(c.calls.length, 0)
  const empty = fakeSync({ capture: async () => null })
  await empty.sync.prepare(); empty.sync.start(metadata)
  assert.equal(await empty.sync.sync(), true)
  assert.equal(empty.calls.length, 0)
  empty.sync.close(); await empty.sync.sync(true)
  assert.equal(empty.sync.snapshot(), null)
})
test('automatic retries are bounded and preserve the pending payload after an uncertain commit', async () => {
  let value = 1
  const c = fakeSync({ capture: async () => bundle(value), putProgress: async () => { throw new SaveError('network') } })
  await c.sync.prepare(); c.sync.start(metadata)
  const now = Date.now
  let time = now()
  Date.now = () => time
  try {
    for (let i = 0; i < 7; i++) { time += 100000; await c.sync.sync(); value++ }
    assert.equal(c.calls.length, 4) // initial + 3 automatic retries
    assert.ok(c.calls.every(call => call.checksum === c.calls[0].checksum && call.expectedRevision === 0))
    assert.equal(c.views.at(-1).status, 'failed')
  } finally { Date.now = now; c.sync.close() }
})

test('a lost upload response is reconciled without skipping a newer captured snapshot or raising its stale revision', async () => {
  let value = 1, attempt = 0
  const committed = new Map()
  const c = fakeSync({ capture: async () => bundle(value), putProgress: async (_bytes, v) => {
    attempt++
    if (attempt === 1) { committed.set(1, v.checksum); throw new SaveError('response lost') }
    if (attempt === 2) {
      assert.equal(v.checksum, committed.get(1))
      assert.equal(v.expectedRevision, 0)
      return { revision: 1, checksum: v.checksum }
    }
    assert.equal(v.expectedRevision, 1)
    return { revision: 2, checksum: v.checksum }
  } })
  await c.sync.prepare(); c.sync.start(metadata)
  assert.equal(await c.sync.sync(true), false)
  value = 2
  assert.equal(await c.sync.sync(true), true)
  assert.equal(c.calls.length, 3)
  assert.equal(c.calls.at(-1).checksum, checksum(bundle(2)))
  assert.equal(c.views.at(-1).pending, false)
})

test('missing active SRAM after a successful restore cannot erase or acknowledge server progress', async () => {
  const c = fakeSync({ initial: { gameId: 'proof', consoleId: 'nes', core: 'fceumm', revision: 7, checksum: checksum(bundle()), deleted: false, metadata }, capture: async () => null })
  await c.sync.prepare(); c.sync.start(metadata)
  assert.equal(await c.sync.sync(true), false)
  assert.equal(c.calls.length, 0)
  assert.equal(c.views.at(-1).status, 'failed')
  assert.deepEqual(c.sync.snapshot(), bundle())
})

test('migration from an M5 version-4 database preserves existing state ownership and bytes', async t => {
  const c = await setup(t)
  const a = await register(c.app)
  const state = Buffer.alloc(700); state.write('RASTATE')
  const r = await c.app.inject({ method: 'PUT', url: '/api/saves/', headers: { ...a.headers, 'content-type': 'application/octet-stream', 'x-save-metadata': encodeURIComponent(JSON.stringify({ gameId: 'old', consoleId: 'nes', core: 'fceumm', title: 'Old state', slot: 1, expectedRevision: 0, checksum: checksum(state), metadata })) }, payload: state })
  assert.equal(r.statusCode, 201, r.body)
  const save = r.json().save
  c.app.database.exec('DROP TABLE games; DROP TABLE bios; ALTER TABLE users DROP COLUMN role; DROP TABLE save_backups; DROP TABLE save_decisions; DROP TABLE game_saves; DELETE FROM schema_migrations WHERE version >= 5; PRAGMA user_version = 4;')
  await c.app.close(); c.app = await createApp({ root: c.root, env: c.env })
  assert.equal(c.app.database.prepare('PRAGMA user_version').get().user_version, schemaVersion)
  assert.equal(c.app.database.prepare('SELECT user_id FROM saves').get().user_id, a.user.id)
  const got = await c.app.inject({ url: '/api/saves/' + save.id, headers: a.headers })
  assert.deepEqual(got.rawPayload, state)
  assert.equal((await put(c.app, a)).statusCode, 201)
})
