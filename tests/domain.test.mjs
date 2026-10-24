import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { DEFAULT_SETTINGS, MAX_ROM_SIZE, detectConsole, validateRom, validateBios, readSettings, readGames, isSafeLocalUrl, recordHistory, toggleFavorite } from '../src/lib/domain.ts'

const consoles = JSON.parse(await readFile(new URL('../public/catalog/consoles.json', import.meta.url), 'utf8'))
const game = { id: 'local-nes-abc', title: 'A game', consoleId: 'nes', source: 'local' }

test('settings validate types, clamp volume, and retain an explicit disabled history', () => {
  assert.deepEqual(readSettings(null), DEFAULT_SETTINGS)
  assert.deepEqual(readSettings({ volume: -1, history: false }), { volume: 0, history: false, widescreen: false })
  assert.equal(readSettings({ volume: 999 }).volume, 100)
  assert.equal(readSettings({ volume: NaN, history: 'false' }).volume, 50)
  assert.equal(readSettings({ volume: 0 }).volume, 0)
  assert.equal(readSettings({ widescreen: true }).widescreen, true)
  assert.equal(readSettings({ widescreen: 'yes' }).widescreen, false)
  assert.deepEqual(readSettings({}), { volume: 50, history: true, widescreen: false })
})
test('console detection is case insensitive and does not guess ambiguous BIN or archives', () => {
  assert.equal(detectConsole('Example.NES', consoles), 'nes')
  assert.equal(detectConsole('Example.gbc', consoles), 'gb')
  assert.equal(detectConsole('Example.bin', consoles), '')
  assert.equal(detectConsole('Example.zip', consoles), '')
})
test('ROM validation rejects empty/large files and mismatched console extensions', () => {
  assert.equal(validateRom({ name: 'test.nes', size: 24592 }, consoles[0]), null)
  assert.equal(validateRom({ name: 'test.zip', size: 10 }, consoles[0]), null)
  assert.match(validateRom({ name: 'test.gba', size: 10 }, consoles[0]), /tidak cocok/)
  assert.match(validateRom({ name: 'test.nes', size: 0 }, consoles[0]), /kosong/)
  assert.match(validateRom({ name: 'test.nes', size: MAX_ROM_SIZE + 1 }, consoles[0]), /terlalu besar/)
})
test('BIOS validation catches wrong types, empty and large files', () => {
  assert.equal(validateBios({ name: 'scph1001.bin', size: 512 * 1024 }), null)
  assert.match(validateBios({ name: 'bad.exe', size: 10 }), /Gunakan BIOS/)
  assert.match(validateBios({ name: 'empty.bin', size: 0 }), /kosong/)
  assert.match(validateBios({ name: 'huge.bin', size: 33 * 1024 * 1024 }), /terlalu besar/)
})
test('runtime content URLs cannot point off origin or contain control characters', () => {
  assert.equal(isSafeLocalUrl('/games/test.nes'), true)
  for (const url of ['//evil.example/a', '/\\evil.example/a', 'https://evil.example/a', 'javascript:alert(1)', '/\nevil', '/\tevil']) assert.equal(isSafeLocalUrl(url), false)
})
test('stored game parser rejects malformed records and unsafe remote URLs', () => {
  assert.deepEqual(readGames([null, {}, game, { ...game, source: 'server', url: 'https://elsewhere.test/a.nes' }]), [game])
  assert.deepEqual(readGames('invalid'), [])
  assert.deepEqual(readGames([{ ...game, lastPlayed: 'yesterday' }]), [])
})
test('disabled history neither adds nor reorders existing history', () => {
  const existing = [{ ...game, lastPlayed: 123 }]
  assert.equal(recordHistory(existing, { ...game, id: 'different' }, false, 999), existing)
})
test('history deduplicates games and caps metadata at 50 entries', () => {
  const history = Array.from({ length: 60 }, (_, i) => ({ ...game, id: `game-${i}` }))
  const next = recordHistory(history, { ...game, id: 'game-40' }, true, 500)
  assert.equal(next.length, 50)
  assert.equal(next[0].lastPlayed, 500)
  assert.equal(next.filter(g => g.id === 'game-40').length, 1)
})
test('favorites toggle without modifying history or storing file bytes', () => {
  const next = toggleFavorite([], game)
  assert.deepEqual(next, [game])
  assert.deepEqual(toggleFavorite(next, game), [])
})
test('all advertised cores include both local variants and a report', async () => {
  for (const console of consoles) {
    for (const suffix of ['-wasm.data', '-legacy-wasm.data']) {
      const bytes = await readFile(new URL(`../public/vendor/emulatorjs/4.2.3/data/cores/${console.core}${suffix}`, import.meta.url))
      assert.ok(bytes.length > 10000)
    }
    const report = JSON.parse(await readFile(new URL(`../public/vendor/emulatorjs/4.2.3/data/cores/reports/${console.core}.json`, import.meta.url), 'utf8'))
    assert.ok(report.buildStart)
  }
})
test('vendored source disables upstream version checks and CDN fallback', async () => {
  const source = await readFile(new URL('../public/vendor/emulatorjs/4.2.3/data/src/emulator.js', import.meta.url), 'utf8')
  assert.ok(!source.includes('fetch("https://cdn.emulatorjs.org'))
  assert.ok(!source.includes('https://netplay.emulatorjs.org'))
  assert.ok(source.includes('Core lokal tidak tersedia'))
  assert.ok(source.includes('addToMenu("Layar lebar", "mainduluWidescreen"'))
  assert.ok(source.includes('window.EJS_onWidescreen(value === "enabled")'))
})
test('server homebrew is a valid NROM-128 cartridge', async () => {
  const bytes = await readFile(new URL('../public/games/jalan-pulang.nes', import.meta.url))
  assert.equal(bytes.subarray(0, 4).toString('hex'), '4e45531a')
  assert.equal(bytes.length, 16 + 16384 + 8192)
  assert.equal(bytes[4], 1)
  const reset = bytes.readUInt16LE(16 + 0x3ffc)
  assert.ok(reset >= 0x8000 && reset < 0xc000)
})
test('account storage patches and published core fingerprints match shipped assets', async () => {
  const root = new URL('../public/vendor/emulatorjs/4.2.3/data/', import.meta.url)
  const builds = JSON.parse(await readFile(new URL('../public/player/builds.json', import.meta.url), 'utf8'))
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const bundle = await readFile(new URL('emulator.min.js', root), 'utf8')
  assert.equal(builds.runtimeBuild, hash(bundle.slice(bundle.indexOf('\n') + 1).replaceAll('\r\n', '\n')))
  assert.equal(builds.engineVersion, '4.2.3')
  for (const [file, digest] of Object.entries(builds.cores)) assert.equal(hash(await readFile(new URL('cores/' + file, root))), digest)
  assert.ok((await readFile(new URL('src/GameManager.js', root), 'utf8')).includes('if (this.EJS.config.mainduluMemorySaves) { resolve(); return; }'))
  assert.ok((await readFile(new URL('src/emulator.js', root), 'utf8')).includes('this.config.mainduluMemorySaves ? new window.EJS_DUMMYSTORAGE()'))
})
