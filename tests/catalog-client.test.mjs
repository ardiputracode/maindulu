import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { catalogBios, catalogGame, catalogRequest, latestCatalogEntry, libraryGames, loadCatalog, mergeCatalog, readCatalogEntry, readCatalogPage, readManifestGames } from '../src/lib/catalog.ts'
import { readGames, recordHistory, toggleFavorite } from '../src/lib/domain.ts'

const entry = (n = 0) => ({ id: randomUUID(), consoleId: 'nes', title: `Game ${n}`, source: 'server', fileName: 'game.nes', size: 16,
  sha256: 'a'.repeat(64), description: '', createdAt: n, updatedAt: n, license: 'CC0', url: '/games/test/rom/game.nes' })
const json = value => Response.json(value)

test('public catalog parsing is distinct from saved metadata and preserves 200-character titles without raising saved-list limits', () => {
  const items = Array.from({ length: 130 }, (_, n) => catalogGame(entry(n)))
  assert.equal(readManifestGames(items).length, 130)
  assert.equal(readGames(items).length, 100)
  assert.equal(recordHistory(items, items[0], true).length, 50)
  assert.equal(toggleFavorite(items, catalogGame(entry(999))).length, 100)
  assert.ok(readCatalogEntry({ ...entry(), title: 'x'.repeat(200) }, 'games'))
  assert.equal(readGames([{ ...items[0], title: 'x'.repeat(200) }]).length, 1)
  assert.equal(readCatalogEntry({ ...entry(), url: '//evil/game' }, 'games'), null)
  assert.equal(readCatalogEntry({ ...entry(), sha256: 'invalid' }, 'games'), null)
  assert.equal(readCatalogPage({ items: [entry()], page: 1, pageSize: 100, total: 0 }, 'games'), null)
  assert.throws(() => readManifestGames({}), /Manifest/)
})

test('public catalog consumes every metadata page, keeps hashes/names and never reads asset bytes', async t => {
  const items = Array.from({ length: 205 }, (_, n) => entry(n)), requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push(url)
    assert.equal(init.cache, 'no-store')
    const query = new URL(url, 'http://localhost').searchParams
    assert.equal(query.get('console'), 'nes')
    assert.equal(query.get('pageSize'), '100')
    const page = Number(query.get('page'))
    return json({ items: items.slice((page - 1) * 100, page * 100), total: items.length, page, pageSize: 100 })
  })
  assert.deepEqual(await loadCatalog('games', 'console=nes'), items)
  assert.equal(requests.length, 3)
  assert.ok(requests.every(url => url.startsWith('/api/games?')))
  const bios = catalogBios({ ...entry(), name: 'Firmware', distributionRights: 'Synthetic', fileName: 'disksys.rom' })
  assert.equal(bios.fileName, 'disksys.rom'); assert.equal(bios.sha256, 'a'.repeat(64))
})

test('incomplete, duplicate or changing pagination fails visibly rather than silently hiding catalog entries', async t => {
  const item = entry()
  for (const items of [[item], Array(100).fill(item)]) {
    t.mock.method(globalThis, 'fetch', async () => json({ items, page: 1, pageSize: 100, total: 101 }))
    await assert.rejects(loadCatalog('bios'), /Halaman|respons|Katalog/)
    t.mock.restoreAll()
  }
  const first = Array.from({ length: 100 }, (_, n) => entry(n))
  t.mock.method(globalThis, 'fetch', async url => {
    const page = Number(new URL(url, 'http://localhost').searchParams.get('page'))
    return json({ items: page === 1 ? first : [entry(101)], page, pageSize: 100, total: page === 1 ? 101 : 102 })
  })
  await assert.rejects(loadCatalog('games'), /Katalog berubah/)
})

test('built-in IDs win merging and search/filter/sort do not change game identity', () => {
  const builtin = { ...catalogGame(entry()), id: 'jalan-pulang-v1', title: 'Jalan Pulang', createdAt: undefined }
  const upload = { ...catalogGame(entry(5)), title: 'Abjad' }
  const merged = mergeCatalog([builtin], [upload, { ...builtin, title: 'Duplicate' }])
  assert.equal(merged.length, 2)
  assert.equal(merged.find(g => g.id === builtin.id), builtin)
  assert.deepEqual(libraryGames(merged, '', 'nes', 'title').map(g => g.id), [upload.id, builtin.id])
  assert.deepEqual(libraryGames(merged, ' JALAN ', 'nes', 'newest'), [builtin])
  assert.deepEqual(libraryGames(merged, '', 'gba', 'title'), [])
})

test('metadata refresh rejects deleted entries, HTML fallbacks and mismatched identities; request cancellation is retained', async t => {
  const item = entry()
  t.mock.method(globalThis, 'fetch', async () => json({ item }))
  assert.equal((await latestCatalogEntry('games', item.id)).id, item.id)
  await assert.rejects(latestCatalogEntry('games', randomUUID()), /Metadata/)
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }))
  await assert.rejects(latestCatalogEntry('games', item.id), /sudah dihapus/)
  t.mock.method(globalThis, 'fetch', async () => new Response('<html/>', { headers: { 'content-type': 'text/html' } }))
  await assert.rejects(catalogRequest('/api/games'), /bukan JSON/)
  const controller = new AbortController(); controller.abort()
  t.mock.method(globalThis, 'fetch', async (_url, init) => { init.signal.throwIfAborted() })
  await assert.rejects(loadCatalog('games', '', controller.signal), { name: 'AbortError' })
})
