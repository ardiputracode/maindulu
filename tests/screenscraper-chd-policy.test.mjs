import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { assessChdSerialEvidence, assessScreenScraperEvidence, normalizeSerial } from '../server/metadata/screenscraper-policy.mjs'

const input = (patch = {}) => ({ method: 'serial', consoleId: 'psx', fileName: 'game.chd', serial: 'SLUS-12345', ...patch })
const candidate = (patch = {}) => ({ id: '123', systemId: '57', notGame: false,
  rom: { id: '456', totalSupports: 1 }, metadata: { title: 'Fixture', media: [] }, ...patch })
const assess = (query = input(), candidates = [candidate()]) => assessChdSerialEvidence(query, candidates)

test('CHD serial evidence accepts exactly one confirmed PS1 candidate for a valid serial', () => {
  assert.deepEqual(assess(), { verified: true, reason: 'serial_unique' })
  assert.deepEqual(assess(input({ serial: 'slus-12345' })), { verified: true, reason: 'serial_unique' })
})

test('CHD serial normalizes uppercase and rejects whitespace, controls, separators and weak values', () => {
  assert.equal(normalizeSerial(' slus-12345 '), null)
  assert.equal(normalizeSerial('slus-12345'), 'SLUS-12345')
  assert.equal(normalizeSerial('SLUS_12345'), null)
  assert.equal(normalizeSerial('SLUS 12345'), null)
  assert.equal(normalizeSerial('SLUS-12345\n'), null)
  assert.equal(normalizeSerial('ABCDEFGH'), null)
  assert.equal(normalizeSerial('A'.repeat(33) + '1'), null)
  assert.equal(normalizeSerial(''), null)
  assert.equal(normalizeSerial(null), null)
  for (const serial of ['', 'ABC', 'SLUS_12345', 'SLUS 12345', ' SLUS-12345', 'SLUS-12345\n',
    'ABCDEFGH', 'A'.repeat(33) + '1', null, 12345, undefined]) {
    assert.deepEqual(assess(input({ serial })), { verified: false, reason: 'invalid_serial' }, String(serial))
  }
})

test('CHD policy is never selected for hash or name lookups', () => {
  for (const method of ['hash', 'name', 'gameid', 'manual', undefined]) {
    assert.deepEqual(assess(input({ method })), { verified: false, reason: 'manual_lookup' })
  }
})

test('CHD policy only applies to a plain PS1 .chd target', () => {
  for (const patch of [
    { consoleId: 'nes' }, { consoleId: 'snes' }, { consoleId: 'gb' },
    { fileName: 'game.iso' }, { fileName: 'game.cue' }, { fileName: 'game.chd.zip' },
    { fileName: '../game.chd' }, { fileName: 'C:\\game.chd' }, { fileName: 'game\n.chd' },
    { fileName: null }, { fileName: undefined },
  ]) {
    assert.deepEqual(assess(input(patch)), { verified: false, reason: 'invalid_target' }, JSON.stringify(patch))
  }
  assert.deepEqual(assess(input({ fileName: 'GAME.CHD' })), { verified: true, reason: 'serial_unique' })
  assert.deepEqual(assessChdSerialEvidence(null, [candidate()]), { verified: false, reason: 'invalid_target' })
})

test('CHD serial evidence requires a single candidate and a confirmed provider game', () => {
  assert.deepEqual(assess(input(), []), { verified: false, reason: 'non_unique_result' })
  assert.deepEqual(assess(input(), [candidate(), candidate()]), { verified: false, reason: 'non_unique_result' })
  assert.deepEqual(assessChdSerialEvidence(input(), undefined), { verified: false, reason: 'non_unique_result' })
  for (const id of ['', '0', '123\n', 123, null]) {
    assert.deepEqual(assess(input(), [candidate({ id })]), { verified: false, reason: 'unconfirmed_game' }, String(id))
  }
  for (const notGame of [true, null, undefined]) {
    assert.deepEqual(assess(input(), [candidate({ notGame })]), { verified: false, reason: 'unconfirmed_game' }, String(notGame))
  }
})

test('CHD serial evidence rejects a different system or a multi-support ROM', () => {
  assert.deepEqual(assess(input(), [candidate({ systemId: '3' })]), { verified: false, reason: 'system_mismatch' })
  assert.deepEqual(assess(input(), [candidate({ systemId: 57 })]), { verified: false, reason: 'system_mismatch' })
  assert.deepEqual(assess(input(), [candidate({ rom: { id: '456', totalSupports: 2 } })]), { verified: false, reason: 'unconfirmed_rom' })
  for (const rom of [null, undefined, {}, { id: '456' }, { totalSupports: '1' }]) {
    assert.deepEqual(assess(input(), [candidate({ rom })]), { verified: true, reason: 'serial_unique' }, JSON.stringify(rom))
  }
})

test('CHD policy leaves the raw/ZIP hash gate unchanged', () => {
  const md5 = createHash('md5').update('abc').digest('hex')
  const sha1 = createHash('sha1').update('abc').digest('hex')
  const raw = { method: 'hash', consoleId: 'gb', fileName: 'game.gb', size: 3, md5, sha1 }
  const rawCandidate = { id: '123', systemId: '9', notGame: false,
    rom: { id: '456', size: 3, md5, sha1, totalSupports: 1 }, metadata: { title: 'Fixture', media: [] } }
  assert.deepEqual(assessScreenScraperEvidence(raw, [rawCandidate]), { verified: true, reason: 'exact_rom' })
  assert.deepEqual(assessScreenScraperEvidence({ ...raw, md5: '0'.repeat(32) }, [rawCandidate]), { verified: false, reason: 'hash_mismatch' })
  assert.deepEqual(assessScreenScraperEvidence({ ...raw, method: 'serial' }, [rawCandidate]), { verified: false, reason: 'manual_lookup' })
  assert.deepEqual(assessScreenScraperEvidence({ method: 'hash', consoleId: 'psx', fileName: 'game.chd', size: 3, md5, sha1 },
    [rawCandidate]), { verified: false, reason: 'format_requires_review' })
})

test('CHD policy does not mutate its inputs', () => {
  const query = Object.freeze(input())
  const game = candidate()
  Object.freeze(game.rom); Object.freeze(game.metadata); Object.freeze(game)
  const before = JSON.stringify({ query, game })
  assert.equal(assess(query, Object.freeze([game])).verified, true)
  assert.equal(JSON.stringify({ query, game }), before)
})
