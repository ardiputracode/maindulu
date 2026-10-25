import { mkdirSync, readdirSync, realpathSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, unlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { transaction } from './auth/mutations.mjs'
import { AuthError, createLimiter } from './auth/limits.mjs'
import { protectRequest } from './auth/security.mjs'
import { archive, decisionReceipt, parseOperation, parseProvenance, readSaveBlob, recordDecision, referenced, usedBytes } from './save-backups.mjs'

const cores = { nes: 'fceumm', snes: 'snes9x', gb: 'gambatte', gba: 'mgba', megadrive: 'genesis_plus_gx', psx: 'pcsx_rearmed' }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const blobName = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(?:bin|tmp)$/
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
class SaveError extends AuthError {
  constructor(status, code, message) { super(status, message); this.code = code }
}
const invalid = () => new SaveError(400, 'INVALID_SAVE', 'Identitas, slot, metadata, atau berkas state tidak valid.')
const conflict = () => new SaveError(409, 'REVISION_CONFLICT', 'Ada konflik simpanan. Versi server berubah; muat ulang daftar. State terbaru dapat diunduh sebagai cadangan.')

function publicSave(row) {
  return { id: row.id, gameId: row.game_id, consoleId: row.console_id, core: row.core, slot: row.slot, title: row.title,
    revision: row.revision, size: row.size, checksum: row.checksum, updatedAt: row.updated_at, deleted: row.blob_key === null, metadata: JSON.parse(row.metadata) }
}
function parseMetadata(header) {
  if (typeof header !== 'string' || header.length > 4096) throw invalid()
  let v
  try { v = JSON.parse(decodeURIComponent(header)) } catch { throw invalid() }
  if (!v || typeof v !== 'object' || typeof v.gameId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(v.gameId) || typeof v.consoleId !== 'string' || !Object.hasOwn(cores, v.consoleId) || cores[v.consoleId] !== v.core || !Number.isInteger(v.slot) || (v.slot !== 99 && (v.slot < 1 || v.slot > 3)) || !Number.isSafeInteger(v.expectedRevision) || v.expectedRevision < 0 || typeof v.title !== 'string' || v.title.length < 1 || v.title.length > 200 || /[\x00-\x1f]/.test(v.title)) throw invalid()
  if (v.gameId.startsWith('local-') && !new RegExp(`^local-${v.consoleId}-[a-f0-9]{64}$`).test(v.gameId)) throw invalid()
  const m = v.metadata
  if (v.operation?.reason === 'import' && v.slot === 99) throw invalid()
  if (!m || m.formatVersion !== 1 || typeof m.engineVersion !== 'string' || m.engineVersion.length > 30 || !/^\d+\.\d+\.\d+$/.test(m.engineVersion) || typeof m.coreBuild !== 'string' || !/^[a-f0-9]{64}$/.test(m.coreBuild) || typeof m.runtimeBuild !== 'string' || !/^[a-f0-9]{64}$/.test(m.runtimeBuild) || !['normal', 'legacy'].includes(m.variant) || typeof v.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(v.checksum)) throw invalid()
  return { gameId: v.gameId, consoleId: v.consoleId, core: v.core, slot: v.slot, title: v.title, expectedRevision: v.expectedRevision, checksum: v.checksum,
    operation: parseOperation(v.operation),
    metadata: { formatVersion: 1, engineVersion: m.engineVersion, coreBuild: m.coreBuild, runtimeBuild: m.runtimeBuild, variant: m.variant, ...parseProvenance(m) } }
}

export function registerSaves(app, config, security) {
  const db = app.database
  const folder = join(config.dataDir, 'saves')
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  if (realpathSync(folder) !== folder) throw new Error('Folder saves tidak boleh berupa symlink/junction.')
  function remove(key) { try { unlinkSync(join(folder, key)) } catch (error) { if (error.code !== 'ENOENT') app.log.warn('Pembersihan berkas save tertunda; akan dicoba saat restart.') } }
  // SQLite owns references; crash leftovers are only reclaimed while holding the
  // same write lock used by uploads, never by an uncoordinated background sweep.
  transaction(db, () => {
    const live = new Set(db.prepare("SELECT blob_key FROM saves WHERE blob_key IS NOT NULL UNION SELECT blob_key FROM save_backups WHERE kind = 'state'").all().map(r => r.blob_key))
    for (const name of readdirSync(folder)) if (blobName.test(name) && !live.has(name)) remove(name)
  })
  const consume = createLimiter()
  let uploads = 0
  function owner(request) {
    const session = security.current(request)
    if (!session.user_id) throw new AuthError(401, 'Silakan masuk terlebih dahulu.')
    // This is a consistency assertion, NOT an owner selector. Ownership always
    // comes from the database session, including after cross-tab cookie changes.
    if (request.headers['x-save-user'] !== session.user_id) throw new SaveError(409, 'ACCOUNT_CHANGED', 'Akun berubah. Buka ulang permainan sebelum memakai save server.')
    return session.user_id
  }
  function usage(user) {
    return { usedBytes: usedBytes(db, user),
      quotaBytes: config.saveQuotaBytes, maxStateBytes: config.stateMaxBytes, slots: 3 }
  }
  function rowFor(id, user) {
    if (!uuid.test(id)) throw invalid()
    const row = db.prepare('SELECT * FROM saves WHERE id = ? AND user_id = ?').get(id, user)
    if (!row || !row.blob_key) throw new SaveError(404, 'SAVE_NOT_FOUND', 'Simpanan tidak ditemukan.')
    return row
  }
  app.register(async api => {
    api.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: config.stateMaxBytes }, (_request, body, done) => done(null, body))
    api.addHook('onRequest', async request => {
      protectRequest(request, config, security.current, [request.method === 'PUT' ? 'application/octet-stream' : 'application/json'])
      const user = owner(request)
      consume('save:' + user, 120, 60000)
      if (request.method === 'PUT') {
        consume('upload:' + user, 30, 60000)
        if (uploads >= 2) throw new AuthError(429, 'Server sedang menyimpan progres lain. Coba lagi sebentar.', 1)
        uploads++; request.saveUpload = true
      }
    })
    function release(request) { if (request.saveUpload) { uploads--; request.saveUpload = false } }
    api.addHook('onResponse', async request => release(request))
    api.addHook('onRequestAbort', async request => release(request))
    api.get('/', async request => {
      const user = owner(request)
      return { saves: db.prepare('SELECT * FROM saves WHERE user_id = ? ORDER BY updated_at DESC, id').all(user).map(publicSave), usage: usage(user) }
    })
    api.get('/:id', async (request, reply) => {
      const user = owner(request)
      const row = rowFor(request.params.id, user)
      let bytes
      try {
        if (!blobName.test(row.blob_key) || realpathSync(join(folder, row.blob_key)) !== join(folder, row.blob_key)) throw new Error('Unsafe blob')
        bytes = readFileSync(join(folder, row.blob_key))
      }
      catch { throw new SaveError(503, 'SAVE_DAMAGED', 'Berkas save tidak tersedia. Pulihkan backup server.') }
      if (bytes.length !== row.size || digest(bytes) !== row.checksum) throw new SaveError(503, 'SAVE_DAMAGED', 'Checksum save tidak sesuai. Jangan timpa simpanan ini; pulihkan backup server.')
      return reply.type('application/octet-stream').header('X-Save-Metadata', encodeURIComponent(JSON.stringify(publicSave(row)))).send(bytes)
    })
    api.put('/', { bodyLimit: config.stateMaxBytes }, async (request, reply) => {
      const v = parseMetadata(request.headers['x-save-metadata'])
      const bytes = request.body
      if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > config.stateMaxBytes || bytes.subarray(0, 7).toString() !== 'RASTATE' || digest(bytes) !== v.checksum) throw invalid()
      let newKey, previous, replay = false
      const user = owner(request)
      let saved
      try {
        saved = transaction(db, () => {
          owner(request)
          const receipt = decisionReceipt(db, user, 'state', v)
          if (receipt?.replay) { replay = true; return receipt.replay }
          previous = db.prepare('SELECT * FROM saves WHERE user_id = ? AND game_id = ? AND console_id = ? AND core = ? AND slot = ?').get(user, v.gameId, v.consoleId, v.core, v.slot)
          if ((previous?.revision ?? 0) !== v.expectedRevision) throw conflict()
          if (!previous && db.prepare('SELECT COUNT(*) AS count FROM saves WHERE user_id = ?').get(user).count >= 5000) throw new SaveError(409, 'IDENTITY_LIMIT', 'Batas identitas save akun tercapai. Hubungi pengelola server.')
          if (usage(user).usedBytes - (v.operation ? 0 : previous?.size ?? 0) + bytes.length > config.saveQuotaBytes) throw new SaveError(409, 'QUOTA_EXCEEDED', 'Kuota tidak cukup, termasuk cadangan. Save sebelumnya tetap aman. Hapus cadangan pilihan sendiri dahulu.')
          if (v.operation && previous?.blob_key) readSaveBlob(config, 'state', previous)
          const fileId = randomUUID()
          const temp = fileId + '.tmp'
          const fd = openSync(join(folder, temp), 'wx', 0o600)
          newKey = temp
          try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
          renameSync(join(folder, temp), join(folder, fileId + '.bin'))
          newKey = fileId + '.bin'
          if (process.platform !== 'win32') { const dir = openSync(folder, 'r'); try { fsyncSync(dir) } finally { closeSync(dir) } }
          let backupId = null
          if (v.operation?.action === 'preserve') {
            backupId = archive(db, 'state', user, { game_id: v.gameId, console_id: v.consoleId, core: v.core, slot: v.slot, title: v.title, metadata: JSON.stringify(v.metadata), size: bytes.length, checksum: v.checksum, blob_key: newKey }, 'conflict-local')
            const result = { save: previous ? publicSave(previous) : null, backupId }
            recordDecision(db, user, v, receipt, result)
            return result
          }
          if (v.operation && previous?.blob_key) backupId = archive(db, 'state', user, previous, v.operation.reason)
          const id = previous?.id ?? randomUUID()
          db.prepare(`INSERT INTO saves (id, user_id, game_id, console_id, core, slot, title, metadata, revision, size, checksum, blob_key, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET title=excluded.title, metadata=excluded.metadata, revision=excluded.revision, size=excluded.size, checksum=excluded.checksum, blob_key=excluded.blob_key, updated_at=excluded.updated_at`)
            .run(id, user, v.gameId, v.consoleId, v.core, v.slot, v.title, JSON.stringify(v.metadata), (previous?.revision ?? 0) + 1, bytes.length, v.checksum, newKey, Date.now())
          const result = { save: publicSave(db.prepare('SELECT * FROM saves WHERE id = ?').get(id)), backupId }
          recordDecision(db, user, v, receipt, result)
          return result
        })
      } catch (error) {
        // Prefer an orphan over deleting a referenced file if an I/O error made
        // the COMMIT outcome uncertain or the database cannot be queried safely.
        if (newKey) {
          try { transaction(db, () => { if (!referenced(db, 'state', newKey)) remove(newKey) }) }
          catch { app.log.warn('Pembersihan save baru ditunda sampai restart.') }
        }
        throw error
      }
      if (previous?.blob_key) transaction(db, () => { if (!referenced(db, 'state', previous.blob_key)) remove(previous.blob_key) })
      return reply.code(replay || previous?.blob_key ? 200 : 201).send({ ...saved, usage: usage(user) })
    })
    api.post('/:id/delete', async request => {
      const user = owner(request)
      const old = transaction(db, () => {
        owner(request)
        const row = rowFor(request.params.id, user)
        if (request.body?.expectedRevision !== row.revision) throw conflict()
        db.prepare('UPDATE saves SET blob_key = NULL, size = 0, revision = revision + 1, updated_at = ? WHERE id = ?').run(Date.now(), row.id)
        return row
      })
      transaction(db, () => { if (!referenced(db, 'state', old.blob_key)) remove(old.blob_key) })
      return { ok: true, usage: usage(user) }
    })
  }, { prefix: '/api/saves' })
}
