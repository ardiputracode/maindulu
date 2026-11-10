import { invalidCatalog } from '../catalog/errors.mjs'

export const jobStatuses = ['queued', 'running', 'retry_wait', 'paused', 'needs_review', 'succeeded', 'not_found', 'unsupported', 'failed', 'cancelled']

// Latest generation only: older failures must not hide a successful rescan.
export function listMetadataJobs(db, query = {}) {
  const page = Number(query.page ?? 1), pageSize = Number(query.pageSize ?? 12)
  const status = query.status ?? '', q = query.q ?? '', consoleId = query.console ?? ''
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
    || typeof status !== 'string' || (status && !jobStatuses.includes(status)) || typeof q !== 'string' || q.length > 200
    || typeof consoleId !== 'string' || consoleId.length > 80) throw invalidCatalog('Filter antrean metadata tidak valid.')
  const from = `FROM metadata_jobs j JOIN games g ON g.id = j.game_id
    WHERE g.deleted_at IS NULL AND j.status != 'disabled' AND j.generation = (SELECT MAX(latest.generation) FROM metadata_jobs latest WHERE latest.game_id = j.game_id)`
  const counts = Object.fromEntries(jobStatuses.map(status => [status, 0]))
  for (const row of db.prepare(`SELECT j.status, COUNT(*) AS n ${from} GROUP BY j.status`).all()) counts[row.status] = row.n
  const values = [], conditions = []
  if (status) { conditions.push('j.status = ?'); values.push(status) }
  if (consoleId) { conditions.push('g.console_id = ?'); values.push(consoleId) }
  if (q.trim()) { conditions.push('(instr(lower(g.title), lower(?)) > 0 OR instr(lower(g.original_name), lower(?)) > 0)'); values.push(q.trim(), q.trim()) }
  const filtered = from + conditions.map(condition => ` AND ${condition}`).join('')
  const rows = db.prepare(`SELECT j.*, g.title, g.console_id, g.original_name ${filtered}
    ORDER BY CASE j.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'retry_wait' THEN 2 ELSE 3 END,
    CASE WHEN j.status IN ('queued', 'retry_wait') THEN j.next_at END ASC, j.updated_at DESC, j.id
    LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize)
  return {
    items: rows.map(row => ({ id: row.id, gameId: row.game_id, title: row.title, consoleId: row.console_id, fileName: row.original_name,
      generation: row.generation, status: row.status, phase: row.phase, reason: row.error_code, attempts: row.attempts,
      nextAt: ['queued', 'retry_wait', 'paused', 'failed', 'not_found'].includes(row.status) ? row.next_at : null,
      createdAt: row.created_at, updatedAt: row.updated_at })),
    total: db.prepare(`SELECT COUNT(*) AS n ${filtered}`).get(...values).n, page, pageSize, counts,
  }
}
