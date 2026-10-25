import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { readFile, realpath } from 'node:fs/promises'
import { realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isWithin, readConfig } from './config.mjs'
import { openDatabase } from './database.mjs'
import { registerAuth } from './auth/routes.mjs'
import { AuthError } from './auth/limits.mjs'
import { registerSaves } from './saves.mjs'
import { registerGameSaves } from './game-saves.mjs'

const pages = ['/', '/index.html', '/console', '/riwayat', '/favorit', '/cara-bermain', '/pengaturan', '/main']
const assetDirectories = new Set(['assets', 'vendor', 'player', 'catalog', 'games', 'bios', 'covers'])
const backendMarker = '<meta name="maindulu-backend" content="enabled" />'

export async function createApp({ env = process.env, root, logger = false } = {}) {
  const config = await readConfig(env, root)
  let html
  try {
    const indexPath = await realpath(join(config.distDir, 'index.html'))
    if (!isWithin(indexPath, config.distDir)) throw new Error('index.html tidak boleh menunjuk ke luar folder build.')
    html = await readFile(indexPath, 'utf8')
    if (!html.includes('</head>')) throw new Error('index.html tidak memiliki penutup head.')
  } catch (error) {
    throw new Error('Hasil build tidak valid atau belum tersedia. Jalankan npm run build sebelum npm start.', { cause: error })
  }
  // Only this server's HTML enables discovery. An unchanged static build makes
  // no API requests, and a failed configured backend never becomes "disabled".
  html = html.replace('</head>', backendMarker + '</head>')
  const db = await openDatabase(config.dataDir)
  const app = Fastify({ logger, bodyLimit: 64 * 1024, requestTimeout: 30000 })
  app.decorate('appConfig', config)
  app.decorate('database', db)
  app.addHook('onClose', async () => db.close())
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    reply.header('Cache-Control', 'no-store')
  })
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AuthError) {
      if (error.retryAfter) reply.header('Retry-After', String(error.retryAfter))
      return reply.code(error.statusCode).send({ error: error.message, ...(error.code ? { code: error.code } : {}) })
    }
    request.log.error(error)
    const status = error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500
    reply.code(status).send({ error: status === 500 ? 'Terjadi kesalahan pada server.' : 'Permintaan tidak valid.' })
  })
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'Halaman atau berkas tidak ditemukan.' }))
  app.get('/api/health', async (_request, reply) => {
    try { db.prepare('SELECT 1').get() }
    catch { return reply.code(503).send({ error: 'Penyimpanan server belum tersedia.' }) }
    return { service: 'maindulu', apiVersion: 1, status: 'ok', capabilities: { accounts: true, serverSaves: true, gameSaves: true } }
  })
  try {
    const security = registerAuth(app, config)
    registerSaves(app, config, security)
    registerGameSaves(app, config, security)
    for (const page of pages) app.get(page, (_request, reply) => reply.type('text/html; charset=utf-8').send(html))
    await app.register(fastifyStatic, {
      root: config.distDir,
      index: false,
      list: false,
      redirect: false,
      dotfiles: 'deny',
      cacheControl: false,
      allowedPath(pathname, staticRoot) {
        // A static root is operator-controlled. Reject private files even if a
        // symlink/junction is accidentally added under an allowed asset folder.
        const parts = pathname.replace(/^\//, '').split('/')
        if (!assetDirectories.has(parts[0]) || parts.some(part => part.startsWith('.')) || /\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm))?$/i.test(pathname)) return false
        try {
          const file = realpathSync(resolve(staticRoot, '.' + pathname))
          return isWithin(file, config.distDir) && statSync(file).isFile()
        }
        catch { return false }
      },
    })
    await app.ready()
    return app
  } catch (error) {
    await app.close()
    throw error
  }
}
