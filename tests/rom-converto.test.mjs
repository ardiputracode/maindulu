import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { ROM_CONVERTO_LIMITS, resolveRomConvertoBinary, probeRomConverto, readChdSerial } from '../server/metadata/rom-converto.mjs'

const platform = process.platform
const arch = process.arch
const executable = platform === 'win32' ? 'rom-converto.exe' : 'rom-converto'
const absolute = name => resolve('fixtures', name)
const serialPath = platform === 'win32' ? 'C:\\Games\\My Disc.chd' : '/games/My Disc.chd'
const json = value => Buffer.from(JSON.stringify(value))

function capture(result) {
  const calls = []
  const execFileImpl = (binary, args, options, callback) => { calls.push({ binary, args, options }); callback(null, result) }
  return { calls, execFileImpl }
}

test('rom-converto resolves an absolute override before vendor and PATH', () => {
  const override = absolute('custom-rom-converto')
  const vendor = join('root', 'vendor', 'rom-converto', `${platform}-${arch}`, executable)
  const found = resolveRomConvertoBinary({ env: { MAIN_DULU_ROM_CONVERTO_PATH: override, PATH: '/bin' },
    root: 'root', platform, arch, exists: candidate => [override, vendor, '/bin/' + executable].includes(candidate) })
  assert.equal(found, override)
  assert.throws(() => resolveRomConvertoBinary({ env: { MAIN_DULU_ROM_CONVERTO_PATH: 'relative/tool' }, platform, arch, exists: () => true }), /absolut/)
  assert.equal(resolveRomConvertoBinary({ env: { MAIN_DULU_ROM_CONVERTO_PATH: override }, platform, arch, exists: () => false }), null)
})

test('rom-converto prefers the pinned vendor layout over PATH', () => {
  const directories = platform === 'linux' && arch === 'x64' ? ['linux-x64-musl', 'linux-x64']
    : platform === 'linux' && arch === 'arm' ? ['linux-arm7'] : [`${platform}-${arch}`]
  const vendor = join('root', 'vendor', 'rom-converto', directories[0], executable)
  const onPath = join('bin', executable)
  const found = resolveRomConvertoBinary({ env: { PATH: 'bin' }, root: 'root', platform, arch,
    exists: candidate => [vendor, onPath].includes(candidate) })
  assert.equal(found, vendor)
})

test('rom-converto falls back to PATH and reports a missing binary without throwing', () => {
  const onPath = join('bin', executable)
  assert.equal(resolveRomConvertoBinary({ env: { PATH: 'bin' }, root: 'root', platform, arch, exists: candidate => candidate === onPath }), onPath)
  assert.equal(resolveRomConvertoBinary({ env: {}, root: 'root', platform, arch, exists: () => false }), null)
  assert.equal(resolveRomConvertoBinary({ env: { PATH: '' }, root: 'root', platform, arch, exists: () => false }), null)
})

test('rom-converto invokes info with one argument, bounded output and a secret-free child environment', async () => {
  const { calls, execFileImpl } = capture(json({ content: { title_id: 'slus-12345', title: 'Fixture', console: 'PS1' } }))
  const result = await readChdSerial({ filePath: serialPath, binary: absolute('tool'), execFileImpl, timeoutMs: 15_000,
    env: { PATH: '/bin', HOME: '/home/test', MAIN_DULU_SCREENSCRAPER_PASSWORD: 'secret', MAIN_DULU_SCREENSCRAPER_DEV_PASSWORD: 'secret' }, platform })
  assert.deepEqual(result, { serial: 'SLUS-12345', title: 'Fixture', console: 'PS1' })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['info', serialPath, '--json'])
  assert.equal(calls[0].binary, absolute('tool'))
  assert.equal(calls[0].options.windowsHide, true)
  assert.equal(calls[0].options.timeout, 15_000)
  assert.equal(calls[0].options.maxBuffer, ROM_CONVERTO_LIMITS.maxOutputBytes)
  assert.equal(calls[0].options.killSignal, 'SIGKILL')
  assert.equal(calls[0].options.encoding, 'buffer')
  const env = calls[0].options.env
  for (const key of Object.keys(env)) assert.ok(['PATH', 'HOME', 'SystemRoot', 'TEMP', 'TMP'].includes(key), key)
  assert.doesNotMatch(JSON.stringify(env), /secret|SCREENSCRAPER/i)
})

test('rom-converto reads every documented serial fallback and rejects invalid payloads', async () => {
  const cases = [
    [{ content: { title_id: 'slus-12345' } }, 'SLUS-12345'],
    [{ content: { serial: 'slus-12345' } }, 'SLUS-12345'],
    [{ serial: 'slus-12345' }, 'SLUS-12345'],
    [{ disc: { serial: 'slus-12345' } }, 'SLUS-12345'],
    [{ metadata: { serial: 'slus-12345' } }, 'SLUS-12345'],
  ]
  for (const [payload, serial] of cases) {
    const { execFileImpl } = capture(json(payload))
    assert.equal((await readChdSerial({ filePath: 'disc.chd', binary: absolute('tool'), execFileImpl })).serial, serial)
  }
  for (const [payload, code] of [
    [{ content: {} }, 'chd_serial_missing'],
    [{}, 'chd_serial_missing'],
    [{ content: { title_id: 'no digits here' } }, 'chd_invalid'],
    [{ content: { title_id: 'AB' } }, 'chd_invalid'],
    [{ content: { title_id: 'SLUS_12345' } }, 'chd_invalid'],
    [{ content: { title_id: 'SLUS-12345\n' } }, 'chd_invalid'],
    [{ content: { title_id: 12345 } }, 'chd_serial_missing'],
    [[], 'chd_invalid'],
    [null, 'chd_invalid'],
  ]) {
    const { execFileImpl } = capture(json(payload))
    await assert.rejects(readChdSerial({ filePath: 'disc.chd', binary: absolute('tool'), execFileImpl }), { code })
  }
})

test('rom-converto rejects malformed JSON, invalid UTF-8 and oversized output', async () => {
  await assert.rejects(readChdSerial({ filePath: 'disc.chd', binary: absolute('tool'),
    execFileImpl: (_binary, _args, _options, callback) => callback(null, Buffer.from('{bad')) }), { code: 'chd_invalid' })
  await assert.rejects(readChdSerial({ filePath: 'disc.chd', binary: absolute('tool'),
    execFileImpl: (_binary, _args, _options, callback) => callback(null, Buffer.from([0xc3, 0x28])) }), { code: 'chd_invalid' })
  await assert.rejects(readChdSerial({ filePath: 'disc.chd', binary: absolute('tool'),
    execFileImpl: (_binary, _args, _options, callback) => callback(null, Buffer.alloc(ROM_CONVERTO_LIMITS.maxOutputBytes + 1)) }), { code: 'chd_invalid' })
})

test('rom-converto maps timeout, missing tool and abort to stable safe codes', async () => {
  await assert.rejects(readChdSerial({ filePath: 'disc.chd', binary: absolute('tool'),
    execFileImpl: (_binary, _args, _options, callback) => callback(Object.assign(new Error('timed out'), { killed: true })) }), { code: 'identification_timeout' })
  await assert.rejects(readChdSerial({ filePath: 'disc.chd', binary: absolute('tool'),
    execFileImpl: (_binary, _args, _options, callback) => callback(Object.assign(new Error('missing'), { code: 'ENOENT' })) }), { code: 'chd_tool_unavailable' })

  const preAborted = new AbortController(); preAborted.abort()
  let invoked = false
  await assert.rejects(readChdSerial({ filePath: 'disc.chd', binary: absolute('tool'), signal: preAborted.signal,
    execFileImpl: () => { invoked = true } }), { code: 'disabled' })
  assert.equal(invoked, false)

  const controller = new AbortController()
  let killed = false
  const pending = readChdSerial({ filePath: 'disc.chd', binary: absolute('tool'), signal: controller.signal,
    execFileImpl: () => ({ kill: () => { killed = true } }) })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, { code: 'disabled' })
  assert.equal(killed, true)
})

test('rom-converto requires a file path and reports an unresolvable binary', async () => {
  for (const filePath of [undefined, '', 42]) await assert.rejects(readChdSerial({ filePath, binary: absolute('tool') }), { code: 'invalid_target' })
  await assert.rejects(readChdSerial({ filePath: 'disc.chd', env: {}, root: resolve('fixtures', 'missing-vendor'), platform, arch }), { code: 'chd_tool_unavailable' })
})

test('rom-converto probe runs --version once per binary and caps its output', async () => {
  let calls = 0
  const execFileImpl = (binary, args, options, callback) => {
    calls++
    assert.deepEqual(args, ['--version'])
    assert.ok(options.maxBuffer <= 64 * 1024)
    callback(null, Buffer.from('rom-converto 0.24.0\nextra'))
  }
  const binary = absolute('probe-' + process.pid)
  assert.equal(await probeRomConverto(binary, { execFileImpl }), 'rom-converto 0.24.0')
  assert.equal(await probeRomConverto(binary, { execFileImpl }), 'rom-converto 0.24.0')
  assert.equal(calls, 1)
  await assert.rejects(probeRomConverto(null), { code: 'chd_tool_unavailable' })
})
