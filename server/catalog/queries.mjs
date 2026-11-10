export function catalogDto(kind, row) {
  const common = { id: row.id, consoleId: row.console_id, fileName: row.original_name, size: row.size, sha256: row.sha256,
    description: row.description, createdAt: row.created_at, updatedAt: row.updated_at }
  return kind === 'games'
    ? { ...common, title: row.title, source: 'server', license: row.license, url: `/games/${row.id}/rom/${encodeURIComponent(row.original_name)}`,
        ...(row.cover_storage_key ? { cover: `/games/${row.id}/cover`, coverRevision: row.cover_sha256 } : {}),
        ...(row.scan_status ? { metadataStatus: ['queued', 'running', 'retry_wait'].includes(row.scan_status) ? 'pending' : row.scan_status === 'succeeded' ? 'ready' : row.scan_status === 'disabled' ? 'disabled' : 'review' } : {}),
        ...(row.metadata_revision ? { metadataRevision: row.metadata_revision } : {}),
        ...(row.release_date ? { releaseDate: row.release_date, releasePrecision: row.release_precision } : {}),
        ...Object.fromEntries(['genre', 'developer', 'publisher', 'players'].filter(field => row[field]).map(field => [field, row[field]])),
        ...(row.region_language ? { regionLanguage: row.region_language } : {}),
        ...(row.provider_game_id ? { providerGameId: row.provider_game_id } : {}) }
    : { ...common, name: row.name, distributionRights: row.distribution_rights, url: `/bios/${row.id}/${encodeURIComponent(row.original_name)}` }
}

export function fileStatus(db, kind, row) {
  return db.prepare('SELECT status FROM catalog_file_status WHERE folder = ? AND entry_id = ? AND storage_key = ?')
    .get(kind, row.id, row.storage_key)?.status ?? 'available'
}

export function queryCatalog(db, kind, v, { availableOnly = false } = {}) {
  const name = kind === 'games' ? 'title' : 'name'
  const conditions = [], values = []
  if (availableOnly) conditions.push(`NOT EXISTS (SELECT 1 FROM catalog_file_status s WHERE s.folder = '${kind}' AND s.entry_id = ${kind}.id AND s.storage_key = ${kind}.storage_key)`)
  if (v.status !== 'all') conditions.push(v.status === 'deleted' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL')
  if (v.consoleId) { conditions.push('console_id = ?'); values.push(v.consoleId) }
  // instr, rather than LIKE, treats %, _ and user input literally.
  if (v.q) { conditions.push(`instr(lower(${name}), lower(?)) > 0`); values.push(v.q) }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  const order = v.sort === 'title' ? `${name} COLLATE NOCASE, id` : 'created_at DESC, id'
  const from = kind === 'games' ? 'games LEFT JOIN game_metadata ON game_metadata.game_id = games.id' : 'bios'
  const fields = kind === 'games' ? "games.*, game_metadata.release_date, game_metadata.release_precision, game_metadata.genre, game_metadata.developer, game_metadata.publisher, game_metadata.players, game_metadata.region_language, game_metadata.provider_game_id, game_metadata.metadata_revision, (SELECT status FROM metadata_jobs WHERE game_id = games.id ORDER BY generation DESC LIMIT 1) AS scan_status" : 'bios.*'
  return {
    rows: db.prepare(`SELECT ${fields} FROM ${from} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...values, v.pageSize, (v.page - 1) * v.pageSize),
    total: db.prepare(`SELECT COUNT(*) AS n FROM ${from} ${where}`).get(...values).n,
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
  const actual = await state(kind, row.storage_key, row.size)
  const recorded = fileStatus(db, kind, row)
  return { ...catalogDto(kind, row), deletedAt: row.deleted_at,
    storageMode: storage.storageMode(kind, row.storage_key),
    // External open() also rejects changed timestamps. Prefer the scan's known
    // checksum failure over that generic unsafe error, but show a fresh absence.
    fileStatus: actual === 'missing' || recorded === 'available' ? actual : recorded,
    ...(kind === 'games' ? { coverStatus: await state('covers', row.cover_storage_key, row.cover_size) } : {}),
    cleanupPending: !!db.prepare('SELECT 1 FROM catalog_cleanup WHERE (folder = ? AND storage_key = ?) OR (folder = ? AND storage_key = ?) LIMIT 1')
      .get(kind, row.storage_key, 'covers', row.cover_storage_key ?? '') }
}
