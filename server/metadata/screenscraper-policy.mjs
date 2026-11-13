// M0: pure decisions only. Not registered in the app, no network or credentials.
// M2 must normalize provider responses before calling the evidence gate.
export const screenScraperSystems = Object.freeze({
  nes: '3', snes: '4', gb: '9', gbc: '10', gba: '12', megadrive: '1', psx: '57',
})

export const screenScraperPreferences = Object.freeze({
  regions: Object.freeze(['wor', 'us', 'eu', 'jp', 'ss']),
  languages: Object.freeze(['en', 'fr', 'ja']),
  coverTypes: Object.freeze(['box-2D']),
})

// Local ceilings, NOT provider entitlements. Effective limits must also respect
// live ssuser quotas, Retry-After, operator approval and shared worker cooldowns.
export const screenScraperLimits = Object.freeze({
  concurrentRequests: 1,
  minRequestIntervalMs: 1000,
  requestTimeoutMs: 20000,
  responseBytes: 2 * 1024 * 1024,
  maxCandidates: 30,
  maxMediaEntries: 1000,
  maxGenres: 20,
  maxTitleLength: 200,
  maxDescriptionLength: 10000,
  maxCompanyLength: 200,
  maxPlayersLength: 32,
  maxUrlLength: 4096,
  positiveCacheTtlMs: 7 * 24 * 60 * 60 * 1000,
  negativeCacheTtlMs: 24 * 60 * 60 * 1000,
  maxCacheEntries: 1000,
  maxCacheBytes: 32 * 1024 * 1024,
  maxQueuedJobs: 1000,
  terminalJobRetentionMs: 30 * 24 * 60 * 60 * 1000,
  reviewRetentionMs: 30 * 24 * 60 * 60 * 1000,
  maxAttempts: 4,
  retryBaseMs: 30000,
  retryMaxMs: 15 * 60 * 1000,
  coverBytes: 8 * 1024 * 1024,
  coverMaxDimension: 4096,
})

// Extension eligibility is not proof of a valid ROM or of provider coverage.
// Never pass a container to this raw evidence gate. M7's bounded ZIP identifier
// supplies the member basename and fingerprint separately. A plain `.smc` is
// eligible only after identification.mjs normalizes its 512-byte copier header;
// this policy module itself performs no I/O, header stripping or byte swapping.
const formats = Object.freeze({
  nes: Object.freeze({ raw: ['nes'], review: ['fds', 'unf', 'unif'] }),
  snes: Object.freeze({ raw: ['sfc', 'smc'], review: ['fig', 'swc'] }),
  gb: Object.freeze({ raw: ['gb', 'gbc'], review: [] }),
  gba: Object.freeze({ raw: ['gba'], review: [] }),
  megadrive: Object.freeze({ raw: ['md', 'gen', 'bin'], review: ['smd'] }),
  psx: Object.freeze({ raw: [], review: ['bin', 'cue', 'chd', 'pbp', 'iso'] }),
})
const archives = new Set(['zip', '7z', 'rar'])

export function screenScraperTarget(consoleId, fileName) {
  if (!Object.hasOwn(formats, consoleId) || typeof fileName !== 'string' || !fileName || fileName.length > 240 || /[/\\\x00-\x1f\x7f]/.test(fileName)) {
    return { systemId: null, hashLookup: false, reason: 'invalid_target' }
  }
  const ext = fileName.includes('.') ? fileName.split('.').at(-1).toLowerCase() : ''
  if (archives.has(ext)) {
    // GB archives do not tell us whether the member is .gb or .gbc.
    return { systemId: consoleId === 'gb' ? null : screenScraperSystems[consoleId], hashLookup: false, reason: 'archive_requires_review' }
  }
  const format = formats[consoleId]
  if (!format.raw.includes(ext) && !format.review.includes(ext)) return { systemId: null, hashLookup: false, reason: 'invalid_target' }
  // FDS is a separate provider platform, not NES. Do not silently query NES.
  if (ext === 'fds') return { systemId: null, hashLookup: false, reason: 'format_requires_review' }
  const systemId = consoleId === 'gb' && ext === 'gbc' ? screenScraperSystems.gbc : screenScraperSystems[consoleId]
  return { systemId, hashLookup: format.raw.includes(ext), reason: format.raw.includes(ext) ? 'raw_candidate' : 'format_requires_review' }
}

const hex = (value, length) => typeof value === 'string' && value.length === length && !/[^a-f0-9]/i.test(value)
const identifier = value => typeof value === 'string' && /^[1-9][0-9]{0,19}(?![\s\S])/.test(value)
const review = reason => ({ verified: false, reason })

// Disc serials are shared with the provider; keep one canonical, fail-closed
// representation. Control characters, whitespace, dots and underscores are
// rejected rather than silently converted.
export function normalizeSerial(value) {
  if (typeof value !== 'string') return null
  // Reject surrounding whitespace and control characters instead of silently
  // canonicalizing malformed probe/provider output.
  if (value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) return null
  const serial = value.toUpperCase()
  return /^[A-Z0-9-]{4,32}$/.test(serial) && /[0-9]/.test(serial) ? serial : null
}

// Input: server-computed fingerprint plus consoleId/fileName/method.
// Candidates: normalized [{ id, systemId, notGame, rom: { id, size, md5,
// sha1, totalSupports } }]. rom MUST come from the matched jeu.rom, never roms.
// verified is evidence eligibility only, not permission to overwrite any field.
export function assessScreenScraperEvidence(input, candidates) {
  if (!input || typeof input !== 'object') return review('invalid_input')
  if (input.method !== 'hash') return review('manual_lookup')
  const target = screenScraperTarget(input.consoleId, input.fileName)
  if (!target.hashLookup) return review(target.reason)
  if (!Number.isSafeInteger(input.size) || input.size < 1 || !hex(input.md5, 32) || !hex(input.sha1, 40)) return review('invalid_fingerprint')
  if (!Array.isArray(candidates) || candidates.length !== 1) return review('non_unique_result')
  const game = candidates[0]
  if (!game || !identifier(game.id) || game.systemId !== target.systemId || game.notGame !== false) return review('unconfirmed_game')
  const rom = game.rom
  if (!rom || !identifier(rom.id) || rom.totalSupports !== 1) return review('unconfirmed_rom')
  if (!Number.isSafeInteger(rom.size) || rom.size !== input.size) return review('size_mismatch')
  if (!hex(rom.md5, 32) || !hex(rom.sha1, 40)) return review('missing_hash_evidence')
  if (rom.md5.toLowerCase() !== input.md5.toLowerCase() || rom.sha1.toLowerCase() !== input.sha1.toLowerCase()) return review('hash_mismatch')
  return { verified: true, reason: 'exact_rom' }
}

// CHD PS1 serial evidence deliberately differs from the raw/ZIP hash gate:
// one provider candidate for a validated disc serial is accepted without an
// inner-disc hash. The candidate must still be a confirmed game on PS1 and
// must not advertise a different multi-support ROM. A missing `rom` object is
// not a failure because the provider may omit it for serial lookups.
export function assessChdSerialEvidence(input, candidates) {
  if (!input || typeof input !== 'object') return review('invalid_target')
  if (input.method !== 'serial') return review('manual_lookup')
  if (input.consoleId !== 'psx' || typeof input.fileName !== 'string' || !/\.chd$/i.test(input.fileName)) return review('invalid_target')
  const target = screenScraperTarget(input.consoleId, input.fileName)
  if (!target.systemId || target.hashLookup || target.reason !== 'format_requires_review') return review('invalid_target')
  if (!normalizeSerial(input.serial)) return review('invalid_serial')
  if (!Array.isArray(candidates) || candidates.length !== 1) return review('non_unique_result')
  const game = candidates[0]
  if (!game || !identifier(game.id) || game.notGame !== false) return review('unconfirmed_game')
  if (game.systemId !== target.systemId) return review('system_mismatch')
  const rom = game.rom
  if (rom && typeof rom === 'object' && Number.isSafeInteger(rom.totalSupports) && rom.totalSupports !== 1) return review('unconfirmed_rom')
  return { verified: true, reason: 'serial_unique' }
}
