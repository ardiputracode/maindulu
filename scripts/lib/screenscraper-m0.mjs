// Manual, opt-in M0 probe. Never imported by server/app.mjs or the frontend.
import { readFile, open, unlink, lstat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { parseEnv } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'
import { openRegular } from '../../server/catalog/storage.mjs'
import { safeOriginalName } from '../../server/catalog/repository.mjs'
import { assessScreenScraperEvidence, screenScraperLimits as limits, screenScraperPreferences, screenScraperSystems, screenScraperTarget } from '../../server/metadata/screenscraper-policy.mjs'

export const smokeSecretName = '.env.screenscraper.local'
export const smokeLockName = '.screenscraper-m0.lock.local'
// systemesListe includes metadata/media for the entire platform catalog, not
// one game. Keep its bounded allowance separate from account/ROM responses.
export const smokeResponseLimits = Object.freeze({
  'ssuserInfos.php': limits.responseBytes,
  'systemesListe.php': 16 * 1024 * 1024,
  'jeuInfos.php': limits.responseBytes,
  'mediaJeu.php': limits.coverBytes,
})
const diagnosticTypes = new Set(['application/json', 'application/*+json', 'text/json', 'text/html', 'text/plain',
  'application/xml', 'text/xml', 'application/octet-stream', 'image/png', 'image/jpeg', 'image/webp', 'missing', 'other'])
const errorDiagnostics = new WeakMap()
const errorEvidenceDiagnostics = new WeakMap()
const evidenceReasons = new Set(['invalid_input', 'manual_lookup', 'invalid_target', 'archive_requires_review', 'format_requires_review',
  'invalid_fingerprint', 'non_unique_result', 'unconfirmed_game', 'unconfirmed_rom', 'size_mismatch', 'missing_hash_evidence',
  'hash_mismatch', 'missing_game', 'missing_matched_rom', 'rom_reference_mismatch', 'rom_reference_invalid', 'unknown_evidence'])
const evidenceChecks = Object.freeze(['hasGame', 'gameIdValid', 'systemIdValid', 'systemMatches', 'notGameFieldPresent',
  'notGameConfirmedFalse', 'notGameConfirmedTrue', 'hasMatchedRom', 'hasRomsList', 'romIdValid', 'hasRomReference',
  'romReferenceValid', 'romReferenceConsistent', 'supportCountPresent', 'singleSupport', 'sizeValid', 'sizeMatches',
  'md5Present', 'md5Valid', 'md5Matches', 'sha1Present', 'sha1Valid', 'sha1Matches'])
const evidenceShapeFields = Object.freeze(['game', 'matchedRom', 'romReference', 'system', 'notGame', 'supportCount', 'size', 'md5', 'sha1'])
const evidenceShapes = new Set(['missing', 'null', 'object', 'array', 'string', 'boolean', 'number', 'other'])

function evidenceSnapshot(value) {
  if (!value || typeof value !== 'object') return null
  return Object.freeze({
    reason: evidenceReasons.has(value.reason) ? value.reason : 'unknown_evidence',
    checks: Object.freeze(Object.fromEntries(evidenceChecks.map(key => [key, value.checks?.[key] === true]))),
    shapes: Object.freeze(Object.fromEntries(evidenceShapeFields.map(key => [key, evidenceShapes.has(value.shapes?.[key]) ? value.shapes[key] : 'other']))),
  })
}

function contentTypeKind(header) {
  if (!header) return 'missing'
  const type = header.split(';', 1)[0].trim().toLowerCase()
  if (diagnosticTypes.has(type) && !['missing', 'other', 'application/*+json'].includes(type)) return type
  if (/^application\/[a-z0-9.-]+\+json(?![\s\S])/.test(type)) return 'application/*+json'
  // Never echo an arbitrary MIME subtype or charset; either can contain secrets.
  return 'other'
}

function diagnosticSnapshot(value) {
  if (!value || typeof value !== 'object' || typeof value.endpoint !== 'string' || !Object.hasOwn(smokeResponseLimits, value.endpoint)) return null
  return Object.freeze({ endpoint: value.endpoint,
    httpStatus: Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : null,
    contentType: diagnosticTypes.has(value.contentType) ? value.contentType : 'other',
    receivedBytes: Number.isSafeInteger(value.receivedBytes) && value.receivedBytes >= 0 ? value.receivedBytes : 0,
    limitBytes: smokeResponseLimits[value.endpoint],
  })
}

// Only immutable, constructor-sanitized facts are exposed. Public properties,
// Error.message/stack/cause and provider headers/bodies are never trusted.
export const smokeErrorDiagnostic = error => errorDiagnostics.get(error) ?? null
export const smokeEvidenceDiagnostic = error => errorEvidenceDiagnostics.get(error) ?? null

const prefix = 'MAIN_DULU_SCREENSCRAPER_'
const fields = ['ENABLED', 'DEV_ID', 'DEV_PASSWORD', 'USER', 'PASSWORD', 'SOFTNAME']
const required = ['DEV_ID', 'DEV_PASSWORD', 'USER', 'PASSWORD']
const messages = Object.freeze({
  USAGE: 'Gunakan npm run metadata:m0 -- --help. Secret tidak diterima sebagai argumen CLI.',
  SECRET_EXISTS: 'File secret lokal sudah ada; tidak ditimpa. Edit file tersebut sendiri.',
  SECRET_FILE: 'File secret lokal tidak dapat dibaca/ditulis dengan aman. Periksa format, izin, dan ukuran maksimum 64 KiB.',
  SECRET_FIELDS: 'File secret hanya boleh berisi enam variabel MAIN_DULU_SCREENSCRAPER yang didokumentasikan.',
  SECRET_MISSING: 'Empat kredensial DEV_ID, DEV_PASSWORD, USER, dan PASSWORD wajib diisi pada file lokal atau environment backend.',
  SECRET_INVALID: 'Kredensial harus berupa teks satu baris, tidak kosong, maksimum 4096 karakter. Nilainya tidak ditampilkan.',
  SOFTNAME: 'SOFTNAME hanya boleh huruf ASCII, angka, titik, minus, atau garis bawah, maksimum 80 karakter.',
  AUTO_SCAN: 'M0 mensyaratkan MAIN_DULU_SCREENSCRAPER_ENABLED=false. --live hanya menjalankan probe manual.',
  LOCKED: 'Probe M0 lain sedang berjalan atau lock tertinggal. Jangan jalankan bersama scan RomM; lihat panduan pemulihan lock.',
  LOCK_FILE: 'Lock probe M0 tidak dapat dikelola. Periksa izin folder proyek.',
  ROM_FILE: 'ROM tidak dapat dibaca dengan aman, kosong, berubah saat dibaca, atau melebihi 768 MiB.',
  ROM_FORMAT: 'Format ROM/console belum eligible untuk lookup hash M0. Arsip, CHD, dan format review tidak dikonversi.',
  CANCELLED: 'Pengujian dibatalkan. Tidak ada scan otomatis atau perubahan katalog.',
  TIMEOUT: 'Request ScreenScraper melewati batas waktu. Tidak dicoba ulang otomatis.',
  TRANSPORT: 'Koneksi ScreenScraper gagal atau redirect ditolak. Detail URL/error provider tidak ditampilkan.',
  RESPONSE: 'Respons ScreenScraper tidak sesuai kontrak. Tidak dicoba ulang otomatis.',
  RESPONSE_TYPE: 'Tipe konten respons bukan JSON yang diizinkan. Lihat diagnostik aman; body tidak ditampilkan.',
  RESPONSE_BODY: 'Respons ScreenScraper tidak menyediakan body stream yang dapat dibaca.',
  RESPONSE_SIZE: 'Respons melebihi batas byte endpoint. Stream dihentikan; tidak dicoba ulang otomatis.',
  RESPONSE_ENCODING: 'Respons JSON bukan UTF-8 yang valid. Body tidak ditampilkan.',
  RESPONSE_JSON: 'Body respons bukan JSON yang valid atau terpotong. Body tidak ditampilkan.',
  RESPONSE_ENVELOPE: 'JSON tidak memiliki object response sesuai kontrak ScreenScraper.',
  RESPONSE_REJECTED: 'Envelope JSON provider menyatakan gagal atau nilai success tidak dikenal. Pesan mentah provider tidak ditampilkan.',
  HTTP_400: 'ScreenScraper menolak parameter request (400).',
  HTTP_401: 'Akses anggota belum diterima atau API sedang ditutup untuk akun ini (401).',
  HTTP_403: 'ScreenScraper menolak kredensial/akses developer (403). Periksa secret dan persetujuan aplikasi.',
  HTTP_404: 'Game tidak ditemukan (404). Probe positif belum membuktikan kecocokan ROM.',
  HTTP_423: 'API ScreenScraper ditutup sementara (423).',
  HTTP_426: 'Identitas/versi aplikasi ditolak ScreenScraper (426).',
  HTTP_429: 'Laju/thread ScreenScraper dibatasi (429). Tunggu cooldown provider sebelum mencoba manual lagi.',
  HTTP_430: 'Kuota harian ScreenScraper habis (430). Jangan mencoba ulang sampai kuota pulih.',
  HTTP_431: 'Kuota pencarian tidak dikenal ScreenScraper habis (431). Jangan mencoba ulang sampai kuota pulih.',
  HTTP_OTHER: 'ScreenScraper mengembalikan kegagalan HTTP. Tidak dicoba ulang otomatis.',
  QUOTA: 'Data kuota tidak lengkap/tidak valid atau kuota sudah habis. Request berikutnya dihentikan.',
  SYSTEMS: 'Daftar sistem tidak cocok dengan tujuh ID M0. Kontrak perlu diperiksa tanpa membagikan respons mentah.',
  EVIDENCE: 'Hasil ROM belum memenuhi bukti kecocokan. Lihat step evidence untuk alasan dan boolean pemeriksaan; tidak ada metadata diterapkan.',
  NEGATIVE: 'Probe negatif tidak menghasilkan HTTP 404. Jangan menganggap respons ini bukti tidak ditemukan.',
  COVER_METADATA: 'Daftar cover tidak valid, terlalu banyak, atau ambigu pada region pilihan. Tidak ada fallback URL atau request media.',
  COVER_MISSING: 'Cover box-2D pada region yang didukung tidak tersedia (daftar kosong, NOMEDIA, atau HTTP 404). Bukan game tidak ditemukan.',
  COVER_TYPE: 'Respons cover bukan MIME PNG/JPEG/WebP yang diizinkan. Body dan header mentah tidak ditampilkan.',
  COVER_IMAGE: 'Cover gagal decode penuh, MIME tidak sesuai isi, beranimasi, atau melebihi 4096 × 4096 piksel.',
  FAILED: 'Probe M0 gagal. Detail internal/secret tidak ditampilkan.',
})

export class SmokeError extends Error {
  constructor(code, diagnostic, evidence) {
    const safeCode = typeof code === 'string' && Object.hasOwn(messages, code) ? code : 'FAILED'
    super(messages[safeCode])
    this.code = safeCode
    const snapshot = diagnosticSnapshot(diagnostic)
    if (snapshot) errorDiagnostics.set(this, snapshot)
    const evidenceInfo = safeCode === 'EVIDENCE' ? evidenceSnapshot(evidence) : null
    if (evidenceInfo) errorEvidenceDiagnostics.set(this, evidenceInfo)
  }
}
const fail = code => { throw new SmokeError(code) }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const checkAbort = signal => { if (signal?.aborted) fail('CANCELLED') }

export function parseSmokeOptions(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { command: 'help' }
  if (args.length === 1 && args[0] === 'init') return { command: 'init' }
  if (args[0] !== 'check') fail('USAGE')
  const result = { command: 'check', live: false, notFound: false }
  const seen = new Set()
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (seen.has(arg)) fail('USAGE')
    seen.add(arg)
    if (arg === '--live') result.live = true
    else if (arg === '--not-found') result.notFound = true
    else if (arg === '--cover') result.cover = true
    else if (arg === '--rom' || arg === '--console') {
      const value = args[++i]
      if (!value || value.startsWith('--')) fail('USAGE')
      result[arg === '--rom' ? 'romPath' : 'consoleId'] = value
    } else fail('USAGE')
  }
  if (!!result.romPath !== !!result.consoleId || ((result.romPath || result.notFound || result.cover) && !result.live)
    || ((result.notFound || result.cover) && !result.romPath)) fail('USAGE')
  return result
}

export async function initSmokeSecrets(root) {
  let file
  try {
    const template = await readFile(new URL('../../deploy/screenscraper-m0.env.example', import.meta.url), 'utf8')
    file = await open(join(root, smokeSecretName), 'wx', 0o600)
    await file.writeFile(template)
    await file.sync()
  } catch (error) { fail(error.code === 'EEXIST' ? 'SECRET_EXISTS' : 'SECRET_FILE') }
  finally { await file?.close() }
}

export async function readSmokeConfig({ root, env = process.env, version }) {
  let local = {}, file
  try {
    file = await openRegular(join(root, smokeSecretName))
    const buffer = Buffer.alloc(64 * 1024 + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 64 * 1024) fail('SECRET_FILE')
    local = parseEnv(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)))
  } catch (error) {
    if (error instanceof SmokeError) throw error
    if (error.code !== 'ENOENT') fail('SECRET_FILE')
  } finally { await file?.close() }
  if (Object.keys(local).some(key => !fields.some(field => key === prefix + field))) fail('SECRET_FIELDS')
  const values = Object.fromEntries(fields.map(field => [field, env[prefix + field] ?? local[prefix + field]]))
  if ((values.ENABLED ?? 'false') !== 'false') fail('AUTO_SCAN')
  if (required.some(field => values[field] === undefined || values[field] === '')) fail('SECRET_MISSING')
  if (required.some(field => typeof values[field] !== 'string' || !values[field].trim() || values[field].length > 4096 || /[\x00-\x1f\x7f]/.test(values[field]))) fail('SECRET_INVALID')
  const softname = values.SOFTNAME || `maindulu-${version}`
  if (typeof softname !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}(?![\s\S])/.test(softname)) fail('SOFTNAME')
  return Object.freeze({ devId: values.DEV_ID, devPassword: values.DEV_PASSWORD, user: values.USER, password: values.PASSWORD, softname })
}

export async function withSmokeLock(root, task) {
  const path = join(root, smokeLockName)
  let file, identity
  try {
    file = await open(path, 'wx', 0o600)
    identity = await file.stat()
    await file.writeFile(String(process.pid))
  } catch (error) {
    await file?.close()
    fail(error.code === 'EEXIST' ? 'LOCKED' : 'LOCK_FILE')
  }
  try { return await task() }
  finally {
    await file.close()
    // Never remove a lock which has been replaced by another process/operator.
    try {
      const current = await lstat(path)
      if (!current.isSymbolicLink() && current.ino === identity.ino && current.dev === identity.dev) await unlink(path)
    } catch { /* A stale own lock is safer than deleting an unknown file. */ }
  }
}

export async function fingerprintSmokeRom(path, consoleId, signal) {
  checkAbort(signal)
  const fileName = basename(path)
  try { safeOriginalName(fileName) } catch { fail('ROM_FILE') }
  if (!screenScraperTarget(consoleId, fileName).hashLookup) fail('ROM_FORMAT')
  let file
  try {
    file = await openRegular(path)
    const before = await file.stat()
    if (before.size < 1 || before.size > 768 * 1024 * 1024) fail('ROM_FILE')
    const md5 = createHash('md5'), sha1 = createHash('sha1'), sha256 = createHash('sha256')
    const buffer = Buffer.alloc(1024 * 1024)
    let size = 0, bytesRead
    while ((bytesRead = (await file.read(buffer, 0, buffer.length, size)).bytesRead)) {
      checkAbort(signal)
      size += bytesRead
      if (size > before.size) fail('ROM_FILE')
      const chunk = buffer.subarray(0, bytesRead)
      md5.update(chunk); sha1.update(chunk); sha256.update(chunk)
    }
    const after = await file.stat()
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('ROM_FILE')
    checkAbort(signal)
    return { consoleId, fileName, method: 'hash', size, md5: md5.digest('hex'), sha1: sha1.digest('hex'), sha256: sha256.digest('hex') }
  } catch (error) { if (error instanceof SmokeError) throw error; fail('ROM_FILE') }
  finally { await file?.close() }
}

const integer = value => {
  if (typeof value === 'string' && /^[0-9]{1,15}(?![\s\S])/.test(value)) value = Number(value)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}
const providerId = value => {
  if (Number.isSafeInteger(value) && value > 0) value = String(value)
  return typeof value === 'string' && /^[1-9][0-9]{0,19}(?![\s\S])/.test(value) ? value : undefined
}

export function smokeQuota(user) {
  if (!record(user)) fail('QUOTA')
  const names = ['maxthreads', 'requeststoday', 'requestskotoday', 'maxrequestsperday', 'maxrequestskoperday']
  const result = Object.fromEntries(names.map(name => [name, integer(user[name])]))
  const minuteLimits = ['maxrequestspermin', 'maxrequestsperdmin'].filter(name => Object.hasOwn(user, name)).map(name => integer(user[name]))
  if (Object.values(result).some(value => value === null) || !minuteLimits.length || minuteLimits.some(value => value === null)) fail('QUOTA')
  result.maxrequestspermin = Math.min(...minuteLimits)
  if (result.maxthreads < 1 || result.maxrequestspermin < 1 || result.requeststoday >= result.maxrequestsperday || result.requestskotoday >= result.maxrequestskoperday || result.requestskotoday > result.requeststoday) fail('QUOTA')
  return result
}

export function smokeSystems(systems) {
  if (!Array.isArray(systems) || systems.length > 2000 || systems.some(item => !record(item) || !providerId(item.id))) fail('SYSTEMS')
  const ids = new Set(systems.map(item => providerId(item.id)))
  if (ids.size !== systems.length || Object.values(screenScraperSystems).some(id => !ids.has(id))) fail('SYSTEMS')
  return { verifiedSystems: Object.keys(screenScraperSystems).length }
}

export function smokeRomEvidence(input, game) {
  const value = record(game) ? game : {}
  const rom = record(value.rom) ? value.rom : {}
  const candidate = { id: providerId(value.id), systemId: providerId(value.systeme?.id),
    notGame: [false, 'false', 0, '0'].includes(value.notgame) ? false : undefined,
    rom: { id: providerId(rom.id), size: integer(rom.romsize), md5: rom.rommd5, sha1: rom.romsha1, totalSupports: integer(rom.romtotalsupport) } }
  const has = (object, key) => Object.hasOwn(object, key)
  const shape = field => field === undefined ? 'missing' : field === null ? 'null' : Array.isArray(field) ? 'array'
    : ['object', 'string', 'boolean', 'number'].includes(typeof field) ? typeof field : 'other'
  const validHash = (field, length) => typeof field === 'string' && field.length === length && !/[^a-f0-9]/i.test(field)
  const hashMatches = (local, remote, length) => validHash(local, length) && validHash(remote, length) && local.toLowerCase() === remote.toLowerCase()
  const target = screenScraperTarget(input?.consoleId, input?.fileName)
  const reference = providerId(value.romid)
  const checks = {
    hasGame: record(game), gameIdValid: candidate.id !== undefined, systemIdValid: candidate.systemId !== undefined,
    systemMatches: target.systemId !== null && candidate.systemId !== undefined && candidate.systemId === target.systemId,
    notGameFieldPresent: has(value, 'notgame'), notGameConfirmedFalse: candidate.notGame === false,
    notGameConfirmedTrue: [true, 'true', 1, '1'].includes(value.notgame),
    hasMatchedRom: record(value.rom), hasRomsList: Array.isArray(value.roms), romIdValid: candidate.rom.id !== undefined,
    hasRomReference: value.romid !== undefined, romReferenceValid: reference !== undefined,
    romReferenceConsistent: value.romid === undefined || (reference !== undefined && candidate.rom.id !== undefined && reference === candidate.rom.id),
    supportCountPresent: has(rom, 'romtotalsupport'), singleSupport: candidate.rom.totalSupports === 1,
    sizeValid: candidate.rom.size !== null && candidate.rom.size > 0,
    sizeMatches: Number.isSafeInteger(input?.size) && input.size > 0 && candidate.rom.size === input.size,
    md5Present: has(rom, 'rommd5'), md5Valid: validHash(rom.rommd5, 32), md5Matches: hashMatches(input?.md5, rom.rommd5, 32),
    sha1Present: has(rom, 'romsha1'), sha1Valid: validHash(rom.romsha1, 40), sha1Matches: hashMatches(input?.sha1, rom.romsha1, 40),
  }
  const shapes = {
    game: shape(game), matchedRom: shape(value.rom), romReference: shape(value.romid), system: shape(value.systeme), notGame: shape(value.notgame),
    supportCount: shape(rom.romtotalsupport), size: shape(rom.romsize), md5: shape(rom.rommd5), sha1: shape(rom.romsha1),
  }
  const assessment = assessScreenScraperEvidence(input, [candidate])
  if (!checks.hasGame || !checks.hasMatchedRom || !assessment.verified) {
    const reason = !checks.hasGame ? 'missing_game' : !checks.hasMatchedRom ? 'missing_matched_rom' : assessment.reason
    throw new SmokeError('EVIDENCE', undefined, { reason, checks, shapes })
  }
  // WebAPI v2 describes jeu.rom as the scraped ROM and roms as the game's
  // broader list. The duplicate top-level romid is auxiliary: never substitute
  // it for rom.id, unwrap it, or let it hide failed primary evidence. A warning
  // preserves the anomaly without inventing an API equality guarantee. See M0 §11.
  const warnings = Object.freeze(checks.romReferenceConsistent ? [] : [evidenceSnapshot({
    reason: checks.romReferenceValid ? 'rom_reference_mismatch' : 'rom_reference_invalid', checks, shapes,
  })])
  return { verified: true, warnings, metadataShape: {
    names: Array.isArray(game.noms), synopsis: Array.isArray(game.synopsis), dates: Array.isArray(game.dates),
    genres: Array.isArray(game.genres), media: Array.isArray(game.medias),
    preferredNameListed: Array.isArray(game.noms) && game.noms.some(name => record(name) && screenScraperPreferences.regions.includes(name.region)
      && typeof name.text === 'string' && name.text.trim().length > 0 && name.text.length <= limits.maxTitleLength),
    preferredSynopsisListed: Array.isArray(game.synopsis) && game.synopsis.some(text => record(text) && screenScraperPreferences.languages.includes(text.langue)
      && typeof text.text === 'string' && text.text.trim().length > 0 && text.text.length <= limits.maxDescriptionLength),
    frontCoverListed: Array.isArray(game.medias) && game.medias.some(media => record(media) && media.type === 'box-2D'),
  } }
}

function smokeCoverSelection(input, game) {
  // Never derive a media request from an unverified game or use a roms entry.
  smokeRomEvidence(input, game)
  if (!Array.isArray(game.medias) || game.medias.length > limits.maxMediaEntries || game.medias.some(media => !record(media))) fail('COVER_METADATA')
  for (const region of screenScraperPreferences.regions) {
    const matches = game.medias.filter(media => media.type === 'box-2D' && media.region === region)
    if (!matches.length) continue
    if (matches.length !== 1) fail('COVER_METADATA')
    // Only the allowlisted type/region and verified game/system IDs are used.
    // Provider URLs, query strings, IDs, format hints and overrides are ignored.
    return { region, params: { systemeid: providerId(game.systeme.id), jeuid: providerId(game.id), media: `box-2D(${region})` } }
  }
  fail('COVER_MISSING')
}

export async function smokeCoverBytes(bytes, contentType, signal) {
  checkAbort(signal)
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > limits.coverBytes) fail('COVER_IMAGE')
  const formats = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' }
  if (!Object.hasOwn(formats, contentType)) fail('COVER_TYPE')
  const image = sharp(bytes, { limitInputPixels: limits.coverMaxDimension ** 2, animated: true, failOn: 'warning' })
    .timeout({ seconds: Math.ceil(limits.requestTimeoutMs / 1000) })
  const abort = () => image.destroy()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const meta = await image.metadata()
    if (meta.format !== formats[contentType] || !meta.width || !meta.height || meta.width > limits.coverMaxDimension
      || meta.height > limits.coverMaxDimension || (meta.pages ?? 1) !== 1) fail('COVER_IMAGE')
    if (meta.format === 'png') {
      // libvips may expose only APNG's first frame. Mirror upload validation.
      for (let offset = 8; offset < bytes.length;) {
        if (offset + 12 > bytes.length) fail('COVER_IMAGE')
        const length = bytes.readUInt32BE(offset)
        if (length > bytes.length - offset - 12 || bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') fail('COVER_IMAGE')
        offset += 12 + length
      }
    }
    checkAbort(signal)
    await image.raw().toBuffer() // Metadata/signature alone does not prove a complete image.
    checkAbort(signal)
    return { verified: true, contentType, receivedBytes: bytes.length, width: meta.width, height: meta.height,
      decoded: true, stored: false, rightsVerified: false }
  } catch { checkAbort(signal); fail('COVER_IMAGE') }
  finally { signal?.removeEventListener('abort', abort); image.destroy() }
}

function createProbeTransport(config, { fetcher, timeoutMs, signal }) {
  return async (endpoint, params = {}, allowNotFound = false) => {
    checkAbort(signal)
    if (!Object.hasOwn(smokeResponseLimits, endpoint)) fail('USAGE')
    const isCover = endpoint === 'mediaJeu.php'
    const diagnostic = { endpoint, httpStatus: null, contentType: 'missing', receivedBytes: 0 }
    const responseLimit = smokeResponseLimits[endpoint]
    const url = new URL(endpoint, 'https://api.screenscraper.fr/api2/')
    for (const [key, value] of Object.entries({ devid: config.devId, devpassword: config.devPassword, softname: config.softname,
      ssid: config.user, sspassword: config.password, ...(isCover ? {} : { output: 'json' }), ...params })) url.searchParams.set(key, String(value))
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    let timer, reader, response
    const operation = async () => {
      response = await fetcher(url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { Accept: isCover ? 'image/png, image/jpeg, image/webp' : 'application/json' }, referrerPolicy: 'no-referrer', signal: controller.signal })
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {})
        controller.signal.throwIfAborted()
      }
      controller.signal.throwIfAborted()
      diagnostic.httpStatus = response.status
      diagnostic.contentType = contentTypeKind(response.headers.get('content-type'))
      if (response.redirected) fail('TRANSPORT')
      if (response.url && response.url !== url.href) fail('TRANSPORT')
      if (isCover && response.status === 404) fail('COVER_MISSING')
      if (response.status === 404 && allowNotFound) return { notFound: true }
      if (!response.ok) fail(Object.hasOwn(messages, `HTTP_${response.status}`) ? `HTTP_${response.status}` : 'HTTP_OTHER')
      if (isCover) {
        if (response.status !== 200) fail('COVER_IMAGE')
        if (!['image/png', 'image/jpeg', 'image/webp', 'text/plain'].includes(diagnostic.contentType)) fail('COVER_TYPE')
      } else if (!['application/json', 'application/*+json', 'text/json'].includes(diagnostic.contentType)) fail('RESPONSE_TYPE')
      if (!response.body?.getReader) fail('RESPONSE_BODY')
      reader = response.body.getReader()
      const chunks = []
      let size = 0
      while (true) {
        const { value, done } = await reader.read()
        controller.signal.throwIfAborted()
        if (done) break
        size += value.byteLength
        diagnostic.receivedBytes = size
        if (size > responseLimit) fail('RESPONSE_SIZE')
        chunks.push(Buffer.from(value))
      }
      const bytes = Buffer.concat(chunks)
      if (isCover) {
        if (bytes.length <= 64 && bytes.toString('utf8').trim() === 'NOMEDIA') fail('COVER_MISSING')
        return { cover: await smokeCoverBytes(bytes, diagnostic.contentType, controller.signal) }
      }
      let text, envelope
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail('RESPONSE_ENCODING') }
      try { envelope = JSON.parse(text) } catch { fail('RESPONSE_JSON') }
      if (!record(envelope) || !record(envelope.response)) fail('RESPONSE_ENVELOPE')
      if (envelope.header?.success !== undefined && ![true, 'true'].includes(envelope.header.success)) fail('RESPONSE_REJECTED')
      return envelope.response
    }
    try {
      return await Promise.race([operation(), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new SmokeError('TIMEOUT')) }, timeoutMs)
      }), new Promise((_, reject) => {
        // Cancellation also terminates a transport/body which ignores AbortSignal.
        controller.signal.addEventListener('abort', () => reject(new SmokeError(signal?.aborted ? 'CANCELLED' : 'TIMEOUT')), { once: true })
      })])
    } catch (error) {
      throw new SmokeError(signal?.aborted ? 'CANCELLED' : error instanceof SmokeError ? error.code : 'TRANSPORT', diagnostic)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      controller.abort()
      if (reader) void reader.cancel().catch(() => {}).finally(() => { try { reader.releaseLock() } catch { /* pending read */ } })
      else if (response?.body) void response.body.cancel().catch(() => {})
    }
  }
}

export async function runSmokeProbe(config, options, { fetcher = globalThis.fetch, wait = delay, signal,
  timeoutMs = limits.requestTimeoutMs, onStep = () => {} } = {}) {
  const report = { format: 'maindulu-screenscraper-m0-v1', automaticScan: false, live: options.live === true, requests: 0 }
  checkAbort(signal)
  if (options.cover && (!options.live || !options.romPath || !options.consoleId)) fail('USAGE')
  if (!options.live) return { ...report, configuration: 'valid' }
  const input = options.romPath ? await fingerprintSmokeRom(options.romPath, options.consoleId, signal) : null
  const transport = createProbeTransport(config, { fetcher, timeoutMs, signal })
  let quota, remaining, negativeRemaining
  async function request(endpoint, params, allowNotFound) {
    if (quota) {
      if (remaining < 1 || negativeRemaining < 1) fail('QUOTA')
      // Space requests after the previous response; slower than a start-to-start cap.
      try { await wait(Math.max(limits.minRequestIntervalMs, Math.ceil(60000 / quota.maxrequestspermin)), undefined, { signal }) }
      catch { fail('CANCELLED') }
      checkAbort(signal)
      remaining--; if (endpoint === 'jeuInfos.php') negativeRemaining--
    }
    report.requests++
    const data = await transport(endpoint, params, allowNotFound)
    if (data.ssuser !== undefined) {
      const latest = smokeQuota(data.ssuser)
      remaining = Math.min(remaining ?? Infinity, latest.maxrequestsperday - latest.requeststoday)
      negativeRemaining = Math.min(negativeRemaining ?? Infinity, latest.maxrequestskoperday - latest.requestskotoday)
      // Never speed up within one probe when snapshots disagree.
      quota = quota ? { ...latest, maxrequestspermin: Math.min(quota.maxrequestspermin, latest.maxrequestspermin) } : latest
    }
    return data
  }
  const account = await request('ssuserInfos.php')
  if (!quota) fail('QUOTA')
  report.account = { verified: true, quota: smokeQuota(account.ssuser) }
  onStep({ step: 'account', ...report.account })
  report.systems = smokeSystems((await request('systemesListe.php')).systemes)
  onStep({ step: 'systems', ...report.systems })
  const paramsFor = fingerprint => ({ systemeid: screenScraperTarget(fingerprint.consoleId, fingerprint.fileName).systemId,
    romtype: 'rom', romnom: fingerprint.fileName, romtaille: fingerprint.size, md5: fingerprint.md5, sha1: fingerprint.sha1 })
  let matchedGame
  if (input) {
    matchedGame = (await request('jeuInfos.php', paramsFor(input))).jeu
    report.rom = smokeRomEvidence(input, matchedGame)
    onStep({ step: 'rom', ...report.rom })
  }
  if (options.notFound) {
    const bytes = randomBytes(64)
    const negative = { ...input, fileName: `maindulu-m0-unmatched-${randomBytes(8).toString('hex')}.${input.fileName.split('.').at(-1)}`,
      size: bytes.length, md5: createHash('md5').update(bytes).digest('hex'), sha1: createHash('sha1').update(bytes).digest('hex') }
    const data = await request('jeuInfos.php', paramsFor(negative), true)
    if (!data.notFound) fail('NEGATIVE')
    report.notFound = { verified: true, httpStatus: 404 }
    onStep({ step: 'not_found', ...report.notFound })
  }
  if (options.cover) {
    const selection = smokeCoverSelection(input, matchedGame)
    const data = await request('mediaJeu.php', selection.params)
    report.cover = { ...data.cover, endpoint: 'mediaJeu.php', fixedOrigin: true, providerUrlFollowed: false,
      type: 'box-2D', region: selection.region }
    onStep({ step: 'cover', ...report.cover })
  }
  return report
}
