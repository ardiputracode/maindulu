import { transaction } from '../auth/mutations.mjs'
import { enqueueCleanup } from '../catalog/maintenance.mjs'
import { screenScraperLimits } from './screenscraper-policy.mjs'

const textFields = Object.freeze({
  title: ['games', 'title', screenScraperLimits.maxTitleLength],
  description: ['games', 'description', screenScraperLimits.maxDescriptionLength],
  releaseDate: ['game_metadata', 'release_date', 32],
  genre: ['game_metadata', 'genre', 200],
  developer: ['game_metadata', 'developer', 200],
  publisher: ['game_metadata', 'publisher', 200],
  players: ['game_metadata', 'players', 32],
  regionLanguage: ['game_metadata', 'region_language', 64],
})
const sourceField = field => ({ releaseDate: 'release_date', regionLanguage: 'region_language' })[field] ?? field

export function metadataPreview(db, gameId, candidate) {
  const game = db.prepare('SELECT * FROM games WHERE id = ? AND deleted_at IS NULL').get(gameId)
  const meta = db.prepare('SELECT * FROM game_metadata WHERE game_id = ?').get(gameId)
  if (!game || !meta) return null
  const sources = new Map(db.prepare('SELECT field, source, locked FROM game_metadata_field_sources WHERE game_id = ?').all(gameId).map(row => [row.field, row]))
  const fields = {}
  for (const [field, [table, column, max]] of Object.entries(textFields)) {
    const value = candidate?.metadata?.[field]
    const current = (table === 'games' ? game : meta)[column]
    const source = sources.get(sourceField(field))
    fields[field] = { current, proposed: typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null,
      locked: source ? source.locked === 1 : (field === 'title' || field === 'description' ? true : !!current), source: source?.source ?? 'manual' }
  }
  const coverSource = sources.get('cover')
  fields.cover = { current: !!game.cover_storage_key, proposed: candidate?.metadata?.media?.some(m => m.type === 'box-2D') ? true : null,
    locked: coverSource ? coverSource.locked === 1 : !!game.cover_storage_key, source: coverSource?.source ?? 'manual' }
  return { revision: meta.metadata_revision, fields }
}

// All checks and writes are in one short SQLite transaction. A stale lease,
// generation, asset, revision or override cannot publish metadata or a cover.
export function applyVerifiedMetadata(db, storage, { job, candidate, expectedRevision, cover = null, selectedFields = null, manual = false, authorize = () => {} }) {
  if (selectedFields !== null && (!Array.isArray(selectedFields) || !selectedFields.length || selectedFields.some(f => f !== 'cover' && !Object.hasOwn(textFields, f)))) throw new Error('Field metadata tidak valid.')
  if (cover && (!storage.ownsFile(cover.file, 'covers') || !['image/png', 'image/jpeg', 'image/webp'].includes(cover.type))) throw new Error('Cover tidak aman.')
  return transaction(db, () => {
    authorize()
    const latest = db.prepare('SELECT * FROM metadata_jobs WHERE id = ?').get(job.id)
    const generation = db.prepare('SELECT MAX(generation) AS value FROM metadata_jobs WHERE game_id = ?').get(job.game_id).value
    const game = db.prepare('SELECT * FROM games WHERE id = ? AND deleted_at IS NULL').get(job.game_id)
    const meta = db.prepare('SELECT * FROM game_metadata WHERE game_id = ?').get(job.game_id)
    const workerClaim = job.lease_token !== null
    if (!latest || (workerClaim ? latest.status !== 'running' || latest.lease_token !== job.lease_token || latest.lease_expires_at <= Date.now()
      : latest.status !== 'needs_review' || latest.lease_token !== null)
      || latest.generation !== job.generation || generation !== job.generation || !game || !meta
      || `${game.sha256}:${game.size}` !== job.asset_fingerprint || game.storage_key !== job.storage_key
      || meta.metadata_revision !== expectedRevision) return null
    const preview = metadataPreview(db, job.game_id, candidate)
    const changes = []
    const now = Date.now()
    for (const [field, [table, column]] of Object.entries(textFields)) {
      const item = preview.fields[field]
      if (!item.proposed || (!manual && item.locked) || (selectedFields && !selectedFields.includes(field))) continue
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${table === 'games' ? 'id' : 'game_id'} = ?`).run(item.proposed, job.game_id)
      db.prepare(`INSERT OR REPLACE INTO game_metadata_field_sources (game_id, field, source, locked, updated_at) VALUES (?, ?, ?, ?, ?)`).run(job.game_id, sourceField(field), manual ? 'manual' : 'screenscraper', manual ? 1 : 0, now)
      changes.push(field)
    }
    if (cover && (manual || !preview.fields.cover.locked) && (!selectedFields || selectedFields.includes('cover'))) {
      if (game.cover_storage_key) enqueueCleanup(db, 'covers', game.cover_storage_key)
      db.prepare('UPDATE games SET cover_storage_key = ?, cover_type = ?, cover_size = ?, cover_sha256 = ? WHERE id = ?')
        .run(cover.file.key, cover.type, cover.file.size, cover.file.sha256, job.game_id)
      db.prepare(`INSERT OR REPLACE INTO game_metadata_field_sources (game_id, field, source, locked, updated_at) VALUES (?, 'cover', ?, ?, ?)`).run(job.game_id, manual ? 'manual' : 'screenscraper', manual ? 1 : 0, now)
      changes.push('cover')
    }
    // Record provenance even if every field was locked/absent.
    db.prepare(`UPDATE game_metadata SET provider_game_id = ?, match_method = ?, fetched_at = ?, applied_at = ?,
      metadata_revision = metadata_revision + 1, updated_at = ? WHERE game_id = ?`)
      .run(candidate.id, manual ? 'manual' : 'hash', now, now, now, job.game_id)
    if (changes.length) {
      db.prepare('UPDATE games SET updated_at = ? WHERE id = ?').run(now, job.game_id)
      db.prepare('UPDATE catalog_revision SET revision = revision + 1 WHERE id = 1').run()
    }
    return { changes, revision: expectedRevision + 1 }
  })
}
