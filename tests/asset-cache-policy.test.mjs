import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  ASSET_CHUNK_SIZE, AssetCacheError, assetChunkCount, assetChunkSize, assetKey,
  cacheStorageError, checkCacheAbort, planAssetAdmission, readAssetDescriptor, requireCacheSettings,
} from '../src/lib/asset-cache-policy.ts'
import { openAssetCache } from '../src/lib/asset-cache.ts'

const id = '12345678-1234-1234-1234-123456789abc'
const descriptor = (overrides = {}) => ({ kind: 'rom', catalogId: id,
  sha256: createHash('sha256').update('abc').digest('hex'), size: 3, fileName: 'test game.nes',
  url: `/games/${id}/rom/test%20game.nes`, consoleId: 'nes', label: 'Game', ...overrides })

test('cache identity separates kind, catalog ID and hash, but not presentation labels', () => {
  const d = descriptor()
  for (const change of [{ kind: 'bios' }, { catalogId: '87654321-1234-1234-1234-123456789abc' }, { sha256: 'f'.repeat(64) }]) {
    assert.notDeepEqual(assetKey(d), assetKey({ ...d, ...change }))
  }
  assert.deepEqual(assetKey(d), assetKey({ ...d, label: 'Renamed', fileName: 'other' }))
})

test('descriptor accepts only canonical upload endpoints including BIOS and encoded names', () => {
  assert.deepEqual(readAssetDescriptor(descriptor()), descriptor())
  const bios = descriptor({ kind: 'bios', url: `/bios/${id}/test%20game.nes` })
  assert.deepEqual(readAssetDescriptor(bios), bios)
  for (const url of ['//evil/test', 'https://evil/test', '/games/demo.nes', `/games/${id}/rom/test%20game.nes?x=1`,
    `/games/${id}/rom/test game.nes`, `/games/${id}/rom/..%2Ftest.nes`, `/games/${id}/rom/test%20game.nes#x`]) {
    assert.equal(readAssetDescriptor(descriptor({ url })), null, url)
  }
})

test('descriptor rejects invalid sizes, identity, labels, filenames and SHA', () => {
  for (const size of [0, -1, 1.5, NaN, Infinity, 768 * 1024 * 1024 + 1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(readAssetDescriptor(descriptor({ size })), null)
  }
  assert.ok(readAssetDescriptor(descriptor({ size: 768 * 1024 * 1024 })))
  assert.ok(readAssetDescriptor(descriptor({ kind: 'bios', size: 32 * 1024 * 1024, url: `/bios/${id}/test%20game.nes` })))
  assert.equal(readAssetDescriptor(descriptor({ kind: 'bios', size: 32 * 1024 * 1024 + 1 })), null)
  for (const overrides of [{ sha256: 'A'.repeat(64) }, { sha256: 'f'.repeat(63) }, { sha256: 'f'.repeat(64) + '\n' },
    { catalogId: 'demo' }, { catalogId: id + '\n' },
    { fileName: '../test.nes' }, { fileName: '.' }, { fileName: 'x\\y' }, { fileName: '\0' }, { fileName: '\ud800' }, { label: '' }, { consoleId: 'bad/id' }, { kind: 'cover' }]) {
    assert.equal(readAssetDescriptor(descriptor(overrides)), null)
  }
})

test('chunk boundaries are exact at 4 MiB -1, exact and +1', () => {
  assert.equal(assetChunkCount(ASSET_CHUNK_SIZE - 1), 1)
  assert.equal(assetChunkCount(ASSET_CHUNK_SIZE), 1)
  assert.equal(assetChunkCount(ASSET_CHUNK_SIZE + 1), 2)
  assert.equal(assetChunkSize(ASSET_CHUNK_SIZE + 1, 0), ASSET_CHUNK_SIZE)
  assert.equal(assetChunkSize(ASSET_CHUNK_SIZE + 1, 1), 1)
})

test('LRU is deterministic, accounts for reservations and skips pins without mutating inputs', () => {
  const candidates = [
    { generationId: 'new', size: 4, lastUsedAt: 20, createdAt: 0 },
    { generationId: 'old', size: 4, lastUsedAt: 10, createdAt: 0 },
  ]
  assert.deepEqual(planAssetAdmission(4, 10, candidates, 0, new Set()), ['old'])
  assert.deepEqual(planAssetAdmission(4, 10, candidates, 0, new Set(['old'])), ['new'])
  assert.deepEqual(planAssetAdmission(4, 10, candidates, 4, new Set()), ['old', 'new'])
  assert.deepEqual(candidates.map(c => c.generationId), ['new', 'old'])
  assert.throws(() => planAssetAdmission(4, 10, candidates, 4, new Set(['old'])), { code: 'budget' })
  assert.throws(() => planAssetAdmission(11, 10, [], 0, new Set()), { code: 'budget' })
})

test('optional browser capacity can constrain admission even when app budget permits it', () => {
  assert.throws(() => planAssetAdmission(4, 100, [], 0, new Set(), 3), { code: 'budget' })
  assert.throws(() => planAssetAdmission(4, 100, [], 4, new Set(), 7), { code: 'budget' })
  assert.deepEqual(planAssetAdmission(4, 100, [], 0, new Set()), [])
  assert.deepEqual(planAssetAdmission(4, 100, [{ generationId: 'old', size: 4, lastUsedAt: 0, createdAt: 0 }], 0, new Set(), 0), ['old'])
})

test('settings and structured failures are distinct from network/integrity failures', () => {
  assert.deepEqual(requireCacheSettings({ enabled: false, budget: 1 }), { enabled: false, budget: 1 })
  for (const value of [null, undefined, [], { enabled: true, budget: 0 }, { enabled: true, budget: 0.5 }, { enabled: 'yes', budget: 2 }]) {
    assert.throws(() => requireCacheSettings(value), { code: 'invalid' })
  }
  for (const [name, code] of [['QuotaExceededError', 'quota'], ['AbortError', 'aborted'], ['VersionError', 'incompatible-version'], ['SecurityError', 'unavailable']]) {
    assert.equal(cacheStorageError(new DOMException('test', name)).code, code)
  }
  const existing = new AssetCacheError('corrupt', 'test')
  assert.equal(cacheStorageError(existing), existing)
  assert.throws(() => checkCacheAbort(AbortSignal.abort()), { code: 'aborted' })
})

test('missing or denied IndexedDB returns an explicit non-destructive fallback error', async () => {
  await assert.rejects(openAssetCache({ indexedDB: undefined }), { code: 'unavailable' })
  await assert.rejects(openAssetCache({ indexedDB: { open: () => { throw new DOMException('denied', 'SecurityError') } } }), { code: 'unavailable' })
  const deniedGetter = Object.defineProperty({}, 'indexedDB', { get() { throw new DOMException('denied', 'SecurityError') } })
  await assert.rejects(openAssetCache(deniedGetter), { code: 'unavailable' })
})
