import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import sharp from 'sharp'
import { main } from '../scripts/screenscraper-m0.mjs'
import { SmokeError, parseSmokeOptions, runSmokeProbe, smokeCoverBytes, smokeErrorDiagnostic, smokeResponseLimits, smokeRomEvidence } from '../scripts/lib/screenscraper-m0.mjs'
import { screenScraperLimits as limits } from '../server/metadata/screenscraper-policy.mjs'

const fixture = async name => JSON.parse(await readFile(new URL(`./fixtures/screenscraper/${name}.json`, import.meta.url), 'utf8'))
const info = await fixture('jeu-infos'), systems = await fixture('systemes')
const config = { devId: 'cover-fake-dev', devPassword: 'cover-fake-dev-secret', user: 'cover-fake-user', password: 'cover-fake-secret', softname: 'maindulu-cover-test' }
const env = { MAIN_DULU_SCREENSCRAPER_DEV_ID: config.devId, MAIN_DULU_SCREENSCRAPER_DEV_PASSWORD: config.devPassword,
  MAIN_DULU_SCREENSCRAPER_USER: config.user, MAIN_DULU_SCREENSCRAPER_PASSWORD: config.password }
const noWait = async () => {}
const code = name => error => error instanceof SmokeError && error.code === name && !error.cause
const image = (format = 'png', width = 3, height = 2) => sharp({ create: { width, height, channels: 3, background: '#abcdef' } })[format]().toBuffer()
const safe = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  for (const secret of Object.values(config)) assert.ok(!text.includes(secret))
  for (const secret of [info.response.jeu.id, info.response.jeu.rom.id, info.response.jeu.rom.rommd5, info.response.jeu.rom.romsha1, info.response.jeu.noms[0].text]) assert.ok(!text.includes(secret))
  assert.doesNotMatch(text, /https?:\/\/|devpassword=|sspassword=|rommd5|romsha1/)
}
async function setup(t, { notFound = false } = {}) {
  const parent = join(tmpdir(), 'opencode')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'maindulu-m0-cover-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'synthetic.gb')
  await writeFile(path, 'abc') // Not a playable ROM; only a synthetic fingerprint fixture.
  const args = ['check', '--live', '--console', 'gb', '--rom', path, '--cover', ...(notFound ? ['--not-found'] : [])]
  return { root, path, args, options: parseSmokeOptions(args) }
}
function transport({ body = info, response, negativeStatus = 404 } = {}) {
  const requests = []
  return { requests, fetcher: async (url, init) => {
    requests.push({ url, init })
    if (url.pathname.endsWith('/ssuserInfos.php')) return Response.json({ response: { ssuser: structuredClone(info.response.ssuser) } })
    if (url.pathname.endsWith('/systemesListe.php')) return Response.json(systems)
    if (url.pathname.endsWith('/jeuInfos.php')) return requests.length === 3 || negativeStatus === 200 ? Response.json(body) : new Response(config.password, { status: negativeStatus })
    assert.equal(url.pathname, '/api2/mediaJeu.php')
    return typeof response === 'function' ? response(url, init) : response ?? new Response(await image(), { headers: { 'content-type': 'image/png' } })
  } }
}

test('M0 cover requires explicit opt-in, live and a ROM/console pair; URL/credential overrides remain forbidden', () => {
  const options = parseSmokeOptions(['check', '--live', '--console', 'gb', '--rom', 'fixture.gb', '--cover', '--not-found'])
  assert.equal(options.cover, true)
  assert.equal(options.notFound, true)
  assert.equal(parseSmokeOptions(['check']).cover, undefined)
  for (const args of [['check', '--cover'], ['check', '--live', '--cover'], ['check', '--rom', 'x.gb', '--console', 'gb', '--cover'],
    ['check', '--live', '--console', 'gb', '--rom', 'x.gb', '--cover', '--cover'],
    ['check', '--live', '--console', 'gb', '--rom', 'x.gb', '--cover-url', 'https://127.0.0.1/']]) assert.throws(() => parseSmokeOptions(args), code('USAGE'))
})

test('M0 cover uses only the fixed HTTPS media endpoint and verified game ID, never provider URLs or ROM IDs', async t => {
  for (const notFound of [false, true]) {
    const { options } = await setup(t, { notFound })
    const body = structuredClone(info), steps = [], waits = []
    body.response.jeu.romid = '900000099'
    body.response.jeu.medias = [{ type: 'box-2D', region: 'us', url: `http://127.0.0.1/?sspassword=${config.password}`,
      id: config.devPassword, format: config.user, media: config.password, source: config.devId }]
    const mock = transport({ body })
    const report = await runSmokeProbe(config, options, { ...mock, wait: async value => waits.push(value), onStep: step => steps.push(step) })
    assert.equal(report.requests, notFound ? 5 : 4)
    assert.deepEqual(steps.map(step => step.step), ['account', 'systems', 'rom', ...(notFound ? ['not_found'] : []), 'cover'])
    assert.equal(report.rom.warnings[0].reason, 'rom_reference_mismatch')
    assert.equal(report.rom.metadataShape.preferredNameListed, true)
    assert.equal(report.rom.metadataShape.preferredSynopsisListed, true)
    assert.equal(report.automaticScan, false)
    assert.deepEqual(waits, Array(notFound ? 4 : 3).fill(1000))
    const { url, init } = mock.requests.at(-1)
    assert.equal(url.origin, 'https://api.screenscraper.fr')
    assert.equal(url.pathname, '/api2/mediaJeu.php')
    assert.equal(url.searchParams.get('jeuid'), info.response.jeu.id)
    assert.equal(url.searchParams.get('systemeid'), '9')
    assert.equal(url.searchParams.get('media'), 'box-2D(us)')
    assert.deepEqual([...url.searchParams.keys()].sort(), ['devid', 'devpassword', 'softname', 'ssid', 'sspassword', 'systemeid', 'jeuid', 'media'].sort())
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined)
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store')
    assert.equal(init.referrerPolicy, 'no-referrer')
    assert.deepEqual(report.cover, { verified: true, contentType: 'image/png', receivedBytes: (await image()).length,
      width: 3, height: 2, decoded: true, stored: false, rightsVerified: false, endpoint: 'mediaJeu.php', fixedOrigin: true,
      providerUrlFollowed: false, type: 'box-2D', region: 'us' })
    safe({ report, steps })
  }
})

test('M0 cover selection has fixed regional preference independent of list order, without trusting format or URL hints', async t => {
  const { options } = await setup(t)
  for (const region of ['wor', 'us', 'eu', 'jp', 'ss']) {
    const body = structuredClone(info)
    const remaining = ['wor', 'us', 'eu', 'jp', 'ss'].slice(['wor', 'us', 'eu', 'jp', 'ss'].indexOf(region))
    body.response.jeu.medias = remaining.reverse().map(value => ({ type: 'box-2D', region: value, url: config.password, format: config.user }))
    body.response.jeu.medias.unshift({ type: 'box-3D', region: 'wor' }, { type: 'box-2D', region: 'unsupported' })
    const mock = transport({ body })
    const report = await runSmokeProbe(config, options, { ...mock, wait: noWait })
    assert.equal(report.cover.region, region)
    assert.equal(mock.requests.at(-1).url.searchParams.get('media'), `box-2D(${region})`)
    safe(report)
  }
})

test('M0 metadata preference diagnostics expose booleans, not texts/codes, and optional metadata cannot substitute ROM evidence', () => {
  const input = { consoleId: 'gb', fileName: 'fixture.gb', method: 'hash', size: 3,
    md5: info.response.jeu.rom.rommd5, sha1: info.response.jeu.rom.romsha1 }
  for (const [noms, synopsis, expected] of [
    [info.response.jeu.noms, info.response.jeu.synopsis, true],
    [undefined, undefined, false], [[], [], false],
    [[{ region: config.password, text: config.user }], [{ langue: config.devPassword, text: config.user }], false],
    [[{ region: 'us', text: ' ' }], [{ langue: 'en', text: ' ' }], false],
    [[{ region: 'us', text: 'x'.repeat(limits.maxTitleLength + 1) }], [{ langue: 'en', text: 'x'.repeat(limits.maxDescriptionLength + 1) }], false],
    [[{ region: { text: 'us' }, text: config.user }], [{ langue: { text: 'en' }, text: config.user }], false],
  ]) {
    const game = structuredClone(info.response.jeu)
    game.noms = noms; game.synopsis = synopsis
    const result = smokeRomEvidence(input, game)
    assert.equal(result.verified, true)
    assert.equal(result.metadataShape.preferredNameListed, expected)
    assert.equal(result.metadataShape.preferredSynopsisListed, expected)
    safe(result)
    game.rom.romsha1 = '0'.repeat(40)
    assert.throws(() => smokeRomEvidence(input, game), code('EVIDENCE'))
  }
})

test('M0 missing, malformed, excessive or ambiguous cover listings stop locally without a media request', async t => {
  const { options } = await setup(t)
  for (const [medias, expected] of [[undefined, 'COVER_METADATA'], [{}, 'COVER_METADATA'], [[null], 'COVER_METADATA'],
    [Array(limits.maxMediaEntries + 1).fill({ type: 'box-2D', region: 'us' }), 'COVER_METADATA'],
    [[{ type: 'box-2D', region: 'wor' }, { type: 'box-2D', region: 'wor' }], 'COVER_METADATA'],
    [[], 'COVER_MISSING'], [[{ type: 'box-2D', region: config.password }], 'COVER_MISSING'],
    [[{ type: 'box-3D', region: 'us' }], 'COVER_MISSING']]) {
    const body = structuredClone(info); body.response.jeu.medias = medias
    const mock = transport({ body })
    await assert.rejects(runSmokeProbe(config, options, { ...mock, wait: noWait }), code(expected))
    assert.equal(mock.requests.length, 3)
  }
})

test('M0 failed primary evidence or negative lookup prevents any cover download', async t => {
  const { options } = await setup(t, { notFound: true })
  for (const kind of ['md5', 'sha1', 'system', 'rom', 'supports', 'negative']) {
    const body = structuredClone(info)
    if (kind === 'md5') body.response.jeu.rom.rommd5 = '0'.repeat(32)
    if (kind === 'sha1') body.response.jeu.rom.romsha1 = '0'.repeat(40)
    if (kind === 'system') body.response.jeu.systeme.id = '10'
    if (kind === 'rom') delete body.response.jeu.rom
    if (kind === 'supports') body.response.jeu.rom.romtotalsupport = '2'
    const mock = transport({ body, negativeStatus: 200 })
    await assert.rejects(runSmokeProbe(config, options, { ...mock, wait: noWait }), code(kind === 'negative' ? 'NEGATIVE' : 'EVIDENCE'))
    assert.equal(mock.requests.length, kind === 'negative' ? 4 : 3)
  }
})

test('M0 cover decode accepts complete bounded PNG/JPEG/WebP only and respects dimension edges', async () => {
  for (const [format, mime] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']]) {
    const bytes = await image(format)
    const result = await smokeCoverBytes(bytes, mime)
    assert.equal(result.decoded, true)
    assert.equal(result.stored, false)
    assert.equal(result.rightsVerified, false)
    assert.equal(result.receivedBytes, bytes.length)
    safe(result)
  }
  assert.equal((await smokeCoverBytes(await image('png', 4096, 1), 'image/png')).width, 4096)
  assert.equal((await smokeCoverBytes(await image('png', 1, 4096), 'image/png')).height, 4096)
  for (const bytes of [await image('png', 4097, 1), await image('png', 1, 4097)]) await assert.rejects(smokeCoverBytes(bytes, 'image/png'), code('COVER_IMAGE'))
})

test('M0 cover decode rejects mismatched MIME, truncated/corrupt images, SVG, animation and invalid input', async () => {
  const png = await image()
  const animated = await sharp(Buffer.from([255, 0, 0, 0, 255, 0]), { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } }).webp({ loop: 0 }).toBuffer()
  assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2)
  const animation = Buffer.alloc(8); animation.writeUInt32BE(1) // One frame still has an animation-control chunk.
  const data = Buffer.concat([Buffer.from('acTL'), animation]), checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(data))
  const apng = Buffer.concat([png.subarray(0, 33), Buffer.from([0, 0, 0, 8]), data, checksum, png.subarray(33)])
  assert.equal((await sharp(apng).metadata()).format, 'png')
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(limits.coverBytes + 1), Buffer.from(config.password),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>'), png.subarray(0, 30), png.subarray(0, png.length - 15), apng]) {
    await assert.rejects(smokeCoverBytes(bytes, 'image/png'), code('COVER_IMAGE'))
  }
  await assert.rejects(smokeCoverBytes(animated, 'image/webp'), code('COVER_IMAGE'))
  await assert.rejects(smokeCoverBytes(png, 'image/jpeg'), code('COVER_IMAGE'))
  await assert.rejects(smokeCoverBytes(png, 'application/octet-stream'), code('COVER_TYPE'))
  await assert.rejects(smokeCoverBytes(png, 'image/png', AbortSignal.abort()), code('CANCELLED'))
})

test('M0 cover text markers, 404 and unsafe MIME never masquerade as an image or a missing game', async t => {
  const { options } = await setup(t)
  for (const [status, mime, body, expected] of [
    [404, 'text/plain', config.password, 'COVER_MISSING'], [200, 'text/plain', 'NOMEDIA', 'COVER_MISSING'],
    [200, 'image/png', 'NOMEDIA', 'COVER_MISSING'], [200, 'text/plain', config.password, 'COVER_TYPE'],
    [200, 'text/html', config.password, 'COVER_TYPE'], [200, 'application/json', '{}', 'COVER_TYPE'],
    [200, 'image/svg+xml', '<svg/>', 'COVER_TYPE'], [200, 'image/gif', config.password, 'COVER_TYPE'],
    [200, 'application/octet-stream', await image(), 'COVER_TYPE'], [200, 'image/png', config.password, 'COVER_IMAGE'],
    [206, 'image/png', await image(), 'COVER_IMAGE'],
  ]) {
    const mock = transport({ response: new Response(body, { status, headers: { 'content-type': mime } }) })
    await assert.rejects(runSmokeProbe(config, options, { ...mock, wait: noWait }), error => {
      assert.equal(code(expected)(error), true)
      const diagnostic = smokeErrorDiagnostic(error)
      assert.equal(diagnostic.endpoint, 'mediaJeu.php')
      assert.equal(diagnostic.httpStatus, status)
      assert.equal(diagnostic.limitBytes, 8 * 1024 * 1024)
      safe({ message: error.message, diagnostic })
      return true
    })
    assert.equal(mock.requests.length, 4)
  }
})

test('M0 cover stream ignores Content-Length and cancels at its separate 8 MiB cap without retrying', async t => {
  const { options } = await setup(t)
  assert.equal(smokeResponseLimits['mediaJeu.php'], limits.coverBytes)
  assert.equal(smokeResponseLimits['jeuInfos.php'], 2 * 1024 * 1024)
  let cancelled = false
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(limits.coverBytes + 1)) }, cancel() { cancelled = true } })
  const mock = transport({ response: new Response(stream, { headers: { 'content-type': 'image/png', 'content-length': '1' } }) })
  await assert.rejects(runSmokeProbe(config, options, { ...mock, wait: noWait }), error => {
    assert.equal(code('RESPONSE_SIZE')(error), true)
    assert.equal(smokeErrorDiagnostic(error).receivedBytes, limits.coverBytes + 1)
    return true
  })
  assert.equal(cancelled, true)
  assert.equal(mock.requests.length, 4)
})

test('M0 cover timeout/cancellation include stalled headers and streams and release late bodies', async t => {
  const { options } = await setup(t)
  const stalled = transport({ response: () => new Promise(() => {}) })
  await assert.rejects(runSmokeProbe(config, options, { ...stalled, wait: noWait, timeoutMs: 50 }), code('TIMEOUT'))
  let cancelled = false
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0x89])) }, cancel() { cancelled = true } })
  const body = transport({ response: new Response(stream, { headers: { 'content-type': 'image/png' } }) })
  await assert.rejects(runSmokeProbe(config, options, { ...body, wait: noWait, timeoutMs: 50 }), code('TIMEOUT'))
  assert.equal(cancelled, true)
  const controller = new AbortController()
  let started, finish, lateCancelled = false
  const admitted = new Promise(resolve => { started = resolve })
  const late = transport({ response: () => { started(); return new Promise(resolve => { finish = resolve }) } })
  const pending = runSmokeProbe(config, options, { ...late, wait: noWait, signal: controller.signal })
  await admitted
  controller.abort()
  await assert.rejects(pending, code('CANCELLED'))
  finish(new Response(new ReadableStream({ cancel() { lateCancelled = true } }), { headers: { 'content-type': 'image/png' } }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(lateCancelled, true)
})

test('M0 cover redirects, URL changes, access and quota failures stop without fallback or response leakage', async t => {
  const { options } = await setup(t)
  for (const mode of ['redirect', 'url', 301, 401, 403, 429, 430, 431, 503]) {
    const response = new Response(config.password, { status: typeof mode === 'number' ? mode : 200, headers: {
      'content-type': 'image/png', location: `https://127.0.0.1/?sspassword=${config.password}`,
    } })
    if (mode === 'redirect') Object.defineProperty(response, 'redirected', { value: true })
    if (mode === 'url') Object.defineProperty(response, 'url', { value: 'https://127.0.0.1/' })
    const mock = transport({ response })
    const expected = typeof mode === 'string' ? 'TRANSPORT' : [301, 503].includes(mode) ? 'HTTP_OTHER' : `HTTP_${mode}`
    await assert.rejects(runSmokeProbe(config, options, { ...mock, wait: noWait }), error => {
      assert.equal(code(expected)(error), true)
      safe({ message: error.message, diagnostic: smokeErrorDiagnostic(error) })
      return true
    })
    assert.equal(mock.requests.length, 4)
  }
})

test('M0 cover respects quota reservation after metadata and optional negative lookup', async t => {
  const { options } = await setup(t, { notFound: true })
  const body = structuredClone(info)
  body.response.ssuser.maxrequestsperday = '3' // One remaining slot for the negative lookup, none for cover.
  const mock = transport({ body })
  await assert.rejects(runSmokeProbe(config, options, { ...mock, wait: noWait }), code('QUOTA'))
  assert.equal(mock.requests.length, 4)
})

test('M0 CLI cover success writes no media/reports, emits only safe summaries and removes its lock', async t => {
  const { root, path, args } = await setup(t)
  const output = [], errors = []
  const mock = transport()
  assert.equal(await main(args, { directory: root, env, ...mock, wait: noWait,
    output: line => output.push(line), errorOutput: line => errors.push(line) }), 0)
  assert.deepEqual(errors, [])
  const report = JSON.parse(output.at(-1))
  assert.equal(report.cover.verified, true)
  assert.equal(report.cover.stored, false)
  assert.equal(report.cover.rightsVerified, false)
  assert.deepEqual(output.slice(0, -1).map(line => JSON.parse(line).step), ['account', 'systems', 'rom', 'cover'])
  safe(output.join('\n'))
  assert.ok(!output.join('\n').includes(path))
  assert.deepEqual(await readdir(root), ['synthetic.gb'])
  assert.equal(await readFile(path, 'utf8'), 'abc')
})

test('M0 CLI cover failure sanitizes MIME parameters, response bytes, URL and decoder errors and removes its lock', async t => {
  const { root, path, args } = await setup(t)
  for (const [mime, bytes, expected] of [[`image/${config.password}; charset=${config.devPassword}`, config.user, 'COVER_TYPE'],
    [`image/png; charset=${config.password}`, config.devPassword, 'COVER_IMAGE']]) {
    const output = [], errors = []
    const mock = transport({ response: new Response(bytes, { headers: { 'content-type': mime } }) })
    assert.equal(await main(args, { directory: root, env, ...mock, wait: noWait,
      output: line => output.push(line), errorOutput: line => errors.push(line) }), 1)
    const diagnostic = JSON.parse(errors[0])
    assert.equal(diagnostic.step, 'diagnostic')
    assert.equal(diagnostic.endpoint, 'mediaJeu.php')
    assert.equal(diagnostic.code, expected)
    safe([...output, ...errors].join('\n'))
    assert.ok(![...output, ...errors].join('\n').includes(path))
    assert.deepEqual(await readdir(root), ['synthetic.gb'])
    assert.equal(mock.requests.length, 4)
  }
})
