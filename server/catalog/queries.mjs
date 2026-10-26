export function catalogDto(kind, row) {
  const common = { id: row.id, consoleId: row.console_id, fileName: row.original_name, size: row.size, sha256: row.sha256,
    description: row.description, createdAt: row.created_at, updatedAt: row.updated_at }
  return kind === 'games'
    ? { ...common, title: row.title, source: 'server', license: row.license, url: `/games/${row.id}/rom/${encodeURIComponent(row.original_name)}`,
        ...(row.cover_storage_key ? { cover: `/games/${row.id}/cover` } : {}) }
    : { ...common, name: row.name, distributionRights: row.distribution_rights, url: `/bios/${row.id}/${encodeURIComponent(row.original_name)}` }
}

export function queryCatalog(db, kind, v) {
  const name = kind === 'games' ? 'title' : 'name'
  const conditions = [], values = []
  if (v.status !== 'all') conditions.push(v.status === 'deleted' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL')
  if (v.consoleId) { conditions.push('console_id = ?'); values.push(v.consoleId) }
  // instr, rather than LIKE, treats %, _ and user input literally.
  if (v.q) { conditions.push(`instr(lower(${name}), lower(?)) > 0`); values.push(v.q) }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  const order = v.sort === 'title' ? `${name} COLLATE NOCASE, id` : 'created_at DESC, id'
  return {
    rows: db.prepare(`SELECT * FROM ${kind} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...values, v.pageSize, (v.page - 1) * v.pageSize),
    total: db.prepare(`SELECT COUNT(*) AS n FROM ${kind} ${where}`).get(...values).n,
    page: v.page, pageSize: v.pageSize,
  }
}

export async function adminDto(db, storage, kind, row) {
  async function state(folder, key, size) {
    if (!key) return 'none'
    let file
    try {
      file = await storage.open(folder, key)
      return (await file.stat()).size === size ? 'available' : 'damaged'
    } catch (error) { return error.code === 'ENOENT' ? 'missing' : 'unsafe' }
    finally { await file?.close() }
  }
  return { ...catalogDto(kind, row), deletedAt: row.deleted_at,
    fileStatus: await state(kind, row.storage_key, row.size),
    ...(kind === 'games' ? { coverStatus: await state('covers', row.cover_storage_key, row.cover_size) } : {}),
    cleanupPending: !!db.prepare('SELECT 1 FROM catalog_cleanup WHERE (folder = ? AND storage_key = ?) OR (folder = ? AND storage_key = ?) LIMIT 1')
      .get(kind, row.storage_key, 'covers', row.cover_storage_key ?? '') }
}
