import test from 'node:test'
import assert from 'node:assert/strict'
import { adminRequest, adminToken, catalogResponseError, CatalogClientError, mutateCatalog, readAdminPage } from '../src/lib/admin-catalog.ts'

const id = '00000000-0000-4000-8000-000000000001'
const entry = { id, consoleId: 'nes', fileName: 'fixture.nes', size: 10, sha256: 'a'.repeat(64), description: '', createdAt: 1, updatedAt: 1,
  url: `/games/${id}/rom/fixture.nes`, title: 'Fixture', license: 'CC0', deletedAt: null, fileStatus: 'available', coverStatus: 'none', cleanupPending: false }
const session = { user: { id, username: 'admin_user', role: 'admin' }, csrfToken: 'b'.repeat(64), registrationOpen: true }
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

test('admin page parser validates pagination, asset URLs and file statuses without the saved-history cap', () => {
  const page = { items: [entry], page: 1, pageSize: 12, total: 301 }
  assert.deepEqual(readAdminPage(page, 'games'), page)
  for (const changes of [{ page: 0 }, { pageSize: 101 }, { total: -1 }, { items: [{ ...entry, url: '//evil/file' }] }, { items: [{ ...entry, sha256: 'bad' }] }, { items: [{ ...entry, fileStatus: 'ready' }] }, { items: [{ ...entry, deletedAt: undefined }] }]) assert.equal(readAdminPage({ ...page, ...changes }, 'games'), null)
  const bios = { ...entry, name: 'Firmware', distributionRights: 'Synthetic', url: `/bios/${id}/disksys.rom` }
  assert.ok(readAdminPage({ ...page, items: [bios] }, 'bios'))
  assert.equal(readAdminPage({ ...page, items: [{ ...bios, name: null }] }, 'bios'), null)
})

test('catalog errors preserve restore IDs and offer safe fallbacks for proxy/storage/auth errors', () => {
  const error = catalogResponseError({ code: 'CATALOG_RESTORE_REQUIRED', existingId: id, error: 'Pulihkan' }, 409)
  assert.equal(error.existingId, id)
  assert.equal(error.status, 409)
  assert.equal(catalogResponseError({ existingId: '../../etc' }, 409).existingId, undefined)
  for (const status of [401, 403, 413, 429, 507]) assert.ok(catalogResponseError(null, status).message)
})

test('admin requests reject HTML success and propagate structured HTTP failures', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html/>', { headers: { 'content-type': 'text/html' } }))
  await assert.rejects(adminRequest('/api/admin/games'), /Respons katalog/)
  globalThis.fetch.mock.mockImplementation(async () => json({ error: 'Penuh', code: 'STORAGE_FULL' }, 507))
  await assert.rejects(adminRequest('/api/admin/games'), e => e instanceof CatalogClientError && e.status === 507 && e.code === 'STORAGE_FULL')
  const timeout = new DOMException('Timed out', 'TimeoutError')
  globalThis.fetch.mock.mockImplementation(async () => { throw timeout })
  await assert.rejects(adminRequest('/api/admin/games', { signal: AbortSignal.abort(timeout) }), /Permintaan terlalu lama/)
})

test('mutation preflight rejects expired, changed and demoted sessions before uploading bytes', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => json(session))
  assert.equal(await adminToken(id, new AbortController().signal), session.csrfToken)
  for (const user of [null, { ...session.user, role: 'user' }, { ...session.user, id: '00000000-0000-4000-8000-000000000002' }]) {
    fetch.mock.mockImplementation(async () => json({ ...session, user }))
    await assert.rejects(mutateCatalog('games', id, 'POST', undefined, new FormData(), new AbortController().signal), e => e instanceof CatalogClientError && [401, 403].includes(e.status))
  }
  assert.equal(fetch.mock.calls.length, 4)
})

test('JSON mutations use same-origin session cookies, current CSRF and explicit empty delete JSON', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (path, init) => { calls.push({ path, init }); return json(path.endsWith('/session') ? session : { ok: true }) })
  await mutateCatalog('bios', id, 'DELETE', id, {}, new AbortController().signal)
  assert.equal(calls[1].path, `/api/admin/bios/${id}`)
  assert.equal(calls[1].init.body, '{}')
  assert.equal(calls[1].init.headers['X-CSRF-Token'], session.csrfToken)
  assert.equal(calls[1].init.credentials, 'same-origin')
})

test('multipart client reports sending then server processing, never invents a boundary, and supports abort', async t => {
  t.mock.method(globalThis, 'fetch', async () => json(session))
  let xhr
  class FakeXHR {
    upload = {}
    headers = {}
    constructor() { xhr = this }
    open(method, path) { this.method = method; this.path = path }
    setRequestHeader(key, value) { this.headers[key] = value }
    send(body) { this.body = body }
    abort() { this.onabort() }
    getResponseHeader() { return 'application/json' }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest')
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, writable: true, value: FakeXHR })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'XMLHttpRequest', previous); else delete globalThis.XMLHttpRequest })
  const progress = [], controller = new AbortController(), body = new FormData()
  body.append('rom', new Blob(['fixture']), 'fixture.nes')
  const promise = mutateCatalog('games', id, 'POST', undefined, body, controller.signal, value => progress.push(value))
  // Flush the async session preflight without polling a real service.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(xhr.body, body)
  assert.equal(xhr.headers['Content-Type'], undefined)
  assert.equal(xhr.headers['X-CSRF-Token'], session.csrfToken)
  assert.equal(xhr.withCredentials, true)
  xhr.upload.onprogress({ loaded: 10, total: 10, lengthComputable: true })
  assert.deepEqual(progress.at(-1), { phase: 'sending', percent: 100 })
  xhr.upload.onload()
  assert.deepEqual(progress.at(-1), { phase: 'processing' })
  xhr.status = 201; xhr.responseText = JSON.stringify({ item: entry }); xhr.onload()
  assert.deepEqual(await promise, { item: entry })
  const cancel = mutateCatalog('games', id, 'POST', undefined, body, controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(cancel, { name: 'AbortError' })
})
