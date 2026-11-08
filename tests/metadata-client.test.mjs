import test from 'node:test'
import assert from 'node:assert/strict'
import { loadCatalog } from '../src/lib/catalog.ts'
import { readMetadata, fieldLabels } from '../src/lib/metadata.ts'
import { refreshSavedMetadata } from '../src/lib/useLiveCatalog.ts'

test('M5 review DTO rejects unsafe or incomplete previews and bounds candidates', () => {
  const preview = { revision: 1, fields: Object.fromEntries(Object.keys(fieldLabels).map(key => [key, { current: '', proposed: null, locked: false, source: 'filename' }])) }
  const data = { gameId: 'test', generation: 1, status: 'needs_review', preview, candidates: [] }
  assert.ok(readMetadata(data))
  for (const invalid of [{ ...data, status: 'unknown' }, { ...data, preview: {} }, { ...data, candidates: Array(31).fill({}) }, { ...data, preview: { ...preview, revision: -1 } }]) assert.equal(readMetadata(invalid), null)
})

test('M5 saved metadata refresh preserves IDs, ROM/cache identity, local/deleted records, ordering and lastPlayed', () => {
  const saved = [{ id: 'server', source: 'server', consoleId: 'nes', title: 'Before', url: '/games/original.nes', sha256: 'a'.repeat(64), lastPlayed: 42 }, { id: 'local', source: 'local', title: 'Local' }, { id: 'deleted', source: 'server', title: 'Keep deleted reference' }]
  const fresh = [{ ...saved[0], title: 'After', url: '/wrong', sha256: 'b'.repeat(64) }]
  const result = refreshSavedMetadata(saved, fresh)
  assert.equal(result[0].title, 'After'); assert.equal(result[0].url, saved[0].url); assert.equal(result[0].sha256, saved[0].sha256); assert.equal(result[0].lastPlayed, 42)
  assert.equal(result[1], saved[1]); assert.equal(result[2], saved[2]); assert.equal(result.length, saved.length)
  assert.equal(refreshSavedMetadata(result, fresh), result)
})

test('M5 pagination detects same-total revision changes and retries a bounded complete snapshot', async t => {
  const entry = n => ({ id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`, title: String(n), consoleId: 'nes', fileName: 'fixture.nes', size: 3, sha256: 'a'.repeat(64), description: '', license: '', createdAt: 1, updatedAt: 1, url: '/games/fixture.nes' })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async url => {
    calls++
    const page = Number(new URL(url, 'http://localhost').searchParams.get('page'))
    const revision = calls === 1 ? 1 : 2
    return Response.json({ items: page === 1 ? Array.from({ length: 100 }, (_, i) => entry(i + revision * 1000)) : [entry(9999)], page, pageSize: 100, total: 101, revision })
  })
  const result = await loadCatalog('games')
  assert.equal(calls, 4); assert.equal(result.length, 101); assert.equal(result[0].title, '2000')
})
