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
import { registerSaveBackups } from './save-backups.mjs'
import { registerAdmin } from './admin.mjs'
import { createCatalogStorage } from './catalog/storage.mjs'
import { registerCatalog } from './catalog/routes.mjs'
import cookie from '@fastify/cookie'
import { randomUUID } from 'node:crypto'
import { createGate } from './auth/gate.mjs'
import { hashPassword, hashRecoveryCode, recoveryCode } from './auth/crypto.mjs'

const pages = ['/', '/index.html', '/console', '/library', '/riwayat', '/favorit', '/cara-bermain', '/pengaturan', '/tentang', '/main', '/admin', '/admin/games', '/admin/bios', '/admin/scan', '/admin/metadata']
const assetDirectories = new Set(['assets', 'vendor', 'player', 'catalog', 'games', 'bios', 'covers'])
const backendMarker = '<meta name="maindulu-backend" content="enabled" />'

export async function createApp({ env = process.env, root, logger = false, metadataDependencies } = {}) {
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
  // Node's transport timeout is server-wide; route lifecycle timeouts retain the
  // 30s account/save limit while only catalog upload routes get a longer window.
  const app = Fastify({ logger, bodyLimit: 64 * 1024, requestTimeout: Math.max(30000, config.catalogUploadTimeoutMs),
    // A 240-character basename can exceed the router's default 100-byte param
    // cap, especially after UTF-8 URL encoding. ID validators stay unchanged.
    routerOptions: { maxParamLength: 3072 } })
  app.server.headersTimeout = 30000
  app.addHook('onRoute', options => {
    // File downloads are not inbound API processing: do not terminate a large
    // stream merely because the client needs longer than 30s to receive it.
    if (options.url.startsWith('/api/')) options.handlerTimeout ??= 30000
  })
  app.decorate('appConfig', config)
  app.decorate('database', db)
  app.addHook('onClose', async () => db.close())
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    reply.header('Cache-Control', 'no-store')
    reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex')
  })
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AuthError) {
      if (error.retryAfter) reply.header('Retry-After', String(error.retryAfter))
      return reply.code(error.statusCode).send({ error: error.message, ...(error.code ? { code: error.code } : {}) })
    }
    const status = error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500
    // JSON/parser errors can quote the supplied body. Never log expected client
    // errors: a malformed login body may contain a password, hash or cookie.
    if (status === 500) request.log.error(error)
    reply.code(status).send({ error: status === 500 ? 'Terjadi kesalahan pada server.' : 'Permintaan tidak valid.' })
  })
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'Halaman atau berkas tidak ditemukan.' }))
  app.get('/api/health', async (_request, reply) => {
    try { db.prepare('SELECT 1').get() }
    catch { return reply.code(503).send({ error: 'Penyimpanan server belum tersedia.' }) }
    return { service: 'maindulu', apiVersion: 1, status: 'ok', capabilities: { gate: true, accounts: true, serverSaves: true, gameSaves: true, admin: true, gameCatalog: true, biosCatalog: true, metadata: true, catalogScan: true } }
  })
  try {
    await app.register(cookie)
    const gate = createGate(config, db)
    const publicExact = new Set([...pages, '/robots.txt', '/api/health', '/api/gate/login', '/api/gate/session', '/api/gate/logout'])
    app.addHook('onRequest', async request => {
      const path = request.url.split('?')[0]
      // Do not let encoded separators or dot segments turn a public asset URL
      // into a protected path in the static resolver.
      const unambiguous = !/%|\\/.test(path) && !path.split('/').some(part => part === '.' || part === '..')
      if (publicExact.has(path) || (unambiguous && ['/assets/', '/vendor/', '/player/'].some(prefix => path.startsWith(prefix)))) return
      gate.guard(request)
    })
    app.post('/api/gate/login', gate.login)
    app.get('/api/gate/session', async request => gate.session(request))
    app.post('/api/gate/logout', gate.logout)
    // Keep crawler policy readable without a gate session, including on builds
    // made before robots.txt was added. This does not grant access to content.
    app.get('/robots.txt', (_request, reply) => reply.type('text/plain; charset=utf-8').send('User-agent: *\nDisallow: /\n'))
    if (config.defaultUsername && !db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
      const passwordHash = await hashPassword(config.defaultPassword)
      // Recheck under SQLite's write lock after the asynchronous KDF.
      db.exec('BEGIN IMMEDIATE')
      try {
        if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) db.prepare('INSERT INTO users (id, username, password_hash, recovery_code_hash, created_at, role) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), config.defaultUsername, passwordHash, hashRecoveryCode(recoveryCode()), Date.now(), 'admin')
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
    }
    const storage = await createCatalogStorage(config, db)
    const security = registerAuth(app, config)
    registerAdmin(app, security)
    registerCatalog(app, config, security, storage, metadataDependencies)
    registerSaves(app, config, security)
    registerGameSaves(app, config, security)
    registerSaveBackups(app, config, security)
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
          return isWithin(file, config.distDir) && (!['assets', 'vendor', 'player'].includes(parts[0]) || isWithin(file, resolve(config.distDir, parts[0]))) && statSync(file).isFile()
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
