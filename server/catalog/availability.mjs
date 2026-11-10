import { fileStatus } from './queries.mjs'

// Called inside the scan's completion transaction. Incomplete/cancelled jobs
// never publish observations, and concurrent upload/delete cannot change keys.
export function reconcileAvailability(db, storage, observations, check, record) {
  let changed = false
  for (const { kind, row, status, file } of observations) {
    check()
    const current = db.prepare(`SELECT * FROM ${kind} WHERE id = ? AND storage_key = ? AND deleted_at IS NULL`).get(row.id, row.storage_key)
    if (!current) continue
    const previous = fileStatus(db, kind, current)
    if (previous === status) continue
    try {
      if (file) storage.claimAdoption(file, false)
      else if (storage.scanFileState(kind, row.platform, row.file_name, row.size) !== status) continue
    } catch { continue } // Parent/path changed since verification: retry a scan.
    if (status === 'available') db.prepare('DELETE FROM catalog_file_status WHERE folder = ? AND entry_id = ?').run(kind, row.id)
    else db.prepare(`INSERT INTO catalog_file_status VALUES (?, ?, ?, ?)
      ON CONFLICT(folder, entry_id) DO UPDATE SET storage_key = excluded.storage_key, status = excluded.status`)
      .run(kind, row.id, row.storage_key, status)
    changed = true
    const result = status === 'available' ? 'restored' : status
    const message = status === 'available' ? 'Byte identik tersedia kembali; ID, metadata, dan save dipertahankan.'
      : status === 'missing' ? 'Berkas hilang; disembunyikan dari Library tanpa menghapus metadata/save.'
        : status === 'damaged' ? 'Isi/ukuran berubah; disembunyikan dari Library. Kembalikan byte asli lalu scan ulang.'
          : 'Berkas tidak aman; disembunyikan dari Library. Perbaiki sumber lalu scan ulang.'
    record(`${kind === 'games' ? 'roms' : 'bios'}/${row.platform}/${row.file_name}`, { status: result, message, existingId: row.id })
  }
  if (changed) db.prepare('UPDATE catalog_revision SET revision = revision + 1 WHERE id = 1').run()
}
