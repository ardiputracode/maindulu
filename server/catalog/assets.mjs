import { catalogDto } from './queries.mjs'
import { validId, fileName } from './validation.mjs'
import { CatalogHttpError } from './errors.mjs'

const missing = () => new CatalogHttpError(404, 'ASSET_NOT_FOUND', 'Aset katalog tidak ditemukan.')
function byteRange(header, size) {
  if (typeof header !== 'string' || header.includes(',')) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2])) return null
  let start, end
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix < 1) return false
    start = Math.max(0, size - suffix); end = size - 1
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return false
    end = Math.min(size - 1, end)
  }
  return { start, end }
}
function contentType(name) {
  const ext = name.split('.').pop().toLowerCase()
  return ({ zip: 'application/zip', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar' })[ext] ?? 'application/octet-stream'
}

export function registerCatalogAssets(app, repository, storage) {
  function rowFor(kind, id) {
    if (!validId(id)) throw missing()
    const row = repository.get(kind, id)
    if (!row) throw missing()
    return row
  }
  async function serve(request, reply, kind, cover = false) {
    const row = rowFor(kind, request.params.id)
    const key = cover ? row.cover_storage_key : row.storage_key
    if (!key) throw missing()
    if (!cover) {
      try { fileName(kind, row.original_name, row.console_id) } catch { throw missing() }
      if (request.params.filename !== row.original_name) throw missing()
    }
    let file
    try {
      file = await storage.open(cover ? 'covers' : kind, key)
      const size = cover ? row.cover_size : row.size
      if ((await file.stat()).size !== size) throw new Error('Size mismatch')
      // Delete or cover replacement may have committed while opening the file.
      const current = repository.get(kind, row.id)
      if (!current || (cover ? current.cover_storage_key : current.storage_key) !== key) throw missing()
      reply.type(cover ? row.cover_type : contentType(row.original_name))
        .header('Accept-Ranges', 'bytes').header('Cache-Control', 'no-store')
      if (!cover) reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.original_name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`)
      const range = request.headers['if-range'] ? null : byteRange(request.headers.range, size)
      if (range === false) {
        await file.close(); file = null
        return reply.code(416).header('Content-Range', `bytes */${size}`).send()
      }
      const start = range?.start ?? 0, end = range?.end ?? size - 1
      if (range) reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`)
      reply.header('Content-Length', String(end - start + 1))
      if (request.method === 'HEAD') { await file.close(); file = null; return reply.send() }
      const stream = file.createReadStream({ start, end, autoClose: true })
      file = null // Stream owns the safe, already opened handle.
      return reply.send(stream)
    } catch (error) {
      await file?.close()
      if (error instanceof CatalogHttpError) throw error
      if (error.code === 'ENOENT') throw missing()
      throw new CatalogHttpError(503, 'ASSET_UNAVAILABLE', 'Berkas katalog tidak tersedia atau rusak. Hubungi pengelola.')
    }
  }
  app.get('/games/:id/rom', async (request, reply) => {
    const row = rowFor('games', request.params.id)
    return reply.redirect(catalogDto('games', row).url)
  })
  app.route({ method: ['GET', 'HEAD'], url: '/games/:id/rom/:filename', handler: (request, reply) => serve(request, reply, 'games') })
  app.route({ method: ['GET', 'HEAD'], url: '/games/:id/cover', handler: (request, reply) => serve(request, reply, 'games', true) })
  app.route({ method: ['GET', 'HEAD'], url: '/bios/:id/:filename', handler: (request, reply) => serve(request, reply, 'bios') })
}
