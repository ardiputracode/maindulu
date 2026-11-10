import { catalogDto, fileStatus } from './queries.mjs'
import { validId, fileName } from './validation.mjs'
import { CatalogHttpError } from './errors.mjs'

const missing = () => new CatalogHttpError(404, 'ASSET_NOT_FOUND', 'Aset katalog tidak ditemukan.')
function matchesEtag(header, etag) {
  if (typeof header !== 'string') return false
  if (/^[ \t]*\*[ \t]*(?![\s\S])/.test(header)) return true
  // Parse the entire HTTP list before accepting a match. Commas inside opaque
  // tags are data; malformed tails (or a wildcard mixed with tags) never match.
  const tag = /(?:W\/)?("[\x21\x23-\x7e\x80-\xff]*")/y
  let offset = 0, matches = false
  while (offset < header.length) {
    while (header[offset] === ' ' || header[offset] === '\t' || header[offset] === ',') offset++
    if (offset === header.length) break
    tag.lastIndex = offset
    const value = tag.exec(header)
    if (!value) return false
    matches ||= value[1] === etag // Weak comparison for GET/HEAD.
    offset = tag.lastIndex
    while (header[offset] === ' ' || header[offset] === '\t') offset++
    if (offset < header.length && header[offset] !== ',') return false
  }
  return matches
}

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
function uncacheError(reply) {
  if (reply.raw.headersSent) return
  reply.header('Cache-Control', 'no-store')
  for (const name of ['ETag', 'Content-Length', 'Content-Range', 'Content-Disposition', 'Content-Type']) reply.removeHeader(name)
}

export function registerCatalogAssets(app, repository, storage) {
  function rowFor(kind, id) {
    if (!validId(id)) throw missing()
    const row = repository.get(kind, id)
    if (!row || fileStatus(app.database, kind, row) !== 'available') throw missing()
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
      if (!current || fileStatus(app.database, kind, current) !== 'available' || (cover ? current.cover_storage_key : current.storage_key) !== key) throw missing()
      // Storage keys are immutable; reuse the upload hash, not a runtime rehash.
      if (!cover && !/^[a-f0-9]{64}(?![\s\S])/.test(row.sha256)) throw new Error('Invalid asset hash')
      const etag = cover ? null : `"${row.sha256}"`
      reply.type(cover ? row.cover_type : contentType(row.original_name))
        .header('Accept-Ranges', 'bytes').header('Cache-Control', 'no-store')
      if (!cover) reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.original_name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`)
      // Validate availability first, then conditions, and only then Range.
      if (etag && matchesEtag(request.headers['if-none-match'], etag)) {
        await file.close(); file = null
        return reply.code(304).header('ETag', etag).header('Cache-Control', 'private, no-cache').send()
      }
      const range = request.headers['if-range'] ? null : byteRange(request.headers.range, size)
      if (range === false) {
        await file.close(); file = null
        return reply.code(416).header('Content-Range', `bytes */${size}`).send()
      }
      if (etag) reply.header('ETag', etag).header('Cache-Control', 'private, no-cache')
      const start = range?.start ?? 0, end = range?.end ?? size - 1
      if (range) reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`)
      reply.header('Content-Length', String(end - start + 1))
      if (request.method === 'HEAD') { await file.close(); file = null; return reply.send() }
      const stream = file.createReadStream({ start, end, autoClose: true })
      file = null // Stream owns the safe, already opened handle.
      return reply.send(stream)
    } catch (error) {
      // A failure after headers were prepared must not cache an error as an asset.
      uncacheError(reply)
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
  // Stream errors before the first byte run outside serve's try/catch. Fastify
  // can still return an error response then, so clear prepared headers there too.
  const onError = async (_request, reply) => { uncacheError(reply) }
  app.route({ method: ['GET', 'HEAD'], url: '/games/:id/rom/:filename', onError, handler: (request, reply) => serve(request, reply, 'games') })
  app.route({ method: ['GET', 'HEAD'], url: '/games/:id/cover', handler: (request, reply) => serve(request, reply, 'games', true) })
  app.route({ method: ['GET', 'HEAD'], url: '/bios/:id/:filename', onError, handler: (request, reply) => serve(request, reply, 'bios') })
}
