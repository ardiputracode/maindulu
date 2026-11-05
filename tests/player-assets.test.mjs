import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { validatePreparedAssets } from '../src/lib/player-bridge-assets.ts'
import { preparedRomFile } from '../src/lib/engine-assets.ts'

const id = '12345678-1234-4234-8234-123456789abc'
function config(kind = 'rom') {
  const descriptor = { kind, catalogId: id, sha256: 'a'.repeat(64), size: 4, fileName: 'test file.nes',
    url: kind === 'rom' ? `/games/${id}/rom/test%20file.nes` : `/bios/${id}/test%20file.nes`, consoleId: 'nes', label: 'Test' }
  return { consoleId: 'nes', game: { id, source: 'server', url: descriptor.url, sha256: descriptor.sha256, size: 4, consoleId: 'nes' },
    biosUrl: descriptor.url, biosSha256: descriptor.sha256,
    [kind === 'rom' ? 'preparedRom' : 'preparedBios']: { descriptor, file: preparedRomFile(new Blob(['test']), descriptor.url) } }
}

test('prepared message contract accepts only exact session descriptors, including structured clone', () => {
  for (const kind of ['rom', 'bios']) assert.doesNotThrow(() => validatePreparedAssets(structuredClone(config(kind))))
  assert.doesNotThrow(() => validatePreparedAssets({ game: { id: 'static' } }))
})

test('prepared ROM cannot change session identity, URL, console, hash, size or source', () => {
  for (const change of [{ id: 'other' }, { source: 'local' }, { url: '/games/static.nes' }, { sha256: 'b'.repeat(64) }, { size: 5 }, { consoleId: 'ps1' }]) {
    const value = config(); Object.assign(value.game, change)
    assert.throws(() => validatePreparedAssets(value))
  }
  const value = config(); value.consoleId = 'ps1'
  assert.throws(() => validatePreparedAssets(value))
})

test('prepared slots reject local/prepared ambiguity, wrong namespace and BIOS identity', () => {
  for (const kind of ['rom', 'bios']) {
    const value = config(kind); value[kind] = new File(['test'], 'test.nes')
    assert.throws(() => validatePreparedAssets(value))
  }
  const value = config('bios'); value.biosSha256 = 'b'.repeat(64)
  assert.throws(() => validatePreparedAssets(value))
  const wrong = config(); wrong.preparedRom.descriptor.kind = 'bios'
  assert.throws(() => validatePreparedAssets(wrong))
})

test('prepared payloads reject non-Files, wrong names, missing/extra bytes and oversize descriptors', () => {
  for (const file of [new Blob(['test']), new File(['test'], 'decoded name.nes'), new File(['tes'], 'test%20file.nes'), new File(['tests'], 'test%20file.nes')]) {
    const value = config(); value.preparedRom.file = file
    assert.throws(() => validatePreparedAssets(value))
  }
  const value = config(); value.preparedRom.descriptor.size = 768 * 1048576 + 1
  assert.throws(() => validatePreparedAssets(value))
  for (const preparedRom of [null, {}, { descriptor: {} }]) assert.throws(() => validatePreparedAssets({ ...config(), preparedRom }))
})

test('application bridge helper is reproducible and does not require engine regeneration', async () => {
  const output = await build({ entryPoints: ['src/lib/player-bridge-assets.ts'], bundle: true, write: false,
    outfile: 'public/player/asset-helpers.js', format: 'iife', globalName: 'MainduluAssets', target: 'es2022',
    platform: 'browser', legalComments: 'none', charset: 'utf8' })
  assert.equal(output.outputFiles[0].text, (await readFile('public/player/asset-helpers.js', 'utf8')).replaceAll('\r\n', '\n'))
  const html = await readFile('public/player/index.html', 'utf8')
  assert.ok(html.indexOf('/player/asset-helpers.js') < html.indexOf('/player/player.js'))
})
