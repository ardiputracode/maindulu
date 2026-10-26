import multipart from '@fastify/multipart'
import { createCatalogRepository, CatalogError } from './repository.mjs'
import { catalogLimits } from './storage.mjs'
import { createCatalogMaintenance, enqueueCleanup, activeReference } from './maintenance.mjs'
import { metadataFields, fileName, validateCover, listQuery, validId } from './validation.mjs'
import { catalogDto, adminDto, queryCatalog } from './queries.mjs'
import { registerCatalogAssets } from './assets.mjs'
import { CatalogHttpError, invalidCatalog } from './errors.mjs'
import { transaction } from '../auth/mutations.mjs'

const overhead = 128 * 1024
const oversized = () => new CatalogHttpError(413, 'UPLOAD_TOO_LARGE', 'Upload melebihi batas ukuran atau jumlah bagian yang diizinkan.')
const notFound = () => new CatalogHttpError(404, 'CATALOG_NOT_FOUND', 'Entri katalog tidak ditemukan.')

export function registerCatalog(app, config, security, storage) {
  const db = app.database
  const repository = createCatalogRepository(db, storage)
  const maintenance = createCatalogMaintenance(db, storage, config, app.log)
  const operations = new Set()
  app.decorate('catalog', { storage, repository, maintenance })
  app.addHook('onClose', async () => {
    for (const operation of operations) operation.cancel()
    await Promise.allSettled([...operations].map(operation => operation.promise))
    await maintenance.close()
  })

  function errorHandler(error, request, reply) {
    if (error.code === 'FST_ERR_HANDLER_TIMEOUT') return reply.code(503).send({ error: 'Waktu pemrosesan upload berakhir. Ulangi upload.', code: 'UPLOAD_TIMEOUT' })
    if (error instanceof CatalogError) {
      const status = ({ INVALID_CATALOG: 400, ADMIN_REQUIRED: 403, CATALOG_NOT_FOUND: 404, CATALOG_DUPLICATE: 409, CATALOG_RESTORE_REQUIRED: 409 })[error.code] ?? 500
      return reply.code(status).send({ error: error.message, code: error.code, ...(error.id ? { existingId: error.id } : {}) })
    }
    if (error.code === 'ENOSPC' || error.code === 'EDQUOT' || error.code?.startsWith('SQLITE_FULL') || error.errcode === 13) {
      return reply.code(507).send({ error: 'Storage penuh. Upload tidak diterbitkan.', code: 'STORAGE_FULL' })
    }
    if (error.code?.startsWith('FST_') && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: 'Format atau ukuran permintaan upload tidak valid.', code: 'INVALID_UPLOAD' })
    }
    if (error.code === 'CATALOG_EMPTY') error = invalidCatalog('Berkas katalog kosong.')
    if (error.code === 'ERR_STREAM_PREMATURE_CLOSE' || /Unexpected end of (?:multipart|form|file)/i.test(error.message)) error = invalidCatalog('Upload terputus atau multipart tidak lengkap.')
    if (error instanceof CatalogHttpError) {
      if (error.statusCode === 429) reply.header('Retry-After', '1')
      return reply.code(error.statusCode).send({ error: error.message, code: error.code })
    }
    throw error // Parent handles AuthError and redacts unexpected failures.
  }

  async function mutate(request, reply, kind, patch) {
    let actor
    const stages = [], promoted = []
    let failed = false, activeFile, failure, received = 0
    function check() {
      if (failure) throw failure
      if (request.catalogExpired) throw new CatalogHttpError(408, 'UPLOAD_EXPIRED', 'Waktu upload berakhir. Ulangi upload.')
      if (request.raw.aborted || reply.sent) throw invalidCatalog('Upload dibatalkan atau waktu pemrosesan berakhir.')
      request.catalogLease?.check()
      if (security.requireAdmin(request).user_id !== actor) throw new CatalogHttpError(401, 'SESSION_CHANGED', 'Sesi berubah. Ulangi upload.')
    }
    const repo = createCatalogRepository(db, storage, { check, onPromoted: file => promoted.push(file) })
    const onAbort = () => { failure = invalidCatalog('Upload dibatalkan.'); activeFile?.destroy(failure) }
    request.catalogCancel = () => {
      onAbort()
      if (!request.raw.complete) request.raw.destroy(failure)
    }
    const count = chunk => {
      received += chunk.length
      if (received > request.catalogMaxBody) {
        failure = oversized()
        activeFile?.destroy(failure)
        // Stop an unbounded preamble too, not just file/field content. Closing
        // after the response prevents draining an attacker-controlled stream.
        reply.header('Connection', 'close').code(413).send({ error: failure.message, code: failure.code })
        request.raw.unpipe()
        request.raw.destroy(failure)
      }
    }
    request.raw.once('aborted', onAbort)
    try {
      actor = security.requireAdmin(request).user_id
      if (patch && (!validId(request.params.id) || !repository.get(kind, request.params.id))) throw notFound()
      let fields, rom, firmware, cover
      if (request.isMultipart()) {
        fields = Object.create(null)
        const files = new Set()
        request.raw.on('data', count)
        for await (const part of request.parts({ preservePath: true, limits: { files: kind === 'games' && !patch ? 2 : 1, fields: 6, parts: 8, fieldNameSize: 60, fieldSize: 40000, headerPairs: 100, fileSize: patch ? catalogLimits.covers : catalogLimits[kind] } })) {
          check()
          if (part.type === 'field') {
            if (part.fieldnameTruncated || part.valueTruncated || typeof part.value !== 'string' || Object.hasOwn(fields, part.fieldname)) throw invalidCatalog('Field multipart berulang, terpotong, atau tidak valid.')
            fields[part.fieldname] = part.value
          } else {
            const allowed = kind === 'games' ? (patch ? ['cover'] : ['rom', 'cover']) : ['bios']
            if (!allowed.includes(part.fieldname) || files.has(part.fieldname)) { part.file.resume(); throw invalidCatalog('Bagian berkas tidak dikenal atau berulang.') }
            files.add(part.fieldname)
            const folder = part.fieldname === 'cover' ? 'covers' : kind
            activeFile = part.file
            const stage = await storage.stage(folder, (async function* () {
              let size = 0
              for await (const chunk of part.file) {
                check(); size += chunk.length
                if (size > catalogLimits[folder]) throw oversized()
                yield chunk
              }
            })())
            activeFile = null; stages.push(stage)
            if (part.file.truncated) throw oversized()
            const descriptor = { stage, name: part.filename }
            if (part.fieldname === 'rom') rom = descriptor
            else if (part.fieldname === 'bios') firmware = descriptor
            else cover = descriptor
          }
        }
      } else {
        if (!patch) throw new CatalogHttpError(415, 'MULTIPART_REQUIRED', 'Upload baru harus menggunakan multipart/form-data.')
        fields = request.body
      }
      check()
      const v = metadataFields(kind, fields, patch)
      if (cover && v.removeCover) throw invalidCatalog('Pilih ganti atau hapus cover, bukan keduanya.')
      const coverValue = cover ? { stage: cover.stage, type: await validateCover(storage, cover.stage) } : v.removeCover ? null : undefined
      check()
      let row
      if (patch) row = await repo.update(kind, actor, request.params.id, v.metadata, { cover: coverValue })
      else {
        const primary = kind === 'games' ? rom : firmware
        if (!primary) throw invalidCatalog('Berkas ROM/BIOS wajib dipilih.')
        v.metadata.fileName = fileName(kind, primary.name, v.metadata.consoleId)
        row = await repo.publish(kind, actor, v.metadata, primary.stage, { cover: coverValue ?? null, restoreId: v.restoreId })
      }
      return reply.code(patch || v.restoreId ? 200 : 201).send({ item: catalogDto(kind, row) })
    } catch (error) { failed = true; reply.header('Connection', 'close'); throw error }
    finally {
      request.raw.removeListener('data', count)
      request.raw.removeListener('aborted', onAbort)
      for (const stage of stages) if (storage.ownsStage(stage, stage.kind)) {
        try { await storage.discard(stage) } catch { app.log.warn('Staging upload tertinggal; gunakan recovery offline.') }
      }
      if (failed && promoted.length) {
        // Never compensate without a successful fresh database reference check.
        try {
          transaction(db, () => {
            for (const file of promoted) if (!activeReference(db, file.kind, file.key)) enqueueCleanup(db, file.kind, file.key)
          })
        } catch { app.log.warn('Kompensasi upload ditunda; periksa recovery offline.') }
      }
      request.catalogWorkDone = true
      request.catalogCancel = null
      clearTimeout(request.catalogTimer)
      release(request)
    }
  }

  function release(request) {
    if (request.catalogLease) {
      request.catalogLease.release()
      request.catalogLease = null
    }
  }
  app.register(async api => {
    api.setErrorHandler(errorHandler)
    await api.register(multipart, { attachFieldsToBody: false, preservePath: true })
    api.addHook('onRequest', async (request, reply) => {
      if (!request.routeOptions.config.catalogUpload) return
      // Guard runs BEFORE parser/admission/disk access, including bad boundaries.
      const { kind, patch } = request.routeOptions.config.catalogUpload
      security.protectAdmin(request, { multipart: !patch || kind === 'games' })
      // Keep an independent wall deadline through hashing/fsync/publication.
      // IncomingMessage's normal close after the body may clear a framework's
      // lifecycle timeout even though asynchronous finalization is still busy.
      request.catalogTimer = setTimeout(() => {
        request.catalogExpired = true
        if (!reply.sent) reply.header('Connection', 'close').code(503).send({ error: 'Waktu pemrosesan upload berakhir. Ulangi upload.', code: 'UPLOAD_TIMEOUT' })
      }, config.catalogUploadTimeoutMs)
      request.catalogTimer.unref()
      if (!request.headers['content-type']?.toLowerCase().startsWith('multipart/form-data')) return
      if (!/;\s*boundary=(?:"[^"\r\n]{1,70}"|[^;\s]{1,70})(?:\s*;|\s*$)/i.test(request.headers['content-type'])) throw invalidCatalog('Boundary multipart tidak valid atau tidak tersedia.')
      const max = (patch ? catalogLimits.covers : catalogLimits[kind] + (kind === 'games' ? catalogLimits.covers : 0)) + overhead
      const length = request.headers['content-length']
      if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) < 1 || Number(length) > max)) throw oversized()
      request.catalogMaxBody = length === undefined ? max : Number(length)
      const operation = { promise: maintenance.reserve(request.catalogMaxBody), cancel: () => request.raw.destroy() }
      operations.add(operation)
      try { request.catalogLease = await operation.promise } finally { operations.delete(operation) }
      if (reply.sent || request.raw.aborted) { release(request); return }
    })
    // A timeout/abort may send the response before async staging has stopped.
    // Keep its reservation until mutate's finally, not merely until onResponse.
    api.addHook('onResponse', async request => {
      clearTimeout(request.catalogTimer)
      if (request.catalogMutating && !request.catalogWorkDone) request.catalogCancel?.()
      if (!request.catalogMutating || request.catalogWorkDone) release(request)
    })
    api.addHook('onRequestAbort', async request => {
      clearTimeout(request.catalogTimer)
      if (!request.catalogMutating) release(request)
    })
    for (const kind of ['games', 'bios']) {
      api.get(`/api/${kind}`, async request => {
        const { rows, ...page } = queryCatalog(db, kind, listQuery(request.query))
        return { items: rows.map(row => catalogDto(kind, row)), ...page }
      })
      api.get(`/api/${kind}/:id`, async request => {
        if (!validId(request.params.id)) throw notFound()
        const row = repository.get(kind, request.params.id)
        if (!row) throw notFound()
        return { item: catalogDto(kind, row) }
      })
      api.get(`/api/admin/${kind}`, { onRequest: async request => { security.protectAdmin(request) } }, async request => {
        const { rows, ...page } = queryCatalog(db, kind, listQuery(request.query, true))
        return { items: await Promise.all(rows.map(row => adminDto(db, storage, kind, row))), ...page }
      })
      for (const patch of [false, true]) api.route({
        method: patch ? 'PATCH' : 'POST', url: `/api/admin/${kind}${patch ? '/:id' : ''}`,
        config: { catalogUpload: { kind, patch } },
        handlerTimeout: config.catalogUploadTimeoutMs,
        handler: async (request, reply) => {
          request.catalogMutating = true
          const operation = { promise: mutate(request, reply, kind, patch), cancel: () => request.catalogCancel?.() }
          operations.add(operation)
          try { return await operation.promise } finally { operations.delete(operation) }
        },
      })
      api.delete(`/api/admin/${kind}/:id`, { onRequest: async request => { security.protectAdmin(request) } }, async request => {
        const actor = security.requireAdmin(request).user_id
        if (!validId(request.params.id)) throw notFound()
        const row = repository.delete(kind, actor, request.params.id)
        return { ok: true, id: row.id, deletedAt: row.deleted_at, cleanupPending: true }
      })
    }
  })
  registerCatalogAssets(app, repository, storage)
}
