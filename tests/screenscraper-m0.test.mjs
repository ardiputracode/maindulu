import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, link, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { setImmediate as tick } from 'node:timers/promises'
import { main } from '../scripts/screenscraper-m0.mjs'
import { SmokeError, fingerprintSmokeRom, initSmokeSecrets, parseSmokeOptions, readSmokeConfig, runSmokeProbe,
  smokeErrorDiagnostic, smokeEvidenceDiagnostic, smokeLockName, smokeQuota, smokeResponseLimits, smokeRomEvidence, smokeSecretName, smokeSystems, withSmokeLock } from '../scripts/lib/screenscraper-m0.mjs'
import { screenScraperLimits } from '../server/metadata/screenscraper-policy.mjs'

const execFile = promisify(execFileCallback)
const fixture = async name => JSON.parse(await readFile(new URL(`./fixtures/screenscraper/${name}.json`, import.meta.url), 'utf8'))
const info = await fixture('jeu-infos'), systems = await fixture('systemes')
const env = { MAIN_DULU_SCREENSCRAPER_DEV_ID: 'fake-developer-id', MAIN_DULU_SCREENSCRAPER_DEV_PASSWORD: 'fake-developer-secret',
  MAIN_DULU_SCREENSCRAPER_USER: 'fake-private-user', MAIN_DULU_SCREENSCRAPER_PASSWORD: 'fake-user-secret' }
const config = { devId: env.MAIN_DULU_SCREENSCRAPER_DEV_ID, devPassword: env.MAIN_DULU_SCREENSCRAPER_DEV_PASSWORD,
  user: env.MAIN_DULU_SCREENSCRAPER_USER, password: env.MAIN_DULU_SCREENSCRAPER_PASSWORD, softname: 'maindulu-test' }
const account = () => ({ header: { success: 'true' }, response: { ssuser: structuredClone(info.response.ssuser) } })
const live = parseSmokeOptions(['check', '--live'])
const json = body => Response.json(body)
const noWait = async () => {}
const evidenceInput = () => ({ consoleId: 'gb', fileName: 'exemple.gb', method: 'hash', size: 3,
  md5: info.response.jeu.rom.rommd5, sha1: info.response.jeu.rom.romsha1 })
const rejectedEvidence = (game, input = evidenceInput()) => {
  let captured
  assert.throws(() => smokeRomEvidence(input, game), error => { captured = error; return expectCode('EVIDENCE')(error) })
  assert.equal(smokeErrorDiagnostic(captured), null)
  return smokeEvidenceDiagnostic(captured)
}
const expectCode = code => error => error instanceof SmokeError && error.code === code && !error.cause
const safeOutput = output => {
  for (const secret of Object.values(env)) assert.ok(!output.includes(secret))
  assert.doesNotMatch(output, /sspassword=|devpassword=|https:\/\/api\.screenscraper\.fr|rommd5|romsha1|Error:.*at /)
}
async function temporary(t) {
  const parent = join(tmpdir(), 'opencode')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'maindulu-m0-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('M0 CLI requires an explicit command/live flag, pairs ROM+console and refuses credential/URL args', () => {
  assert.equal(parseSmokeOptions(['--help']).command, 'help')
  assert.deepEqual(parseSmokeOptions(['check']), { command: 'check', live: false, notFound: false })
  assert.equal(parseSmokeOptions(['init']).command, 'init')
  for (const args of [[], ['check', '--password', 'secret'], ['check', '--url', 'https://example.invalid'],
    ['check', '--rom', 'game.gb', '--console', 'gb'], ['check', '--live', '--console', 'gb'],
    ['check', '--live', '--rom', 'game.gb'], ['check', '--live', '--not-found'], ['check', '--live', '--live'],
    ['check', '--rom'], ['init', '--live']]) assert.throws(() => parseSmokeOptions(args), expectCode('USAGE'))
})

test('M0 init creates only a private blank secret template and never overwrites user credentials', async t => {
  const root = await temporary(t)
  await initSmokeSecrets(root)
  const path = join(root, smokeSecretName)
  const content = await readFile(path, 'utf8')
  assert.match(content, /MAIN_DULU_SCREENSCRAPER_ENABLED=false/)
  assert.match(content, /MAIN_DULU_SCREENSCRAPER_DEV_PASSWORD=\r?\n/)
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
  await writeFile(path, 'user content must survive')
  await assert.rejects(initSmokeSecrets(root), expectCode('SECRET_EXISTS'))
  assert.equal(await readFile(path, 'utf8'), 'user content must survive')
})

test('M0 reads only its dedicated local file, preserves quoted passwords, and environment overrides it', async t => {
  const root = await temporary(t)
  await writeFile(join(root, '.env'), 'NODE_OPTIONS=not-loaded\nMAIN_DULU_SCREENSCRAPER_ENABLED=true')
  await writeFile(join(root, smokeSecretName), Object.entries(env).map(([key, value]) => `${key}="${value} # preserved"`).join('\n'))
  const fromFile = await readSmokeConfig({ root, env: {}, version: '0.5.0' })
  assert.equal(fromFile.password, config.password + ' # preserved')
  assert.equal(fromFile.softname, 'maindulu-0.5.0')
  const override = await readSmokeConfig({ root, env, version: '0.5.0' })
  assert.equal(override.password, config.password)
  assert.ok(Object.isFrozen(override))
})

test('M0 missing/blank credentials, unknown fields, active flag and unsafe values fail locally without printing secrets', async t => {
  const root = await temporary(t)
  await assert.rejects(readSmokeConfig({ root, env: {}, version: '0.5.0' }), expectCode('SECRET_MISSING'))
  await initSmokeSecrets(root)
  await assert.rejects(readSmokeConfig({ root, env: {}, version: '0.5.0' }), expectCode('SECRET_MISSING'))
  for (const [changes, code] of [
    [{ MAIN_DULU_SCREENSCRAPER_ENABLED: 'true' }, 'AUTO_SCAN'],
    [{ MAIN_DULU_SCREENSCRAPER_PASSWORD: 'line1\nline2' }, 'SECRET_INVALID'],
    [{ MAIN_DULU_SCREENSCRAPER_PASSWORD: ' ' }, 'SECRET_INVALID'],
    [{ MAIN_DULU_SCREENSCRAPER_PASSWORD: 'x'.repeat(4097) }, 'SECRET_INVALID'],
    [{ MAIN_DULU_SCREENSCRAPER_SOFTNAME: 'maindulu/test' }, 'SOFTNAME'],
    [{ MAIN_DULU_SCREENSCRAPER_SOFTNAME: 'maindulu\n' }, 'SOFTNAME'],
  ]) await assert.rejects(readSmokeConfig({ root, env: { ...env, ...changes }, version: '0.5.0' }), expectCode(code))
  await writeFile(join(root, smokeSecretName), 'NODE_OPTIONS=anything')
  await assert.rejects(readSmokeConfig({ root, env, version: '0.5.0' }), expectCode('SECRET_FIELDS'))
  await writeFile(join(root, smokeSecretName), '#'.repeat(64 * 1024 + 1))
  await assert.rejects(readSmokeConfig({ root, env, version: '0.5.0' }), expectCode('SECRET_FILE'))
})

test('M0 refuses a hard-linked secret file without reading its private contents', async t => {
  const root = await temporary(t), original = join(root, 'private')
  await writeFile(original, config.password)
  await link(original, join(root, smokeSecretName))
  await assert.rejects(readSmokeConfig({ root, env, version: '0.5.0' }), expectCode('SECRET_FILE'))
})

test('M0 offline CLI check validates configuration with zero requests and without creating a lock', async t => {
  const root = await temporary(t), output = []
  const code = await main(['check'], { directory: root, env, output: line => output.push(line),
    fetcher: () => assert.fail('offline check must never call fetch') })
  assert.equal(code, 0)
  const report = JSON.parse(output.join('\n'))
  assert.deepEqual({ requests: report.requests, live: report.live, automaticScan: report.automaticScan }, { requests: 0, live: false, automaticScan: false })
  safeOutput(output.join('\n'))
  await assert.rejects(access(join(root, smokeLockName)), { code: 'ENOENT' })
})

test('M0 fingerprint hashes exact bounded file bytes without modifying the ROM or accepting archives', async t => {
  const root = await temporary(t), path = join(root, 'legal.gb')
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 13, 0x5a)
  await writeFile(path, bytes)
  const result = await fingerprintSmokeRom(path, 'gb')
  assert.equal(result.size, bytes.length)
  for (const algorithm of ['md5', 'sha1', 'sha256']) assert.equal(result[algorithm], createHash(algorithm).update(bytes).digest('hex'))
  assert.deepEqual(await readFile(path), bytes)
  await assert.rejects(fingerprintSmokeRom(join(root, 'game.chd'), 'psx'), expectCode('ROM_FORMAT'))
  await assert.rejects(fingerprintSmokeRom(join(root, 'game.zip'), 'gb'), expectCode('ROM_FORMAT'))
  await writeFile(path, '')
  await assert.rejects(fingerprintSmokeRom(path, 'gb'), expectCode('ROM_FILE'))
  await assert.rejects(fingerprintSmokeRom(path, 'gb', AbortSignal.abort()), expectCode('CANCELLED'))
})

test('M0 quota accepts numeric/string fields, respects the strictest minute alias, and fails closed', () => {
  const user = structuredClone(info.response.ssuser)
  assert.equal(smokeQuota({ ...user, maxthreads: 1, maxrequestsperdmin: '2' }).maxrequestspermin, 2)
  const aliasOnly = { ...user, maxrequestsperdmin: '3' }; delete aliasOnly.maxrequestspermin
  assert.equal(smokeQuota(aliasOnly).maxrequestspermin, 3)
  for (const patch of [{ maxthreads: '0' }, { maxrequestsperday: user.requeststoday }, { maxrequestskoperday: '0' },
    { maxrequestspermin: undefined }, { maxrequestsperdmin: 'invalid' }, { requeststoday: '-1' },
    { maxrequestsperday: '9007199254740992' }, { requestskotoday: '3', requeststoday: '2' }]) {
    assert.throws(() => smokeQuota({ ...user, ...patch }), expectCode('QUOTA'))
  }
})

test('M0 checks all seven systems, rejecting missing, duplicate and malformed identities', () => {
  assert.equal(smokeSystems(systems.response.systemes).verifiedSystems, 7)
  assert.equal(smokeSystems(systems.response.systemes.map(item => ({ ...item, id: Number(item.id) }))).verifiedSystems, 7)
  for (const value of [undefined, {}, systems.response.systemes.slice(1), [...systems.response.systemes, systems.response.systemes[0]],
    [...systems.response.systemes, { id: '57\n' }]]) assert.throws(() => smokeSystems(value), expectCode('SYSTEMS'))
})

test('M0 ROM evidence normalizes numeric provider IDs and false flags without guessing absent fields', () => {
  const input = { consoleId: 'gb', fileName: 'exemple.gb', method: 'hash', size: 3,
    md5: info.response.jeu.rom.rommd5, sha1: info.response.jeu.rom.romsha1 }
  const game = structuredClone(info.response.jeu)
  game.id = Number(game.id); game.systeme.id = 9; game.rom.id = Number(game.rom.id); game.romid = Number(game.romid)
  for (const value of [false, 'false', 0, '0']) {
    game.notgame = value
    assert.equal(smokeRomEvidence(input, game).verified, true)
  }
  delete game.notgame
  assert.throws(() => smokeRomEvidence(input, game), expectCode('EVIDENCE'))
})

test('M0 rejected evidence identifies each failing check without changing match requirements or printing values', () => {
  const cases = [
    ['missing_game', () => undefined, { hasGame: false }, { game: 'missing' }],
    ['missing_game', game => [game], { hasGame: false }, { game: 'array' }],
    ['missing_matched_rom', game => { delete game.rom; return game }, { hasMatchedRom: false, hasRomsList: true }, { matchedRom: 'missing' }],
    ['missing_matched_rom', game => { game.rom = [game.rom]; return game }, { hasMatchedRom: false }, { matchedRom: 'array' }],
    ['unconfirmed_game', game => { game.id = ''; return game }, { gameIdValid: false, md5Matches: true }, {}],
    ['unconfirmed_game', game => { delete game.systeme; return game }, { systemIdValid: false, systemMatches: false }, { system: 'missing' }],
    ['unconfirmed_game', game => { game.systeme.id = '10'; return game }, { systemIdValid: true, systemMatches: false }, {}],
    ['unconfirmed_game', game => { delete game.notgame; return game }, { notGameFieldPresent: false, notGameConfirmedFalse: false, md5Matches: true }, { notGame: 'missing' }],
    ['unconfirmed_game', game => { game.notgame = true; return game }, { notGameConfirmedTrue: true, notGameConfirmedFalse: false }, { notGame: 'boolean' }],
    ['unconfirmed_game', game => { game.notgame = { text: 'false' }; return game }, { notGameFieldPresent: true, notGameConfirmedFalse: false }, { notGame: 'object' }],
    ['unconfirmed_rom', game => { delete game.romid; game.rom.id = ''; return game }, { romIdValid: false, hasRomReference: false }, {}],
    ['unconfirmed_rom', game => { delete game.rom.romtotalsupport; return game }, { supportCountPresent: false, singleSupport: false }, { supportCount: 'missing' }],
    ['unconfirmed_rom', game => { game.rom.romtotalsupport = '2'; return game }, { supportCountPresent: true, singleSupport: false }, { supportCount: 'string' }],
    ['size_mismatch', game => { game.rom.romsize = '4'; return game }, { sizeValid: true, sizeMatches: false }, {}],
    ['size_mismatch', game => { game.rom.romsize = { text: '3' }; return game }, { sizeValid: false, sizeMatches: false }, { size: 'object' }],
    ['missing_hash_evidence', game => { delete game.rom.rommd5; return game }, { md5Present: false, md5Valid: false, md5Matches: false }, { md5: 'missing' }],
    ['missing_hash_evidence', game => { game.rom.rommd5 = { text: game.rom.rommd5 }; return game }, { md5Present: true, md5Valid: false }, { md5: 'object' }],
    ['hash_mismatch', game => { game.rom.rommd5 = '0'.repeat(32); return game }, { md5Valid: true, md5Matches: false, sha1Matches: true }, {}],
    ['missing_hash_evidence', game => { delete game.rom.romsha1; return game }, { sha1Present: false, sha1Valid: false, sha1Matches: false }, { sha1: 'missing' }],
    ['missing_hash_evidence', game => { game.rom.romsha1 = config.password; return game }, { sha1Present: true, sha1Valid: false }, { sha1: 'string' }],
    ['hash_mismatch', game => { game.rom.romsha1 = '0'.repeat(40); return game }, { sha1Valid: true, sha1Matches: false, md5Matches: true }, {}],
  ]
  for (const [reason, change, expectedChecks, expectedShapes] of cases) {
    const game = change(structuredClone(info.response.jeu))
    const diagnostic = rejectedEvidence(game)
    assert.equal(diagnostic.reason, reason)
    for (const [key, value] of Object.entries(expectedChecks)) assert.equal(diagnostic.checks[key], value, `${reason}/${key}`)
    for (const [key, value] of Object.entries(expectedShapes)) assert.equal(diagnostic.shapes[key], value, `${reason}/${key}`)
    for (const value of Object.values(diagnostic.checks)) assert.equal(typeof value, 'boolean')
    assert.ok(Object.isFrozen(diagnostic) && Object.isFrozen(diagnostic.checks) && Object.isFrozen(diagnostic.shapes))
    const text = JSON.stringify(diagnostic)
    safeOutput(text)
    for (const value of [info.response.jeu.id, info.response.jeu.rom.id, info.response.jeu.rom.rommd5, info.response.jeu.rom.romsha1, info.response.jeu.noms[0].text]) {
      assert.ok(!text.includes(value))
    }
  }
})

test('M0 evidence diagnostics also safely classify malformed local input instead of relaxing the policy', () => {
  const game = structuredClone(info.response.jeu)
  for (const [input, reason] of [[null, 'invalid_input'], [{ ...evidenceInput(), method: config.password }, 'manual_lookup'],
    [{ ...evidenceInput(), fileName: 'game.zip' }, 'archive_requires_review'],
    [{ ...evidenceInput(), md5: config.devPassword }, 'invalid_fingerprint']]) {
    const diagnostic = rejectedEvidence(game, input)
    assert.equal(diagnostic.reason, reason)
    safeOutput(JSON.stringify(diagnostic))
  }
})

test('M0 evidence diagnostics leave accepted data and optional ROM references unchanged and never mutate input', () => {
  const input = Object.freeze(evidenceInput())
  for (const value of [false, 'false', 0, '0']) {
    const game = structuredClone(info.response.jeu)
    game.notgame = value
    delete game.romid // Existing optional-reference behavior must be retained.
    Object.freeze(game.rom); Object.freeze(game)
    const before = JSON.stringify(game)
    assert.equal(smokeRomEvidence(input, game).verified, true)
    assert.equal(JSON.stringify(game), before)
  }
})

test('M0 auxiliary ROM reference variants warn safely only after exact primary evidence and never mutate or unwrap data', () => {
  const matchedId = info.response.jeu.rom.id
  const input = Object.freeze(evidenceInput())
  for (const [reference, reason, valid, shape] of [
    [undefined, null, false, 'missing'], [matchedId, null, true, 'string'], [Number(matchedId), null, true, 'number'],
    ['900000099', 'rom_reference_mismatch', true, 'string'], [900000099, 'rom_reference_mismatch', true, 'number'],
    [null, 'rom_reference_invalid', false, 'null'], ['0', 'rom_reference_invalid', false, 'string'],
    [0, 'rom_reference_invalid', false, 'number'], ['', 'rom_reference_invalid', false, 'string'],
    [`0${matchedId}`, 'rom_reference_invalid', false, 'string'], [true, 'rom_reference_invalid', false, 'boolean'],
    [{ id: matchedId, text: config.password }, 'rom_reference_invalid', false, 'object'],
    [[matchedId, config.devPassword], 'rom_reference_invalid', false, 'array'],
    [config.password, 'rom_reference_invalid', false, 'string'],
  ]) {
    const game = structuredClone(info.response.jeu)
    if (reference === undefined) delete game.romid
    else game.romid = reference
    if (reference && typeof reference === 'object') Object.freeze(reference)
    Object.freeze(game.rom); Object.freeze(game)
    const before = JSON.stringify(game)
    const result = smokeRomEvidence(input, game)
    assert.equal(result.verified, true)
    assert.equal(JSON.stringify(game), before)
    assert.ok(Object.isFrozen(result.warnings))
    assert.equal(result.warnings.length, reason ? 1 : 0)
    if (reason) {
      const warning = result.warnings[0]
      assert.equal(warning.reason, reason)
      assert.equal(warning.checks.hasRomReference, true)
      assert.equal(warning.checks.romReferenceValid, valid)
      assert.equal(warning.checks.romReferenceConsistent, false)
      assert.equal(warning.shapes.romReference, shape)
      for (const key of ['hasMatchedRom', 'romIdValid', 'systemMatches', 'notGameConfirmedFalse', 'singleSupport', 'sizeMatches', 'md5Matches', 'sha1Matches']) {
        assert.equal(warning.checks[key], true)
      }
      assert.ok(Object.isFrozen(warning) && Object.isFrozen(warning.checks) && Object.isFrozen(warning.shapes))
      for (const value of Object.values(warning.checks)) assert.equal(typeof value, 'boolean')
    }
    const text = JSON.stringify(result)
    safeOutput(text)
    for (const value of [matchedId, info.response.jeu.id, '900000099', input.md5, input.sha1, game.noms[0].text]) assert.ok(!text.includes(value))
  }
})

test('M0 auxiliary reference agreement or anomalies cannot mask primary contradictions or supply missing matched evidence', () => {
  for (const reference of [undefined, info.response.jeu.rom.id, '900000099', null, { id: info.response.jeu.rom.id }]) {
    for (const [change, reason] of [
      [game => { game.id = '0' }, 'unconfirmed_game'],
      [game => { game.systeme.id = '10' }, 'unconfirmed_game'],
      [game => { game.notgame = 'true' }, 'unconfirmed_game'],
      [game => { delete game.notgame }, 'unconfirmed_game'],
      [game => { game.rom.id = '0' }, 'unconfirmed_rom'],
      [game => { delete game.rom.id }, 'unconfirmed_rom'],
      [game => { game.rom.romtotalsupport = '2' }, 'unconfirmed_rom'],
      [game => { delete game.rom.romtotalsupport }, 'unconfirmed_rom'],
      [game => { game.rom.romsize = '4' }, 'size_mismatch'],
      [game => { game.rom.rommd5 = '0'.repeat(32) }, 'hash_mismatch'],
      [game => { game.rom.romsha1 = '0'.repeat(40) }, 'hash_mismatch'],
      [game => { delete game.rom.rommd5 }, 'missing_hash_evidence'],
      [game => { delete game.rom.romsha1 }, 'missing_hash_evidence'],
      [game => { game.roms.push(game.rom); delete game.rom }, 'missing_matched_rom'],
    ]) {
      const game = structuredClone(info.response.jeu)
      game.romid = reference
      change(game)
      const diagnostic = rejectedEvidence(game)
      assert.equal(diagnostic.reason, reason)
      assert.equal(diagnostic.checks.romReferenceValid, typeof reference === 'string')
      safeOutput(JSON.stringify(diagnostic))
    }
  }
})

test('M0 CLI emits safe ROM reference warnings, continues optional negative lookup, and adds no requests', async t => {
  const root = await temporary(t), path = join(root, 'legal.gb')
  await writeFile(path, 'abc')
  for (const notFound of [false, true]) {
    for (const reference of ['900000099', { id: config.password, text: config.devPassword }]) {
      const output = [], errors = [], endpoints = []
      const body = structuredClone(info)
      body.response.jeu.romid = reference
      body.header.request = `https://example.invalid/?sspassword=${config.password}`
      body.response.jeu.noms[0].text = config.user
      body.response.jeu.rom.romfilename = config.password
      assert.equal(await main(['check', '--live', '--console', 'gb', '--rom', path, ...(notFound ? ['--not-found'] : [])], {
        directory: root, env, wait: noWait, output: line => output.push(line), errorOutput: line => errors.push(line), fetcher: async url => {
          endpoints.push(url.pathname.split('/').at(-1))
          return endpoints.length === 1 ? json(account()) : endpoints.length === 2 ? json(systems)
            : endpoints.length === 3 ? json(body) : new Response(config.password, { status: 404 })
        },
      }), 0)
      assert.deepEqual(errors, [])
      assert.deepEqual(endpoints, ['ssuserInfos.php', 'systemesListe.php', 'jeuInfos.php', ...(notFound ? ['jeuInfos.php'] : [])])
      const steps = output.slice(0, -1).map(line => JSON.parse(line))
      assert.deepEqual(steps.map(item => item.step), ['account', 'systems', 'rom', ...(notFound ? ['not_found'] : [])])
      const report = JSON.parse(output.at(-1))
      assert.equal(report.requests, notFound ? 4 : 3)
      assert.equal(report.automaticScan, false)
      assert.equal(report.rom.verified, true)
      assert.equal(report.rom.warnings[0].reason, typeof reference === 'string' ? 'rom_reference_mismatch' : 'rom_reference_invalid')
      assert.deepEqual(steps[2].warnings, report.rom.warnings)
      if (notFound) assert.equal(report.notFound.verified, true)
      else assert.equal(report.notFound, undefined)
      const text = output.join('\n')
      safeOutput(text)
      for (const value of [path, info.response.jeu.id, info.response.jeu.rom.id, '900000099', info.response.jeu.rom.rommd5,
        info.response.jeu.rom.romsha1, info.response.jeu.noms[0].text]) assert.ok(!text.includes(value))
      await assert.rejects(access(join(root, smokeLockName)), { code: 'ENOENT' })
    }
  }
})

test('M0 evidence snapshot only exposes allowlisted reasons, strict booleans and shape categories', () => {
  const raw = { reason: 'hash_mismatch', checks: { md5Matches: true, sha1Matches: config.password, secret: config.devPassword },
    shapes: { game: 'object', matchedRom: 'object', md5: config.user, secret: config.devId }, requestUrl: config.password }
  const error = new SmokeError('EVIDENCE', undefined, raw)
  raw.reason = config.password; raw.checks.md5Matches = false; raw.shapes.game = config.devPassword
  error.evidence = { reason: config.password }
  const snapshot = smokeEvidenceDiagnostic(error)
  assert.equal(snapshot.reason, 'hash_mismatch')
  assert.equal(snapshot.checks.md5Matches, true)
  assert.equal(snapshot.checks.sha1Matches, false)
  assert.equal(snapshot.shapes.game, 'object')
  assert.equal(snapshot.shapes.md5, 'other')
  assert.deepEqual(Object.keys(snapshot), ['reason', 'checks', 'shapes'])
  assert.equal(Object.hasOwn(snapshot.checks, 'secret'), false)
  assert.equal(Object.hasOwn(snapshot.shapes, 'secret'), false)
  safeOutput(JSON.stringify(snapshot))
  const unknown = smokeEvidenceDiagnostic(new SmokeError('EVIDENCE', undefined, { reason: config.password }))
  assert.equal(unknown.reason, 'unknown_evidence')
  safeOutput(JSON.stringify(unknown))
  assert.equal(smokeEvidenceDiagnostic(Object.assign(new Error(config.password), { evidence: raw })), null)
  assert.equal(smokeEvidenceDiagnostic(new SmokeError('HTTP_403', undefined, raw)), null)
})

test('M0 CLI emits an actionable evidence line without hashes, game names, IDs or secret echoes, and stops before the negative probe', async t => {
  const root = await temporary(t), path = join(root, 'legal.gb'), output = []
  await writeFile(path, 'abc')
  let count = 0
  const body = structuredClone(info)
  delete body.response.jeu.notgame
  body.header.request = `https://example.invalid/?sspassword=${config.password}`
  body.response.jeu.noms[0].text = config.user
  body.response.jeu.rom.romfilename = config.password
  body.response.jeu.rom.rommd5 = config.devPassword
  assert.equal(await main(['check', '--live', '--console', 'gb', '--rom', path, '--not-found'], { directory: root, env, wait: noWait,
    output: line => output.push(line), errorOutput: line => output.push(line), fetcher: async () => {
      count++
      return json(count === 1 ? account() : count === 2 ? systems : body)
    } }), 1)
  assert.equal(count, 3)
  const evidenceLines = output.filter(line => line.startsWith('{')).map(line => JSON.parse(line)).filter(item => item.step === 'evidence')
  assert.equal(evidenceLines.length, 1)
  const diagnostic = evidenceLines[0]
  assert.equal(diagnostic.endpoint, 'jeuInfos.php')
  assert.equal(diagnostic.code, 'EVIDENCE')
  assert.equal(diagnostic.reason, 'unconfirmed_game')
  assert.equal(diagnostic.checks.hasGame, true)
  assert.equal(diagnostic.checks.hasMatchedRom, true)
  assert.equal(diagnostic.checks.notGameFieldPresent, false)
  assert.equal(diagnostic.checks.notGameConfirmedFalse, false)
  assert.equal(diagnostic.shapes.notGame, 'missing')
  assert.equal(diagnostic.checks.sizeMatches, true)
  assert.equal(diagnostic.checks.md5Matches, false)
  assert.equal(diagnostic.checks.sha1Matches, true)
  safeOutput(output.join('\n'))
  for (const value of [path, info.response.jeu.id, info.response.jeu.rom.id, info.response.jeu.rom.romsha1,
    createHash('md5').update('abc').digest('hex'), info.response.jeu.noms[0].text]) assert.ok(!output.join('\n').includes(value))
  await assert.rejects(access(join(root, smokeLockName)), { code: 'ENOENT' })
})

test('M0 live smoke performs at most four fixed-host GETs, sends hashes not ROM bytes, and reports only sanitized summaries', async t => {
  const root = await temporary(t), path = join(root, 'legal.gb'), requests = [], waits = [], steps = []
  await writeFile(path, 'abc')
  const options = parseSmokeOptions(['check', '--live', '--rom', path, '--console', 'gb', '--not-found'])
  const report = await runSmokeProbe(config, options, { wait: async milliseconds => waits.push(milliseconds), onStep: step => steps.push(step), fetcher: async (url, init) => {
    requests.push(url)
    assert.equal(url.origin, 'https://api.screenscraper.fr')
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit')
    assert.equal(url.searchParams.get('devpassword'), config.devPassword)
    assert.equal(url.searchParams.get('sspassword'), config.password)
    assert.equal(url.searchParams.has('sha256'), false)
    if (requests.length === 1) return json({ ...account(), header: { success: 'true', request: String(url) } })
    if (requests.length === 2) return json(systems)
    if (requests.length === 3) {
      assert.equal(url.searchParams.get('md5'), info.response.jeu.rom.rommd5.toLowerCase())
      assert.equal(url.searchParams.get('romtaille'), '3')
      return json(info)
    }
    assert.equal(url.searchParams.get('romtaille'), '64')
    assert.notEqual(url.searchParams.get('md5'), info.response.jeu.rom.rommd5.toLowerCase())
    return new Response('private provider body: ' + config.password, { status: 404 })
  } })
  assert.equal(report.requests, 4)
  assert.equal(report.rom.verified, true)
  assert.equal(report.notFound.httpStatus, 404)
  assert.equal(report.automaticScan, false)
  assert.deepEqual(waits, [1000, 1000, 1000])
  assert.deepEqual(steps.map(step => step.step), ['account', 'systems', 'rom', 'not_found'])
  safeOutput(JSON.stringify({ report, steps }))
})

test('M0 slow minute quota changes spacing and exhausted/unknown quota stops before the second request', async () => {
  let count = 0
  const waits = []
  await runSmokeProbe(config, live, { wait: async value => waits.push(value), fetcher: async () => {
    if (++count === 1) { const body = account(); body.response.ssuser.maxrequestsperdmin = '2'; return json(body) }
    return json(systems)
  } })
  assert.deepEqual(waits, [30000])
  for (const user of [{}, { ...info.response.ssuser, maxrequestsperday: '2' }, { ...info.response.ssuser, maxrequestskoperday: '0' }]) {
    count = 0
    await assert.rejects(runSmokeProbe(config, live, { wait: noWait, fetcher: async () => { count++; return json({ response: { ssuser: user } }) } }), expectCode('QUOTA'))
    assert.equal(count, 1)
  }
})

test('M0 reserves quota conservatively when following responses do not include account counters', async t => {
  const root = await temporary(t), path = join(root, 'legal.gb')
  await writeFile(path, 'abc')
  let count = 0
  const options = parseSmokeOptions(['check', '--live', '--rom', path, '--console', 'gb', '--not-found'])
  await assert.rejects(runSmokeProbe(config, options, { wait: noWait, fetcher: async () => {
    count++
    if (count === 1) { const body = account(); body.response.ssuser.maxrequestsperday = '3'; return json(body) }
    if (count === 2) return json(systems)
    assert.fail('no quota left for ROM lookup')
  } }), expectCode('QUOTA'))
  assert.equal(count, 2)
})

test('M0 HTTP access, cooldown and quota failures never retry or echo provider error bodies', async t => {
  const root = await temporary(t)
  for (const status of [400, 401, 403, 404, 423, 426, 429, 430, 431, 503]) {
    const output = []; let count = 0
    assert.equal(await main(['check', '--live'], { directory: root, env, output: line => output.push(line), errorOutput: line => output.push(line),
      fetcher: async () => { count++; return new Response('URL?devpassword=' + config.devPassword, { status }) } }), 1)
    assert.equal(count, 1)
    assert.ok(output.join().includes(status === 503 ? 'HTTP_OTHER' : `HTTP_${status}`))
    safeOutput(output.join('\n'))
    await assert.rejects(access(join(root, smokeLockName)), { code: 'ENOENT' })
  }
})

test('M0 transport/redirect errors and tampered Error.message/stack/cause are never printed', async t => {
  const root = await temporary(t)
  for (const error of [new Error('https://api.screenscraper.fr/?sspassword=' + config.password, { cause: config.devPassword }),
    Object.assign(new SmokeError('HTTP_403'), { message: config.password, stack: config.devPassword }),
    Object.assign(new SmokeError('HTTP_403'), { code: config.password })]) {
    const output = []
    assert.equal(await main(['check', '--live'], { directory: root, env, output: line => output.push(line), errorOutput: line => output.push(line),
      fetcher: async () => { throw error } }), 1)
    safeOutput(output.join('\n'))
  }
  const response = json(account()); Object.defineProperty(response, 'redirected', { value: true })
  await assert.rejects(runSmokeProbe(config, live, { fetcher: async () => response }), expectCode('TRANSPORT'))
})

test('M0 distinguishes response MIME, body, UTF-8, JSON, envelope and provider-rejection failures', async () => {
  for (const [response, code] of [
    [new Response('<html>private</html>', { headers: { 'content-type': 'text/html' } }), 'RESPONSE_TYPE'],
    [new Response(null, { headers: { 'content-type': 'application/json' } }), 'RESPONSE_BODY'],
    [new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }), 'RESPONSE_ENCODING'],
    [new Response('{', { headers: { 'content-type': 'application/json' } }), 'RESPONSE_JSON'],
    [json({ header: { success: 'false' }, response: { ssuser: info.response.ssuser } }), 'RESPONSE_REJECTED'],
    [json({ header: { success: 'true' } }), 'RESPONSE_ENVELOPE'],
  ]) {
    await assert.rejects(runSmokeProbe(config, live, { fetcher: async () => response }), error => {
      assert.equal(expectCode(code)(error), true)
      const diagnostic = smokeErrorDiagnostic(error)
      assert.equal(diagnostic.endpoint, 'ssuserInfos.php')
      assert.equal(diagnostic.httpStatus, 200)
      assert.equal(diagnostic.limitBytes, screenScraperLimits.responseBytes)
      safeOutput(JSON.stringify(diagnostic))
      return true
    })
  }
})

test('M0 account response stream remains bounded at 2 MiB despite a fake Content-Length header', async () => {
  let cancelled = false
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(screenScraperLimits.responseBytes + 1)) }, cancel() { cancelled = true } })
  await assert.rejects(runSmokeProbe(config, live, { fetcher: async () => new Response(stream,
    { headers: { 'content-type': 'application/json', 'content-length': '1' } }) }), error => {
    assert.equal(expectCode('RESPONSE_SIZE')(error), true)
    assert.equal(smokeErrorDiagnostic(error).receivedBytes, screenScraperLimits.responseBytes + 1)
    return true
  })
  assert.equal(cancelled, true)
})

test('M0 full systems JSON larger than the game budget succeeds with a separate bounded systems allowance', async () => {
  assert.ok(Object.isFrozen(smokeResponseLimits))
  assert.equal(smokeResponseLimits['ssuserInfos.php'], screenScraperLimits.responseBytes)
  assert.equal(smokeResponseLimits['jeuInfos.php'], screenScraperLimits.responseBytes)
  assert.equal(smokeResponseLimits['systemesListe.php'], 16 * 1024 * 1024)
  const base = JSON.stringify(systems)
  const body = base + ' '.repeat(screenScraperLimits.responseBytes + 128 - Buffer.byteLength(base))
  let count = 0
  const report = await runSmokeProbe(config, live, { wait: noWait, fetcher: async () => {
    count++
    return count === 1 ? json(account()) : new Response(body, { headers: { 'content-type': 'application/json; charset=UTF-8', 'content-length': '1' } })
  } })
  assert.equal(report.requests, 2)
  assert.equal(report.systems.verifiedSystems, 7)
  safeOutput(JSON.stringify(report))
})

test('M0 systems hard cap cancels oversized streams, reports byte facts and never retries', async () => {
  const limit = smokeResponseLimits['systemesListe.php']
  let count = 0, cancelled = false
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(limit + 1)) }, cancel() { cancelled = true } })
  await assert.rejects(runSmokeProbe(config, live, { wait: noWait, fetcher: async () => {
    count++
    return count === 1 ? json(account()) : new Response(stream, { headers: { 'content-type': 'application/json', 'content-length': '1' } })
  } }), error => {
    assert.equal(expectCode('RESPONSE_SIZE')(error), true)
    assert.deepEqual(smokeErrorDiagnostic(error), { endpoint: 'systemesListe.php', httpStatus: 200,
      contentType: 'application/json', receivedBytes: limit + 1, limitBytes: limit })
    return true
  })
  assert.equal(count, 2)
  assert.equal(cancelled, true)
})

test('M0 ROM response keeps the 2 MiB limit even after a systems request with a larger allowance', async t => {
  const root = await temporary(t), path = join(root, 'legal.gb')
  await writeFile(path, 'abc')
  const options = parseSmokeOptions(['check', '--live', '--rom', path, '--console', 'gb', '--not-found'])
  let count = 0, cancelled = false
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(screenScraperLimits.responseBytes + 1)) }, cancel() { cancelled = true } })
  await assert.rejects(runSmokeProbe(config, options, { wait: noWait, fetcher: async () => {
    count++
    return count === 1 ? json(account()) : count === 2 ? json(systems) : new Response(stream, { headers: { 'content-type': 'application/json' } })
  } }), error => {
    assert.equal(expectCode('RESPONSE_SIZE')(error), true)
    assert.equal(smokeErrorDiagnostic(error).endpoint, 'jeuInfos.php')
    assert.equal(smokeErrorDiagnostic(error).limitBytes, screenScraperLimits.responseBytes)
    return true
  })
  assert.equal(count, 3)
  assert.equal(cancelled, true)
})

test('M0 CLI error diagnostics identify the failing endpoint without exposing MIME params, redirect headers or bodies', async t => {
  const root = await temporary(t)
  for (const [contentType, category, body, code, bytes] of [
    [`text/plain; charset=${config.password}`, 'text/plain', config.devPassword, 'RESPONSE_TYPE', 0],
    [`application/${config.password}; charset=${config.devPassword}`, 'other', config.user, 'RESPONSE_TYPE', 0],
    [`application/${config.password}+json; charset=${config.devPassword}`, 'application/*+json', '{', 'RESPONSE_JSON', 1],
    ['application/json', 'application/json', '{', 'RESPONSE_JSON', 1],
  ]) {
    const output = []; let count = 0
    assert.equal(await main(['check', '--live'], { directory: root, env, wait: noWait,
      output: line => output.push(line), errorOutput: line => output.push(line), fetcher: async () => {
        count++
        return count === 1 ? json(account()) : new Response(body, { headers: { 'content-type': contentType,
          location: `https://example.invalid/?sspassword=${config.password}` } })
      } }), 1)
    const diagnostic = output.filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(item => item.step === 'diagnostic')
    assert.deepEqual(diagnostic, { step: 'diagnostic', code, endpoint: 'systemesListe.php', httpStatus: 200,
      contentType: category, receivedBytes: bytes, limitBytes: smokeResponseLimits['systemesListe.php'] })
    safeOutput(output.join('\n'))
    assert.equal(count, 2)
    await assert.rejects(access(join(root, smokeLockName)), { code: 'ENOENT' })
  }
})

test('M0 diagnostic snapshots cannot be replaced with public properties, raw URLs or malformed numeric values', () => {
  const diagnostic = { endpoint: 'systemesListe.php', httpStatus: 200, contentType: 'application/json', receivedBytes: 17 }
  const error = new SmokeError('RESPONSE_JSON', diagnostic)
  diagnostic.endpoint = config.password
  error.diagnostic = { endpoint: config.devPassword }
  assert.ok(Object.isFrozen(smokeErrorDiagnostic(error)))
  assert.equal(smokeErrorDiagnostic(error).endpoint, 'systemesListe.php')
  assert.equal(smokeErrorDiagnostic(new Error(config.password)), null)
  assert.equal(smokeErrorDiagnostic(new SmokeError('RESPONSE_JSON', { endpoint: `https://example.invalid/?sspassword=${config.password}` })), null)
  assert.equal(smokeErrorDiagnostic(new SmokeError('RESPONSE_JSON', { endpoint: { toString: () => 'ssuserInfos.php' } })), null)
  const invalid = smokeErrorDiagnostic(new SmokeError('RESPONSE_SIZE', { endpoint: 'jeuInfos.php', httpStatus: config.password,
    contentType: config.devPassword, receivedBytes: config.user, limitBytes: config.devId }))
  assert.deepEqual(invalid, { endpoint: 'jeuInfos.php', httpStatus: null, contentType: 'other', receivedBytes: 0, limitBytes: screenScraperLimits.responseBytes })
  safeOutput(JSON.stringify(invalid))
})

test('M0 bounds total request time including stalled headers/body, and explicit cancellation', async () => {
  await assert.rejects(runSmokeProbe(config, live, { timeoutMs: 15, fetcher: () => new Promise(() => {}) }), expectCode('TIMEOUT'))
  let cancelled = false
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) }, cancel() { cancelled = true } })
  await assert.rejects(runSmokeProbe(config, live, { timeoutMs: 15,
    fetcher: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }) }), expectCode('TIMEOUT'))
  assert.equal(cancelled, true)
  const controller = new AbortController()
  const pending = runSmokeProbe(config, live, { signal: controller.signal, fetcher: () => new Promise(() => {}) })
  controller.abort()
  await assert.rejects(pending, expectCode('CANCELLED'))
})

test('M0 cancels a late response body even when an injected transport ignores its abort signal', async () => {
  let resolveFetch, cancelled = false
  const pending = runSmokeProbe(config, live, { timeoutMs: 15, fetcher: () => new Promise(resolve => { resolveFetch = resolve }) })
  await assert.rejects(pending, expectCode('TIMEOUT'))
  resolveFetch(new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { 'content-type': 'application/json' } }))
  await tick()
  assert.equal(cancelled, true)
})

test('M0 positive ROM lookup rejects absent/mismatched evidence without falling back to roms or negative probes', async t => {
  const root = await temporary(t), path = join(root, 'legal.gb')
  await writeFile(path, 'abc')
  for (const variant of ['missing-rom', 'bad-size', 'bad-md5', 'bad-sha1', 'wrong-system', 'invalid-rom-id', 'multiple-supports', 'not-game', 'not-found']) {
    let count = 0
    const options = parseSmokeOptions(['check', '--live', '--rom', path, '--console', 'gb', '--not-found'])
    await assert.rejects(runSmokeProbe(config, options, { wait: noWait, fetcher: async () => {
      if (++count === 1) return json(account())
      if (count === 2) return json(systems)
      if (variant === 'not-found') return new Response('secret body', { status: 404 })
      const data = structuredClone(info)
      data.response.jeu.romid = '900000099' // Auxiliary mismatch must never mask primary failure.
      if (variant === 'missing-rom') { data.response.jeu.roms.push(data.response.jeu.rom); delete data.response.jeu.rom }
      if (variant === 'bad-size') data.response.jeu.rom.romsize = '4'
      if (variant === 'bad-md5') data.response.jeu.rom.rommd5 = '0'.repeat(32)
      if (variant === 'bad-sha1') data.response.jeu.rom.romsha1 = '0'.repeat(40)
      if (variant === 'wrong-system') data.response.jeu.systeme.id = '10'
      if (variant === 'invalid-rom-id') data.response.jeu.rom.id = '0'
      if (variant === 'multiple-supports') data.response.jeu.rom.romtotalsupport = '2'
      if (variant === 'not-game') data.response.jeu.notgame = 'true'
      return json(data)
    } }), expectCode(variant === 'not-found' ? 'HTTP_404' : 'EVIDENCE'))
    assert.equal(count, 3)
  }
})

test('M0 negative probe must actually return 404, not a valid-looking HTTP 200 game', async t => {
  const root = await temporary(t), path = join(root, 'legal.gb')
  await writeFile(path, 'abc')
  let count = 0
  const body = structuredClone(info)
  body.response.jeu.romid = '900000099'
  await assert.rejects(runSmokeProbe(config, parseSmokeOptions(['check', '--live', '--rom', path, '--console', 'gb', '--not-found']),
    { wait: noWait, fetcher: async () => { count++; return json(count === 1 ? account() : count === 2 ? systems : body) } }), expectCode('NEGATIVE'))
  assert.equal(count, 4)
})

test('M0 lock rejects a simultaneous probe, cleans up on failure, and never overwrites an existing lock', async t => {
  const root = await temporary(t)
  let release, admit
  const admitted = new Promise(resolve => { admit = resolve })
  const active = withSmokeLock(root, () => new Promise(resolve => { release = resolve; admit() }))
  await admitted
  await assert.rejects(withSmokeLock(root, () => assert.fail('second probe')), expectCode('LOCKED'))
  release('done'); assert.equal(await active, 'done')
  await assert.rejects(access(join(root, smokeLockName)), { code: 'ENOENT' })
  await assert.rejects(withSmokeLock(root, async () => { throw new SmokeError('TRANSPORT') }), expectCode('TRANSPORT'))
  await writeFile(join(root, smokeLockName), 'operator-owned')
  await assert.rejects(withSmokeLock(root, noWait), expectCode('LOCKED'))
  assert.equal(await readFile(join(root, smokeLockName), 'utf8'), 'operator-owned')
})

test('M0 secret and lock are ignored by Git, public example is not, and app startup never imports the manual probe', async () => {
  const result = await execFile('git', ['check-ignore', '--no-index', smokeSecretName, smokeLockName])
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 2)
  await assert.rejects(execFile('git', ['check-ignore', '--no-index', 'deploy/screenscraper-m0.env.example']), error => error.code === 1)
  const app = await readFile(new URL('../server/app.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(app, /scripts\/.*screenscraper|runSmokeProbe|readSmokeConfig/)
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.scripts['metadata:m0'], 'node scripts/screenscraper-m0.mjs')
})
