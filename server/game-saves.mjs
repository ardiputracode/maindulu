import { mkdirSync, readdirSync, realpathSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, unlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { transaction } from './auth/mutations.mjs'
import { AuthError, createLimiter } from './auth/limits.mjs'
import { protectRequest } from './auth/security.mjs'
import { decodeGameSave, gameSaveLayout } from '../src/lib/game-save-format.ts'

const cores = { nes: 'fceumm', psx: 'pcsx_rearmed' }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const blobName = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(?:bin|tmp)$/
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
class GameSaveError extends AuthError {
  constructor(status, code, message) { super(status, message); this.code = code }
}
const invalid = () => new GameSaveError(400, 'INVALID_SAVE', 'Paket atau metadata progres tidak valid.')
const conflict = () => new GameSaveError(409, 'REVISION_CONFLICT', 'Progres server berubah. Sinkronisasi dihentikan; unduh cadangan sebelum membuka ulang game.')
function publicSave(row) {
  return { id: row.id, gameId: row.game_id, consoleId: row.console_id, core: row.core, title: row.title,
    revision: row.revision, size: row.size, checksum: row.checksum, updatedAt: row.updated_at, deleted: row.blob_key === null, metadata: JSON.parse(row.metadata) }
}
function parseMetadata(header) {
  if (typeof header !== 'string' || header.length > 4096) throw invalid()
  let v
  try { v = JSON.parse(decodeURIComponent(header)) } catch { throw invalid() }
  if (!v || typeof v !== 'object' || typeof v.gameId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(v.gameId) || !Object.hasOwn(cores, v.consoleId) || cores[v.consoleId] !== v.core || !Number.isSafeInteger(v.expectedRevision) || v.expectedRevision < 0 || typeof v.title !== 'string' || !v.title.length || v.title.length > 200 || /[\x00-\x1f]/.test(v.title) || !/^[a-f0-9]{64}$/.test(v.checksum)) throw invalid()
  if (v.gameId.startsWith('local-') && !new RegExp(`^local-${v.consoleId}-[a-f0-9]{64}$`).test(v.gameId)) throw invalid()
  const m = v.metadata
  if (!m || m.formatVersion !== 1 || m.layout !== gameSaveLayout(v.core) || typeof m.engineVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.engineVersion) || m.engineVersion.length > 30 || !['normal', 'legacy'].includes(m.variant) || !/^[a-f0-9]{64}$/.test(m.coreBuild) || !/^[a-f0-9]{64}$/.test(m.runtimeBuild)) throw invalid()
  return { ...v, metadata: { formatVersion: 1, layout: m.layout, engineVersion: m.engineVersion, variant: m.variant, coreBuild: m.coreBuild, runtimeBuild: m.runtimeBuild } }
}

export function registerGameSaves(app, config, security) {
  const db = app.database
  // Separate namespace: the M5 orphan collector must never sweep M6 blobs.
  const folder = join(config.dataDir, 'game-saves')
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  if (realpathSync(folder) !== folder) throw new Error('Folder game-saves tidak boleh berupa symlink/junction.')
  function remove(key) { try { unlinkSync(join(folder, key)) } catch (e) { if (e.code !== 'ENOENT') app.log.warn('Pembersihan progres ditunda sampai restart.') } }
  transaction(db, () => {
    const live = new Set(db.prepare('SELECT blob_key FROM game_saves WHERE blob_key IS NOT NULL').all().map(r => r.blob_key))
    for (const name of readdirSync(folder)) if (blobName.test(name) && !live.has(name)) remove(name)
  })
  function owner(request) {
    const session = security.current(request)
    if (!session.user_id) throw new AuthError(401, 'Silakan masuk terlebih dahulu.')
    if (request.headers['x-save-user'] !== session.user_id) throw new GameSaveError(409, 'ACCOUNT_CHANGED', 'Akun berubah. Sinkronisasi progres dihentikan.')
    return session.user_id
  }
  function usage(user) {
    return { usedBytes: db.prepare('SELECT (SELECT COALESCE(SUM(size), 0) FROM saves WHERE user_id = ?) + (SELECT COALESCE(SUM(size), 0) FROM game_saves WHERE user_id = ?) AS size').get(user, user).size, quotaBytes: config.saveQuotaBytes, maxGameSaveBytes: config.gameSaveMaxBytes }
  }
  function rowFor(id, user) {
    if (!uuid.test(id)) throw invalid()
    const row = db.prepare('SELECT * FROM game_saves WHERE id = ? AND user_id = ?').get(id, user)
    if (!row?.blob_key) throw new GameSaveError(404, 'SAVE_NOT_FOUND', 'Progres tidak ditemukan.')
    return row
  }
  function readBlob(row) {
    try {
      if (!blobName.test(row.blob_key) || realpathSync(join(folder, row.blob_key)) !== join(folder, row.blob_key)) throw new Error('Unsafe blob')
      const bytes = readFileSync(join(folder, row.blob_key))
      if (bytes.length !== row.size || digest(bytes) !== row.checksum) throw new Error('Damaged blob')
      return bytes
    } catch { throw new GameSaveError(503, 'SAVE_DAMAGED', 'Progres hilang/rusak. Jangan mulai baru; pulihkan backup server.') }
  }
  const consume = createLimiter()
  let uploads = 0
  app.register(async api => {
    api.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: config.gameSaveMaxBytes }, (_request, body, done) => done(null, body))
    api.addHook('onRequest', async request => {
      protectRequest(request, config, security.current, [request.method === 'PUT' ? 'application/octet-stream' : 'application/json'])
      const user = owner(request)
      consume('progress:' + user, 120, 60000)
      if (request.method === 'PUT') {
        consume('progress-upload:' + user, 30, 60000)
        if (uploads >= 2) throw new AuthError(429, 'Server sedang menyimpan progres lain.', 1)
        uploads++; request.gameSaveUpload = true
      }
    })
    function release(request) { if (request.gameSaveUpload) { uploads--; request.gameSaveUpload = false } }
    api.addHook('onResponse', async request => release(request))
    api.addHook('onRequestAbort', async request => release(request))
    api.get('/', async request => {
      const user = owner(request)
      return { saves: db.prepare('SELECT * FROM game_saves WHERE user_id = ? ORDER BY updated_at DESC, id').all(user).map(publicSave), usage: usage(user) }
    })
    api.get('/:id', async (request, reply) => {
      const row = rowFor(request.params.id, owner(request))
      const bytes = readBlob(row)
      return reply.type('application/octet-stream').header('X-Save-Metadata', encodeURIComponent(JSON.stringify(publicSave(row)))).send(bytes)
    })
    api.put('/', { bodyLimit: config.gameSaveMaxBytes }, async (request, reply) => {
      const v = parseMetadata(request.headers['x-save-metadata'])
      const bytes = request.body
      if (!Buffer.isBuffer(bytes) || digest(bytes) !== v.checksum) throw invalid()
      try { if (decodeGameSave(bytes).layout !== v.metadata.layout) throw invalid() } catch { throw invalid() }
      const user = owner(request)
      let newKey, previous, saved, replay = false
      try {
        saved = transaction(db, () => {
          owner(request)
          previous = db.prepare('SELECT * FROM game_saves WHERE user_id = ? AND game_id = ? AND console_id = ? AND core = ?').get(user, v.gameId, v.consoleId, v.core)
          // Exact immediate replay is safe if the previous response was lost.
          if (previous?.blob_key && previous.revision === v.expectedRevision + 1 && previous.checksum === v.checksum && previous.metadata === JSON.stringify(v.metadata)) { readBlob(previous); replay = true; return previous }
          if ((previous?.revision ?? 0) !== v.expectedRevision) throw conflict()
          if (!previous && db.prepare('SELECT COUNT(*) AS count FROM game_saves WHERE user_id = ?').get(user).count >= 5000) throw new GameSaveError(409, 'IDENTITY_LIMIT', 'Batas identitas progres akun tercapai.')
          if (usage(user).usedBytes - (previous?.size ?? 0) + bytes.length > config.saveQuotaBytes) throw new GameSaveError(409, 'QUOTA_EXCEEDED', 'Kuota akun tidak cukup. Progres lama tetap aman; unduh cadangan atau kelola simpanan.')
          const fileId = randomUUID()
          newKey = fileId + '.tmp'
          const fd = openSync(join(folder, newKey), 'wx', 0o600)
          try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
          renameSync(join(folder, newKey), join(folder, fileId + '.bin'))
          newKey = fileId + '.bin'
          if (process.platform !== 'win32') { const dir = openSync(folder, 'r'); try { fsyncSync(dir) } finally { closeSync(dir) } }
          const id = previous?.id ?? randomUUID()
          db.prepare(`INSERT INTO game_saves (id, user_id, game_id, console_id, core, title, metadata, revision, size, checksum, blob_key, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET title=excluded.title, metadata=excluded.metadata, revision=excluded.revision, size=excluded.size, checksum=excluded.checksum, blob_key=excluded.blob_key, updated_at=excluded.updated_at`)
            .run(id, user, v.gameId, v.consoleId, v.core, v.title, JSON.stringify(v.metadata), (previous?.revision ?? 0) + 1, bytes.length, v.checksum, newKey, Date.now())
          return db.prepare('SELECT * FROM game_saves WHERE id = ?').get(id)
        })
      } catch (error) {
        if (newKey) { try { if (!db.prepare('SELECT id FROM game_saves WHERE blob_key = ?').get(newKey)) remove(newKey) } catch { app.log.warn('Pembersihan progres ditunda.') } }
        throw error
      }
      if (!replay && previous?.blob_key) remove(previous.blob_key)
      return reply.code(replay || previous?.blob_key ? 200 : 201).send({ save: publicSave(saved), usage: usage(user) })
    })
    api.post('/:id/delete', async request => {
      const user = owner(request)
      const old = transaction(db, () => {
        owner(request)
        const row = rowFor(request.params.id, user)
        if (request.body?.expectedRevision !== row.revision) throw conflict()
        db.prepare('UPDATE game_saves SET blob_key = NULL, size = 0, revision = revision + 1, updated_at = ? WHERE id = ?').run(Date.now(), row.id)
        return row
      })
      remove(old.blob_key)
      return { ok: true, usage: usage(user) }
    })
  }, { prefix: '/api/game-saves' })
}
