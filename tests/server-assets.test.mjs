import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServerAssetResolver, ServerAssetError } from '../src/lib/server-assets.ts'
import { ASSET_CHUNK_SIZE, AssetCacheError, catalogAssetDescriptor } from '../src/lib/asset-cache-policy.ts'
import { CatalogRequestError, catalogBios } from '../src/lib/catalog.ts'
import { createIncrementalSha256, hashRom } from '../src/lib/identity.ts'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const id = '12345678-1234-1234-1234-123456789abc'
function fixture(bytes = new Uint8Array([1, 2, 3]), kind = 'rom') {
  const fileName = kind === 'rom' ? 'test game.nes' : 'firmware.bin'
  const entry = { id, consoleId: 'nes', fileName, sha256: digest(bytes), size: bytes.length,
    url: kind === 'rom' ? `/games/${id}/rom/${encodeURIComponent(fileName)}` : `/bios/${id}/${fileName}`,
    title: 'Game', name: 'BIOS', createdAt: 1, updatedAt: 1, description: '' }
  return { bytes, entry, descriptor: catalogAssetDescriptor(kind, entry) }
}
function headers(f) { return { 'content-length': String(f.bytes.length), etag: `"${f.descriptor.sha256}"`, 'content-type': 'application/octet-stream' } }
function response(f, method, overrides = {}) {
  return new Response(method === 'HEAD' ? null : f.bytes, { status: 200, headers: headers(f), ...overrides })
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function setup(t, f = fixture(), extra = {}) {
  const requests = [], events = []
  const state = { hit: null, committed: false, appends: [], aborted: 0, closed: 0, deleted: [], begins: 0 }
  const writer = {
    append: async blob => { state.appends.push(blob) },
    commit: async () => { state.committed = true },
    abort: async () => { state.aborted++ },
  }
  const cache = {
    read: async () => { events.push('read'); return state.hit },
    begin: async () => { state.begins++; return writer },
    delete: async (...args) => { state.deleted.push(args) }, close: () => { state.closed++ },
  }
  const resolver = createServerAssetResolver({ origin: 'http://example.test',
    latest: async (kind, catalogId, signal) => { events.push('metadata'); assert.equal(catalogId, id); assert.equal(kind, f.descriptor.kind === 'rom' ? 'games' : 'bios'); assert.ok(signal); return f.entry },
    fetch: async (url, options) => {
      assert.equal(url, 'http://example.test' + f.descriptor.url)
      assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error')
      assert.equal(options.credentials, 'same-origin'); assert.equal(options.mode, 'same-origin')
      assert.equal(options.headers, undefined)
      requests.push(options.method); events.push(options.method)
      return response(f, options.method)
    }, openCache: async () => cache, ...extra })
  t.after(() => resolver.close())
  return { resolver, state, requests, events, writer, cache, f }
}
const code = expected => error => error instanceof ServerAssetError && error.code === expected

test('miss verifies one GET and reports stored only after commit settles; next launch is fresh', async t => {
  const c = setup(t), committed = deferred()
  c.writer.commit = async () => { await committed.promise; c.state.committed = true }
  const phases = [], saving = deferred()
  let settled = false
  const pending = c.resolver.resolve(c.f.descriptor, { onProgress: p => { phases.push(p.phase); if (p.phase === 'saving') saving.resolve() } }).then(value => { settled = true; return value })
  await saving.promise
  assert.equal(settled, false); assert.equal(c.state.committed, false)
  committed.resolve()
  const result = await pending
  assert.equal(result.persistence, 'stored'); assert.equal(result.source, 'network')
  assert.equal(result.transferredBytes, 3); assert.deepEqual(result.warnings, [])
  assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()), c.f.bytes)
  assert.deepEqual(c.requests, ['HEAD', 'GET']); assert.deepEqual(c.events.slice(0, 3), ['metadata', 'HEAD', 'read'])
  assert.equal(phases.at(-1), 'ready'); assert.equal(c.state.closed, 1)
  c.state.hit = { blob: result.blob }
  const hit = await c.resolver.resolve(c.f.descriptor)
  assert.equal(hit.source, 'indexeddb'); assert.equal(hit.persistence, 'reused'); assert.equal(hit.transferredBytes, 0)
  assert.deepEqual(c.requests, ['HEAD', 'GET', 'HEAD'])
})

test('BIOS descriptor retains size, raw filename and independent namespace', async t => {
  const f = fixture(undefined, 'bios'), c = setup(t, f)
  assert.equal(catalogBios(f.entry).size, f.bytes.length)
  const result = await c.resolver.resolve(f.descriptor)
  assert.equal(result.descriptor.kind, 'bios'); assert.equal(result.descriptor.fileName, 'firmware.bin')
  assert.equal(result.descriptor.url, f.entry.url)
})

test('descriptor rejects static/local/external inputs before metadata or network', async t => {
  const c = setup(t)
  for (const invalid of [{ ...c.f.descriptor, url: '/games/demo.nes' }, { ...c.f.descriptor, url: '//evil.test/a' },
    { ...c.f.descriptor, size: 0 }, { ...c.f.descriptor, sha256: 'invalid' }, new File(['x'], 'local.nes')]) {
    await assert.rejects(c.resolver.resolve(invalid), code('invalid'))
  }
  assert.deepEqual(c.events, [])
})

test('latest metadata changes require reopening; label-only edits preserve descriptor identity', async t => {
  for (const patch of [{ sha256: 'a'.repeat(64) }, { size: 4 }, { consoleId: 'snes' }, { fileName: 'other.nes' }, { url: '/unsafe' }, { id: '87654321-1234-1234-1234-123456789abc' }]) {
    const f = fixture(), c = setup(t, f, { latest: async () => ({ ...f.entry, ...patch }) })
    await assert.rejects(c.resolver.resolve(f.descriptor), code('changed')); assert.deepEqual(c.requests, [])
  }
  const f = fixture(), c = setup(t, f, { latest: async () => ({ ...f.entry, title: 'Renamed' }) })
  assert.equal((await c.resolver.resolve(f.descriptor)).descriptor.label, 'Renamed')
})

for (const status of [404, 410, 503, 206, 304]) test(`HEAD ${status} never bypasses origin via a cache hit`, async t => {
  const c = setup(t, fixture(), { fetch: async () => new Response(null, { status }) })
  c.state.hit = { blob: new Blob([c.f.bytes]) }
  await assert.rejects(c.resolver.resolve(c.f.descriptor), code(status === 404 || status === 410 ? 'unavailable' : 'http'))
  assert.equal(c.state.begins, 0); assert.ok(!c.events.includes('read'))
  assert.equal(c.state.deleted.length, status === 404 || status === 410 ? 1 : 0)
})

for (const status of [404, 410, 503]) test(`latest catalog HTTP ${status} preserves source failure and invalidates only deletion`, async t => {
  const c = setup(t, fixture(), { latest: async () => { throw new CatalogRequestError(status, 'catalog error') } })
  await assert.rejects(c.resolver.resolve(c.f.descriptor), code(status === 503 ? 'http' : 'unavailable'))
  assert.deepEqual(c.requests, []); assert.equal(c.state.deleted.length, status === 503 ? 0 : 1)
})

const invalidHeaders = [
  { 'content-type': 'TEXT/HTML; charset=utf-8' }, { 'content-type': 'application/xhtml+xml' },
  { etag: null }, { etag: 'W/"weak"' }, { etag: '"' + 'a'.repeat(64) + '"' },
  { 'content-length': null }, { 'content-length': '0' }, { 'content-length': '-1' },
  { 'content-length': '3.0' }, { 'content-length': '4' }, { 'content-length': '9007199254740992' },
  { 'content-range': 'bytes 0-2/3' },
]
for (const method of ['HEAD', 'GET']) test(`${method} rejects HTML, missing/weak/wrong validators and malformed lengths`, async t => {
  for (const patch of invalidHeaders) {
    const f = fixture(), c = setup(t, f, { fetch: async (_, options) => {
      if (options.method !== method) return response(f, options.method)
      const h = new Headers(headers(f))
      for (const [key, value] of Object.entries(patch)) { if (value === null) h.delete(key); else h.set(key, value) }
      return response(f, options.method, { headers: h })
    } })
    await assert.rejects(c.resolver.resolve(f.descriptor), code('validator'))
    assert.equal(c.state.committed, false)
  }
})

for (const status of [206, 304, 302, 404, 410, 503]) test(`GET ${status} is not a full verified file`, async t => {
  const f = fixture(), c = setup(t, f, { fetch: async (_, options) => options.method === 'HEAD' ? response(f, 'HEAD') : new Response(null, { status }) })
  await assert.rejects(c.resolver.resolve(f.descriptor), code(status === 404 || status === 410 ? 'unavailable' : 'http'))
  assert.equal(c.state.committed, false); assert.equal(c.state.aborted, 1)
})

for (const method of ['HEAD', 'GET']) test(`${method} rejects followed redirects and response URL changes`, async t => {
  for (const patch of [{ redirected: true }, { url: 'https://other.test/asset' }]) {
    const f = fixture(), c = setup(t, f, { fetch: async (_, options) => {
      const r = response(f, options.method)
      if (options.method === method) for (const [key, value] of Object.entries(patch)) Object.defineProperty(r, key, { value })
      return r
    } })
    await assert.rejects(c.resolver.resolve(f.descriptor), code('validator'))
    assert.equal(c.state.committed, false)
  }
})

test('truncated, oversized, empty, same-size changed and interrupted bodies never commit', async t => {
  for (const data of [new Uint8Array([1, 2]), new Uint8Array([1, 2, 3, 4]), new Uint8Array(), new Uint8Array([3, 2, 1]), null]) {
    const f = fixture(), c = setup(t, f, { fetch: async (_, options) => {
      if (options.method === 'HEAD') return response(f, 'HEAD')
      const body = data ?? new ReadableStream({ start(controller) { controller.error(new TypeError('interrupted')) } })
      return new Response(body, { headers: headers(f) })
    } })
    await assert.rejects(c.resolver.resolve(f.descriptor), code(data === null ? 'network' : 'integrity'))
    assert.equal(c.state.committed, false); assert.equal(c.state.aborted, 1)
  }
})

test('no stream API is an explicit failure, not an unbounded whole-body fallback', async t => {
  const f = fixture(), c = setup(t, f, { fetch: async (_, options) => options.method === 'HEAD' ? response(f, 'HEAD') : new Response(null, { headers: headers(f) }) })
  await assert.rejects(c.resolver.resolve(f.descriptor), code('unsupported-stream'))
})

test('network chunks reassemble into bounded 4 MiB storage chunks with matching incremental digest', async t => {
  const bytes = new Uint8Array(ASSET_CHUNK_SIZE * 2 + 17).fill(0xa9), f = fixture(bytes)
  const c = setup(t, f, { fetch: async (_, options) => {
    if (options.method === 'HEAD') return response(f, 'HEAD')
    return new Response(new ReadableStream({ start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 713731) controller.enqueue(bytes.subarray(offset, offset + 713731))
      controller.close()
    } }), { headers: headers(f) })
  } })
  const hash = createIncrementalSha256()
  try {
    hash.update(bytes.subarray(0, 101)); hash.update(bytes.subarray(101))
    assert.equal(hash.digest(), digest(bytes)); assert.equal(await hashRom(new Blob([bytes]), {}), digest(bytes))
  } finally { hash.destroy() }
  const result = await c.resolver.resolve(f.descriptor)
  assert.deepEqual(c.state.appends.map(blob => blob.size), [ASSET_CHUNK_SIZE, ASSET_CHUNK_SIZE, 17])
  assert.equal(digest(new Uint8Array(await result.blob.arrayBuffer())), f.descriptor.sha256)
})

test('corrupt cache recovers once; a subsequent server failure never loops', async t => {
  for (const fail of [false, true]) {
    const f = fixture(), methods = [], c = setup(t, f, { fetch: async (_, options) => {
      methods.push(options.method)
      return fail && options.method === 'GET' ? new Response(null, { status: 503 }) : response(f, options.method)
    } })
    c.cache.read = async () => { throw new AssetCacheError('corrupt', 'Corrupt generation already invalidated by M1') }
    if (fail) await assert.rejects(c.resolver.resolve(f.descriptor), code('http'))
    else assert.equal((await c.resolver.resolve(f.descriptor)).warnings[0].code, 'corrupt')
    assert.deepEqual(methods, ['HEAD', 'GET'])
  }
})

test('quota during stream stops further writes but finishes the same download', async t => {
  const f = fixture(new Uint8Array(ASSET_CHUNK_SIZE + 1).fill(7)), c = setup(t, f)
  let calls = 0
  c.writer.append = async () => { calls++; throw new AssetCacheError('quota', 'Full') }
  const result = await c.resolver.resolve(f.descriptor)
  assert.equal(calls, 1); assert.equal(c.state.aborted, 1); assert.equal(c.state.committed, false)
  assert.equal(result.persistence, 'not-stored'); assert.equal(result.warnings[0].code, 'quota')
  assert.equal(result.blob.size, f.bytes.length); assert.deepEqual(c.requests, ['HEAD', 'GET'])
})

test('commit failure is not reported stored; cache abort without caller cancellation is nonfatal', async t => {
  const c = setup(t)
  c.writer.commit = async () => { throw new AssetCacheError('aborted', 'Transaction aborted after request success') }
  const result = await c.resolver.resolve(c.f.descriptor)
  assert.equal(result.persistence, 'not-stored'); assert.equal(result.warnings[0].code, 'aborted')
})

for (const failure of ['unavailable', 'blocked', 'incompatible-version', 'budget', 'disabled', 'busy', 'fenced']) test(`storage ${failure} falls back, never bypassing HEAD`, async t => {
  const c = setup(t)
  if (['unavailable', 'blocked', 'incompatible-version'].includes(failure)) c.cache.read = async () => { throw new AssetCacheError(failure, failure) }
  else c.cache.begin = async () => { throw new AssetCacheError(failure, failure) }
  const result = await c.resolver.resolve(c.f.descriptor)
  assert.equal(result.persistence, 'not-stored'); assert.equal(result.warnings[0].code, failure)
  assert.deepEqual(c.requests, ['HEAD', 'GET']); assert.equal(c.state.appends.length, 0)
})

test('open failure and cache toggle off still require origin and verify the full download', async t => {
  for (const extra of [{ openCache: async () => { throw new DOMException('unsupported', 'SecurityError') } },
    { cacheEnabled: false, openCache: async () => { assert.fail('disabled cache must not open') } }]) {
    const c = setup(t, fixture(), extra), result = await c.resolver.resolve(c.f.descriptor)
    assert.equal(result.persistence, 'not-stored'); assert.equal(result.warnings.length, 1)
    assert.deepEqual(c.requests, ['HEAD', 'GET'])
  }
})

test('connection and stream idle timeouts abort requests without a total file-duration timer', async t => {
  for (const phase of ['HEAD', 'GET', 'body']) {
    const f = fixture(), signals = [], c = setup(t, f, { connectionTimeoutMs: 15, idleTimeoutMs: 15,
      fetch: async (_, options) => {
        signals.push(options.signal)
        if (options.method === phase) return new Promise(() => {})
        if (options.method === 'GET' && phase === 'body') return new Response(new ReadableStream({ start() {} }), { headers: headers(f) })
        return response(f, options.method)
      } })
    await assert.rejects(c.resolver.resolve(f.descriptor), code('timeout'))
    assert.equal(signals.at(-1).aborted, true); assert.equal(c.state.committed, false)
  }
})

test('one subscriber cancellation does not abort another; last cancellation permits a fresh flight', async t => {
  const f = fixture(), entered = deferred(), release = deferred(), methods = []
  const c = setup(t, f, { fetch: async (_, options) => {
    methods.push(options.method)
    if (options.method === 'GET') { entered.resolve(); await release.promise }
    return response(f, options.method)
  } })
  const a = new AbortController(), b = new AbortController()
  const first = c.resolver.resolve(f.descriptor, { signal: a.signal }), second = c.resolver.resolve({ ...f.descriptor, label: 'Another view label' }, { signal: b.signal })
  const rejected = assert.rejects(first, code('aborted'))
  await entered.promise; a.abort(); await rejected; release.resolve()
  assert.equal((await second).persistence, 'stored'); assert.deepEqual(methods, ['HEAD', 'GET'])
  await c.resolver.resolve(f.descriptor)
  assert.deepEqual(methods, ['HEAD', 'GET', 'HEAD', 'GET'])
})

test('last subscriber abort and immediate retry do not inherit a dead owner signal', async t => {
  const f = fixture(), entered = deferred(), methods = []
  const c = setup(t, f, { fetch: async (_, options) => {
    methods.push(options.method)
    if (methods.length === 1) { entered.resolve(); return new Promise(() => {}) }
    return response(f, options.method)
  } })
  const controller = new AbortController(), pending = c.resolver.resolve(f.descriptor, { signal: controller.signal })
  const rejected = assert.rejects(pending, code('aborted'))
  await entered.promise; controller.abort()
  const retry = c.resolver.resolve(f.descriptor)
  await rejected; assert.equal((await retry).source, 'network')
  assert.deepEqual(methods, ['HEAD', 'HEAD', 'GET'])
})

test('abort during append fences late completion and cleans the writer; observer errors are isolated', async t => {
  const c = setup(t), entered = deferred(), release = deferred(), controller = new AbortController()
  c.writer.append = async () => { entered.resolve(); await release.promise }
  const pending = c.resolver.resolve(c.f.descriptor, { signal: controller.signal, onProgress: () => { throw new Error('UI failure') } })
  const rejected = assert.rejects(pending, code('aborted'))
  await entered.promise; controller.abort(); release.resolve(); await rejected; await c.resolver.close()
  assert.equal(c.state.committed, false); assert.equal(c.state.aborted, 1)
  await assert.rejects(c.resolver.resolve(c.f.descriptor), code('aborted'))
})

test('close aborts active transfer, pre-aborted subscribers never start metadata', async t => {
  const entered = deferred(), c = setup(t, fixture(), { fetch: async () => { entered.resolve(); return new Promise(() => {}) } })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(c.resolver.resolve(c.f.descriptor, { signal: controller.signal }), code('aborted'))
  assert.deepEqual(c.events, [])
  const pending = c.resolver.resolve(c.f.descriptor), rejected = assert.rejects(pending, code('aborted'))
  await entered.promise; await c.resolver.close(); await rejected
})

test('metadata that ignores AbortSignal cannot keep a closed resolver alive', async t => {
  const c = setup(t, fixture(), { latest: async () => new Promise(() => {}) })
  const pending = c.resolver.resolve(c.f.descriptor), rejected = assert.rejects(pending, code('aborted'))
  await c.resolver.close(); await rejected
  assert.deepEqual(c.requests, [])
})

test('cancellation fences a delayed database open and closes the late connection', async t => {
  const entered = deferred(), opening = deferred()
  let closed = 0
  const c = setup(t, fixture(), { openCache: async () => { entered.resolve(); return opening.promise } })
  const pending = c.resolver.resolve(c.f.descriptor), rejected = assert.rejects(pending, code('aborted'))
  await entered.promise; await c.resolver.close(); await rejected
  opening.resolve({ close: () => { closed++ } })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(closed, 1); assert.deepEqual(c.requests, ['HEAD'])
})

test('source deletion remains fatal if cache invalidation fails, including disabled cache', async t => {
  for (const cacheEnabled of [true, false]) {
    let opens = 0
    const c = setup(t, fixture(), { cacheEnabled, fetch: async () => new Response(null, { status: 404 }),
      openCache: async () => { opens++; throw new AssetCacheError('unavailable', 'No storage') } })
    await assert.rejects(c.resolver.resolve(c.f.descriptor), error => code('unavailable')(error) && error.status === 404)
    assert.equal(opens, 1)
  }
})

test('missing or unsafe origin and invalid timer values fail explicitly', async t => {
  for (const origin of ['invalid', 'file:///tmp/test']) {
    const c = setup(t, fixture(), { origin })
    await assert.rejects(c.resolver.resolve(c.f.descriptor), code('invalid'))
    assert.deepEqual(c.events, [])
  }
  for (const timeout of [0, -1, 0.5, Infinity, 2147483648]) assert.throws(() => createServerAssetResolver({ idleTimeoutMs: timeout }), code('invalid'))
})
