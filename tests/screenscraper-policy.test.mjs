import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { assessScreenScraperEvidence, screenScraperLimits, screenScraperPreferences, screenScraperSystems, screenScraperTarget } from '../server/metadata/screenscraper-policy.mjs'

const fixture = async name => JSON.parse(await readFile(new URL(`./fixtures/screenscraper/${name}.json`, import.meta.url), 'utf8'))
const details = await fixture('jeu-infos')
const search = await fixture('jeu-recherche')
const input = () => ({ consoleId: 'gb', fileName: 'exemple.gb', method: 'hash', size: 3,
  md5: createHash('md5').update('abc').digest('hex'), sha1: createHash('sha1').update('abc').digest('hex') })

// Test-only adapter for the synthetic fixture, not the future provider parser.
const evidence = game => ({ id: game.id, systemId: game.systeme.id, notGame: game.notgame === 'false' ? false : undefined,
  ...(game.rom ? { rom: { id: game.rom.id, size: Number(game.rom.romsize), md5: game.rom.rommd5,
    sha1: game.rom.romsha1, totalSupports: Number(game.rom.romtotalsupport) } } : {}) })
const game = () => evidence(structuredClone(details.response.jeu))
const assess = (query = input(), games = [game()]) => assessScreenScraperEvidence(query, games)

test('M0 systems match the researched provider subset and keep GB/GBC distinct', async () => {
  const systems = (await fixture('systemes')).response.systemes
  assert.deepEqual(new Set(Object.values(screenScraperSystems)), new Set(systems.map(system => system.id)))
  assert.equal(screenScraperTarget('gb', 'Example.GB').systemId, '9')
  assert.equal(screenScraperTarget('gb', 'Example.GBC').systemId, '10')
  assert.notEqual(screenScraperSystems.gb, screenScraperSystems.gbc)
})

test('M0 covers every accepted catalog extension without changing the console manifest', async () => {
  const consoles = JSON.parse(await readFile(new URL('../public/catalog/consoles.json', import.meta.url), 'utf8'))
  for (const consoleInfo of consoles) {
    assert.ok(Object.hasOwn(screenScraperSystems, consoleInfo.id))
    for (const ext of [...consoleInfo.extensions, 'zip', '7z', 'rar']) {
      const target = screenScraperTarget(consoleInfo.id, `fixture.${ext}`)
      assert.notEqual(target.reason, 'invalid_target', `${consoleInfo.id}/${ext}`)
      if (target.systemId !== null) assert.ok(Object.values(screenScraperSystems).includes(target.systemId))
    }
  }
})

test('M0 only permits a raw hash lookup for the agreed MVP extensions', () => {
  for (const [consoleId, ext] of [['nes', 'nes'], ['snes', 'sfc'], ['gb', 'gb'], ['gb', 'gbc'], ['gba', 'gba'], ['megadrive', 'md'], ['megadrive', 'gen'], ['megadrive', 'bin']]) {
    assert.equal(screenScraperTarget(consoleId, `example.${ext}`).hashLookup, true)
  }
  for (const [consoleId, ext] of [['nes', 'fds'], ['nes', 'unif'], ['snes', 'smc'], ['snes', 'fig'], ['megadrive', 'smd'], ['psx', 'chd'], ['psx', 'pbp'], ['psx', 'cue'], ['psx', 'bin'], ['psx', 'iso']]) {
    assert.equal(screenScraperTarget(consoleId, `example.${ext}`).hashLookup, false)
  }
  assert.equal(screenScraperTarget('nes', 'example.fds').systemId, null)
})

test('M0 never mistakes an archive hash for its ROM member or guesses GB archive platform', () => {
  for (const ext of ['zip', '7z', 'rar']) {
    assert.deepEqual(screenScraperTarget('gb', `game.${ext}`), { systemId: null, hashLookup: false, reason: 'archive_requires_review' })
    assert.equal(assess({ ...input(), fileName: `game.${ext}` }).verified, false)
  }
  assert.equal(screenScraperTarget('psx', 'game.zip').systemId, '57')
  assert.equal(screenScraperTarget('psx', 'game.zip').hashLookup, false)
})

test('M0 rejects unknown consoles, mismatched extensions and path-like names', () => {
  for (const [consoleId, fileName] of [['gbc', 'game.gbc'], ['gb', 'game.nes'], ['gb', '../game.gb'], ['gb', 'C:\\game.gb'], ['gb', 'game\n.gb'], ['gb', 'game'], ['gb', null], ['__proto__', 'game.gb']]) {
    assert.deepEqual(screenScraperTarget(consoleId, fileName), { systemId: null, hashLookup: false, reason: 'invalid_target' })
  }
})

test('M0 exact evidence requires one game, its matched ROM, both hashes and exact size', () => {
  assert.deepEqual(assess(), { verified: true, reason: 'exact_rom' })
  const color = game(); color.systemId = '10'
  assert.equal(assess({ ...input(), fileName: 'exemple.gbc' }, [color]).verified, true)
  assert.equal(assess(input(), [color]).verified, false)
})

test('M0 cannot auto-apply a name or forced game-id lookup, even with matching data', () => {
  for (const method of ['name', 'gameid', 'serial', undefined]) assert.deepEqual(assess({ ...input(), method }), { verified: false, reason: 'manual_lookup' })
  const candidates = search.response.jeux.map(evidence)
  assert.equal(assess(input(), candidates).verified, false)
  assert.equal(assess(input(), candidates.slice(0, 1)).verified, false)
  assert.equal(assess(input(), []).verified, false)
  assert.equal(assess(input(), [game(), game()]).verified, false)
})

test('M0 fails closed for absent, partial, invalid or unsafe local fingerprint values', () => {
  for (const patch of [{ md5: undefined }, { sha1: undefined }, { sha1: 'g'.repeat(40) }, { md5: 'a'.repeat(31) }, { md5: 'a'.repeat(31) + '\n' }, { sha1: 'a'.repeat(39) + '\n' }, { size: '3' }, { size: 0 }, { size: NaN }, { size: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(assess({ ...input(), ...patch }).verified, false)
  }
  assert.equal(assessScreenScraperEvidence(null, [game()]).verified, false)
})

test('M0 does not treat HTTP success, SHA-256 or CRC alone as evidence', () => {
  const candidate = game()
  delete candidate.rom.md5; delete candidate.rom.sha1
  candidate.rom.sha256 = createHash('sha256').update('abc').digest('hex')
  candidate.rom.crc = '352441C2'
  assert.deepEqual(assess(input(), [candidate]), { verified: false, reason: 'missing_hash_evidence' })
  assert.equal(details.header.success, 'true')
  assert.equal(assess(input(), [{ id: '900000001', systemId: '9', notGame: false }]).verified, false)
})

test('M0 rejects conflicting hash, wrong size, system, non-game or multi-support data', () => {
  for (const patch of [{ md5: '0'.repeat(32) }, { sha1: '0'.repeat(40) }, { size: 4 }, { size: '3' }, { totalSupports: 2 }, { totalSupports: undefined }, { id: '' }]) {
    const candidate = game(); Object.assign(candidate.rom, patch)
    assert.equal(assess(input(), [candidate]).verified, false, JSON.stringify(patch))
  }
  for (const patch of [{ id: '' }, { id: '900000001\n' }, { systemId: '10' }, { systemId: 9 }, { notGame: true }, { notGame: undefined }]) {
    assert.equal(assess(input(), [{ ...game(), ...patch }]).verified, false)
  }
})

test('M0 never combines hashes from different ROMs or silently uses a roms list', () => {
  const providerGame = structuredClone(details.response.jeu)
  const matchingRom = providerGame.rom
  providerGame.rom = providerGame.roms[0]
  providerGame.roms.push(matchingRom)
  assert.equal(assess(input(), [evidence(providerGame)]).verified, false)
  delete providerGame.rom
  assert.equal(assess(input(), [evidence(providerGame)]).verified, false)
  const md5Only = game(), sha1Only = game()
  delete md5Only.rom.sha1; delete sha1Only.rom.md5
  assert.equal(assess(input(), [md5Only, sha1Only]).verified, false)
})

test('M0 preferences and local resource ceilings are finite and immutable', () => {
  assert.deepEqual(screenScraperPreferences.regions, ['wor', 'us', 'eu', 'jp', 'ss'])
  assert.deepEqual(screenScraperPreferences.languages, ['en', 'fr', 'ja'])
  assert.deepEqual(screenScraperPreferences.coverTypes, ['box-2D'])
  assert.ok(Object.isFrozen(screenScraperSystems))
  assert.ok(Object.isFrozen(screenScraperLimits))
  for (const value of Object.values(screenScraperPreferences)) assert.ok(Object.isFrozen(value))
  for (const value of Object.values(screenScraperLimits)) assert.ok(Number.isSafeInteger(value) && value > 0)
  assert.equal(screenScraperLimits.maxCandidates, 30)
  assert.equal(screenScraperLimits.concurrentRequests, 1)
  assert.equal(screenScraperLimits.coverBytes, 8 * 1024 * 1024)
  assert.equal(screenScraperLimits.coverMaxDimension, 4096)
})

test('M0 fixtures distinguish no match from quota/access errors and contain defensive invalid responses', async () => {
  const errors = await fixture('http-errors')
  assert.deepEqual(errors.filter(item => item.decision === 'not_found').map(item => item.status), [404])
  assert.equal(errors.find(item => item.status === 430).decision, 'paused_daily_quota')
  assert.equal(errors.find(item => item.status === 431).decision, 'paused_negative_quota')
  assert.equal(errors.find(item => item.status === 429).headers['retry-after'], '120')
  assert.equal(errors.filter(item => item.status === 200 && item.decision === 'invalid_response').length, 2)
})

test('M0 fixtures contain no credentials, request URLs or downloadable provider media', async () => {
  const directory = new URL('./fixtures/screenscraper/', import.meta.url)
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.json'))) {
    const body = await readFile(new URL(name, directory), 'utf8')
    assert.doesNotMatch(body, /devid|devpassword|sspassword|\bssid\b|https?:\/\/[^\s"]*\?/i)
    for (const match of body.matchAll(/https?:\/\/[^\s"]+/g)) assert.ok(new URL(match[0]).hostname.endsWith('.invalid'))
    assert.doesNotThrow(() => JSON.parse(body))
  }
})

test('M0 policy has no I/O and does not mutate fingerprints or evidence', t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('M0 must not call a provider') })
  const query = Object.freeze(input()), candidate = game()
  Object.freeze(candidate.rom); Object.freeze(candidate)
  const before = JSON.stringify({ query, candidate })
  assert.equal(assess(query, Object.freeze([candidate])).verified, true)
  assert.equal(JSON.stringify({ query, candidate }), before)
})
