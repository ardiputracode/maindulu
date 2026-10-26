import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { acquireDataLock } from '../data-lock.mjs'
import { schemaVersion } from '../database.mjs'
import { catalogFolders, createCatalogStorage, openRegular, stagingKeyPattern, storageKeyPattern } from './storage.mjs'

// Never called as a startup sweep: shared server leases also permit other
// processes whose in-flight uploads have no database reference yet.
export async function recoverCatalogStorage(config, { remove = false } = {}) {
  const release = await acquireDataLock(config.dataDir, true)
  let db
  try {
    const storage = await createCatalogStorage(config)
    const database = await openRegular(join(config.dataDir, 'maindulu.sqlite'))
    await database.close()
    db = new DatabaseSync(join(config.dataDir, 'maindulu.sqlite'), { readOnly: true })
    db.exec('PRAGMA trusted_schema = OFF; PRAGMA query_only = ON;')
    if (db.prepare('PRAGMA user_version').get().user_version !== schemaVersion) throw new Error('Versi skema recovery tidak cocok; buka dengan aplikasi yang sesuai terlebih dahulu.')
    if (db.prepare('PRAGMA integrity_check').all().some(row => row.integrity_check !== 'ok') || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Integritas SQLite recovery gagal; jangan hapus berkas.')
    const references = new Map()
    const rows = db.prepare(`SELECT 'games' AS folder, storage_key AS key, size, sha256 FROM games WHERE deleted_at IS NULL
      UNION ALL SELECT 'bios', storage_key, size, sha256 FROM bios WHERE deleted_at IS NULL
      UNION ALL SELECT 'covers', cover_storage_key, cover_size, cover_sha256 FROM games WHERE deleted_at IS NULL AND cover_storage_key IS NOT NULL`).all()
    for (const row of rows) {
      if (!storageKeyPattern.test(row.key) || !Number.isSafeInteger(row.size) || row.size < 1 || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('Referensi katalog recovery tidak valid; jangan hapus berkas.')
      const path = row.folder + '/' + row.key
      const previous = references.get(path)
      if (previous && (previous.size !== row.size || previous.sha256 !== row.sha256)) throw new Error('Referensi katalog recovery tidak konsisten; jangan hapus berkas.')
      references.set(path, row)
    }
    const result = { active: references.size, damaged: [], unknown: [], unsafe: [], candidates: [], removed: [], failed: [] }
    for (const row of references.values()) {
      try { await storage.verify(row.folder, row) }
      catch (error) { result.damaged.push({ folder: row.folder, key: row.key, message: error.message }) }
    }
    // Inspect all managed folders before removing anything. Unknown and unsafe
    // entries are never followed, recursively traversed, or unlinked.
    for (const folder of catalogFolders) {
      for (const key of await storage.entries(folder)) {
        if (!(folder === 'uploads' ? stagingKeyPattern : storageKeyPattern).test(key)) { result.unknown.push({ folder, key }); continue }
        if (references.has(folder + '/' + key)) continue
        try {
          const file = await openRegular(await storage.pathFor(folder, key))
          await file.close()
          result.candidates.push({ folder, key })
        } catch (error) { result.unsafe.push({ folder, key, message: error.message }) }
      }
    }
    if (remove) for (const entry of result.candidates) {
      try { await storage.remove(entry.folder, entry.key); result.removed.push(entry) }
      catch (error) { result.failed.push({ ...entry, message: error.message }) }
    }
    return result
  } finally {
    try { db?.close() } finally { release() }
  }
}
