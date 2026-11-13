import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createApp } from './helpers/gated-backend.mjs'
import { identifyCatalogRom, archiveIdentificationLimits as limits, candidateTarget, smcHeaderSize } from '../server/metadata/identification.mjs'
import { createMetadataWorker } from '../server/metadata/worker.mjs'
import { enqueueMetadata, storedCandidates } from '../server/metadata/queue.mjs'
import { assessScreenScraperEvidence } from '../server/metadata/screenscraper-policy.mjs'
import { ScreenScraperClient } from '../server/metadata/screenscraper.mjs'
import { metadataCacheKey } from '../server/metadata/cache.mjs'
import { crc32, deflateRawSync } from 'node:zlib'
import { backendFixture } from './helpers/backend-fixture.mjs'
import { metadataZip } from './helpers/metadata-zip.mjs'

const hash = (data, algorithm = 'sha256') => createHash(algorithm).update(data).digest('hex')
async function identify(t, bytes, options = {}) {
  const root = await backendFixture(t), path = join(root, 'archive.zip')
  await writeFile(path, bytes)
  const file = await open(path, 'r')
  try { return await identifyCatalogRom(file, { consoleId: 'gb', fileName: 'upload.zip', size: bytes.length, sha256: hash(bytes), ...options }) }
  finally { await file.close() }
}
const candidate = (input, systemId = '9') => ({ id: '123', systemId, notGame: false,
  rom: { id: '456', size: input.size, md5: input.md5, sha1: input.sha1, totalSupports: 1 },
  metadata: { title: 'ZIP title', description: 'ZIP description', media: [] } })

test('M7 SMC header detection follows the 512-byte copier convention', () => {
  assert.equal(smcHeaderSize(1536), 512)
  assert.equal(smcHeaderSize(512), 0)
  assert.equal(smcHeaderSize(1024), 0)
  assert.equal(smcHeaderSize(1025), 0)
  assert.equal(smcHeaderSize(undefined), 0)
})

test('M7 plain SMC hashes the raw ROM after stripping a 512-byte copier header', async t => {
  const root = await backendFixture(t), path = join(root, 'game.smc')
  const header = Buffer.alloc(512, 0x11), inner = Buffer.alloc(1024, 0x5a)
  const bytes = Buffer.concat([header, inner])
  await writeFile(path, bytes)
  const file = await open(path, 'r')
  try {
    const found = await identifyCatalogRom(file, { consoleId: 'snes', fileName: 'game.smc', size: bytes.length, sha256: hash(bytes) })
    assert.deepEqual(found.hashes, { size: inner.length, md5: hash(inner, 'md5'), sha1: hash(inner, 'sha1'), sha256: hash(bytes) })
    assert.deepEqual(found.identification, { kind: 'smc-header', version: 1 })
  } finally { await file.close() }
})

test('M7 plain SFC keeps the exact raw fingerprint and identification', async t => {
  const root = await backendFixture(t), path = join(root, 'game.sfc')
  const bytes = Buffer.alloc(1024, 0x5a)
  await writeFile(path, bytes)
  const file = await open(path, 'r')
  try {
    const found = await identifyCatalogRom(file, { consoleId: 'snes', fileName: 'game.sfc', size: bytes.length, sha256: hash(bytes) })
    assert.deepEqual(found.hashes, { size: bytes.length, md5: hash(bytes, 'md5'), sha1: hash(bytes, 'sha1'), sha256: hash(bytes) })
    assert.deepEqual(found.identification, { kind: 'raw', version: 1 })
  } finally { await file.close() }
})

test('M7 plain SMC without a copier header stays raw and keeps exact fingerprint', async t => {
  const root = await backendFixture(t), path = join(root, 'game.smc')
  const bytes = Buffer.alloc(1024, 0x5a)
  await writeFile(path, bytes)
  const file = await open(path, 'r')
  try {
    const found = await identifyCatalogRom(file, { consoleId: 'snes', fileName: 'game.smc', size: bytes.length, sha256: hash(bytes) })
    assert.deepEqual(found.hashes, { size: bytes.length, md5: hash(bytes, 'md5'), sha1: hash(bytes, 'sha1'), sha256: hash(bytes) })
    assert.deepEqual(found.identification, { kind: 'raw', version: 1 })
  } finally { await file.close() }
})

for (const method of [0, 8]) test(`M7 ZIP method ${method} normalizes a headered SMC member`, async t => {
  const header = Buffer.alloc(512, 0x11), inner = Buffer.alloc(1024, 0x5a)
  const found = await identify(t, metadataZip([{ name: 'game.smc', data: Buffer.concat([header, inner]), method }]), { consoleId: 'snes' })
  assert.equal(found.fileName, 'game.smc')
  assert.deepEqual(found.hashes, { size: inner.length, md5: hash(inner, 'md5'), sha1: hash(inner, 'sha1') })
  const target = candidateTarget('snes', 'upload.zip', found.identification)
  assert.equal(target.systemId, '4')
  assert.equal(target.hashLookup, true)
  assert.equal(assessScreenScraperEvidence({ method: 'hash', consoleId: 'snes', fileName: found.fileName, ...found.hashes },
    [candidate(found.hashes, '4')]).verified, true)
})

test('M7 ZIP SMC without a copier header keeps the whole member fingerprint', async t => {
  const data = Buffer.alloc(1024, 0x5a)
  const found = await identify(t, metadataZip([{ name: 'game.smc', data, method: 0 }]), { consoleId: 'snes' })
  assert.deepEqual(found.hashes, { size: data.length, md5: hash(data, 'md5'), sha1: hash(data, 'sha1') })
})

for (const method of [0, 8]) for (const [consoleId, fileName] of [['nes', 'a.nes'], ['snes', 'a.sfc'], ['gb', 'a.gb'], ['gb', 'a.gbc'], ['gba', 'a.gba'], ['megadrive', 'a.bin']]) {
  test(`M7 ZIP method ${method} identifies only member bytes: ${consoleId}/${fileName}`, async t => {
    const data = Buffer.from('Synthetic legal ROM bytes. Not a commercial dump.')
    const zip = metadataZip([{ name: 'folder/', data: '' }, { name: 'folder/' + fileName, data, method }])
    const found = await identify(t, zip, { consoleId })
    assert.deepEqual(found.hashes, { size: data.length, md5: hash(data, 'md5'), sha1: hash(data, 'sha1') })
    assert.notEqual(found.hashes.md5, hash(zip, 'md5'))
    assert.equal(found.fileName, fileName)
    const target = candidateTarget(consoleId, 'upload.zip', found.identification)
    assert.ok(target.hashLookup)
    assert.equal(assessScreenScraperEvidence({ method: 'hash', consoleId, fileName: found.fileName, ...found.hashes }, [candidate(found.hashes, target.systemId)]).verified, true)
  })
}

test('M7 ZIP data descriptor is validated and CRC is mandatory independently of provider hashes', async t => {
  const good = metadataZip([{ name: 'a.gb', method: 8, flags: 8 }])
  assert.equal((await identify(t, good)).hashes.md5, hash('abc', 'md5'))
  const bad = Buffer.from(good); bad[good.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08])) + 4] ^= 1
  await assert.rejects(identify(t, bad), { code: 'archive_invalid' })
  await assert.rejects(identify(t, metadataZip([{ name: 'a.gb', crc: 1 }])), { code: 'archive_invalid' })
})

test('M7 interoperates with a ZIP produced independently by Windows .NET ZipArchive', async t => {
  // Generated 2026-11-08 using System.IO.Compression.ZipArchive, Optimal,
  // one entry contoh.gbc containing only ASCII abc. No ROM/provider data.
  const zip = Buffer.from('UEsDBBQAAAAIAAWjaF3CQSQ1BQAAAAMAAAAKAAAAY29udG9oLmdiY0tMSgYAUEsBAhQAFAAAAAgABaNoXcJBJDUFAAAAAwAAAAoAAAAAAAAAAAAAAAAAAAAAAGNvbnRvaC5nYmNQSwUGAAAAAAEAAQA4AAAALQAAAAAA', 'base64')
  const found = await identify(t, zip)
  assert.equal(found.fileName, 'contoh.gbc')
  assert.equal(found.hashes.md5, hash('abc', 'md5'))
  assert.equal(candidateTarget('gb', 'a.zip', found.identification).systemId, '10')
})

const attacks = [
  ['traversal', [{ name: '../a.gb' }]], ['absolute', [{ name: '/a.gb' }]], ['drive', [{ name: 'C:a.gb' }]],
  ['backslash', [{ name: 'dir\\a.gb' }]], ['control', [{ name: 'a\0.gb' }]], ['dot segment', [{ name: './a.gb' }]],
  ['deep path', [{ name: 'x/'.repeat(9) + 'a.gb' }]], ['long path', [{ name: 'x'.repeat(241) + '.gb' }]],
  ['empty segment', [{ name: 'dir//a.gb' }]], ['windows alias', [{ name: 'dir./a.gb' }]],
  ['symlink', [{ name: 'a.gb', attributes: 0xa1ff0000 }]], ['special file', [{ name: 'a.gb', attributes: 0x61ff0000 }]],
  ['DOS directory masquerading as ROM', [{ name: 'a.gb', attributes: 0x10 }]],
  ['hardlink extra', [{ name: 'a.gb', extra: Buffer.from([0x0d, 0, 0, 0]) }]],
  ['encrypted', [{ name: 'a.gb', flags: 1 }]], ['unsupported codec', [{ name: 'a.gb', method: 12 }]],
  ['nested archive', [{ name: 'a.zip' }]], ['smc on the wrong platform', [{ name: 'a.smc' }]], ['wrong platform', [{ name: 'a.nes' }]],
  ['two games', [{ name: 'a.gb' }, { name: 'b.gb' }]], ['readme not silently ignored', [{ name: 'a.gb' }, { name: 'README.txt' }]],
  ['duplicate names', [{ name: 'a.gb' }, { name: 'a.gb' }]], ['case aliases', [{ name: 'a.gb' }, { name: 'A.GB' }]],
  ['empty ROM', [{ name: 'a.gb', data: '' }]], ['directory with data', [{ name: 'folder/' }, { name: 'a.gb' }]],
  ['local filename disagreement', [{ name: 'a.gb', localName: 'b.gb' }]], ['overlapping entry', [{ name: 'a.gb', offset: 1 }]],
  ['compression bomb', [{ name: 'a.gb', data: Buffer.alloc(1024 * 1024), method: 8 }]],
  ['forged inflated size', [{ name: 'a.gb', data: Buffer.alloc(1000, 1), size: 10, method: 8 }]],
  ['inflated size cap', [{ name: 'a.gb', data: 'a', size: limits.outputBytes + 1, method: 8 }]],
  ['trailing compressed garbage', [{ name: 'a.gb', method: 8, compressed: Buffer.concat([deflateRawSync(Buffer.from('abc')), Buffer.from('junk')]) }]],
  ['entry cap', Array.from({ length: limits.entries + 1 }, (_, n) => ({ name: `${n}/`, data: '' }))],
]
for (const [label, entries] of attacks) test(`M7 rejects ${label} without extraction`, async t => {
  await assert.rejects(identify(t, metadataZip(entries)), error => /^archive_/.test(error.code))
})

test('M7 rejects inconsistent directory sizes/counts, hidden local records, multi-volume, ZIP64 and Unicode name overrides', async t => {
  const zip = metadataZip([{ name: 'a.gb' }])
  for (const [offset, value, width] of [[zip.length - 10, 0, 4], [zip.length - 14, 2, 2], [zip.length - 18, 1, 2]]) {
    const bad = Buffer.from(zip)
    width === 4 ? bad.writeUInt32LE(value, offset) : bad.writeUInt16LE(value, offset)
    await assert.rejects(identify(t, bad), error => /^archive_/.test(error.code))
  }
  const hidden = metadataZip([{ name: 'a.gb' }, { name: 'b.gb' }])
  const central = hidden.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  const firstLength = 46 + Buffer.byteLength('a.gb')
  const bad = Buffer.concat([hidden.subarray(0, central + firstLength), hidden.subarray(-22)])
  bad.writeUInt16LE(1, bad.length - 14); bad.writeUInt16LE(1, bad.length - 12); bad.writeUInt32LE(firstLength, bad.length - 10)
  await assert.rejects(identify(t, bad), { code: 'archive_invalid' })
  for (const extra of [Buffer.from([1, 0, 0, 0]), Buffer.from([0x75, 0x70, 0, 0])]) {
    await assert.rejects(identify(t, metadataZip([{ name: 'a.gb', extra }])), error => /^archive_/.test(error.code))
  }
})

test('M7 cache isolates search/member hashes from the uploaded container and shares identical raw identification', async t => {
  const found = await identify(t, metadataZip([{ name: 'a.gb' }]))
  const key = metadataCacheKey('9', found.hashes, found.fileName)
  assert.equal(key.key, metadataCacheKey('9', { size: 3, md5: hash('abc', 'md5'), sha1: hash('abc', 'sha1') }, 'a.gb').key)
  assert.notEqual(key.key, metadataCacheKey('10', found.hashes, found.fileName).key)
  assert.notEqual(key.key, metadataCacheKey('9', { ...found.hashes, md5: '0'.repeat(32) }, found.fileName).key)
})

test('M7 ratio boundary distinguishes the 100:1 metadata ceiling from actual output size validation', async t => {
  // A real deflate stream need not be exactly the boundary: stored payload
  // padded with bytes must be refused too, so here test the metadata ceiling.
  const compressed = deflateRawSync(Buffer.alloc(1000, 1))
  const at = metadataZip([{ name: 'a.gb', method: 8, compressed, size: compressed.length * limits.ratio, crc: crc32(Buffer.alloc(1000, 1)) }])
  // Below/equal ratio passes metadata gate then fails actual size equality.
  await assert.rejects(identify(t, at), { code: 'archive_invalid' })
  const above = metadataZip([{ name: 'a.gb', method: 8, compressed, size: compressed.length * limits.ratio + 1 }])
  await assert.rejects(identify(t, above), { code: 'archive_limits' })
})

test('M7 rejects corrupt/truncated ZIP, wrong asset hash and input cap; worker never owns the storage handle', async t => {
  const bytes = metadataZip([{ name: 'a.gb' }])
  await assert.rejects(identify(t, bytes.subarray(0, -2)), { code: 'archive_invalid' })
  await assert.rejects(identify(t, bytes, { sha256: '0'.repeat(64) }), { code: 'asset_mismatch' })
  await assert.rejects(identify(t, bytes, { size: limits.inputBytes + 1 }), { code: 'archive_limits' })
  const root = await backendFixture(t), path = join(root, 'borrowed.zip')
  await writeFile(path, bytes)
  const file = await open(path, 'r')
  try {
    await identifyCatalogRom(file, { consoleId: 'gb', fileName: 'a.zip', size: bytes.length, sha256: hash(bytes) })
    assert.equal((await file.stat()).size, bytes.length)
    assert.deepEqual((await readdir(root)).sort(), ['borrowed.zip', 'dist', 'public'])
  } finally { await file.close() }
})

test('M7 deadline and abort terminate the archive worker before returning the borrowed handle', async t => {
  const bytes = metadataZip([{ name: 'a.gb' }])
  await assert.rejects(identify(t, bytes, { timeoutMs: 1 }), { code: 'identification_timeout' })
  const controller = new AbortController()
  const pending = identify(t, bytes, { signal: controller.signal })
  await delay(5); controller.abort()
  await assert.rejects(pending)
})

test('M7 bounds a real 64 MiB member and refuses a larger one; no complete output buffer is needed', async t => {
  // Stored avoids the ratio cap; generated legal synthetic bytes, not a dump.
  const data = Buffer.alloc(limits.outputBytes, 0x5a)
  const result = await identify(t, metadataZip([{ name: 'a.gba', data }]), { consoleId: 'gba' })
  assert.equal(result.hashes.size, limits.outputBytes)
  assert.equal(result.hashes.md5, hash(data, 'md5'))
  await assert.rejects(identify(t, metadataZip([{ name: 'a.gba', data: Buffer.concat([data, Buffer.from('x')]) }]), { consoleId: 'gba' }), { code: 'archive_limits' })
})

test('M7 7z/RAR and PS1 containers remain unsupported without even reading disc bytes', async () => {
  const file = { createReadStream() { assert.fail('Must not read unsupported formats, including a large disc') } }
  for (const [consoleId, fileName] of [['gba', 'a.7z'], ['gba', 'a.rar'], ['psx', 'a.pbp'], ['psx', 'a.cue'], ['psx', 'a.bin'], ['psx', 'a.iso'], ['psx', 'a.zip']]) {
    await assert.rejects(identifyCatalogRom(file, { consoleId, fileName, size: 768 * 1024 * 1024 }), { code: 'unsupported_format' })
  }
  // A plain PS1 CHD is now identifiable only through a validated asset path and
  // the serial probe; this legacy test still guarantees no disc bytes are read.
  await assert.rejects(identifyCatalogRom(file, { consoleId: 'psx', fileName: 'a.chd', size: 768 * 1024 * 1024 }), { code: 'invalid_target' })
  assert.equal(candidateTarget('gb', 'a.zip', { kind: 'zip-member', version: 1, fileName: '../a.gb' }).systemId, null)
  assert.equal(candidateTarget('gb', 'a.zip', { kind: 'zip-member', version: 2, fileName: 'a.gb' }).systemId, null)
})

async function workerFixture(t, { data = Buffer.from('abc'), entries, consoleId = 'gb', fileName = 'upload.zip', clientFactory, raw = false } = {}) {
  let app
  const root = await backendFixture(t, { beforeCleanup: () => app?.close() })
  app = await createApp({ root, env: {} })
  const db = app.database, storage = app.catalog.storage, actor = randomUUID()
  db.prepare('INSERT INTO users (id, username, password_hash, recovery_code_hash, created_at, role) VALUES (?, ?, ?, ?, ?, ?)').run(actor, 'm7admin', 'fixture', 'fixture', Date.now(), 'admin')
  const bytes = raw ? Buffer.from(data) : metadataZip(entries ?? [{ name: 'inner.gbc', data, method: 8 }])
  const stage = await storage.stage('games', (async function* () { yield bytes })())
  const game = await app.catalog.repository.publish('games', actor, { description: '', license: 'Manual license', consoleId, fileName }, stage)
  const config = { screenscraper: { enabled: true, missing: [] } }
  const calls = []
  const worker = createMetadataWorker({ db, storage, config, logger: { warn() {}, error() {} }, clientFactory: clientFactory ?? (() => ({
    searchByHash: async input => { calls.push(input); return { method: 'hash', systemId: '10', candidates: [candidate(input, '10')] } },
    searchByName: async input => { calls.push(input); return { method: 'name', systemId: '10', candidates: [candidate({ size: 3, md5: hash('abc', 'md5'), sha1: hash('abc', 'sha1') }, '10')] } },
  })) })
  t.after(() => worker.stop())
  return { app, db, storage, actor, game, bytes, worker, calls, config }
}

test('M7 worker identifies GBC ZIP, applies exact evidence and keeps asset identity/bytes/provenance boundaries', async t => {
  const { app, db, storage, game, bytes, worker, calls } = await workerFixture(t)
  await worker.processOne()
  const job = db.prepare('SELECT * FROM metadata_jobs WHERE game_id = ?').get(game.id)
  assert.equal(job.status, 'succeeded')
  assert.equal(calls.length, 1); assert.equal(calls[0].fileName, 'inner.gbc'); assert.equal(calls[0].size, 3)
  const after = db.prepare('SELECT * FROM games WHERE id = ?').get(game.id)
  assert.equal(after.title, 'ZIP title'); assert.equal(after.description, 'ZIP description')
  for (const field of ['id', 'sha256', 'size', 'original_name', 'storage_key', 'license', 'console_id']) assert.equal(after[field], game[field])
  assert.deepEqual(await readFile(await storage.pathFor('games', game.storage_key)), bytes)
  assert.equal(storedCandidates(job, after).length, 1)
  assert.equal(JSON.parse(job.candidate_json).identification.fileName, 'inner.gbc')
  assert.deepEqual(JSON.parse(job.candidate_json).fingerprint, { size: 3, md5: hash('abc', 'md5'), sha1: hash('abc', 'sha1') })
  assert.equal((await app.inject(`/api/games/${game.id}`)).json().item.sha256, hash(bytes))
})

test('M7 worker auto-applies plain SMC after normalizing its copier header', async t => {
  const inner = Buffer.alloc(1024, 0x5a)
  const bytes = Buffer.concat([Buffer.alloc(512, 0x11), inner])
  const { app, db, game, worker, calls } = await workerFixture(t, {
    consoleId: 'snes', fileName: 'game.smc', raw: true, data: bytes,
    clientFactory: () => ({ searchByHash: async input => {
      calls.push(input)
      return { method: 'hash', systemId: '4', candidates: [{ id: '123', systemId: '4', notGame: false,
        rom: { id: '456', size: input.size, md5: input.md5, sha1: input.sha1, totalSupports: 1 },
        metadata: { title: 'SMC title', description: 'SMC description', media: [] } }] }
    } }),
  })
  await worker.processOne()
  const job = db.prepare('SELECT * FROM metadata_jobs WHERE game_id = ?').get(game.id)
  assert.equal(job.status, 'succeeded')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].fileName, 'game.smc')
  assert.equal(calls[0].size, inner.length)
  assert.equal(calls[0].md5, hash(inner, 'md5'))
  assert.equal(calls[0].sha1, hash(inner, 'sha1'))
  const after = db.prepare('SELECT * FROM games WHERE id = ?').get(game.id)
  assert.equal(after.title, 'SMC title')
  assert.equal(after.sha256, game.sha256)
  assert.equal(after.size, game.size)
  assert.equal(JSON.parse(job.candidate_json).identification.kind, 'smc-header')
  assert.deepEqual(JSON.parse(job.candidate_json).fingerprint, { size: inner.length, md5: hash(inner, 'md5'), sha1: hash(inner, 'sha1') })
  assert.equal((await app.inject(`/api/games/${game.id}`)).json().item.sha256, hash(bytes))
})

test('M7 worker auto-applies a ZIP SMC after normalizing its copier header', async t => {
  const inner = Buffer.alloc(1024, 0x5a)
  const { app, db, game, bytes, worker, calls } = await workerFixture(t, {
    consoleId: 'snes', fileName: 'upload.zip', entries: [{ name: 'inner.smc', data: Buffer.concat([Buffer.alloc(512, 0x11), inner]), method: 8 }],
    clientFactory: () => ({ searchByHash: async input => {
      calls.push(input)
      return { method: 'hash', systemId: '4', candidates: [{ id: '123', systemId: '4', notGame: false,
        rom: { id: '456', size: input.size, md5: input.md5, sha1: input.sha1, totalSupports: 1 },
        metadata: { title: 'ZIP SMC title', description: 'ZIP SMC description', media: [] } }] }
    } }),
  })
  await worker.processOne()
  const job = db.prepare('SELECT * FROM metadata_jobs WHERE game_id = ?').get(game.id)
  assert.equal(job.status, 'succeeded')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].fileName, 'inner.smc')
  assert.equal(calls[0].size, inner.length)
  assert.equal(calls[0].md5, hash(inner, 'md5'))
  assert.equal(calls[0].sha1, hash(inner, 'sha1'))
  const after = db.prepare('SELECT * FROM games WHERE id = ?').get(game.id)
  assert.equal(after.title, 'ZIP SMC title')
  assert.equal(after.sha256, game.sha256)
  assert.equal(after.size, game.size)
  assert.equal(JSON.parse(job.candidate_json).identification.fileName, 'inner.smc')
  assert.deepEqual(JSON.parse(job.candidate_json).fingerprint, { size: inner.length, md5: hash(inner, 'md5'), sha1: hash(inner, 'sha1') })
  assert.equal((await app.inject(`/api/games/${game.id}`)).json().item.sha256, hash(bytes))
})

test('M7 rejected multi-game ZIP never contacts provider and leaves game playable', async t => {
  const { app, db, game, worker, calls } = await workerFixture(t, { entries: [{ name: 'a.gb' }, { name: 'b.gbc' }] })
  await worker.processOne()
  assert.equal(calls.length, 0)
  assert.equal(db.prepare('SELECT status FROM metadata_jobs WHERE game_id = ?').get(game.id).status, 'unsupported')
  const publicGame = (await app.inject(`/api/games/${game.id}`)).json().item
  assert.equal((await app.inject(publicGame.url)).statusCode, 200)
})

test('M7 GBC ZIP name fallback stays manual; review survives explicit apply and retains member/system binding', async t => {
  const { db, game, worker, calls, config } = await workerFixture(t)
  db.prepare("UPDATE metadata_jobs SET status = 'cancelled' WHERE game_id = ?").run(game.id)
  enqueueMetadata(db, config, game, { method: 'name', query: 'Manual query' })
  await worker.processOne()
  let job = db.prepare('SELECT * FROM metadata_jobs WHERE game_id = ? ORDER BY generation DESC LIMIT 1').get(game.id)
  assert.equal(job.status, 'needs_review'); assert.equal(calls[0].fileName, 'inner.gbc')
  assert.equal(storedCandidates(job, game).length, 1)
  const fingerprint = JSON.parse(job.candidate_json).fingerprint
  db.prepare('UPDATE metadata_provider_state SET next_at = 0').run()
  const revision = db.prepare('SELECT metadata_revision FROM game_metadata WHERE game_id = ?').get(game.id).metadata_revision
  enqueueMetadata(db, config, game, { method: 'apply', candidateId: '123', generation: job.generation, expectedRevision: revision, fields: ['title'] })
  await worker.processOne()
  job = db.prepare('SELECT * FROM metadata_jobs WHERE game_id = ? ORDER BY generation DESC LIMIT 1').get(game.id)
  assert.equal(job.status, 'succeeded'); assert.equal(storedCandidates(job, game).length, 1); assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(job.candidate_json).fingerprint, fingerprint)
})

test('M7 rejected NES ZIP still permits name-only review on the known platform, never automatic apply', async t => {
  const { db, game, worker, config } = await workerFixture(t, { consoleId: 'nes', entries: [{ name: 'a.nes' }, { name: 'README.txt' }],
    clientFactory: () => ({ searchByName: async () => ({ method: 'name', systemId: '3', candidates: [candidate({}, '3')] }) }) })
  await worker.processOne()
  db.prepare('UPDATE metadata_provider_state SET next_at = 0').run()
  enqueueMetadata(db, config, game, { method: 'name', query: 'Manual name' })
  await worker.processOne()
  const job = db.prepare('SELECT * FROM metadata_jobs WHERE game_id = ? ORDER BY generation DESC LIMIT 1').get(game.id)
  assert.equal(job.status, 'needs_review'); assert.equal(storedCandidates(job, game).length, 1)
  assert.notEqual(db.prepare('SELECT title FROM games WHERE id = ?').get(game.id).title, 'ZIP title')
})

for (const action of ['edit', 'delete', 'disable', 'stop']) test(`M7 ZIP ${action} during held provider lookup fences late results`, async t => {
  let enter, release
  const entered = new Promise(resolve => { enter = resolve }), gate = new Promise(resolve => { release = resolve })
  const { app, db, actor, game, worker, config } = await workerFixture(t, { clientFactory: () => ({ searchByHash: async input => {
    enter(); await gate; return { method: 'hash', systemId: '10', candidates: [candidate(input, '10')] }
  } }) })
  const pending = worker.processOne()
  try {
    await entered
    if (action === 'edit') await app.catalog.repository.update('games', actor, game.id, { title: 'Admin wins' })
    if (action === 'delete') await app.catalog.repository.delete('games', actor, game.id)
    if (action === 'disable') config.screenscraper.enabled = false
    if (action === 'stop') await worker.stop()
  } finally { release() }
  await pending
  const row = db.prepare('SELECT title FROM games WHERE id = ?').get(game.id)
  assert.notEqual(row.title, 'ZIP title')
  if (action === 'edit') assert.equal(row.title, 'Admin wins')
  assert.notEqual(db.prepare('SELECT status FROM metadata_jobs WHERE game_id = ?').get(game.id).status, 'succeeded')
})

test('M7 HTTP lookup sends only member basename/size/hashes and still requires exact provider evidence', async t => {
  const found = await identify(t, metadataZip([{ name: 'dir/a.gbc' }]))
  const client = new ScreenScraperClient({ enabled: true, missing: [], devId: 'dummy' }, { fetch: async url => {
    assert.equal(url.searchParams.get('systemeid'), '10'); assert.equal(url.searchParams.get('romnom'), 'a.gbc')
    assert.equal(url.searchParams.get('romtaille'), '3'); assert.equal(url.searchParams.get('md5'), hash('abc', 'md5'))
    return new Response(JSON.stringify({ response: { jeu: { id: '123', systeme: { id: '10' }, notgame: false,
      rom: { id: '456', romsize: 3, rommd5: found.hashes.md5, romsha1: found.hashes.sha1, romtotalsupport: 1 } } } }))
  } })
  const result = await client.searchByHash({ consoleId: 'gb', fileName: found.fileName, ...found.hashes })
  const input = { method: 'hash', consoleId: 'gb', fileName: found.fileName, ...found.hashes }
  assert.equal(assessScreenScraperEvidence(input, result.candidates).verified, true)
  for (const patch of [{ systemId: '9' }, { rom: { ...result.candidates[0].rom, totalSupports: 2 } }, { rom: { ...result.candidates[0].rom, size: 4 } }]) {
    assert.equal(assessScreenScraperEvidence(input, [{ ...result.candidates[0], ...patch }]).verified, false)
  }
})
