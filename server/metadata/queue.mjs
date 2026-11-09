import { randomUUID } from 'node:crypto'
import { transaction } from '../auth/mutations.mjs'
import { CatalogHttpError, invalidCatalog } from '../catalog/errors.mjs'
import { getScreenScraperConfigStatus, resolveScreenScraperSystem } from './screenscraper.mjs'
import { screenScraperLimits } from './screenscraper-policy.mjs'
import { metadataPreview } from './apply.mjs'
import { candidateTarget, isIdentifiableZip } from './identification.mjs'

// Schema-9 catalogs predate metadata rows. Initialize only on explicit admin
// inspection/scan, preserving historical values as manual, never enqueue here.
function ensureLegacyMetadata(db, game) {
  const now = Date.now()
  const inserted = db.prepare(`INSERT OR IGNORE INTO game_metadata (game_id, metadata_revision, created_at, updated_at)
    SELECT id, 1, ?, ? FROM games WHERE id = ? AND deleted_at IS NULL`).run(now, now, game.id)
  if (inserted.changes) {
    for (const field of ['title', 'description', 'cover']) {
      db.prepare(`INSERT OR IGNORE INTO game_metadata_field_sources (game_id, field, source, locked, updated_at)
        VALUES (?, ?, 'manual', 1, ?)`).run(game.id, field, now)
    }
    db.prepare('UPDATE catalog_revision SET revision = revision + 1 WHERE id = 1').run()
  }
}

export function storedCandidates(job, game) {
  if (!job || job.asset_fingerprint !== `${game.sha256}:${game.size}` || !job.candidate_at || Date.now() - job.candidate_at > screenScraperLimits.reviewRetentionMs) return []
  try {
    const payload = JSON.parse(job.candidate_json)
    const target = candidateTarget(game.console_id, game.original_name, payload.identification)
    return Array.isArray(payload.candidates) ? payload.candidates.slice(0, screenScraperLimits.maxCandidates)
      .filter(c => c && /^[1-9][0-9]{0,19}$/.test(c.id) && c.systemId === target.systemId && c.notGame === false && c.metadata) : []
  } catch { return [] }
}

export function metadataDetail(db, game) {
  if (!db.prepare('SELECT 1 FROM game_metadata WHERE game_id = ?').get(game.id)) transaction(db, () => ensureLegacyMetadata(db, game))
  const job = db.prepare('SELECT * FROM metadata_jobs WHERE game_id = ? ORDER BY generation DESC LIMIT 1').get(game.id)
  const candidates = storedCandidates(job, game)
  const matchMethod = db.prepare('SELECT match_method FROM game_metadata WHERE game_id = ?').get(game.id)?.match_method ?? null
  return { gameId: game.id, generation: job?.generation ?? null, status: job?.status ?? 'disabled',
    cooldownUntil: db.prepare('SELECT next_at FROM metadata_provider_state WHERE id = 1').get().next_at,
    phase: job?.phase ?? null, reason: job?.error_code ?? null, attempts: job?.attempts ?? 0, matchMethod,
    nextAt: job && ['retry_wait', 'failed', 'not_found', 'paused'].includes(job.status) ? job.next_at : null,
    updatedAt: job?.updated_at ?? null, preview: metadataPreview(db, game.id, candidates[0]),
    candidates: candidates.map(c => ({ id: c.id, systemId: c.systemId, title: c.metadata.title || 'Tanpa judul',
      preview: metadataPreview(db, game.id, c) })) }
}

export function enqueueMetadata(db, config, game, { method = 'hash', query, candidateId, generation, expectedRevision, fields, replaceLocked = true } = {}, authorize = () => {}) {
  return transaction(db, () => {
    authorize()
    const ready = getScreenScraperConfigStatus(config.screenscraper)
    if (!ready.ready) throw new CatalogHttpError(409, 'METADATA_DISABLED', ready.enabled ? 'Konfigurasi ScreenScraper belum lengkap.' : 'Fitur metadata ScreenScraper nonaktif.')
    if (typeof replaceLocked !== 'boolean') throw invalidCatalog('Pilihan penerapan scan tidak valid.')
    ensureLegacyMetadata(db, game)
    const latest = db.prepare('SELECT * FROM metadata_jobs WHERE game_id = ? ORDER BY generation DESC LIMIT 1').get(game.id)
    const now = Date.now()
    const gate = db.prepare('SELECT * FROM metadata_provider_state WHERE id = 1').get()
    if (latest && ['queued', 'running', 'retry_wait'].includes(latest.status)) return { gameId: game.id, generation: latest.generation, status: latest.status }
    if (gate.next_at > now || (latest && (latest.status === 'failed' || latest.status === 'not_found' && method === 'hash') && latest.next_at > now)) throw new CatalogHttpError(429, 'METADATA_COOLDOWN', 'Scan dibatasi sementara. Tunggu jadwal percobaan berikutnya.')
    if (db.prepare("SELECT COUNT(*) AS n FROM metadata_jobs WHERE status IN ('queued', 'running', 'retry_wait')").get().n >= screenScraperLimits.maxQueuedJobs) throw new CatalogHttpError(429, 'METADATA_QUEUE_FULL', 'Antrean metadata penuh. Coba lagi nanti.')
    let request = null, payload = null
    if (method === 'hash') {
      // Explicit rescans may replace existing overrides, but never edits made
      // after the administrator queued this scan (even before a worker starts).
      request = { replaceLocked, expectedRevision: db.prepare('SELECT metadata_revision FROM game_metadata WHERE game_id = ?').get(game.id).metadata_revision }
    }
    if (method === 'name') {
      if (typeof query !== 'string' || !query.trim() || query.length > 200 || /[\x00-\x1f\x7f]/.test(query)) throw invalidCatalog('Isi nama pencarian, maksimum 200 karakter tanpa karakter kontrol.')
      if (!resolveScreenScraperSystem(game.console_id, game.original_name).systemId && !isIdentifiableZip(game.console_id, game.original_name)) throw invalidCatalog('Sistem berkas ini belum dapat dipastikan; pencarian nama belum didukung.')
      request = { query: query.trim() }
    }
    if (method === 'apply') {
      if (!Number.isSafeInteger(generation) || latest?.generation !== generation || !['needs_review', 'succeeded'].includes(latest.status)) throw new CatalogHttpError(409, 'METADATA_CONFLICT', 'Kandidat tidak lagi berlaku. Muat ulang preview.')
      const candidate = storedCandidates(latest, game).find(c => c.id === candidateId)
      if (!candidate || !Number.isSafeInteger(expectedRevision) || db.prepare('SELECT metadata_revision FROM game_metadata WHERE game_id = ?').get(game.id)?.metadata_revision !== expectedRevision) throw new CatalogHttpError(409, 'METADATA_CONFLICT', 'Metadata atau kandidat berubah. Muat ulang preview.')
      const allowed = ['title', 'description', 'releaseDate', 'genre', 'developer', 'publisher', 'players', 'regionLanguage', 'cover']
      if (!Array.isArray(fields) || !fields.length || fields.length > 9 || new Set(fields).size !== fields.length || fields.some(f => !allowed.includes(f))) throw invalidCatalog('Pilih field metadata yang valid.')
      request = { candidateId, expectedRevision, fields }
      const previous = JSON.parse(latest.candidate_json)
      payload = JSON.stringify({ candidates: [candidate], method: 'manual', systemId: candidate.systemId,
        identification: previous.identification, fingerprint: previous.fingerprint })
    }
    const nextGeneration = (latest?.generation ?? 0) + 1
    // An explicit admin retry can resume an authentication pause, never a cooldown.
    db.prepare('UPDATE metadata_provider_state SET paused_reason = NULL WHERE id = 1').run()
    db.prepare(`INSERT INTO metadata_jobs (id, game_id, asset_fingerprint, generation, phase, status, next_at, created_at, updated_at, request_method, request_json, candidate_json, candidate_at)
      VALUES (?, ?, ?, ?, 'identifying', 'queued', ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), game.id, `${game.sha256}:${game.size}`, nextGeneration, now, now, now, method, request ? JSON.stringify(request) : null, payload, payload ? now : null)
    db.prepare('UPDATE catalog_revision SET revision = revision + 1 WHERE id = 1').run()
    return { gameId: game.id, generation: nextGeneration, status: 'queued' }
  })
}
