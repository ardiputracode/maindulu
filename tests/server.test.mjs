import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createApp } from '../server/app.mjs'
import { openDatabase } from '../server/database.mjs'
import { readConfig } from '../server/config.mjs'
import { backendFixture } from './helpers/backend-fixture.mjs'

test('backend configuration defaults to loopback and validates port and private data location', async t => {
  const root = await backendFixture(t)
  const config = await readConfig({}, root)
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, 7777)
  assert.equal(config.dataDir, join(root, 'data'))
  const custom = await readConfig({ MAIN_DULU_HOST: '0.0.0.0', MAIN_DULU_PORT: '8888', MAIN_DULU_DATA_DIR: 'private' }, root)
  assert.equal(custom.host, '0.0.0.0')
  assert.equal(custom.port, 8888)
  assert.equal(custom.dataDir, join(root, 'private'))
  for (const port of ['', '0', '-1', '65536', 'abc', '77.5']) await assert.rejects(readConfig({ MAIN_DULU_PORT: port }, root), /MAIN_DULU_PORT/)
  for (const data of ['dist', 'dist/nested', 'public/private', '.']) await assert.rejects(readConfig({ MAIN_DULU_DATA_DIR: data }, root), /Folder data/)
  await assert.rejects(readConfig({ MAIN_DULU_DATA_DIR: '' }, root), /tidak boleh kosong/)
  await assert.rejects(readConfig({ MAIN_DULU_HOST: '' }, root), /tidak boleh kosong/)
  await assert.rejects(readConfig({ MAIN_DULU_DIST_DIR: '' }, root), /tidak boleh kosong/)
})

test('private directory checks follow existing symlink or junction ancestors', async t => {
  const root = await backendFixture(t)
  await symlink(join(root, 'public'), join(root, 'public-alias'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(readConfig({ MAIN_DULU_DATA_DIR: 'public-alias/new-data' }, root), /Folder data/)
})

test('SQLite migrations are atomic, idempotent and preserve metadata across reopen', async t => {
  const root = await backendFixture(t)
  const dataDir = join(root, 'data')
  let db = await openDatabase(dataDir)
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6)
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
    const id = db.prepare("SELECT value FROM app_metadata WHERE key = 'installation_id'").get().value
    db.prepare('INSERT INTO app_metadata (key, value) VALUES (?, ?)').run('persist-test', 'retained')
    db.close()
    db = await openDatabase(dataDir)
    assert.equal(db.prepare("SELECT value FROM app_metadata WHERE key = 'installation_id'").get().value, id)
    assert.equal(db.prepare("SELECT value FROM app_metadata WHERE key = 'persist-test'").get().value, 'retained')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 6)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('users', 'sessions')").get().count, 2)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'saves'").get().count, 1)
  } finally { db.close() }
})

test('a future database version is rejected without destroying its data', async t => {
  const root = await backendFixture(t)
  const dataDir = join(root, 'data')
  const db = await openDatabase(dataDir)
  db.exec('PRAGMA user_version = 999')
  db.close()
  await assert.rejects(openDatabase(dataDir), /lebih baru/)
  const check = new DatabaseSync(join(dataDir, 'maindulu.sqlite'))
  try {
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 999)
    assert.equal(check.prepare('SELECT COUNT(*) AS count FROM app_metadata').get().count, 2)
  } finally { check.close() }
})

test('missing build fails with instructions before creating the database', async t => {
  const root = await backendFixture(t)
  await assert.rejects(createApp({ root, env: { MAIN_DULU_DIST_DIR: 'missing' } }), /npm run build/)
  await assert.rejects(readFile(join(root, 'data/maindulu.sqlite')), { code: 'ENOENT' })
})

test('one server serves SPA pages with runtime discovery and a JSON health endpoint', async t => {
  const root = await backendFixture(t)
  const app = await createApp({ root, env: {} })
  try {
    for (const page of ['/', '/index.html', '/console?console=nes', '/pengaturan', '/main']) {
      const response = await app.inject(page)
      assert.equal(response.statusCode, 200)
      assert.match(response.headers['content-type'], /text\/html/)
      assert.match(response.body, /name="maindulu-backend" content="enabled"/)
      assert.equal(response.headers['cache-control'], 'no-store')
      assert.equal(response.headers['x-content-type-options'], 'nosniff')
    }
    // The marker must never become part of the portable static build.
    assert.doesNotMatch(await readFile(join(root, 'dist/index.html'), 'utf8'), /maindulu-backend/)
    const health = await app.inject('/api/health')
    assert.equal(health.statusCode, 200)
    assert.deepEqual(health.json(), { service: 'maindulu', apiVersion: 1, status: 'ok', capabilities: { accounts: true, serverSaves: true, gameSaves: true } })
    assert.doesNotMatch(health.body, /sqlite|installation_id|dataDir|distDir/)
  } finally { await app.close() }
})

test('asset serving supports HEAD, byte ranges and WASM MIME without directory listing', async t => {
  const root = await backendFixture(t)
  const app = await createApp({ root, env: {} })
  try {
    assert.equal((await app.inject('/assets/app.js')).statusCode, 200)
    const head = await app.inject({ method: 'HEAD', url: '/games/sample.chd' })
    assert.equal(head.statusCode, 200)
    assert.equal(head.headers['content-length'], '10')
    assert.equal(head.body, '')
    const range = await app.inject({ url: '/games/sample.chd', headers: { range: 'bytes=2-5' } })
    assert.equal(range.statusCode, 206)
    assert.equal(range.body, '2345')
    const wasm = await app.inject('/vendor/sample.wasm')
    assert.match(wasm.headers['content-type'], /application\/wasm/)
    for (const path of ['/games/', '/assets/', '/catalog/missing.json', '/vendor/missing.js', '/player/missing.js', '/api/unknown', '/api/health/extra']) {
      const response = await app.inject(path)
      assert.equal(response.statusCode, 404, path)
      assert.match(response.headers['content-type'], /application\/json/)
      assert.doesNotMatch(response.body, /frontend fixture/)
    }
  } finally { await app.close() }
})

test('private files, symlink escapes, dotfiles and encoded traversal are never served', async t => {
  const root = await backendFixture(t)
  const app = await createApp({ root, env: {} })
  try {
    await mkdir(join(root, 'private'), { recursive: true })
    await writeFile(join(root, 'private/secret.txt'), 'PRIVATE-SECRET')
    await writeFile(join(root, 'dist/assets/.env'), 'PRIVATE-SECRET')
    await writeFile(join(root, 'dist/assets/accidental.sqlite'), 'PRIVATE-SECRET')
    await symlink(join(root, 'private'), join(root, 'dist/assets/escape'), process.platform === 'win32' ? 'junction' : 'dir')
    for (const path of ['/data/maindulu.sqlite', '/data/maindulu.sqlite-wal', '/assets/accidental.sqlite', '/assets/.env', '/assets/escape/secret.txt', '/assets/%2e%2e/%2e%2e/private/secret.txt', '/assets/%2eenv', '/assets%2fescape%2fsecret.txt', '/server/app.mjs', '/package.json']) {
      const response = await app.inject(path)
      assert.ok(response.statusCode >= 400, path)
      assert.doesNotMatch(response.body, /PRIVATE-SECRET|SQLite format|frontend fixture/)
    }
  } finally { await app.close() }
})

test('database metadata persists across full server recreation', async t => {
  const root = await backendFixture(t)
  let app = await createApp({ root, env: {} })
  app.database.prepare('INSERT INTO app_metadata (key, value) VALUES (?, ?)').run('restart-proof', 'saved')
  const installation = app.database.prepare("SELECT value FROM app_metadata WHERE key = 'installation_id'").get().value
  await app.close()
  app = await createApp({ root, env: {} })
  try {
    assert.equal((await app.inject('/api/health')).statusCode, 200)
    assert.equal(app.database.prepare("SELECT value FROM app_metadata WHERE key = 'restart-proof'").get().value, 'saved')
    assert.equal(app.database.prepare("SELECT value FROM app_metadata WHERE key = 'installation_id'").get().value, installation)
  } finally { await app.close() }
})

test('the real CLI serves web and API in one process and retains SQLite identity after process restart', async t => {
  const root = await backendFixture(t)
  const reserve = createServer()
  await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve) })
  const port = reserve.address().port
  await new Promise(resolve => reserve.close(resolve))
  const env = { ...process.env, MAIN_DULU_HOST: '127.0.0.1', MAIN_DULU_PORT: String(port), MAIN_DULU_DIST_DIR: join(root, 'dist'), MAIN_DULU_DATA_DIR: join(root, 'data') }
  async function start() {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../server/index.mjs', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await new Promise((resolve, reject) => {
        let output = '', errors = ''
        const timer = setTimeout(() => reject(new Error('Server startup timed out: ' + errors)), 15000)
        child.stdout.on('data', data => {
          output += data.toString()
          if (output.includes('maindulu berjalan di ')) { clearTimeout(timer); resolve() }
        })
        child.stderr.on('data', data => { errors += data.toString() })
        child.once('error', error => { clearTimeout(timer); reject(error) })
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited (${code}): ${errors}`)) })
      })
      return child
    } catch (error) {
      await stop(child)
      throw error
    }
  }
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill('SIGTERM')
    await exited
  }
  function identity() {
    const db = new DatabaseSync(join(root, 'data/maindulu.sqlite'), { readOnly: true })
    try { return db.prepare("SELECT value FROM app_metadata WHERE key = 'installation_id'").get().value }
    finally { db.close() }
  }
  let child = await start()
  try {
    const origin = `http://127.0.0.1:${port}`
    assert.match(await (await fetch(origin + '/pengaturan')).text(), /maindulu-backend/)
    assert.equal((await (await fetch(origin + '/api/health')).json()).service, 'maindulu')
    const first = identity()
    await stop(child)
    child = await start()
    assert.equal((await fetch(origin + '/api/health')).status, 200)
    assert.equal(identity(), first)
  } finally { await stop(child) }
})
