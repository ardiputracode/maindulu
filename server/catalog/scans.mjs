import { opendir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { transaction } from '../auth/mutations.mjs'
import { createCatalogRepository } from './repository.mjs'
import { safeDirectory } from './storage.mjs'
import { platformSlugs, platformConsole, storagePlatform, safeStorageName } from './paths.mjs'
import { fileName, validId } from './validation.mjs'
import { CatalogHttpError, invalidCatalog } from './errors.mjs'
import { getScreenScraperConfigStatus } from '../metadata/screenscraper.mjs'
import { createLimiter } from '../auth/limits.mjs'
import { reconcileAvailability } from './availability.mjs'

const active = "status IN ('queued','running')"
const statuses = ['added', 'already_registered', 'duplicate', 'conflict', 'restore_required', 'busy', 'invalid', 'unsafe', 'not_ready', 'failed', 'unsupported_multifile', 'missing', 'damaged', 'restored']
const stop = message => Object.assign(new Error(message), { scanStop: true })
const outcome = (status, message, existingId) => ({ status, message, existingId })

// One sequential reader, 1 MiB hash buffers, at most 100,000 entries/job and
// 10,000 persisted details. Database uniqueness and lease checks fence processes.
export function registerCatalogScans(api, config, security, storage) {
  const db = api.database
  const operations = new Set()
  let closing = false
  const limit = createLimiter()
  function reap() {
    const now = Date.now()
    db.prepare(`UPDATE catalog_scans SET status = 'interrupted', finished_at = ?, message = 'Lease worker berakhir; jalankan scan baru.' WHERE ${active} AND lease_until <= ?`).run(now, now)
    db.prepare(`DELETE FROM catalog_scans WHERE status NOT IN ('queued','running') AND finished_at < ?`).run(now - 7 * 86400000)
    // Keep counters for seven days; only the newest 20 jobs retain details.
    db.exec(`UPDATE catalog_scans SET truncated = 1 WHERE id IN (SELECT job_id FROM catalog_scan_results WHERE job_id NOT IN (SELECT id FROM catalog_scans ORDER BY created_at DESC LIMIT 20));
      DELETE FROM catalog_scan_results WHERE job_id NOT IN (SELECT id FROM catalog_scans ORDER BY created_at DESC LIMIT 20);`)
  }
  reap()
  const reaper = setInterval(() => { try { reap() } catch { api.log.error('Pemeliharaan scan folder gagal; periksa database.') } }, 10000)
  reaper.unref()
  function dto(row) {
    return row ? { id: row.id, scope: JSON.parse(row.scope), status: row.status, discovered: row.discovered,
      processed: row.processed, added: row.added, skipped: row.skipped, problems: row.problems,
      metadataQueued: row.metadata_queued, truncated: !!row.truncated, createdAt: row.created_at,
      physicalBytes: row.physical_bytes, quotaBytes: config.catalogQuotaBytes, usageWarning: row.usage_warning,
      finishedAt: row.finished_at, message: row.message, cancelRequested: !!row.cancel } : null
  }
  function get(id) {
    if (!validId(id)) throw invalidCatalog('ID scan tidak valid.')
    const row = db.prepare('SELECT * FROM catalog_scans WHERE id = ?').get(id)
    if (!row) throw new CatalogHttpError(404, 'SCAN_NOT_FOUND', 'Scan tidak ditemukan atau hasil sudah kedaluwarsa.')
    return row
  }
  function record(id, token, path, result, metadata = false, inTransaction = false) {
    const work = () => {
      const row = db.prepare(`SELECT * FROM catalog_scans WHERE id = ? AND token = ? AND ${active} AND lease_until > ?`).get(id, token, Date.now())
      if (!row) throw stop('Kepemilikan scan hilang.')
      const added = result.status === 'added', skipped = ['already_registered', 'duplicate'].includes(result.status)
      db.prepare(`UPDATE catalog_scans SET processed = processed + 1, added = added + ?, skipped = skipped + ?, problems = problems + ?, metadata_queued = metadata_queued + ?, truncated = ? WHERE id = ?`)
        .run(+added, +skipped, +(!added && !skipped && result.status !== 'restored'), +(added && metadata), +(row.processed >= 10000 || !!row.truncated), id)
      if (row.processed < 10000) db.prepare('INSERT INTO catalog_scan_results VALUES (?, ?, ?, ?, ?, ?)').run(id, row.processed + 1, path.slice(0, 512), result.status, result.message, result.existingId ?? null)
    }
    return inTransaction ? work() : transaction(db, work)
  }
  async function run(job, request) {
    const { id, token } = job, scope = JSON.parse(job.scope)
    let workerFault
    function check() {
      if (workerFault) throw workerFault
      if (closing) throw stop('Server berhenti; jalankan scan baru.')
      const row = db.prepare('SELECT * FROM catalog_scans WHERE id = ?').get(id)
      if (!row || row.token !== token || !['queued', 'running'].includes(row.status) || row.lease_until <= Date.now()) throw stop('Kepemilikan scan hilang.')
      if (row.cancel) throw stop('Scan dibatalkan. Entri sukses dan antrean metadata sebelumnya tetap disimpan.')
      if (security.requireAdmin(request).user_id !== job.actor) throw stop('Sesi pemulai berubah.')
    }
    const heartbeat = setInterval(() => {
      try { db.prepare(`UPDATE catalog_scans SET lease_until = ? WHERE id = ? AND token = ? AND ${active} AND lease_until > ?`).run(Date.now() + 30000, id, token, Date.now()) }
      catch (error) { workerFault = error }
    }, 5000)
    heartbeat.unref()
    let currentPath
    const repo = createCatalogRepository(db, storage, { check, onPublished: (kind, row, { reattached }) => {
      record(id, token, currentPath, outcome(reattached ? 'already_registered' : 'added', reattached ? 'Berkas identik disambungkan kembali; ID, metadata, dan save dipertahankan.' : 'Terdaftar otomatis; berkas tetap di tempatnya.', row.id), !reattached && kind === 'games' && scope.scanMetadata, true)
    } })
    let discovered = 0
    const kinds = scope.kind === 'both' ? ['games', 'bios'] : [scope.kind]
    const entries = new Map()
    const observations = []
    const verified = new Map()
    async function candidate(kind, platform, name) {
      check()
      const consoleId = platformConsole(platform)
      const mapped = storage.scanMapping(kind, platform, name)
      if (mapped && (mapped.state !== 'ready' || db.prepare('SELECT 1 FROM catalog_cleanup WHERE folder = ? AND storage_key = ?').get(kind, mapped.storage_key))) return outcome('busy', 'Path sedang dipesan/dibersihkan; ulangi nanti.')
      if (!safeStorageName(name)) return outcome('invalid', 'Basename tidak aman atau terlalu panjang.')
      if (name.startsWith('.') || /\.(filepart|part|tmp)$/i.test(name)) return outcome('not_ready', 'Berkas sementara/tersembunyi; gunakan rename final setelah transfer selesai.')
      if (kind === 'games' && consoleId === 'psx' && /\.(cue|m3u|bin)$/i.test(name)) return outcome('unsupported_multifile', 'Paket/track PSX tidak diadopsi. Gunakan single-file CHD/PBP/ISO yang didukung.')
      try { fileName(kind, name, consoleId) } catch (error) { return outcome('invalid', error.message) }
      if (storagePlatform(consoleId, name, kind) !== platform) return outcome('invalid', 'Lokasi fisik tidak sesuai platform upload.')
      const file = await storage.adoption(kind, platform, name, check)
      check()
      if (mapped) {
        const row = db.prepare(`SELECT * FROM ${kind} WHERE storage_key = ?`).get(mapped.storage_key)
        if (!row || row.deleted_at !== null) return outcome('restore_required', 'Gunakan pemulihan ID lama melalui upload eksplisit.', row?.id)
        if (mapped.file_name !== name) return outcome('conflict', 'Nama berbenturan menurut identitas case/Unicode.', row.id)
        if (row.sha256 !== file.sha256 || row.size !== file.size) {
          verified.set(mapped.storage_key, { status: 'damaged', file })
          return outcome('conflict', 'Byte aset terdaftar berubah. Metadata dan ID tidak diubah.', row.id)
        }
        storage.refreshAdoption(file, mapped.storage_key)
        verified.set(mapped.storage_key, { status: 'available', file })
        return outcome('already_registered', 'Sudah terdaftar; hash byte konsisten.', row.id)
      }
      const row = await repo.adopt(kind, job.actor, { consoleId, fileName: name, [kind === 'games' ? 'title' : 'name']: kind === 'games' ? '' : name.slice(0, 200), description: '', [kind === 'games' ? 'license' : 'distributionRights']: '' }, file, { scanMetadata: scope.scanMetadata })
      return outcome('added', 'Terdaftar otomatis; berkas tetap di tempatnya.', row.id)
    }
    try {
      check()
      for (const kind of kinds) entries.set(kind, storage.scanEntries(kind, scope.platforms))
      if ([...entries.values()].reduce((sum, rows) => sum + rows.length, 0) > 100000) throw new Error('Batas 100.000 entri terdaftar tercapai; persempit pilihan platform.')
      db.prepare("UPDATE catalog_scans SET status = 'running' WHERE id = ? AND token = ?").run(id, token)
      try {
        const bytes = await storage.physicalUsage(check)
        check()
        db.prepare('UPDATE catalog_scans SET physical_bytes = ?, usage_warning = ? WHERE id = ?').run(bytes, bytes > config.catalogQuotaBytes ? 'Volume sudah melewati kuota. Adopsi tidak menambah byte dan tidak menghapus berkas untuk mengatasinya.' : '', id)
      } catch (error) {
        check()
        if (error.scanStop || error.errcode || error.code?.startsWith('SQLITE')) throw error
        db.prepare('UPDATE catalog_scans SET usage_warning = ? WHERE id = ?').run('Pemakaian disk tidak dapat dihitung dengan aman; periksa permission, symlink/hard link, dan kapasitas volume. Scan tidak menyembunyikan atau membersihkan file operator.', id)
      }
      await safeDirectory(config.dataDir)
      for (const kind of kinds) {
        const base = storage.scanRoot(kind)
        await safeDirectory(base)
        for (const platform of scope.platforms) {
          check()
          let directory
          try { await safeDirectory(join(base, platform)); directory = await opendir(join(base, platform)) }
          catch (error) {
            if (error.code === 'ENOENT' && !entries.get(kind).some(row => row.platform === platform)) continue
            db.prepare('UPDATE catalog_scans SET discovered = discovered + 1 WHERE id = ?').run(id)
            record(id, token, `${kind === 'games' ? 'roms' : 'bios'}/${platform}`, outcome('unsafe', 'Folder hilang/tidak aman/tidak dapat dibaca; status file lama tidak diubah. Periksa mount/permission lalu scan ulang.'))
            continue
          }
          for await (const entry of directory) {
            check()
            if (++discovered > 100000) throw new Error('Batas 100.000 item tercapai; persempit pilihan platform.')
            db.prepare('UPDATE catalog_scans SET discovered = discovered + 1 WHERE id = ?').run(id)
            let result
            currentPath = `${kind === 'games' ? 'roms' : 'bios'}/${platform}/${entry.name}`
            try { result = entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()) ? outcome('unsafe', 'Symlink/junction atau berkas khusus ditolak; tidak diikuti.') : entry.isDirectory() ? outcome('invalid', 'Subfolder tidak didukung; tidak diikuti.') : await candidate(kind, platform, entry.name) }
            catch (error) {
              if (error.scanStop || error.statusCode === 401 || error.statusCode === 403 || error.code === 'ADMIN_REQUIRED' || error.code?.startsWith('SQLITE') || error.errcode) throw error
              const status = error.scanStatus ?? ({ CATALOG_DUPLICATE: 'duplicate', CATALOG_RESTORE_REQUIRED: 'restore_required' }[error.code])
                ?? (/tidak aman/.test(error.message) ? 'unsafe' : /berubah|ENOENT/.test(error.message) ? 'not_ready' : 'failed')
              result = outcome(status, error.scanStatus || ['CATALOG_DUPLICATE', 'CATALOG_RESTORE_REQUIRED'].includes(error.code) ? error.message : status === 'unsafe' ? 'Symlink/junction, hard link, atau berkas khusus ditolak.' : status === 'not_ready' ? 'Berkas hilang/berubah saat verifikasi; ulangi setelah transfer selesai.' : 'Berkas tidak dapat dibaca; periksa permission dan storage.', error.id)
            }
            if (result.status !== 'added') record(id, token, currentPath, result)
          }
          // Only successfully enumerated folders can produce missing entries.
          // Failed/too-new individual files retain their previous status.
          await safeDirectory(base)
          await safeDirectory(join(base, platform))
          for (const row of entries.get(kind).filter(row => row.platform === platform)) {
            check()
            const value = verified.get(row.storage_key)
            if (value) observations.push({ kind, row, ...value })
            else {
              try {
                const status = storage.scanFileState(kind, platform, row.file_name, row.size)
                if (status !== 'present') observations.push({ kind, row, status })
              } catch { /* Unreadable parent/path is not proof of a missing file. */ }
            }
          }
        }
      }
      transaction(db, () => {
        check()
        reconcileAvailability(db, storage, observations, check, (path, result) => record(id, token, path, result, false, true))
        check()
        db.prepare("UPDATE catalog_scans SET status = 'completed', finished_at = ? WHERE id = ? AND token = ? AND status = 'running' AND lease_until > ?").run(Date.now(), id, token, Date.now())
      })
    } catch (error) {
      const row = db.prepare('SELECT cancel FROM catalog_scans WHERE id = ?').get(id)
      const status = row?.cancel ? 'cancelled' : closing || error.scanStop ? 'interrupted' : 'failed'
      db.prepare(`UPDATE catalog_scans SET status = ?, finished_at = ?, message = ? WHERE id = ? AND token = ? AND ${active}`)
        .run(status, Date.now(), row?.cancel ? 'Scan dibatalkan; entri sukses tetap disimpan.' : error.scanStop ? error.message : 'Scan dihentikan: sesi/izin berakhir, batas item, atau kegagalan storage/database. Periksa server lalu scan lagi.', id, token)
    } finally { clearInterval(heartbeat) }
  }
  const guard = { onRequest: async request => { const session = security.protectAdmin(request); limit(`scan:${session.user_id}`, 240, 60000) } }
  api.get('/api/admin/catalog-scans/sources', guard, async () => ({ sources: Object.fromEntries(['games', 'bios'].map(kind => [kind, { mode: config.externalCatalog?.[kind] ? config.externalWritable ? 'shared' : 'external' : 'managed' }])) }))
  api.post('/api/admin/catalog-scans', guard, async (request, reply) => {
    const body = request.body
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['kind', 'platforms', 'scanMetadata'].includes(k))
      || (body.kind !== undefined && !['games', 'bios', 'both'].includes(body.kind)) || (body.scanMetadata !== undefined && typeof body.scanMetadata !== 'boolean')
      || (body.platforms !== undefined && (!Array.isArray(body.platforms) || !body.platforms.length || body.platforms.length > 7 || new Set(body.platforms).size !== body.platforms.length || body.platforms.some(p => !platformSlugs.includes(p))))) throw invalidCatalog('Pilihan scan tidak valid; gunakan jenis dan slug platform yang didukung.')
    const scope = { kind: body.kind ?? 'both', platforms: body.platforms ?? [...platformSlugs], scanMetadata: body.scanMetadata ?? false }
    if (scope.scanMetadata && (scope.kind === 'bios' || !getScreenScraperConfigStatus(config.screenscraper).ready)) throw invalidCatalog('Metadata hanya untuk ROM baru dan memerlukan layanan ScreenScraper siap. Periksa konfigurasi provider.')
    reap()
    const job = transaction(db, () => {
      const existing = db.prepare(`SELECT * FROM catalog_scans WHERE ${active}`).get()
      if (existing) return { existing }
      const recent = db.prepare('SELECT COUNT(*) AS n FROM catalog_scans WHERE created_at > ?').get(Date.now() - 60000).n
      if (recent >= 6) throw new CatalogHttpError(429, 'SCAN_RATE_LIMIT', 'Terlalu banyak scan. Tunggu satu menit.')
      const id = randomUUID(), token = randomUUID(), now = Date.now()
      db.prepare(`INSERT INTO catalog_scans (id, actor, scope, status, token, lease_until, created_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)`).run(id, security.requireAdmin(request).user_id, JSON.stringify(scope), token, now + 30000, now)
      return get(id)
    })
    if (job.existing) return reply.code(409).send({ code: 'SCAN_ACTIVE', error: 'Scan lain masih aktif.', activeJob: dto(job.existing) })
    // Track even fenced workers while they unwind, so a replacement job cannot
    // escape orderly shutdown. Socket close does not cancel a scan.
    const operation = Promise.resolve().then(() => run(job, request))
      .catch(() => { api.log.error('Worker scan berhenti karena kegagalan database/storage; lease akan kedaluwarsa.') })
      .finally(() => { operations.delete(operation) })
    operations.add(operation)
    return reply.code(202).send({ job: dto(job) })
  })
  api.get('/api/admin/catalog-scans/active', guard, async () => { reap(); return { job: dto(db.prepare(`SELECT * FROM catalog_scans WHERE ${active} ORDER BY created_at DESC LIMIT 1`).get()) } })
  api.get('/api/admin/catalog-scans/:id', guard, async request => { reap(); return { job: dto(get(request.params.id)) } })
  api.post('/api/admin/catalog-scans/:id/cancel', guard, async request => {
    get(request.params.id)
    db.prepare(`UPDATE catalog_scans SET cancel = 1 WHERE id = ? AND ${active}`).run(request.params.id)
    return { job: dto(get(request.params.id)) }
  })
  api.get('/api/admin/catalog-scans/:id/results', guard, async request => {
    get(request.params.id)
    const { status = '', q = '', page = '1' } = request.query
    if (Object.keys(request.query).some(k => !['status', 'q', 'page'].includes(k)) || typeof status !== 'string' || (status && !statuses.includes(status)) || typeof q !== 'string' || q.length > 200 || typeof page !== 'string' || !/^[1-9]\d{0,5}$/.test(page)) throw invalidCatalog('Filter hasil scan tidak valid.')
    const args = [request.params.id, status, status, q, q]
    const where = "job_id = ? AND (? = '' OR status = ?) AND (? = '' OR instr(lower(path), lower(?)) > 0)"
    return { items: db.prepare(`SELECT ordinal, path, status, message, existing_id AS existingId FROM catalog_scan_results WHERE ${where} ORDER BY ordinal LIMIT 50 OFFSET ?`).all(...args, (Number(page) - 1) * 50), total: db.prepare(`SELECT COUNT(*) AS n FROM catalog_scan_results WHERE ${where}`).get(...args).n, page: Number(page), pageSize: 50 }
  })
  api.addHook('onClose', async () => { closing = true; clearInterval(reaper); await Promise.allSettled([...operations]) })
}
