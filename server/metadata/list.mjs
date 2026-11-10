import { invalidCatalog } from '../catalog/errors.mjs'

export const jobStatuses = ['disabled', 'queued', 'running', 'retry_wait', 'paused', 'needs_review', 'succeeded', 'not_found', 'unsupported', 'failed', 'cancelled']

// Latest generation only: older failures must not hide a successful rescan.
export function listMetadataJobs(db, query = {}) {
  const page = Number(query.page ?? 1), pageSize = Number(query.pageSize ?? 12)
  const status = query.status ?? '', q = query.q ?? '', consoleId = query.console ?? ''
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
    || typeof status !== 'string' || (status && !jobStatuses.includes(status)) || typeof q !== 'string' || q.length > 200
    || typeof consoleId !== 'string' || consoleId.length > 80) throw invalidCatalog('Filter antrean metadata tidak valid.')
  const from = `FROM games g LEFT JOIN metadata_jobs j ON j.game_id = g.id
    AND j.generation = (SELECT MAX(latest.generation) FROM metadata_jobs latest WHERE latest.game_id = g.id)
    WHERE g.deleted_at IS NULL`
  const counts = Object.fromEntries(jobStatuses.map(status => [status, 0]))
  for (const row of db.prepare(`SELECT COALESCE(j.status, 'disabled') AS status, COUNT(*) AS n ${from} GROUP BY COALESCE(j.status, 'disabled')`).all()) counts[row.status] = row.n
  const values = [], conditions = []
  if (status) { conditions.push("COALESCE(j.status, 'disabled') = ?"); values.push(status) }
  else conditions.push("COALESCE(j.status, 'disabled') != 'disabled'")
  if (consoleId) { conditions.push('g.console_id = ?'); values.push(consoleId) }
  if (q.trim()) { conditions.push('(instr(lower(g.title), lower(?)) > 0 OR instr(lower(g.original_name), lower(?)) > 0)'); values.push(q.trim(), q.trim()) }
  const filtered = from + conditions.map(condition => ` AND ${condition}`).join('')
  const rows = db.prepare(`SELECT j.*, g.id AS live_game_id, g.created_at AS game_created_at, g.updated_at AS game_updated_at, g.title, g.console_id, g.original_name ${filtered}
    ORDER BY CASE j.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'retry_wait' THEN 2 ELSE 3 END,
    CASE WHEN j.status IN ('queued', 'retry_wait') THEN j.next_at END ASC, j.updated_at DESC, j.id
    LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize)
  return {
    items: rows.map(row => ({ id: row.id ?? `unscanned-${row.live_game_id}`, gameId: row.live_game_id, title: row.title, consoleId: row.console_id, fileName: row.original_name,
      generation: row.generation ?? 1, status: row.status ?? 'disabled', phase: row.phase ?? null, reason: row.error_code ?? null, attempts: row.attempts ?? 0,
      nextAt: ['queued', 'retry_wait', 'paused', 'failed', 'not_found'].includes(row.status) ? row.next_at : null,
      createdAt: row.created_at ?? row.game_created_at, updatedAt: row.updated_at ?? row.game_updated_at })),
    total: db.prepare(`SELECT COUNT(*) AS n ${filtered}`).get(...values).n, page, pageSize, counts,
  }
}
