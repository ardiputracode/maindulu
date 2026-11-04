import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { engineAssetFileName, preparedRomFile, preparedBiosBlob, engineRomInput } from '../src/lib/engine-assets.ts'
import { saveIdentity, MAX_ROM_SIZE, MAX_BIOS_SIZE } from '../src/lib/domain.ts'

const source = await readFile(new URL('../public/vendor/emulatorjs/4.2.3/data/src/emulator.js', import.meta.url), 'utf8')
// Execute the actual vendored methods without booting a proprietary PS1 ROM.
const Engine = runInNewContext(source + '\nEmulatorJS', { window: {}, Blob, File, ArrayBuffer, Uint8Array, URL, fetch, console })

test('prepared assets preserve encoded URL basenames, not decoded filenames or save IDs', () => {
  for (const name of ['Suikoden%20(Asia).chd', 'BIOS%20Jepang.bin', '%E6%97%A5%E6%9C%AC.nes', '100%25.nes']) {
    assert.equal(engineAssetFileName('/games/id/rom/' + name), name)
    assert.equal(preparedRomFile(new Blob(['test']), '/games/id/rom/' + name).name, name)
  }
  for (const url of ['//evil.test/a', '/\\evil/a', '/a\nb', '/game/', '/game/..', '/game/%2e%2e', '/game/%2f.bin', '/game/%5c.bin', '/game/%00.bin', '/game/%.bin', '/game/a?x', '/game/a#x']) {
    assert.throws(() => engineAssetFileName(url))
  }
})

test('prepared asset size guards use existing domain limits', async () => {
  assert.throws(() => preparedRomFile(new Blob(), '/games/a.nes'))
  await assert.rejects(preparedBiosBlob(new Blob(), '/bios/a.bin'))
  // Blob slices share backing storage; no 768 MiB allocation is needed here.
  const large = new Blob(Array(769).fill(new Blob([new Uint8Array(1024 * 1024)])))
  assert.equal(large.size, MAX_ROM_SIZE + 1024 * 1024)
  assert.throws(() => preparedRomFile(large, '/games/a.chd'))
  await assert.rejects(preparedBiosBlob(large.slice(0, MAX_BIOS_SIZE + 1), '/bios/a.bin'))
})

test('raw prepared BIOS ZIP has correct stored bytes, name, CRC and directory; archives pass through', async () => {
  const input = new Blob([new Uint8Array([1, 2, 3, 4])])
  const output = new Uint8Array(await (await preparedBiosBlob(input, '/bios/id/fw%20test.bin')).arrayBuffer())
  const view = new DataView(output.buffer)
  assert.equal(view.getUint32(0, true), 0x04034b50)
  assert.equal(view.getUint16(8, true), 0) // STORED, not deflated
  assert.equal(view.getUint32(14, true), 0xb63cfbcd)
  const length = view.getUint16(26, true)
  assert.equal(new TextDecoder().decode(output.slice(30, 30 + length)), 'fw%20test.bin')
  assert.deepEqual([...output.slice(30 + length, 34 + length)], [1, 2, 3, 4])
  const end = output.length - 22
  assert.equal(view.getUint32(end, true), 0x06054b50)
  const directory = view.getUint32(end + 16, true)
  assert.equal(view.getUint32(directory, true), 0x02014b50)
  assert.equal(new TextDecoder().decode(output.slice(directory + 46, directory + 46 + length)), 'fw%20test.bin')
  for (const extension of ['zip', '7z', 'rar']) assert.equal(await preparedBiosBlob(input, '/bios/id/fw.' + extension), input)
})

function fakeEngine(gameUrl, core, compressedFiles) {
  const e = Object.create(Engine.prototype)
  const files = new Map()
  e.config = { gameUrl, gameName: saveIdentity({ id: 'catalog-id', sha256: 'a'.repeat(64) }, core), cacheLimit: 0 }
  e.textElem = {}; e.debug = false; e.extensions = core === 'fceumm' ? ['nes'] : ['bin', 'chd', 'cue']
  e.storage = { rom: { get: async () => undefined, put: () => assert.fail('Engine database cache must remain disabled') } }
  e.getCore = () => core
  e.localization = value => value
  e.gameManager = { FS: { writeFile: (name, bytes) => files.set(name.replace(/^\//, ''), bytes), analyzePath: () => ({ exists: true }) } }
  e.checkCompression = async (bytes, _label, callback) => {
    const extracted = compressedFiles ?? { '!!notCompressedData': bytes }
    for (const [name, data] of Object.entries(extracted)) callback(name, data)
  }
  e.startGameError = message => assert.fail(message)
  return { e, files }
}

test('native ROM File path matches URL raw CHD/NES names and save identity without patching engine', async () => {
  for (const [core, filename] of [['pcsx_rearmed', 'Suikoden%20(Asia).chd'], ['fceumm', 'battery%20test.nes']]) {
    const payload = new Uint8Array([1, 2, 3, 4])
    const url = '/games/catalog-id/rom/' + filename
    const baseline = fakeEngine(url, core)
    baseline.e.downloadFile = async (_url, _progress, _relative, opts) => ({ headers: { 'content-length': String(payload.length) }, ...(opts.method === 'GET' ? { data: payload.buffer } : {}) })
    await baseline.e.downloadRom()
    const native = fakeEngine(preparedRomFile(new Blob([payload]), url), core)
    await native.e.downloadRom()
    assert.equal(native.e.fileName, baseline.e.fileName)
    assert.equal(native.e.fileName, filename)
    assert.equal(native.e.config.gameName, baseline.e.config.gameName)
    assert.deepEqual([...native.files.get(filename)], [...payload])
    const stem = e => e.fileName.replace(/\.[^.]+$/, '')
    assert.equal(`/data/saves/${core === 'pcsx_rearmed' ? 'PCSX-ReARMed' : 'FCEUmm'}/${stem(native.e)}.srm`, `/data/saves/${core === 'pcsx_rearmed' ? 'PCSX-ReARMed' : 'FCEUmm'}/${stem(baseline.e)}.srm`)
  }
})

test('native ZIP File path keeps extracted name rather than File/cache identifier', async () => {
  const payload = new Uint8Array([1, 2, 3])
  const { e, files } = fakeEngine(preparedRomFile(new Blob(['archive']), '/games/id/rom/archive.zip'), 'fceumm', { 'nested/actual-game.nes': payload })
  await e.downloadRom()
  assert.equal(e.fileName, 'nested/actual-game.nes')
  assert.deepEqual([...files.get('nested/actual-game.nes')], [...payload])
})

test('native File HEAD also materializes bytes: retain as an explicit memory risk', async () => {
  const { e } = fakeEngine('', 'fceumm')
  const file = preparedRomFile(new Blob(['data']), '/games/id/rom/a.nes')
  let reads = 0
  const arrayBuffer = file.arrayBuffer.bind(file)
  file.arrayBuffer = () => { reads++; return arrayBuffer() }
  await e.downloadFile(file, null, true, { method: 'HEAD' })
  await e.downloadFile(file, null, true, { method: 'GET', responseType: 'arraybuffer' })
  assert.equal(reads, 2)
})

test('session File adapter shares the HEAD/GET buffer, releases it, and must be reconstructed after clone', async () => {
  const prepared = preparedRomFile(new Blob(['data']), '/games/id/rom/a%20test.nes')
  const input = engineRomInput(structuredClone(prepared))
  assert.ok(input.file instanceof File)
  assert.equal(input.file.name, prepared.name)
  const first = input.file.arrayBuffer(), second = input.file.arrayBuffer()
  assert.equal(first, second)
  const { e } = fakeEngine('', 'fceumm')
  await e.downloadFile(input.file, null, true, { method: 'HEAD' })
  const get = await e.downloadFile(input.file, null, true, { method: 'GET' })
  assert.equal(get.data.buffer, await first)
  const clone = structuredClone(input.file)
  assert.equal(clone.constructor, File)
  assert.equal(clone.name, prepared.name)
  input.release(); input.release()
  await assert.rejects(input.file.arrayBuffer(), /dilepas/)
  assert.equal(new TextDecoder().decode(await clone.arrayBuffer()), 'data')
})

test('engine bundle fingerprint still matches builds.json; no engine regeneration for native File spike', async () => {
  const builds = JSON.parse(await readFile(new URL('../public/player/builds.json', import.meta.url), 'utf8'))
  const bundled = await readFile(new URL('../public/vendor/emulatorjs/4.2.3/data/emulator.min.js', import.meta.url), 'utf8')
  const code = bundled.slice(bundled.indexOf('\n') + 1)
  assert.equal(createHash('sha256').update(code).digest('hex'), builds.runtimeBuild)
})
