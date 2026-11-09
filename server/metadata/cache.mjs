import { createHash } from 'node:crypto'
import { transaction } from '../auth/mutations.mjs'
import { screenScraperLimits as limits, screenScraperPreferences } from './screenscraper-policy.mjs'
import { cleanRomName } from './screenscraper.mjs'

const version = 2
const preferences = JSON.stringify(screenScraperPreferences)
// No account credentials, raw URLs or response envelopes enter the cache.
export function metadataCacheKey(systemId, hashes, fileName, query) {
  const fingerprint = createHash('sha256').update(JSON.stringify([hashes.size, hashes.md5, hashes.sha1, cleanRomName(fileName), query ?? null])).digest('hex')
  return { key: createHash('sha256').update(JSON.stringify([systemId, fingerprint, preferences, version])).digest('hex'), systemId, fingerprint }
}

// Serial lookups deliberately use a separate namespace so an old hash/name
// cache entry can never be mistaken for serial evidence.
export function metadataSerialCacheKey(systemId, serial, fileName) {
  const fingerprint = createHash('sha256').update(JSON.stringify(['serial', serial, cleanRomName(fileName)])).digest('hex')
  return { key: createHash('sha256').update(JSON.stringify([systemId, fingerprint, preferences, version])).digest('hex'), systemId, fingerprint }
}

export function readMetadataCache(db, key, now = Date.now()) {
  const row = db.prepare('SELECT * FROM provider_cache WHERE cache_key = ? AND expires_at > ? AND normalization_version = ?').get(key.key, now, version)
  if (!row) return null
  try {
    const value = JSON.parse(row.payload)
    if (value.systemId !== key.systemId || !['hash', 'name', 'serial'].includes(value.method) || !Array.isArray(value.candidates) || value.candidates.length > limits.maxCandidates) return null
    return value
  } catch { return null }
}

export function writeMetadataCache(db, key, result, now = Date.now()) {
  const payload = JSON.stringify({ method: result.method, systemId: result.systemId, candidates: result.candidates })
  const bytes = Buffer.byteLength(payload)
  if (bytes > limits.responseBytes) return
  const negative = result.candidates.length === 0
  transaction(db, () => {
    db.prepare('DELETE FROM provider_cache WHERE expires_at <= ? OR normalization_version != ?').run(now, version)
    db.prepare(`INSERT OR REPLACE INTO provider_cache VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(key.key, key.systemId, key.fingerprint, 'm0-fixed', version, payload,
        now + (negative ? limits.negativeCacheTtlMs : limits.positiveCacheTtlMs), Number(negative), bytes, now, now)
    while (true) {
      const size = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM provider_cache').get()
      if (size.n <= limits.maxCacheEntries && size.bytes <= limits.maxCacheBytes) break
      db.prepare('DELETE FROM provider_cache WHERE cache_key = (SELECT cache_key FROM provider_cache ORDER BY updated_at, cache_key LIMIT 1)').run()
    }
  })
}

export function pruneMetadata(db, now = Date.now()) {
  transaction(db, () => {
    db.prepare('DELETE FROM provider_cache WHERE expires_at <= ?').run(now)
    db.prepare('UPDATE metadata_jobs SET candidate_json = NULL, candidate_at = NULL WHERE candidate_at < ? AND status NOT IN (\'queued\', \'running\', \'retry_wait\')').run(now - limits.reviewRetentionMs)
    // Keep the newest generation (including tombstones) as a fencing token.
    db.prepare(`DELETE FROM metadata_jobs WHERE updated_at < ? AND status NOT IN ('queued', 'running', 'retry_wait')
      AND generation < (SELECT MAX(j.generation) FROM metadata_jobs j WHERE j.game_id = metadata_jobs.game_id)`)
      .run(now - limits.terminalJobRetentionMs)
  })
}
