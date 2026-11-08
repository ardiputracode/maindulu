import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { transaction } from '../auth/mutations.mjs'
import { createScreenScraperClient, resolveScreenScraperSystem, ScreenScraperError } from './screenscraper.mjs'
import { identifyCatalogRom, isIdentifiableZip } from './identification.mjs'
import { metadataCacheKey, readMetadataCache, writeMetadataCache, pruneMetadata } from './cache.mjs'
import { assessScreenScraperEvidence } from './screenscraper-policy.mjs'
import { downloadScreenScraperCover, selectScreenScraperCover, CoverError } from './cover.mjs'
import { applyVerifiedMetadata, metadataPreview } from './apply.mjs'
import { validateCover } from '../catalog/validation.mjs'
import { enqueueCleanup, activeReference } from '../catalog/maintenance.mjs'
import { screenScraperLimits } from './screenscraper-policy.mjs'

const LEASE_MS = 60_000
const POLL_MS = 250
const MAX_ATTEMPTS = screenScraperLimits.maxAttempts

function nowMs() { return Date.now() }

// Fence injected/late I/O as well as real transports; never await an ignored abort.
async function abortable(promise, signal) {
  signal.throwIfAborted()
  let abort
  const cancelled = new Promise((_, reject) => { abort = () => reject(new ScreenScraperError('disabled')); signal.addEventListener('abort', abort, { once: true }) })
  try { return await Promise.race([promise, cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
}

function classifyError(code) {
  if (code === 'not_found') return { status: 'not_found', retryable: false }
  if (['unsupported_format', 'invalid_target', 'invalid_fingerprint', 'archive_invalid', 'archive_limits', 'archive_ambiguous', 'archive_unsupported', 'identification_timeout'].includes(code)) return { status: 'unsupported', retryable: false }
  if (code === 'asset_mismatch') return { status: 'failed', retryable: false }
  if (['auth_rejected', 'forbidden', 'not_configured', 'disabled', 'quota_unknown', 'client_rejected'].includes(code)) return { status: 'paused', retryable: false }
  if (code === 'rate_limited' || code === 'quota_exhausted' || code === 'search_quota_exhausted' || code === 'provider_closed') return { status: 'retry_wait', retryable: true }
  if (code === 'timeout' || code === 'transport' || code === 'invalid_json' || code === 'invalid_envelope' || code === 'response_too_large' || code === 'provider_error' || code === 'bad_request') return { status: 'retry_wait', retryable: true }
  return { status: 'failed', retryable: false }
}

function backoffMs(attempts) {
  const base = Math.min(30_000 * (2 ** Math.max(0, attempts - 1)), 15 * 60_000)
  const jitter = Math.floor(Math.random() * 5_000)
  return base + jitter
}

export function createMetadataWorker({ db, config, storage, maintenance, logger = console, clientFactory = createScreenScraperClient,
  downloadCover = downloadScreenScraperCover }) {
  let running = false
  let loopPromise = null
  let stopping = false
  let currentAbort = null
  let timer = null
  let active = null
  let quota = null
  let lastPrune = 0
  const metrics = { completed: 0, cacheHits: 0, cacheMisses: 0, outcomes: {}, phases: {} }
  let phaseStarted = 0, currentPhase = null

  function recordPhase() {
    if (!currentPhase) return
    const durationMs = Math.max(0, Date.now() - phaseStarted)
    const previous = metrics.phases[currentPhase] ?? { count: 0, totalMs: 0, maxMs: 0 }
    metrics.phases[currentPhase] = { count: previous.count + 1, totalMs: previous.totalMs + durationMs, maxMs: Math.max(previous.maxMs, durationMs) }
    currentPhase = null
  }

  function isEnabled() {
    return config?.screenscraper?.enabled === true && (config?.screenscraper?.missing?.length ?? 0) === 0
  }

  function claimJob() {
    const now = nowMs()
    return transaction(db, () => {
      const gate = db.prepare('SELECT * FROM metadata_provider_state WHERE id = 1').get()
      if (gate.paused_reason || gate.next_at > now || (gate.lease_token && gate.lease_expires_at > now)) return null
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
      if (row.generation !== db.prepare('SELECT MAX(generation) AS g FROM metadata_jobs WHERE game_id = ?').get(row.game_id).g || row.attempts >= MAX_ATTEMPTS) {
        db.prepare("UPDATE metadata_jobs SET status = 'failed', error_code = 'STALE_OR_EXHAUSTED', lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?").run(now, row.id)
        return null
      }

      const token = randomUUID()
      const leaseExpires = now + LEASE_MS
      db.prepare(`
        UPDATE metadata_jobs
        SET status = 'running', phase = 'identifying', lease_token = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
        WHERE id = ?
      `).run(token, leaseExpires, now, row.id)
      db.prepare('UPDATE metadata_provider_state SET lease_token = ?, lease_expires_at = ? WHERE id = 1').run(token, leaseExpires)
      return { ...row, storage_key: game.storage_key, lease_token: token, lease_expires_at: leaseExpires, attempts: row.attempts + 1, phase: 'identifying' }
    })
  }

  function setPhase(job, phase) {
    recordPhase(); currentPhase = phase; phaseStarted = Date.now(); job.phase = phase
    const now = nowMs()
    db.prepare(`UPDATE metadata_jobs SET phase = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND lease_token = ?`)
      .run(phase, now + LEASE_MS, now, job.id, job.lease_token)
  }

  function checkCurrent(job, signal) {
    signal.throwIfAborted()
    const row = db.prepare('SELECT j.*, g.sha256, g.size, g.deleted_at FROM metadata_jobs j JOIN games g ON g.id = j.game_id WHERE j.id = ?').get(job.id)
    const latest = db.prepare('SELECT MAX(generation) AS g FROM metadata_jobs WHERE game_id = ?').get(job.game_id).g
    const gate = db.prepare('SELECT lease_token, lease_expires_at FROM metadata_provider_state WHERE id = 1').get()
    if (stopping || !isEnabled() || !row || row.deleted_at !== null || row.status !== 'running' || row.lease_token !== job.lease_token || row.lease_expires_at <= nowMs() || gate.lease_token !== job.lease_token || gate.lease_expires_at <= nowMs() || latest !== job.generation || `${row.sha256}:${row.size}` !== job.asset_fingerprint) throw new ScreenScraperError('disabled')
  }

  function finishJob(job, patch) {
    const now = nowMs()
    const fields = {
      status: patch.status,
      phase: patch.phase || job.phase,
      error_code: patch.error_code ?? null,
      candidate_json: patch.candidate_json ?? (job.request_method === 'apply' ? job.candidate_json : null),
      candidate_at: patch.candidate_at ?? (job.request_method === 'apply' ? job.candidate_at : null),
      next_at: patch.next_at ?? now,
      lease_token: null,
      lease_expires_at: null,
      updated_at: now,
    }
    db.prepare(`
      UPDATE metadata_jobs
      SET status = ?, phase = ?, error_code = ?, candidate_json = ?, candidate_at = ?, next_at = ?, lease_token = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_token = ?
    `).run(
      fields.status, fields.phase, fields.error_code, fields.candidate_json, fields.candidate_at,
      fields.next_at, fields.lease_token, fields.lease_expires_at, fields.updated_at,
      job.id, job.lease_token
    )
    if (db.prepare('SELECT 1 FROM games WHERE id = ? AND deleted_at IS NULL').get(job.game_id)) db.prepare('UPDATE catalog_revision SET revision = revision + 1 WHERE id = 1').run()
  }

  async function processJob(job) {
    const controller = new AbortController()
    currentAbort = controller
    setPhase(job, 'identifying')
    const checkEnabled = setInterval(() => { if (stopping || !isEnabled()) controller.abort() }, 100)
    checkEnabled.unref()
    const heartbeat = setInterval(() => {
      if (!stopping && !controller.signal.aborted) {
        db.prepare(`UPDATE metadata_jobs SET lease_expires_at = ? WHERE id = ? AND status = 'running' AND lease_token = ?`).run(nowMs() + LEASE_MS, job.id, job.lease_token)
        db.prepare('UPDATE metadata_provider_state SET lease_expires_at = ? WHERE id = 1 AND lease_token = ?').run(nowMs() + LEASE_MS, job.lease_token)
        if (!isEnabled()) controller.abort()
      }
    }, LEASE_MS / 4)
    heartbeat.unref()
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

      // Snapshot revision *before* any async work; edits during hashing,
      // lookup or cover download must win at the final transaction.
      const request = JSON.parse(job.request_json ?? '{}')
      const manual = job.request_method === 'apply'
      const expectedRevision = manual ? request.expectedRevision : db.prepare('SELECT metadata_revision FROM game_metadata WHERE game_id = ?').get(game.id)?.metadata_revision
      checkCurrent(job, controller.signal)
      let hashes = {}, result, lookupName = game.original_name, identification
      async function identify() {
        const file = await storage.open('games', game.storage_key)
        try {
          const found = await identifyCatalogRom(file, { consoleId: game.console_id, fileName: game.original_name,
            size: game.size, sha256: game.sha256, signal: controller.signal })
          hashes = found.hashes; lookupName = found.fileName; identification = found.identification
        } finally { await file.close() }
      }
      const client = clientFactory(config.screenscraper)
      let intervalMs = screenScraperLimits.minRequestIntervalMs
      let quotaChecked = false
      async function lookup(key, requestLookup) {
        const cached = readMetadataCache(db, key)
        if (cached) { metrics.cacheHits++; return cached }
        metrics.cacheMisses++
        // A fresh account preflight for every uncached lookup, under the shared
        // lease. Tests may inject a client with no network/quota implementation.
        if (client.accountQuota) {
          quota = await abortable(client.accountQuota({ signal: controller.signal }), controller.signal)
          quotaChecked = true
          intervalMs = quota.intervalMs
          if (quota.remaining < 2 || quota.negativeRemaining < 1) throw new ScreenScraperError('quota_exhausted')
          await delay(intervalMs, undefined, { signal: controller.signal })
        }
        checkCurrent(job, controller.signal)
        let value
        try { value = await abortable(requestLookup(), controller.signal) }
        catch (error) {
          if (!(error instanceof ScreenScraperError) || error.code !== 'not_found') throw error
          value = { method: job.request_method, systemId: key.systemId, candidates: [] }
        }
        checkCurrent(job, controller.signal)
        writeMetadataCache(db, key, value)
        return value
      }
      if (manual) {
        result = JSON.parse(job.candidate_json)
        identification = result.identification
      } else if (job.request_method === 'name') {
        if (!resolveScreenScraperSystem(game.console_id, lookupName).systemId && isIdentifiableZip(game.console_id, lookupName)) await identify()
        setPhase(job, 'lookup')
        const target = resolveScreenScraperSystem(game.console_id, lookupName)
        result = await lookup(metadataCacheKey(target.systemId, {}, lookupName, request.query), () => client.searchByName({ consoleId: game.console_id, fileName: lookupName, query: request.query, signal: controller.signal }))
      } else {
        setPhase(job, 'identifying')
        await identify()
        const target = resolveScreenScraperSystem(game.console_id, lookupName)

        setPhase(job, 'lookup')
        checkCurrent(job, controller.signal)
        result = await lookup(metadataCacheKey(target.systemId, hashes, lookupName), () => client.searchByHash({
          consoleId: game.console_id,
          fileName: lookupName,
          size: hashes.size,
          md5: hashes.md5,
          sha1: hashes.sha1,
          signal: controller.signal,
        }))
      }
      checkCurrent(job, controller.signal)

      const candidates = Array.isArray(result.candidates) ? result.candidates : []
      const payload = JSON.stringify({ method: result.method, systemId: result.systemId, candidates,
        identification,
        fingerprint: manual ? result.fingerprint : { size: hashes.size, md5: hashes.md5, sha1: hashes.sha1 } })

      if (candidates.length === 0) {
        finishJob(job, { status: 'not_found', phase: 'lookup', next_at: nowMs() + screenScraperLimits.negativeCacheTtlMs })
        return
      }
      const evidence = assessScreenScraperEvidence({ method: result.method, consoleId: game.console_id,
        fileName: lookupName, size: hashes.size, md5: hashes.md5, sha1: hashes.sha1 }, candidates)
      if (!manual && !evidence.verified) {
        finishJob(job, { status: 'needs_review', phase: 'apply', error_code: evidence.reason,
          candidate_json: payload, candidate_at: nowMs() })
        return
      }
      const candidate = candidates[0]
      let stage, promoted, reservation, warning = null
      try {
        const region = selectScreenScraperCover(candidate)
        if (region && (manual ? request.fields.includes('cover') : !metadataPreview(db, game.id, candidate)?.fields.cover.locked)) {
          setPhase(job, 'cover')
          try {
            if (!maintenance) throw new CoverError('COVER_CAPACITY')
            reservation = await maintenance.reserve(8 * 1024 * 1024)
            checkCurrent(job, controller.signal)
            if (!quotaChecked && client.accountQuota) {
              quota = await abortable(client.accountQuota({ signal: controller.signal }), controller.signal)
              quotaChecked = true
              intervalMs = quota.intervalMs
              if (quota.remaining < 1) throw new ScreenScraperError('quota_exhausted')
            }
            await delay(intervalMs, undefined, { signal: controller.signal })
            checkCurrent(job, controller.signal)
            const media = await abortable(downloadCover(config.screenscraper, { gameId: candidate.id, systemId: result.systemId,
              region, signal: controller.signal }), controller.signal)
            if (media) {
              stage = await storage.stage('covers', (async function* () { yield media.bytes })())
              const type = await validateCover(storage, stage)
              if (type !== media.type) throw new CoverError('COVER_TYPE')
              reservation.check()
              controller.signal.throwIfAborted()
              promoted = { file: await storage.promote(stage), type }
            }
          } catch (error) {
            if (error instanceof ScreenScraperError || controller.signal.aborted) throw error
            warning = error instanceof CoverError ? error.code : 'COVER_UNAVAILABLE'
            if (error instanceof CoverError && [401, 403, 423, 426, 429, 430, 431].includes(error.httpStatus)) {
              const cooldown = [430, 431].includes(error.httpStatus) ? 86400000 : Math.max(30000, error.retryAfterMs)
              db.prepare('UPDATE metadata_provider_state SET next_at = MAX(next_at, ?), paused_reason = ? WHERE id = 1 AND lease_token = ?').run(nowMs() + cooldown, [401, 403, 426].includes(error.httpStatus) ? 'auth_rejected' : null, job.lease_token)
            }
          }
        }
        setPhase(job, 'apply')
        checkCurrent(job, controller.signal)
        const applied = applyVerifiedMetadata(db, storage, { job, candidate, expectedRevision, cover: promoted,
          manual, selectedFields: manual ? request.fields : null })
        if (applied) {
          finishJob(job, { status: 'succeeded', phase: 'apply', error_code: warning, candidate_json: payload, candidate_at: nowMs() })
        } else {
          finishJob(job, { status: 'needs_review', phase: 'apply', error_code: 'STALE_RESULT', candidate_json: payload, candidate_at: nowMs() })
        }
      } finally {
        if (stage && storage.ownsStage(stage, 'covers')) {
          try { await storage.discard(stage) } catch { /* offline recovery */ }
        }
        if (promoted) transaction(db, () => {
          if (!activeReference(db, 'covers', promoted.file.key)) enqueueCleanup(db, 'covers', promoted.file.key)
        })
        reservation?.release()
      }
    } catch (error) {
      const code = error instanceof ScreenScraperError ? error.code : controller.signal.aborted ? 'CANCELLED' : 'provider_error'
      const classified = classifyError(code)
      const attempts = job.attempts || 0
      let nextAt = classified.status === 'retry_wait'
        ? nowMs() + backoffMs(attempts)
        : nowMs() + 24 * 60 * 60 * 1000
      if (['quota_exhausted', 'search_quota_exhausted'].includes(code)) nextAt = nowMs() + 24 * 60 * 60 * 1000
      if (error instanceof ScreenScraperError && error.details.retryAfterMs) nextAt = Math.max(nextAt, nowMs() + error.details.retryAfterMs)
      if (classified.retryable || classified.status === 'paused') db.prepare('UPDATE metadata_provider_state SET next_at = MAX(next_at, ?), paused_reason = ? WHERE id = 1 AND lease_token = ?')
        .run(classified.retryable ? nextAt : 0, classified.status === 'paused' ? code : null, job.lease_token)
      finishJob(job, {
        status: classified.status === 'retry_wait' && attempts >= MAX_ATTEMPTS ? 'failed' : classified.status,
        error_code: code,
        next_at: nextAt,
      })
      // Never log a raw provider error: it may contain a URL with credentials.
      if (logger?.warn) logger.warn({ code: typeof code === 'string' && /^[A-Z_a-z]{1,64}$/.test(code) ? code : 'provider_error' }, 'metadata worker job failed')
    } finally {
      clearInterval(checkEnabled)
      clearInterval(heartbeat)
      recordPhase()
      metrics.completed++
      const outcome = db.prepare('SELECT status, error_code FROM metadata_jobs WHERE id = ?').get(job.id)
      const key = outcome?.status ?? 'cancelled'
      metrics.outcomes[key] = (metrics.outcomes[key] ?? 0) + 1
      currentAbort = null
      db.prepare('UPDATE metadata_provider_state SET lease_token = NULL, lease_expires_at = NULL, next_at = MAX(next_at, ?) WHERE id = 1 AND lease_token = ?').run(nowMs() + (quota?.intervalMs ?? screenScraperLimits.minRequestIntervalMs), job.lease_token)
    }
  }

  async function processOne() {
    if (!isEnabled() || active) return false
    if (Date.now() - lastPrune > 60_000) { pruneMetadata(db); lastPrune = Date.now() }
    const job = claimJob()
    if (!job) return false
    stopping = false
    active = processJob(job)
    try { await active; return true } finally { active = null }
  }

  async function tick() {
    if (stopping || !running) return
    if (!isEnabled()) {
      timer = setTimeout(() => { loopPromise = tick() }, POLL_MS)
      return
    }
    try {
      if (await processOne()) {
        if (!stopping && running) timer = setTimeout(() => { loopPromise = tick() }, 0)
        return
      }
    } catch {
      if (logger?.error) logger.error({ code: 'WORKER_FAILED' }, 'metadata worker tick failed')
    }
    if (!stopping && running) timer = setTimeout(() => { loopPromise = tick() }, POLL_MS)
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
    clearTimeout(timer)
    if (currentAbort) {
      try { currentAbort.abort() } catch { /* ignore */ }
    }
    // All network waits are abortable; wait for cleanup before SQLite closes.
    if (active) { try { await active } catch { /* safe tick error only */ } }
    if (loopPromise) { try { await loopPromise } catch { /* safe tick error only */ } }
  }

  return { start, stop, isEnabled, processOne, status: () => ({ enabled: isEnabled(), running, processing: active !== null,
    quota: quota ? { ...quota } : null, metrics: structuredClone(metrics) }) }
}
