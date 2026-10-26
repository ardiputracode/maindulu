import { randomUUID } from 'node:crypto'
import { statfs } from 'node:fs/promises'
import { transaction } from '../auth/mutations.mjs'
import { openRegular, catalogFolders, storageKeyPattern } from './storage.mjs'
import { CatalogHttpError } from './errors.mjs'

export function enqueueCleanup(db, folder, key) {
  if (!['games', 'bios', 'covers'].includes(folder) || !storageKeyPattern.test(key)) throw new Error('Referensi cleanup katalog tidak valid.')
  db.prepare('INSERT OR IGNORE INTO catalog_cleanup (folder, storage_key) VALUES (?, ?)').run(folder, key)
}
export function activeReference(db, folder, key) {
  return folder === 'covers'
    ? db.prepare('SELECT 1 FROM games WHERE cover_storage_key = ? AND deleted_at IS NULL').get(key)
    : db.prepare(`SELECT 1 FROM ${folder} WHERE storage_key = ? AND deleted_at IS NULL`).get(key)
}

export function createCatalogMaintenance(db, storage, config, log) {
  let running, stopped = false
  const bump = () => db.exec('UPDATE catalog_capacity SET generation = generation + 1 WHERE id = 1')
  function release(id) {
    transaction(db, () => { db.prepare('DELETE FROM catalog_uploads WHERE id = ?').run(id); bump() })
  }
  function check(id) {
    if (!db.prepare('SELECT 1 FROM catalog_uploads WHERE id = ? AND expires_at > ?').get(id, Date.now())) throw new CatalogHttpError(408, 'UPLOAD_EXPIRED', 'Waktu upload berakhir. Ulangi upload.')
  }
  async function reserve(bytes) {
    // Sampling outside SQLite avoids holding a write transaction over disk I/O.
    // A generation change (admission/release in ANY process) invalidates the sample.
    for (let attempt = 0; attempt < 8; attempt++) {
      const generation = db.prepare('SELECT generation FROM catalog_capacity WHERE id = 1').get().generation
      let physical = 0
      try {
        for (const folder of catalogFolders) for (const key of await storage.entries(folder)) {
          const file = await openRegular(await storage.pathFor(folder, key))
          try { physical += (await file.stat()).size } finally { await file.close() }
        }
      } catch (error) {
        if (error.code === 'ENOENT') continue // Promotion/cleanup raced the sample.
        throw new CatalogHttpError(503, 'STORAGE_UNSAFE', 'Storage katalog tidak aman atau tidak dapat dibaca. Jalankan inspeksi recovery offline.')
      }
      const disk = await statfs(config.dataDir, { bigint: true })
      const id = randomUUID()
      const admitted = transaction(db, () => {
        if (db.prepare('SELECT generation FROM catalog_capacity WHERE id = 1').get().generation !== generation) return false
        db.prepare('DELETE FROM catalog_uploads WHERE expires_at <= ?').run(Date.now())
        const usage = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(reserved_bytes), 0) AS bytes FROM catalog_uploads').get()
        if (usage.n >= config.catalogUploadLimit) throw new CatalogHttpError(429, 'UPLOAD_BUSY', 'Batas upload bersamaan tercapai. Coba lagi sebentar.')
        // Conservatively count full reservations as well as physical staging;
        // active uploads may temporarily make admission stricter, never looser.
        if (physical + usage.bytes + bytes > config.catalogQuotaBytes) throw new CatalogHttpError(507, 'CATALOG_QUOTA_EXCEEDED', 'Kuota storage katalog tidak cukup. Bersihkan aset yang tidak digunakan.')
        if (disk.bavail * disk.bsize < BigInt(config.catalogMinFreeBytes + usage.bytes + bytes)) throw new CatalogHttpError(507, 'STORAGE_FULL', 'Ruang disk tidak cukup untuk menerima upload dengan aman.')
        db.prepare('INSERT INTO catalog_uploads VALUES (?, ?, ?)').run(id, bytes, Date.now() + config.catalogUploadTimeoutMs)
        bump()
        return true
      })
      if (admitted) return { id, check: () => check(id), release: () => release(id) }
    }
    throw new CatalogHttpError(503, 'STORAGE_BUSY', 'Storage sedang berubah. Ulangi upload sebentar lagi.')
  }
  async function cleanup() {
    if (stopped) return
    if (running) return running
    running = (async () => {
      const jobs = db.prepare('SELECT * FROM catalog_cleanup WHERE next_at <= ? ORDER BY next_at LIMIT 32').all(Date.now())
      for (const job of jobs) {
        if (stopped) break
        try {
          // Final keys are immutable, never reused or attached to a different
          // publication. A restore promotes NEW keys; no resurrection race.
          if (!activeReference(db, job.folder, job.storage_key)) await storage.removeUnreferenced(job.folder, job.storage_key)
          db.prepare('DELETE FROM catalog_cleanup WHERE folder = ? AND storage_key = ?').run(job.folder, job.storage_key)
        } catch {
          db.prepare('UPDATE catalog_cleanup SET attempts = attempts + 1, next_at = ? WHERE folder = ? AND storage_key = ?')
            .run(Date.now() + Math.min(300000, 1000 * 2 ** Math.min(job.attempts, 8)), job.folder, job.storage_key)
          log?.warn('Pembersihan aset katalog tertunda; akan dicoba kembali.')
        }
      }
    })().finally(() => { running = null })
    return running
  }
  const timer = setInterval(() => { cleanup().catch(error => log?.error(error)) }, 1000)
  timer.unref()
  return {
    reserve, cleanup,
    async close() { stopped = true; clearInterval(timer); await running },
  }
}
