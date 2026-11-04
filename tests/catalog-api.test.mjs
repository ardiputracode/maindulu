import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, rm, link, mkdir, rename, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import sharp from 'sharp'
import { createApp } from '../server/app.mjs'
import { csrfToken, hashToken } from '../server/auth/crypto.mjs'
import { openDatabase, schemaVersion } from '../server/database.mjs'
import { createCatalogStorage } from '../server/catalog/storage.mjs'
import { createCatalogMaintenance, enqueueCleanup } from '../server/catalog/maintenance.mjs'
import { backendFixture } from './helpers/backend-fixture.mjs'

const origin = { host: 'localhost:7777', origin: 'http://localhost:7777', 'sec-fetch-site': 'same-origin' }
const rom = Buffer.from('synthetic ROM bytes, not playable')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const png = () => sharp({ create: { width: 2, height: 2, channels: 3, background: '#abcd00' } }).png().toBuffer()
function multipart(fields = {}, files = [], tail = true) {
  const boundary = 'maindulu-test-' + randomUUID()
  const chunks = []
  for (const [key, value] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`))
  for (const file of files) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`), file.bytes, Buffer.from('\r\n'))
  if (tail) chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { type: `multipart/form-data; boundary=${boundary}`, payload: Buffer.concat(chunks) }
}
async function setup(t, env = {}) {
  const c = { app: null }
  c.root = await backendFixture(t, { beforeCleanup: () => c.app?.close() })
  c.env = env
  c.app = await createApp({ root: c.root, env, logger: process.env.DEBUG_CATALOG_API === '1' })
  c.actor = randomUUID()
  c.token = 'a'.repeat(64)
  c.app.database.prepare('INSERT INTO users (id, username, password_hash, recovery_code_hash, created_at, role) VALUES (?, ?, ?, ?, ?, ?)').run(c.actor, 'api_admin', 'fixture', 'fixture', Date.now(), 'admin')
  c.app.database.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(hashToken(c.token), c.actor, Date.now(), Date.now() + 600000)
  c.headers = { ...origin, cookie: `maindulu_session=${c.token}`, 'x-csrf-token': csrfToken(c.token) }
  c.upload = (kind = 'games', fields = {}, files, extra = {}) => {
    const body = multipart({ [kind === 'games' ? 'title' : 'name']: 'Fixture', consoleId: 'nes', ...fields }, files ?? [{ field: kind === 'games' ? 'rom' : 'bios', name: kind === 'games' ? 'fixture.nes' : 'disksys.rom', bytes: rom }])
    return c.app.inject({ method: 'POST', url: `/api/admin/${kind}`, headers: { ...c.headers, 'content-type': body.type, ...extra }, payload: body.payload })
  }
  c.remove = (kind, id) => c.app.inject({ method: 'DELETE', url: `/api/admin/${kind}/${id}`, headers: { ...c.headers, 'content-type': 'application/json' }, payload: {} })
  c.restart = async () => { await c.app.close(); c.app = await createApp({ root: c.root, env }) }
  return c
}
function item(response, status = 201) { assert.equal(response.statusCode, status, response.body); return response.json().item }
async function eventually(fn) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail('Timed out waiting for controlled test operation')
}

test('catalog HTTP uploads exact hashes, private DTOs and usable ROM/BIOS filenames', async t => {
  const c = await setup(t)
  const game = item(await c.upload('games', { license: 'Synthetic fixture' }, [
    { field: 'rom', name: 'fixture.nes', bytes: rom }, { field: 'cover', name: 'cover.png', type: 'text/html', bytes: await png() },
  ]))
  const bios = item(await c.upload('bios'))
  for (const [kind, value] of [['games', game], ['bios', bios]]) {
    assert.equal(value.sha256, hash(rom))
    assert.equal(value.size, rom.length)
    assert.match(value.url, kind === 'games' ? /\/rom\/fixture\.nes$/ : /\/disksys\.rom$/)
    const detail = await c.app.inject(`/api/${kind}/${value.id}`)
    assert.deepEqual(detail.json().item, value)
    assert.doesNotMatch(detail.body, /storage_key|storageKey|created_by|createdBy|api_admin|private-data/)
    assert.deepEqual((await c.app.inject(value.url)).rawPayload, rom)
    const head = await c.app.inject({ method: 'HEAD', url: value.url })
    assert.equal(head.statusCode, 200)
    assert.equal(head.headers['content-length'], String(rom.length))
    assert.equal(head.body, '')
    assert.equal(head.headers['cache-control'], 'no-store')
    assert.equal(head.headers['x-content-type-options'], 'nosniff')
  }
  const cover = await c.app.inject(game.cover)
  assert.equal(cover.headers['content-type'], 'image/png')
  assert.deepEqual(cover.rawPayload, await png())
  const redirect = await c.app.inject(`/games/${game.id}/rom`)
  assert.equal(redirect.statusCode, 302)
  assert.equal(redirect.headers.location, game.url)
  assert.equal(redirect.headers['cache-control'], 'no-store')
  assert.equal(c.app.database.prepare('SELECT COUNT(*) AS n FROM catalog_uploads').get().n, 0)
  assert.deepEqual(await c.app.catalog.storage.entries('uploads'), [])
})

test('asset GET/HEAD supports single, suffix, open and unsatisfiable ranges; multi-range is ignored', async t => {
  const c = await setup(t)
  const cover = await png()
  const game = item(await c.upload('games', {}, [{ field: 'rom', name: 'fixture.nes', bytes: rom }, { field: 'cover', name: 'cover.png', bytes: cover }]))
  const bios = item(await c.upload('bios'))
  for (const [url, bytes] of [[game.url, rom], [bios.url, rom], [game.cover, cover]]) {
    const full = await c.app.inject(url)
    assert.equal(full.statusCode, 200)
    assert.deepEqual(full.rawPayload, bytes)
    assert.equal(full.headers['accept-ranges'], 'bytes')
    assert.equal(full.headers['cache-control'], 'no-store')
    for (const [range, expected, start] of [['bytes=2-5', bytes.subarray(2, 6), 2], ['bytes=-5', bytes.subarray(-5), bytes.length - 5], ['bytes=5-', bytes.subarray(5), 5], ['bytes=0-9999', bytes, 0]]) {
      for (const method of ['GET', 'HEAD']) {
        const response = await c.app.inject({ method, url, headers: { range } })
        assert.equal(response.statusCode, 206, response.body)
        assert.equal(Number(response.headers['content-length']), expected.length)
        assert.equal(response.headers['content-range'], `bytes ${start}-${start + expected.length - 1}/${bytes.length}`)
        assert.equal(response.headers['cache-control'], 'no-store')
        assert.deepEqual(response.rawPayload, method === 'HEAD' ? Buffer.alloc(0) : expected)
      }
    }
    for (const range of ['bytes=999-', 'bytes=8-2', 'bytes=-0']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await c.app.inject({ method, url, headers: { range } })
        assert.equal(response.statusCode, 416)
        assert.equal(response.headers['content-range'], `bytes */${bytes.length}`)
      }
    }
    for (const headers of [{ range: 'bytes=0-1,4-5' }, { range: 'nonsense' }, { range: 'bytes=1-2', 'if-range': 'old-validator' }]) {
      assert.equal((await c.app.inject({ url, headers })).statusCode, 200)
    }
  }
})

test('every catalog mutation rejects guests, ordinary users and invalid CSRF before staging or changing records', async t => {
  const c = await setup(t)
  const game = item(await c.upload()), bios = item(await c.upload('bios'))
  const before = ['games', 'bios'].map(table => c.app.database.prepare(`SELECT * FROM ${table}`).all())
  let stages = 0, reservations = 0
  const stage = c.app.catalog.storage.stage
  const reserve = c.app.catalog.maintenance.reserve
  c.app.catalog.storage.stage = (...args) => { stages++; return stage(...args) }
  c.app.catalog.maintenance.reserve = (...args) => { reservations++; return reserve(...args) }
  const cases = [
    { extra: { cookie: '' }, status: 401 },
    { role: 'user', extra: { 'x-role': 'admin' }, status: 403 },
    { extra: { 'x-csrf-token': '' }, status: 403 },
    { extra: { 'x-csrf-token': 'f'.repeat(64) }, status: 403 },
    { extra: { origin: 'https://evil.example' }, status: 403 },
    { extra: { 'sec-fetch-site': 'cross-site' }, status: 403 },
  ]
  for (const [kind, value] of [['games', game], ['bios', bios]]) {
    const form = multipart({ [kind === 'games' ? 'title' : 'name']: 'Forbidden', consoleId: 'nes', role: 'admin' }, [{ field: kind === 'games' ? 'rom' : 'bios', name: value.fileName, bytes: rom }])
    for (const denied of cases) {
      c.app.database.prepare('UPDATE users SET role = ?').run(denied.role ?? 'admin')
      for (const [method, suffix, payload, type] of [
        ['POST', '', form.payload, form.type],
        ['PATCH', '/' + value.id, { [kind === 'games' ? 'title' : 'name']: 'Forbidden' }, 'application/json'],
        ['DELETE', '/' + value.id, {}, 'application/json'],
        ...(kind === 'games' ? [['PATCH', '/' + value.id, form.payload, form.type]] : []),
      ]) {
        const response = await c.app.inject({ method, url: `/api/admin/${kind}${suffix}`, headers: { ...c.headers, 'content-type': type, ...denied.extra }, payload })
        assert.equal(response.statusCode, denied.status, `${method} ${kind}: ${response.body}`)
      }
    }
  }
  assert.equal(stages, 0)
  assert.equal(reservations, 0)
  assert.equal(c.app.database.prepare('SELECT COUNT(*) AS n FROM catalog_uploads').get().n, 0)
  assert.equal(c.app.database.prepare('SELECT COUNT(*) AS n FROM catalog_cleanup').get().n, 0)
  for (const [i, table] of ['games', 'bios'].entries()) assert.deepEqual(c.app.database.prepare(`SELECT * FROM ${table}`).all(), before[i])
})

test('BIOS accepts exactly 32 MiB with an independent checksum and concurrent duplicates publish only once', async t => {
  const c = await setup(t)
  const bytes = Buffer.alloc(32 * 1024 * 1024, 42)
  const bios = item(await c.upload('bios', {}, [{ field: 'bios', name: 'boundary.bin', bytes }]))
  assert.equal(bios.size, bytes.length)
  assert.equal(bios.sha256, hash(bytes))
  const head = await c.app.inject({ method: 'HEAD', url: bios.url })
  assert.equal(head.statusCode, 200)
  assert.equal(Number(head.headers['content-length']), bytes.length)
  const results = await Promise.all([c.upload('bios'), c.upload('bios')])
  const created = item(results.find(response => response.statusCode === 201))
  const duplicate = results.find(response => response.statusCode === 409).json()
  assert.equal(duplicate.code, 'CATALOG_DUPLICATE')
  assert.equal(duplicate.existingId, created.id)
  const list = (await c.app.inject('/api/bios?console=nes&pageSize=1&page=2')).json()
  assert.equal(list.total, 2)
  assert.equal(list.items.length, 1)
  assert.equal(c.app.database.prepare('SELECT COUNT(*) AS n FROM catalog_uploads').get().n, 0)
  assert.deepEqual(await c.app.catalog.storage.entries('uploads'), [])
})

test('disk-full after a partial staged write cleans the real staging file and permits a subsequent upload', async t => {
  for (const kind of ['games', 'bios']) await t.test(kind, async t => {
    const c = await setup(t)
    const stage = c.app.catalog.storage.stage
    c.app.catalog.storage.stage = (folder, source) => stage(folder, (async function* () {
      for await (const chunk of source) {
        yield chunk.subarray(0, 8) // Real file write precedes the injected failure.
        throw Object.assign(new Error('controlled mid-stream disk full'), { code: 'ENOSPC' })
      }
    })())
    const response = await c.upload(kind)
    assert.equal(response.statusCode, 507, response.body)
    assert.equal(response.json().code, 'STORAGE_FULL')
    assert.equal((await c.app.inject(`/api/${kind}`)).json().total, 0)
    assert.deepEqual(await c.app.catalog.storage.entries('uploads'), [])
    assert.deepEqual(await c.app.catalog.storage.entries(kind), [])
    assert.equal(c.app.database.prepare('SELECT COUNT(*) AS n FROM catalog_uploads').get().n, 0)
    c.app.catalog.storage.stage = stage
    item(await c.upload(kind))
  })
})

test('HTTP assets reject substituted symlink/junction directories without exposing private save bytes', async t => {
  const c = await setup(t)
  const game = item(await c.upload('games', {}, [{ field: 'rom', name: 'fixture.nes', bytes: rom }, { field: 'cover', name: 'cover.png', bytes: await png() }]))
  const bios = item(await c.upload('bios'))
  const gameRow = c.app.catalog.repository.get('games', game.id)
  const biosRow = c.app.catalog.repository.get('bios', bios.id)
  const privateDir = join(c.root, 'private-save-fixture')
  await mkdir(privateDir)
  for (const [kind, key, url] of [['games', gameRow.storage_key, game.url], ['bios', biosRow.storage_key, bios.url], ['covers', gameRow.cover_storage_key, game.cover]]) {
    const folder = join(c.root, 'data', kind), parked = folder + '-original'
    const secret = Buffer.alloc(kind === 'covers' ? gameRow.cover_size : rom.length, 83)
    await writeFile(join(privateDir, key), secret)
    await rename(folder, parked)
    try {
      await symlink(privateDir, folder, process.platform === 'win32' ? 'junction' : 'dir')
      for (const method of ['GET', 'HEAD']) {
        const response = await c.app.inject({ method, url })
        assert.equal(response.statusCode, 503, url)
        assert.doesNotMatch(response.body, /SSSS|private-save-fixture/)
      }
    } finally { await rm(folder, { force: true }); await rename(parked, folder) }
    assert.deepEqual(await readFile(join(privateDir, key)), secret)
    assert.equal((await c.app.inject(url)).statusCode, 200)
  }
})

test('delete committed while an asset is opening blocks GET/HEAD and closes the already-open file handle', async t => {
  for (const kind of ['games', 'bios']) for (const method of ['GET', 'HEAD']) await t.test(`${kind} ${method}`, async t => {
    const c = await setup(t)
    const value = item(await c.upload(kind))
    const open = c.app.catalog.storage.open
    let handle
    c.app.catalog.storage.open = async (...args) => {
      handle = await open(...args)
      c.app.catalog.repository.delete(kind, c.actor, value.id)
      return handle
    }
    const response = await c.app.inject({ method, url: value.url })
    assert.equal(response.statusCode, 404, response.body)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(handle.fd, -1)
    assert.equal((await c.app.inject(`/api/${kind}/${value.id}`)).statusCode, 404)
  })
})

test('long and UTF-8 ROM/archive names remain downloadable within the documented basename limit', async t => {
  const c = await setup(t)
  for (const [kind, name] of [['games', 'a'.repeat(236) + '.nes'], ['games', '漢'.repeat(236) + '.nes'], ['bios', 'b'.repeat(236) + '.bin'], ['bios', '漢'.repeat(236) + '.zip']]) {
    const value = item(await c.upload(kind, {}, [{ field: kind === 'games' ? 'rom' : 'bios', name, bytes: Buffer.from(name) }]))
    assert.equal(value.fileName, name)
    const response = await c.app.inject(value.url)
    assert.equal(response.statusCode, 200, value.url)
    assert.deepEqual(response.rawPayload, Buffer.from(name))
  }
})

test('public/admin catalog pagination, literal search, sorting and status are bounded SQL queries', async t => {
  const c = await setup(t)
  for (const [title, consoleId] of [['Zebra', 'nes'], ['alpha 100%', 'snes'], ['Beta', 'nes']]) {
    item(await c.upload('games', { title, consoleId }, [{ field: 'rom', name: 'fixture.zip', bytes: Buffer.from(title) }]))
  }
  const list = (await c.app.inject('/api/games?sort=title&pageSize=2')).json()
  assert.equal(list.total, 3)
  assert.deepEqual(list.items.map(v => v.title), ['alpha 100%', 'Beta'])
  assert.equal((await c.app.inject('/api/games?console=nes')).json().total, 2)
  assert.equal((await c.app.inject('/api/games?q=100%25')).json().total, 1)
  assert.equal((await c.app.inject('/api/games?q=_')).json().total, 0)
  assert.equal((await c.app.inject('/api/games?page=2&pageSize=2')).json().items.length, 1)
  await c.remove('games', list.items[0].id)
  assert.equal((await c.app.inject('/api/games')).json().total, 2)
  const admin = (await c.app.inject({ url: '/api/admin/games?status=deleted', headers: c.headers })).json()
  assert.equal(admin.total, 1)
  assert.equal(admin.items[0].deletedAt > 0, true)
  assert.ok(['available', 'missing'].includes(admin.items[0].fileStatus))
  for (const query of ['page=0', 'page=1.5', 'pageSize=101', 'console=invalid', 'sort=bad', 'status=all', 'q=x&q=y', 'unknown=1']) assert.equal((await c.app.inject('/api/games?' + query)).statusCode, 400, query)
})

test('admin/session/CSRF guards reject before any staging or reservation and keep account body limits', async t => {
  const c = await setup(t)
  let staged = 0
  const stage = c.app.catalog.storage.stage
  c.app.catalog.storage.stage = (...args) => { staged++; return stage(...args) }
  const denied = async (headers, expected) => assert.equal((await c.upload('games', {}, undefined, headers)).statusCode, expected)
  await denied({ cookie: '' }, 401)
  c.app.database.prepare("UPDATE users SET role = 'user'").run()
  await denied({}, 403)
  c.app.database.prepare("UPDATE users SET role = 'admin'").run()
  for (const headers of [{ origin: 'https://evil.example' }, { 'x-csrf-token': '' }, { 'sec-fetch-site': 'cross-site' }, { origin: '' }]) await denied(headers, 403)
  assert.equal(staged, 0)
  assert.equal(c.app.database.prepare('SELECT COUNT(*) AS n FROM catalog_uploads').get().n, 0)
  assert.equal((await c.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...c.headers, 'content-type': 'application/json' }, payload: { x: 'a'.repeat(65536) } })).statusCode, 413)
  assert.equal((await c.app.inject('/api/admin/games')).statusCode, 401)
})

test('role revocation and session expiry/logout during finalization cannot commit a catalog entry', async t => {
  for (const change of ['role', 'expiry', 'logout']) await t.test(change, async t => {
    const c = await setup(t)
    const promote = c.app.catalog.storage.promote
    c.app.catalog.storage.promote = async value => {
      const result = await promote(value)
      if (change === 'role') c.app.database.exec("UPDATE users SET role = 'user'")
      else if (change === 'expiry') c.app.database.exec('UPDATE sessions SET expires_at = 0')
      else c.app.database.exec('DELETE FROM sessions')
      return result
    }
    assert.equal((await c.upload()).statusCode, change === 'role' ? 403 : 401)
    assert.equal((await c.app.inject('/api/games')).json().total, 0)
    await c.app.catalog.maintenance.cleanup()
    assert.deepEqual(await c.app.catalog.storage.entries('games'), [])
    assert.deepEqual(await c.app.catalog.storage.entries('uploads'), [])
  })
})

test('duplicate uploads, tombstone restoration and metadata/cover edits preserve game identity and saves', async t => {
  const c = await setup(t)
  const results = await Promise.all([c.upload(), c.upload()])
  const game = item(results.find(v => v.statusCode === 201))
  const duplicate = results.find(v => v.statusCode === 409).json()
  assert.equal(duplicate.code, 'CATALOG_DUPLICATE')
  assert.equal(duplicate.existingId, game.id)
  c.app.database.prepare('INSERT INTO saves VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), c.actor, game.id, 'nes', 'fceumm', 1, 'unchanged save', '{}', 1, 0, hash(rom), null, 1)
  const saved = c.app.database.prepare('SELECT * FROM saves').get()
  const edit = await c.app.inject({ method: 'PATCH', url: `/api/admin/games/${game.id}`, headers: c.headers, payload: { title: 'Edited', license: 'CC0 fixture' } })
  assert.equal(item(edit, 200).id, game.id)
  const coverForm = multipart({ description: 'Cover edited' }, [{ field: 'cover', name: 'cover.png', bytes: await png() }])
  const withCover = item(await c.app.inject({ method: 'PATCH', url: `/api/admin/games/${game.id}`, headers: { ...c.headers, 'content-type': coverForm.type }, payload: coverForm.payload }), 200)
  assert.ok(withCover.cover)
  assert.equal((await c.remove('games', game.id)).statusCode, 200)
  for (const url of [game.url, `/games/${game.id}/rom`, withCover.cover, `/api/games/${game.id}`]) assert.equal((await c.app.inject(url)).statusCode, 404, url)
  const required = await c.upload()
  assert.equal(required.statusCode, 409)
  assert.equal(required.json().code, 'CATALOG_RESTORE_REQUIRED')
  assert.equal(required.json().existingId, game.id)
  const restored = item(await c.upload('games', { restoreId: game.id, title: 'Ignored title on restore' }), 200)
  assert.equal(restored.id, game.id)
  assert.equal(restored.title, 'Edited')
  assert.equal(restored.sha256, game.sha256)
  assert.equal(restored.createdAt, game.createdAt)
  assert.equal(restored.cover, undefined)
  await c.app.catalog.maintenance.cleanup()
  assert.deepEqual((await c.app.inject(game.url)).rawPayload, rom)
  assert.deepEqual(c.app.database.prepare('SELECT * FROM saves').get(), saved)
  await c.restart()
  assert.equal((await c.app.inject(`/api/games/${game.id}`)).json().item.title, 'Edited')
  assert.deepEqual(c.app.database.prepare('SELECT * FROM saves').get(), saved)
})

test('BIOS supports multiple choices, immutable firmware names, deletion and same-ID restoration', async t => {
  const c = await setup(t)
  const bios = item(await c.upload('bios'))
  const other = item(await c.upload('bios', { name: 'Other' }, [{ field: 'bios', name: 'SCPH1001.bin', bytes: Buffer.from('second synthetic firmware') }]))
  assert.equal((await c.app.inject('/api/bios?console=nes')).json().total, 2)
  assert.equal((await c.app.inject('/api/bios?console=psx')).json().total, 0)
  for (const payload of [{ fileName: 'renamed.bin' }, { consoleId: 'psx' }, { sha256: hash(rom) }, { removeCover: true }]) assert.equal((await c.app.inject({ method: 'PATCH', url: `/api/admin/bios/${bios.id}`, headers: c.headers, payload })).statusCode, 400)
  item(await c.app.inject({ method: 'PATCH', url: `/api/admin/bios/${bios.id}`, headers: c.headers, payload: { name: 'New display name' } }), 200)
  assert.equal((await c.remove('bios', bios.id)).statusCode, 200)
  assert.equal((await c.app.inject(bios.url)).statusCode, 404)
  assert.equal((await c.app.inject(other.url)).statusCode, 200)
  assert.equal(item(await c.upload('bios', { restoreId: bios.id }), 200).id, bios.id)
  await c.app.catalog.maintenance.cleanup()
  assert.deepEqual((await c.app.inject(bios.url)).rawPayload, rom)
})

test('multipart rejects missing, empty, excess, duplicate and unsafe files/metadata without publishing', async t => {
  const c = await setup(t)
  for (const fields of [{ title: '' }, { title: 'x'.repeat(201) }, { description: 'x'.repeat(10001) }, { consoleId: 'other' }, { createdBy: c.actor }, { role: 'admin' }, { storageKey: 'x' }, { restoreId: 'bad' }]) assert.equal((await c.upload('games', fields)).statusCode, 400, JSON.stringify(fields).slice(0, 80))
  for (const files of [[], [{ field: 'rom', name: 'empty.nes', bytes: Buffer.alloc(0) }], [{ field: 'rom', name: '../escape.nes', bytes: rom }], [{ field: 'rom', name: 'NUL.nes', bytes: rom }], [{ field: 'rom', name: 'wrong.exe', bytes: rom }], [{ field: 'extra', name: 'x.nes', bytes: rom }], [{ field: 'rom', name: 'x.nes', bytes: rom }, { field: 'rom', name: 'y.nes', bytes: rom }]]) {
    const response = await c.upload('games', {}, files)
    assert.equal(response.statusCode, 400, response.body)
  }
  const duplicateFields = multipart({ title: 'one', consoleId: 'nes' }, [{ field: 'rom', name: 'x.nes', bytes: rom }])
  const duplicate = Buffer.concat([Buffer.from(`--${duplicateFields.type.split('boundary=')[1]}\r\nContent-Disposition: form-data; name="title"\r\n\r\ntwo\r\n`), duplicateFields.payload])
  assert.equal((await c.app.inject({ method: 'POST', url: '/api/admin/games', headers: { ...c.headers, 'content-type': duplicateFields.type }, payload: duplicate })).statusCode, 400)
  for (const name of ['boot.exe', 'two words.bin', 'boot%20.bin', '../boot.bin']) assert.equal((await c.upload('bios', {}, [{ field: 'bios', name, bytes: rom }])).statusCode, 400, name)
  assert.equal((await c.app.inject('/api/games')).json().total, 0)
  assert.deepEqual(await c.app.catalog.storage.entries('uploads'), [])
})

test('covers require a complete bounded raster decode; MIME and filename do not establish image validity', async t => {
  const c = await setup(t)
  const large = await sharp({ create: { width: 4097, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer()
  const good = await png()
  const animated = await sharp(Buffer.from([255, 0, 0, 0, 255, 0]), { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } }).webp({ loop: 0 }).toBuffer()
  assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2)
  for (const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), Buffer.from('<html>bad</html>'), good.subarray(0, 30), large, animated]) {
    const response = await c.upload('games', {}, [{ field: 'rom', name: 'x.nes', bytes: rom }, { field: 'cover', name: 'cover.png', type: 'image/png', bytes }])
    assert.equal(response.statusCode, 400, response.body)
  }
  assert.equal((await c.app.inject('/api/games')).json().total, 0)
  assert.deepEqual(await c.app.catalog.storage.entries('uploads'), [])
  for (const format of ['jpeg', 'webp']) {
    const bytes = await sharp(good).toFormat(format).toBuffer()
    const game = item(await c.upload('games', { title: format }, [{ field: 'rom', name: 'x.nes', bytes: Buffer.from(format) }, { field: 'cover', name: 'cover.bin', bytes }]))
    assert.equal((await c.app.inject(game.cover)).headers['content-type'], `image/${format}`)
  }
})

test('failed multipart PATCH admission and session revocation before the handler do not leak reservations', async t => {
  const c = await setup(t)
  const form = multipart({}, [{ field: 'cover', name: 'cover.png', bytes: await png() }])
  for (const id of [randomUUID(), 'invalid']) {
    const response = await c.app.inject({ method: 'PATCH', url: `/api/admin/games/${id}`, headers: { ...c.headers, 'content-type': form.type }, payload: form.payload })
    assert.equal(response.statusCode, 404)
    assert.equal(c.app.database.prepare('SELECT COUNT(*) AS n FROM catalog_uploads').get().n, 0)
  }
  const reserve = c.app.catalog.maintenance.reserve
  c.app.catalog.maintenance.reserve = async bytes => {
    const lease = await reserve(bytes)
    c.app.database.exec('DELETE FROM sessions')
    return lease
  }
  assert.equal((await c.upload()).statusCode, 401)
  assert.equal(c.app.database.prepare('SELECT COUNT(*) AS n FROM catalog_uploads').get().n, 0)
})

test('multipart bounds cover bytes, duplicate scalar fields, parser fields/files, and missing boundaries', async t => {
  const c = await setup(t)
  assert.equal((await c.upload('games', {}, [{ field: 'rom', name: 'x.nes', bytes: rom }, { field: 'cover', name: 'x.png', bytes: Buffer.alloc(8 * 1024 * 1024 + 1) }])).statusCode, 413)
  assert.equal((await c.upload('games', {}, [{ field: 'rom', name: 'x.nes', bytes: rom }, { field: 'cover', name: 'x.png', bytes: await png() }, { field: 'extra', name: 'x.bin', bytes: rom }])).statusCode, 413)
  const fields = multipart(Object.fromEntries(Array.from({ length: 7 }, (_, i) => ['field' + i, 'x'])))
  assert.equal((await c.app.inject({ method: 'POST', url: '/api/admin/games', headers: { ...c.headers, 'content-type': fields.type }, payload: fields.payload })).statusCode, 413)
  const boundary = await c.upload('games', {}, undefined, { 'content-type': 'multipart/form-data' })
  assert.equal(boundary.statusCode, 400, boundary.body)
  assert.equal(c.app.database.prepare('SELECT COUNT(*) AS n FROM catalog_uploads').get().n, 0)
  assert.deepEqual(await c.app.catalog.storage.entries('uploads'), [])
})

test('upload size/part bounds and incomplete multipart cannot publish truncated bytes', async t => {
  const c = await setup(t)
  const tooLarge = await c.upload('bios', {}, [{ field: 'bios', name: 'boot.bin', bytes: Buffer.alloc(32 * 1024 * 1024 + 1) }])
  assert.equal(tooLarge.statusCode, 413, tooLarge.body)
  const truncated = multipart({ title: 'truncated', consoleId: 'nes' }, [{ field: 'rom', name: 'x.nes', bytes: rom }], false)
  assert.equal((await c.app.inject({ method: 'POST', url: '/api/admin/games', headers: { ...c.headers, 'content-type': truncated.type }, payload: truncated.payload })).statusCode, 400)
  assert.equal((await c.upload('games', {}, undefined, { 'content-length': String(768 * 1024 * 1024 + 8 * 1024 * 1024 + 131073) })).statusCode, 413)
  assert.equal((await c.app.inject('/api/games')).json().total, 0)
  assert.equal((await c.app.inject('/api/bios')).json().total, 0)
  assert.deepEqual(await c.app.catalog.storage.entries('uploads'), [])
})

test('controlled disk-full, rename and database failures never leave active partial entries', async t => {
  for (const failure of ['disk', 'rename', 'database', 'second-promotion']) await t.test(failure, async t => {
    const c = await setup(t)
    const storage = c.app.catalog.storage
    if (failure === 'disk') storage.stage = async () => { throw Object.assign(new Error('controlled disk full'), { code: 'ENOSPC' }) }
    else if (failure === 'rename') storage.promote = async () => { throw Object.assign(new Error('controlled rename failure'), { code: 'EACCES' }) }
    else if (failure === 'database') c.app.database.exec("CREATE TRIGGER fail_publish BEFORE INSERT ON games BEGIN SELECT RAISE(ABORT, 'controlled database failure'); END;")
    else {
      const promote = storage.promote
      storage.promote = value => value.kind === 'covers' ? Promise.reject(new Error('controlled second promotion failure')) : promote(value)
    }
    const response = await c.upload('games', {}, [{ field: 'rom', name: 'x.nes', bytes: rom }, { field: 'cover', name: 'x.png', bytes: await png() }])
    assert.equal(response.statusCode, failure === 'disk' ? 507 : 500, response.body)
    assert.doesNotMatch(response.body, /controlled|sqlite|EACCES/)
    assert.equal((await c.app.inject('/api/games')).json().total, 0)
    await c.app.catalog.maintenance.cleanup()
    assert.deepEqual(await storage.entries('uploads'), [])
    assert.deepEqual(await storage.entries('games'), [])
  })
})

test('online cleanup retries after restart and never removes active references or another upload staging', async t => {
  const c = await setup(t)
  const game = item(await c.upload())
  const oldKey = c.app.catalog.repository.get('games', game.id).storage_key
  const stage = await c.app.catalog.storage.stage('bios', [Buffer.from('another in-flight upload')])
  await c.remove('games', game.id)
  const remove = c.app.catalog.storage.removeUnreferenced
  c.app.catalog.storage.removeUnreferenced = async () => { throw new Error('controlled busy file') }
  await c.app.catalog.maintenance.cleanup()
  assert.equal(c.app.database.prepare('SELECT attempts FROM catalog_cleanup').get().attempts, 1)
  assert.deepEqual(await readFile(join(c.root, 'data/games', oldKey)), rom)
  c.app.catalog.storage.removeUnreferenced = remove
  const restored = item(await c.upload('games', { restoreId: game.id }), 200)
  const newKey = c.app.catalog.repository.get('games', game.id).storage_key
  assert.notEqual(newKey, oldKey)
  enqueueCleanup(c.app.database, 'games', newKey) // Deliberately defensive reference check.
  await c.restart()
  c.app.database.exec('UPDATE catalog_cleanup SET next_at = 0')
  await c.app.catalog.maintenance.cleanup()
  await assert.rejects(readFile(join(c.root, 'data/games', oldKey)), { code: 'ENOENT' })
  assert.deepEqual((await c.app.inject(restored.url)).rawPayload, rom)
  assert.equal(await readFile(join(c.root, 'data/uploads', stage.key), 'utf8'), 'another in-flight upload')
})

test('delete and its persistent cleanup job roll back together if enqueueing fails', async t => {
  const c = await setup(t)
  const game = item(await c.upload())
  c.app.database.exec("CREATE TRIGGER refuse_cleanup BEFORE INSERT ON catalog_cleanup BEGIN SELECT RAISE(ABORT, 'controlled queue failure'); END;")
  const response = await c.remove('games', game.id)
  assert.equal(response.statusCode, 500)
  assert.doesNotMatch(response.body, /controlled|queue|SQLite/)
  assert.equal(c.app.catalog.repository.get('games', game.id).deleted_at, null)
  assert.deepEqual((await c.app.inject(game.url)).rawPayload, rom)
  assert.equal(c.app.database.prepare('SELECT COUNT(*) AS n FROM catalog_cleanup').get().n, 0)
})

test('shared reservations enforce cross-connection upload limits and include physical orphan/staging bytes in quota', async t => {
  const c = await setup(t, { MAIN_DULU_CATALOG_UPLOAD_LIMIT: '1', MAIN_DULU_CATALOG_QUOTA_BYTES: '1048576' })
  const second = await openDatabase(join(c.root, 'data'))
  const storage = await createCatalogStorage(c.app.appConfig)
  const other = createCatalogMaintenance(second, storage, c.app.appConfig)
  try {
    const reservation = await other.reserve(1024)
    assert.equal((await c.upload()).statusCode, 429)
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { openDatabase } from ${JSON.stringify(new URL('../server/database.mjs', import.meta.url).href)};
      import { createCatalogStorage } from ${JSON.stringify(new URL('../server/catalog/storage.mjs', import.meta.url).href)};
      import { createCatalogMaintenance } from ${JSON.stringify(new URL('../server/catalog/maintenance.mjs', import.meta.url).href)};
      const config = ${JSON.stringify(c.app.appConfig)};
      const db = await openDatabase(config.dataDir);
      const maintenance = createCatalogMaintenance(db, await createCatalogStorage(config), config);
      try { const lease = await maintenance.reserve(1024); lease.release(); console.log('unexpected admission'); }
      catch (error) { console.log(error.code); }
      finally { await maintenance.close(); db.close(); }
    `], { encoding: 'utf8', timeout: 15000 })
    assert.equal(child.status, 0, child.stderr)
    assert.equal(child.stdout.trim(), 'UPLOAD_BUSY')
    reservation.release()
    await writeFile(join(c.root, 'data/games', randomUUID() + '.bin'), Buffer.alloc(1024 * 1024))
    assert.equal((await c.upload()).statusCode, 507)
  } finally { await other.close(); second.close() }
  assert.equal((await c.app.inject('/api/games')).json().total, 0)
  const disk = await setup(t, { MAIN_DULU_CATALOG_MIN_FREE_BYTES: String(1024 * 1024 ** 3) })
  assert.equal((await disk.upload()).statusCode, 507)
})

test('schema-9 migration preserves a populated schema-8 catalog, firmware names, sessions and assets', async t => {
  const c = await setup(t)
  const game = item(await c.upload())
  const bios = item(await c.upload('bios'))
  const installation = c.app.database.prepare("SELECT value FROM app_metadata WHERE key = 'installation_id'").get().value
  const games = c.app.database.prepare('SELECT * FROM games').all()
  const firmware = c.app.database.prepare('SELECT * FROM bios').all()
  const sessions = c.app.database.prepare('SELECT * FROM sessions').all()
  await c.app.close(); c.app = null
  let db = await openDatabase(join(c.root, 'data'))
  db.exec('DROP TABLE catalog_cleanup; DROP TABLE catalog_uploads; DROP TABLE catalog_capacity; DELETE FROM schema_migrations WHERE version = 9; PRAGMA user_version = 8;')
  db.close()
  c.app = await createApp({ root: c.root, env: c.env })
  db = c.app.database
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, schemaVersion)
  assert.equal(db.prepare("SELECT value FROM app_metadata WHERE key = 'installation_id'").get().value, installation)
  assert.deepEqual(db.prepare('SELECT * FROM games').all(), games)
  assert.deepEqual(db.prepare('SELECT * FROM bios').all(), firmware)
  assert.deepEqual(db.prepare('SELECT * FROM sessions').all(), sessions)
  for (const value of [game, bios]) assert.deepEqual((await c.app.inject(value.url)).rawPayload, rom)
})

test('asset endpoints reject wrong/encoded traversal names, missing files and hardlinks without serving private data', async t => {
  const c = await setup(t)
  const bios = item(await c.upload('bios'))
  for (const suffix of ['wrong.bin', '..%2fmaindulu.sqlite', '%252e%252e%252fsaves', 'maindulu.sqlite', '%5cboot.bin']) {
    const response = await c.app.inject(`/bios/${bios.id}/${suffix}`)
    assert.ok(response.statusCode >= 400)
    assert.doesNotMatch(response.body, /SQLite format|frontend fixture/)
  }
  for (const url of ['/data/maindulu.sqlite', '/saves/secret.bin', `/games/${bios.id}/rom`, '/uploads/file.tmp', '/bios/maindulu.sqlite']) assert.equal((await c.app.inject(url)).statusCode, 404, url)
  const row = c.app.catalog.repository.get('bios', bios.id)
  const path = join(c.root, 'data/bios', row.storage_key)
  await link(path, join(c.root, 'linked-firmware'))
  assert.equal((await c.app.inject(bios.url)).statusCode, 503)
  await rm(join(c.root, 'linked-firmware'))
  await rm(path)
  assert.equal((await c.app.inject(bios.url)).statusCode, 404)
  assert.equal((await c.app.inject({ url: '/api/admin/bios', headers: c.headers })).json().items[0].fileStatus, 'missing')
})

test('real HTTP aborted upload and route timeout release staging/reservations without publication', { timeout: 15000 }, async t => {
  const c = await setup(t, { MAIN_DULU_CATALOG_UPLOAD_TIMEOUT_MS: '1000' })
  await c.app.listen({ host: '127.0.0.1', port: 0 })
  const port = c.app.server.address().port
  const body = multipart({ title: 'Interrupted', consoleId: 'nes' }, [{ field: 'rom', name: 'x.nes', bytes: Buffer.alloc(65536) }], false)
  function start() {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/admin/games', method: 'POST', headers: { ...c.headers, 'content-type': body.type, 'transfer-encoding': 'chunked' } })
    req.on('error', () => {})
    req.write(body.payload)
    return req
  }
  const aborted = start()
  await eventually(() => c.app.database.prepare('SELECT COUNT(*) AS n FROM catalog_uploads').get().n === 1)
  aborted.destroy()
  await eventually(async () => c.app.database.prepare('SELECT COUNT(*) AS n FROM catalog_uploads').get().n === 0 && (await c.app.catalog.storage.entries('uploads')).length === 0)
  const stalled = start()
  const [response] = await once(stalled, 'response')
  response.resume()
  assert.equal(response.statusCode, 503)
  stalled.destroy()
  await eventually(() => c.app.database.prepare('SELECT COUNT(*) AS n FROM catalog_uploads').get().n === 0)
  assert.equal((await c.app.inject('/api/games')).json().total, 0)
  assert.deepEqual(await c.app.catalog.storage.entries('uploads'), [])
  assert.equal(c.app.database.prepare('PRAGMA user_version').get().user_version, schemaVersion)
})

test('upload deadline also cancels finalization after the complete HTTP body has arrived', { timeout: 15000 }, async t => {
  const c = await setup(t, { MAIN_DULU_CATALOG_UPLOAD_TIMEOUT_MS: '1000' })
  const promote = c.app.catalog.storage.promote
  c.app.catalog.storage.promote = async value => {
    await new Promise(resolve => setTimeout(resolve, 1400))
    return promote(value)
  }
  const response = await c.upload()
  assert.equal(response.statusCode, 503, response.body)
  assert.equal(response.json().code, 'UPLOAD_TIMEOUT')
  await eventually(() => c.app.database.prepare('SELECT COUNT(*) AS n FROM catalog_uploads').get().n === 0)
  assert.equal((await c.app.inject('/api/games')).json().total, 0)
  await c.app.catalog.maintenance.cleanup()
  assert.deepEqual(await c.app.catalog.storage.entries('games'), [])
  assert.deepEqual(await c.app.catalog.storage.entries('uploads'), [])
})
