import { randomUUID } from 'node:crypto'
import { transaction } from '../auth/mutations.mjs'
import { createScreenScraperClient, computeRomHashes, ScreenScraperError } from './screenscraper.mjs'

const LEASE_MS = 60_000
const POLL_MS = 250
const MAX_ATTEMPTS = 5

function nowMs() { return Date.now() }

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function classifyError(error) {
  const code = error?.code
  if (code === 'not_found') return { status: 'not_found', retryable: false }
  if (code === 'unsupported_format' || code === 'invalid_target' || code === 'invalid_fingerprint') return { status: 'unsupported', retryable: false }
  if (code === 'auth_rejected' || code === 'forbidden' || code === 'not_configured' || code === 'disabled') return { status: 'paused', retryable: false }
  if (code === 'rate_limited' || code === 'quota_exhausted' || code === 'search_quota_exhausted' || code === 'provider_closed' || code === 'client_rejected') return { status: 'retry_wait', retryable: true }
  if (code === 'timeout' || code === 'transport' || code === 'invalid_json' || code === 'invalid_envelope' || code === 'response_too_large' || code === 'provider_error' || code === 'bad_request') return { status: 'retry_wait', retryable: true }
  return { status: 'failed', retryable: false }
}

function backoffMs(attempts) {
  const base = Math.min(30_000 * (2 ** Math.max(0, attempts - 1)), 15 * 60_000)
  const jitter = Math.floor(Math.random() * 5_000)
  return base + jitter
}

export function createMetadataWorker({ db, config, storage, logger = console }) {
  let running = false
  let loopPromise = null
  let stopping = false
  let currentAbort = null

  function isEnabled() {
    return config?.screenscraper?.enabled === true && (config?.screenscraper?.missing?.length ?? 0) === 0
  }

  function claimJob() {
    const now = nowMs()
    return transaction(db, () => {
      const row = db.prepare(`
        SELECT * FROM metadata_jobs
        WHERE ((status IN ('queued', 'retry_wait') AND next_at <= ?)
               OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?))
        ORDER BY next_at ASC, created_at ASC
        LIMIT 1
      `).get(now, now)
      if (!row) return null

      const game = db.prepare('SELECT * FROM games WHERE id = ? AND deleted_at IS NULL').get(row.game_id)
      if (!game) {
        db.prepare(`UPDATE metadata_jobs SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(now, row.id)
        return null
      }
      const fingerprint = `${game.sha256}:${game.size}`
      if (fingerprint !== row.asset_fingerprint) {
        db.prepare(`UPDATE metadata_jobs SET status = 'cancelled', error_code = 'STALE_ASSET', updated_at = ? WHERE id = ?`).run(now, row.id)
        return null
      }

      const token = randomUUID()
      const leaseExpires = now + LEASE_MS
      db.prepare(`
        UPDATE metadata_jobs
        SET status = 'running', phase = 'identifying', lease_token = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
        WHERE id = ?
      `).run(token, leaseExpires, now, row.id)
      return { ...row, lease_token: token, lease_expires_at: leaseExpires, attempts: row.attempts + 1, phase: 'identifying' }
    })
  }

  function setPhase(job, phase) {
    const now = nowMs()
    db.prepare(`UPDATE metadata_jobs SET phase = ?, updated_at = ? WHERE id = ? AND lease_token = ?`)
      .run(phase, now, job.id, job.lease_token)
  }

  function finishJob(job, patch) {
    const now = nowMs()
    const fields = {
      status: patch.status,
      phase: patch.phase || job.phase,
      error_code: patch.error_code ?? null,
      candidate_json: patch.candidate_json ?? null,
      candidate_at: patch.candidate_at ?? null,
      next_at: patch.next_at ?? now,
      lease_token: null,
      lease_expires_at: null,
      updated_at: now,
    }
    db.prepare(`
      UPDATE metadata_jobs
      SET status = ?, phase = ?, error_code = ?, candidate_json = ?, candidate_at = ?, next_at = ?, lease_token = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND lease_token = ?
    `).run(
      fields.status, fields.phase, fields.error_code, fields.candidate_json, fields.candidate_at,
      fields.next_at, fields.lease_token, fields.lease_expires_at, fields.updated_at,
      job.id, job.lease_token
    )
  }

  async function processJob(job) {
    const controller = new AbortController()
    currentAbort = controller
    try {
      const game = db.prepare('SELECT * FROM games WHERE id = ? AND deleted_at IS NULL').get(job.game_id)
      if (!game) {
        finishJob(job, { status: 'cancelled', error_code: 'GAME_DELETED' })
        return
      }
      const fp = `${game.sha256}:${game.size}`
      if (fp !== job.asset_fingerprint) {
        finishJob(job, { status: 'cancelled', error_code: 'STALE_ASSET' })
        return
      }

      setPhase(job, 'identifying')
      const hashes = await computeRomHashes(
        { path: await storage.pathFor('games', game.storage_key), size: game.size, sha256: game.sha256 },
        { signal: controller.signal }
      )

      setPhase(job, 'lookup')
      const client = createScreenScraperClient(config.screenscraper)
      const result = await client.searchByHash({
        consoleId: game.console_id,
        fileName: game.original_name,
        size: hashes.size,
        md5: hashes.md5,
        sha1: hashes.sha1,
        signal: controller.signal,
      })

      const candidates = Array.isArray(result.candidates) ? result.candidates : []
      const payload = JSON.stringify({ method: result.method, systemId: result.systemId, candidates })

      if (candidates.length === 0) {
        finishJob(job, { status: 'not_found', phase: 'lookup', next_at: nowMs() + 7 * 24 * 60 * 60 * 1000 })
        return
      }

      finishJob(job, {
        status: 'needs_review',
        phase: 'apply',
        candidate_json: payload,
        candidate_at: nowMs(),
      })
    } catch (error) {
      const code = error instanceof ScreenScraperError ? error.code : (error?.code || 'provider_error')
      const classified = classifyError(code)
      const attempts = job.attempts || 0
      if (classified.status === 'retry_wait' && attempts >= MAX_ATTEMPTS) {
        finishJob(job, { status: 'failed', error_code: code, next_at: nowMs() + 60 * 60 * 1000 })
        return
      }
      const nextAt = classified.status === 'retry_wait'
        ? nowMs() + backoffMs(attempts)
        : nowMs() + 24 * 60 * 60 * 1000
      finishJob(job, {
        status: classified.status,
        error_code: code,
        next_at: nextAt,
      })
      if (logger?.warn) logger.warn({ err: error?.message, code }, 'metadata worker job failed')
    } finally {
      currentAbort = null
    }
  }

  async function tick() {
    if (stopping || !running) return
    if (!isEnabled()) {
      setTimeout(tick, POLL_MS)
      return
    }
    try {
      const job = claimJob()
      if (job) {
        await processJob(job)
        if (!stopping && running) setTimeout(tick, 0)
        return
      }
    } catch (error) {
      if (logger?.error) logger.error(error, 'metadata worker tick failed')
    }
    if (!stopping && running) setTimeout(tick, POLL_MS)
  }

  function start() {
    if (running) return
    running = true
    stopping = false
    loopPromise = (async () => { await tick() })()
  }

  async function stop() {
    stopping = true
    running = false
    if (currentAbort) {
      try { currentAbort.abort() } catch { /* ignore */ }
    }
    if (loopPromise) {
      try { await Promise.race([loopPromise, sleep(5000)]) } catch { /* ignore */ }
    }
  }

  return { start, stop, isEnabled }
}