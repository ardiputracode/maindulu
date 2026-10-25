import { readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { AuthError, createLimiter } from './auth/limits.mjs'
import { protectRequest } from './auth/security.mjs'
import { transaction } from './auth/mutations.mjs'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export class BackupError extends AuthError {
  constructor(status, code, message) { super(status, message); this.code = code }
}
export const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export function parseOperation(v) {
  if (v === undefined) return undefined
  if (!v || typeof v.id !== 'string' || !uuid.test(v.id) || !['replace', 'preserve'].includes(v.action) || !['conflict', 'import', 'restore'].includes(v.reason)) throw new BackupError(400, 'INVALID_SAVE', 'Keputusan save tidak valid.')
  if (v.action === 'preserve' && v.reason !== 'conflict') throw new BackupError(400, 'INVALID_SAVE', 'Cadangan sesi hanya untuk keputusan konflik.')
  return { id: v.id, action: v.action, reason: v.reason }
}
export function parseProvenance(m) {
  if (m.provenance === undefined) return {}
  const p = m.provenance
  if (!p || !['browser', 'file'].includes(p.source) || p.sourceBuild !== 'unknown' || p.confirmedForTarget !== true) throw new BackupError(400, 'INVALID_SAVE', 'Asal save impor tidak valid.')
  return { provenance: { source: p.source, sourceBuild: 'unknown', confirmedForTarget: true } }
}
export function usedBytes(db, user) {
  return db.prepare(`SELECT (SELECT COALESCE(SUM(size), 0) FROM saves WHERE user_id = ?)
    + (SELECT COALESCE(SUM(size), 0) FROM game_saves WHERE user_id = ?)
    + (SELECT COALESCE(SUM(size), 0) FROM save_backups WHERE user_id = ?) AS size`).get(user, user, user).size
}
export function referenced(db, kind, key) {
  return !!db.prepare(`SELECT 1 FROM ${kind === 'state' ? 'saves' : 'game_saves'} WHERE blob_key = ?
    UNION ALL SELECT 1 FROM save_backups WHERE kind = ? AND blob_key = ? LIMIT 1`).get(key, kind, key)
}
export function readSaveBlob(config, kind, row) {
  try {
    if (!/^[a-f0-9-]{36}\.bin$/.test(row.blob_key)) throw new Error()
    const path = join(config.dataDir, kind === 'state' ? 'saves' : 'game-saves', row.blob_key)
    if (realpathSync(path) !== path) throw new Error()
    const bytes = readFileSync(path)
    if (bytes.length !== row.size || digest(bytes) !== row.checksum) throw new Error()
    return bytes
  } catch { throw new BackupError(503, 'SAVE_DAMAGED', 'Berkas save/cadangan hilang atau rusak. Penggantian ditahan; pulihkan backup server.') }
}
export function archive(db, kind, user, row, reason, sourceRevision = row.revision ?? null) {
  if (db.prepare('SELECT COUNT(*) AS n FROM save_backups WHERE user_id = ?').get(user).n >= 5000) throw new BackupError(409, 'BACKUP_LIMIT', 'Batas 5.000 cadangan tercapai. Hapus cadangan pilihan sendiri dahulu.')
  const id = randomUUID()
  db.prepare(`INSERT INTO save_backups (id, user_id, kind, game_id, console_id, core, slot, title, metadata, source_revision, size, checksum, blob_key, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, user, kind, row.game_id, row.console_id, row.core, row.slot ?? 0, row.title, row.metadata, sourceRevision, row.size, row.checksum, row.blob_key, reason, Date.now())
  return id
}
export function decisionReceipt(db, user, kind, v) {
  if (!v.operation) return null
  const fingerprint = digest(JSON.stringify({ kind, ...v }))
  const old = db.prepare('SELECT * FROM save_decisions WHERE user_id = ? AND operation_id = ?').get(user, v.operation.id)
  if (old) {
    if (old.fingerprint !== fingerprint) throw new BackupError(409, 'OPERATION_CONFLICT', 'ID keputusan sudah dipakai untuk payload berbeda.')
    return { replay: JSON.parse(old.result), fingerprint }
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM save_decisions WHERE user_id = ?').get(user).n >= 20000) throw new BackupError(409, 'DECISION_LIMIT', 'Batas keputusan akun tercapai. Hubungi pengelola; data tidak dihapus otomatis.')
  return { fingerprint }
}
export function recordDecision(db, user, v, receipt, result) {
  if (v.operation) db.prepare('INSERT INTO save_decisions VALUES (?, ?, ?, ?)').run(user, v.operation.id, receipt.fingerprint, JSON.stringify(result))
}
const publicBackup = r => ({ id: r.id, kind: r.kind, gameId: r.game_id, consoleId: r.console_id, core: r.core, slot: r.slot, title: r.title, metadata: JSON.parse(r.metadata), sourceRevision: r.source_revision, size: r.size, checksum: r.checksum, reason: r.reason, createdAt: r.created_at })

export function registerSaveBackups(app, config, security) {
  const db = app.database
  const consume = createLimiter()
  function owner(request) {
    const user = security.current(request).user_id
    if (!user) throw new AuthError(401, 'Silakan masuk terlebih dahulu.')
    if (request.headers['x-save-user'] !== user) throw new BackupError(409, 'ACCOUNT_CHANGED', 'Akun berubah. Operasi dihentikan.')
    return user
  }
  function row(request) {
    const user = owner(request)
    if (!uuid.test(request.params.id)) throw new BackupError(400, 'INVALID_SAVE', 'ID cadangan tidak valid.')
    const r = db.prepare('SELECT * FROM save_backups WHERE id = ? AND user_id = ?').get(request.params.id, user)
    if (!r) throw new BackupError(404, 'SAVE_NOT_FOUND', 'Cadangan tidak ditemukan.')
    return r
  }
  app.register(async api => {
    api.addHook('onRequest', async request => {
      protectRequest(request, config, security.current, ['application/json'])
      consume('backups:' + owner(request), 120, 60000)
    })
    api.get('/', async request => ({ backups: db.prepare('SELECT * FROM save_backups WHERE user_id = ? ORDER BY created_at DESC, id').all(owner(request)).map(publicBackup), usage: { usedBytes: usedBytes(db, owner(request)), quotaBytes: config.saveQuotaBytes } }))
    api.get('/:id', async (request, reply) => {
      const r = row(request)
      return reply.type('application/octet-stream').header('X-Save-Metadata', encodeURIComponent(JSON.stringify(publicBackup(r)))).send(readSaveBlob(config, r.kind, r))
    })
    api.post('/:id/delete', async request => {
      const old = transaction(db, () => {
        const r = row(request)
        if (request.body?.checksum !== r.checksum) throw new BackupError(409, 'REVISION_CONFLICT', 'Cadangan berubah. Muat ulang daftar.')
        db.prepare('DELETE FROM save_backups WHERE id = ? AND user_id = ?').run(r.id, owner(request))
        return r
      })
      // Collect under the same write lock as uploads/reference creation.
      transaction(db, () => {
        if (!referenced(db, old.kind, old.blob_key)) {
          try { unlinkSync(join(config.dataDir, old.kind === 'state' ? 'saves' : 'game-saves', old.blob_key)) }
          catch (e) { if (e.code !== 'ENOENT') app.log.warn('Pembersihan cadangan ditunda sampai restart.') }
        }
      })
      return { ok: true }
    })
  }, { prefix: '/api/save-backups' })
}
