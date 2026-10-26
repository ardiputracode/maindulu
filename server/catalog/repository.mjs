import { randomUUID } from 'node:crypto'
import { transaction } from '../auth/mutations.mjs'
import { enqueueCleanup } from './maintenance.mjs'

const consoles = new Set(['nes', 'snes', 'gb', 'gba', 'megadrive', 'psx'])
const types = new Set(['image/png', 'image/jpeg', 'image/webp'])
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/

export class CatalogError extends Error {
  constructor(code, message, id) { super(message); this.code = code; this.id = id }
}
const invalid = () => new CatalogError('INVALID_CATALOG', 'Metadata atau berkas katalog tidak valid.')
function table(kind) {
  if (!['games', 'bios'].includes(kind)) throw invalid()
  return kind
}
function text(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw invalid()
  if (required && /[\r\n\t]/.test(value)) throw invalid()
  return value.trim()
}
export function safeOriginalName(value) {
  text(value, 240, true)
  if (value !== value.trim() || /[/\\:*?"<>|\x00-\x1f\x7f]/.test(value) || /[. ]$/.test(value) || value === '.' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) throw invalid()
  return value
}
function metadata(kind, value, patch = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const title = kind === 'games' ? 'title' : 'name'
  const rights = kind === 'games' ? 'license' : 'distributionRights'
  const allowed = patch ? [title, 'description', rights] : [title, 'consoleId', 'fileName', 'description', rights]
  if (Object.keys(value).some(key => !allowed.includes(key))) throw invalid()
  const result = {}
  if (!patch || Object.hasOwn(value, title)) result[title] = text(value[title], 200, true)
  for (const [key, max] of [['description', 10000], [rights, 2000]]) {
    if (!patch || Object.hasOwn(value, key)) result[key] = text(value[key] ?? '', max)
  }
  if (!patch) {
    if (!consoles.has(value.consoleId)) throw invalid()
    result.consoleId = value.consoleId
    result.fileName = safeOriginalName(value.fileName)
  }
  return result
}

export function createCatalogRepository(db, storage, { check = () => {}, onPromoted = () => {} } = {}) {
  function authorize(actor) {
    check(actor)
    if (typeof actor !== 'string' || db.prepare('SELECT role FROM users WHERE id = ?').get(actor)?.role !== 'admin') throw new CatalogError('ADMIN_REQUIRED', 'Hanya admin aktif yang dapat mengelola katalog.')
  }
  function get(kind, id, { includeDeleted = false } = {}) {
    table(kind)
    if (typeof id !== 'string' || !uuid.test(id)) throw invalid()
    return db.prepare(`SELECT * FROM ${kind} WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`).get(id) ?? null
  }
  function duplicate(row) {
    return new CatalogError(row.deleted_at === null ? 'CATALOG_DUPLICATE' : 'CATALOG_RESTORE_REQUIRED', row.deleted_at === null ? 'Berkas sudah ada pada console ini.' : 'Berkas pernah dihapus; pemulihan ID lama harus dipilih secara eksplisit.', row.id)
  }
  async function promote(kind, stage) {
    if (!storage.ownsStage(stage, kind)) throw invalid()
    const file = await storage.promote(stage)
    onPromoted(file)
    return file
  }
  function coverFields(cover) {
    if (cover === null) return [null, null, null, null]
    if (!cover || !types.has(cover.type) || !storage.ownsFile(cover.file, 'covers')) throw invalid()
    return [cover.file.key, cover.type, cover.file.size, cover.file.sha256]
  }
  return {
    get,
    list(kind) { return db.prepare(`SELECT * FROM ${table(kind)} WHERE deleted_at IS NULL ORDER BY created_at DESC, id`).all() },
    async publish(kind, actor, value, stage, { cover = null, restoreId } = {}) {
      table(kind); authorize(actor)
      const v = metadata(kind, value)
      if (!storage.ownsStage(stage, kind) || (restoreId !== undefined && (typeof restoreId !== 'string' || !uuid.test(restoreId)))) throw invalid()
      if (cover !== null && (!cover || kind !== 'games' || !types.has(cover.type) || !storage.ownsStage(cover.stage, 'covers'))) throw invalid()
      // Files are durable before publication. Errors leave at most unreferenced
      // server-generated files, reclaimed offline, never an active partial row.
      const file = await promote(kind, stage)
      const coverFile = cover ? { file: await promote('covers', cover.stage), type: cover.type } : null
      const fields = coverFields(coverFile)
      return transaction(db, () => {
        authorize(actor) // Role may have been revoked during asynchronous I/O.
        const previous = db.prepare(`SELECT * FROM ${kind} WHERE console_id = ? AND sha256 = ?`).get(v.consoleId, file.sha256)
        if (previous && (previous.deleted_at === null || restoreId !== previous.id)) throw duplicate(previous)
        if (restoreId !== undefined && (!previous || previous.id !== restoreId)) throw invalid()
        const id = previous?.id ?? randomUUID()
        const now = Date.now()
        if (previous) {
          enqueueCleanup(db, kind, previous.storage_key)
          if (kind === 'games' && previous.cover_storage_key) enqueueCleanup(db, 'covers', previous.cover_storage_key)
          db.prepare(`UPDATE ${kind} SET storage_key = ?, original_name = ?, updated_at = ?, deleted_at = NULL WHERE id = ?`).run(file.key, v.fileName, now, id)
        } else {
          const title = kind === 'games' ? 'title' : 'name'
          const rights = kind === 'games' ? 'license' : 'distribution_rights'
          db.prepare(`INSERT INTO ${kind} (id, ${title}, console_id, description, ${rights}, original_name, storage_key, size, sha256, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, v[title], v.consoleId, v.description, kind === 'games' ? v.license : v.distributionRights, v.fileName, file.key, file.size, file.sha256, actor, now, now)
        }
        if (kind === 'games') db.prepare('UPDATE games SET cover_storage_key = ?, cover_type = ?, cover_size = ?, cover_sha256 = ? WHERE id = ?').run(...fields, id)
        return get(kind, id)
      })
    },
    async update(kind, actor, id, value, { cover } = {}) {
      table(kind); authorize(actor)
      const v = metadata(kind, value, true)
      if (cover !== undefined && kind !== 'games') throw invalid()
      let fields
      if (cover !== undefined) {
        if (cover !== null && (!types.has(cover.type) || !storage.ownsStage(cover.stage, 'covers'))) throw invalid()
        fields = coverFields(cover === null ? null : { file: await promote('covers', cover.stage), type: cover.type })
      }
      return transaction(db, () => {
        authorize(actor)
        const row = get(kind, id)
        if (!row) throw new CatalogError('CATALOG_NOT_FOUND', 'Entri katalog tidak ditemukan.')
        if (fields && row.cover_storage_key) enqueueCleanup(db, 'covers', row.cover_storage_key)
        const title = kind === 'games' ? 'title' : 'name'
        const rights = kind === 'games' ? 'license' : 'distribution_rights'
        db.prepare(`UPDATE ${kind} SET ${title} = ?, description = ?, ${rights} = ?, updated_at = ? WHERE id = ?`)
          .run(v[title] ?? row[title], v.description ?? row.description, v[kind === 'games' ? 'license' : 'distributionRights'] ?? row[rights], Date.now(), id)
        if (fields) db.prepare('UPDATE games SET cover_storage_key = ?, cover_type = ?, cover_size = ?, cover_sha256 = ? WHERE id = ?').run(...fields, id)
        return get(kind, id)
      })
    },
    delete(kind, actor, id) {
      return transaction(db, () => {
        table(kind); authorize(actor)
        const row = get(kind, id, { includeDeleted: true })
        if (!row) throw new CatalogError('CATALOG_NOT_FOUND', 'Entri katalog tidak ditemukan.')
        if (row.deleted_at === null) db.prepare(`UPDATE ${kind} SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(Date.now(), Date.now(), id)
        enqueueCleanup(db, kind, row.storage_key)
        if (kind === 'games' && row.cover_storage_key) enqueueCleanup(db, 'covers', row.cover_storage_key)
        return get(kind, id, { includeDeleted: true })
      })
    },
  }
}
