import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync, backup } from 'node:sqlite'
import { canonicalPath, isWithin } from './config.mjs'
import { acquireDataLock } from './data-lock.mjs'
import { schemaVersion } from './database.mjs'

const databaseName = 'maindulu.sqlite'
const blobName = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.bin$/
const checksum = /^[a-f0-9]{64}$/
const allowedFile = path => path === databaseName || /^(saves|game-saves)\//.test(path) && blobName.test(path.split('/')[1]) && path.split('/').length === 2
const fail = message => { throw new Error(message) }

async function safeEntry(path, directory = false) {
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail('Berkas/folder backup tidak aman; symlink, hard link, dan berkas khusus ditolak.')
  return stat
}

async function privatePath(config, input) {
  if (typeof input !== 'string' || !input.trim()) fail('Path backup/restore harus diisi.')
  const path = await canonicalPath(resolve(input))
  for (const served of [config.distDir, config.publicDir]) {
    if (isWithin(path, served) || isWithin(served, path)) fail('Backup/restore harus di luar folder publik dan hasil build.')
  }
  return path
}

function disjoint(a, b) {
  if (isWithin(a, b) || isWithin(b, a)) fail('Folder backup, data, dan restore harus terpisah; tidak boleh saling memuat.')
}

async function absent(path) {
  try { await lstat(path) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  fail('Folder tujuan sudah ada. Gunakan nama folder baru; data lama tidak ditimpa.')
}

async function fingerprint(path) {
  const stat = await safeEntry(path)
  const hash = createHash('sha256')
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    let size = 0, n
    while ((n = (await file.read(buffer, 0, buffer.length, null)).bytesRead)) { hash.update(buffer.subarray(0, n)); size += n }
    if (size !== stat.size) fail('Berkas berubah saat verifikasi backup.')
    return { size, checksum: hash.digest('hex') }
  } finally { await file.close() }
}

async function sync(path, directory = false) {
  if (directory && process.platform === 'win32') return
  const fd = await open(path, directory ? 'r' : 'r+')
  try { await fd.sync() } finally { await fd.close() }
}

async function copy(source, target) {
  await safeEntry(source)
  await copyFile(source, target, constants.COPYFILE_EXCL)
  await chmod(target, 0o600)
  await sync(target)
}

function inspectDatabase(db, { legacy = false } = {}) {
  db.exec('PRAGMA trusted_schema = OFF; PRAGMA query_only = ON;')
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (version !== schemaVersion && !(legacy && version === 7)) fail('Versi skema backup tidak cocok. Gunakan versi aplikasi yang sesuai; jangan paksa migrasi/downgrade.')
  if (db.prepare('PRAGMA integrity_check').all().some(row => row.integrity_check !== 'ok') || db.prepare('PRAGMA foreign_key_check').all().length) fail('Integritas SQLite backup gagal.')
  if (version === 7) {
    if (db.prepare("SELECT name FROM sqlite_master WHERE name IN ('games', 'bios')").all().length) fail('Katalog backup tidak didukung sebelum Milestone 7; jangan gunakan backup yang mengabaikan aset katalog.')
  } else if (db.prepare('SELECT 1 FROM games UNION ALL SELECT 1 FROM bios LIMIT 1').get()) {
    fail('Katalog backup belum didukung sebelum Milestone 7. Backup dibatalkan karena ROM/BIOS/cover belum dapat dicadangkan lengkap, termasuk entri terhapus.')
  }
  const installationId = db.prepare("SELECT value FROM app_metadata WHERE key = 'installation_id'").get()?.value
  if (typeof installationId !== 'string') fail('Identitas instalasi backup tidak valid.')
  const files = new Map()
  const rows = db.prepare(`SELECT 'saves' AS folder, blob_key, size, checksum FROM saves WHERE blob_key IS NOT NULL
    UNION ALL SELECT 'game-saves', blob_key, size, checksum FROM game_saves WHERE blob_key IS NOT NULL
    UNION ALL SELECT CASE kind WHEN 'state' THEN 'saves' ELSE 'game-saves' END, blob_key, size, checksum FROM save_backups`).all()
  for (const row of rows) {
    if (!blobName.test(row.blob_key) || !Number.isSafeInteger(row.size) || row.size < 1 || !checksum.test(row.checksum)) fail('Referensi blob database tidak valid.')
    const path = row.folder + '/' + row.blob_key
    const previous = files.get(path)
    if (previous && (previous.size !== row.size || previous.checksum !== row.checksum)) fail('Referensi blob database tidak konsisten.')
    files.set(path, { size: row.size, checksum: row.checksum })
  }
  const counts = {}
  for (const table of ['users', 'saves', 'game_saves', 'save_backups', 'save_decisions']) counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
  if (version === schemaVersion) for (const table of ['games', 'bios']) counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
  return { installationId, files, counts, version }
}

async function refuseCatalogAssets(source) {
  for (const folder of ['games', 'bios', 'covers']) {
    const path = join(source, folder)
    try { await safeEntry(path, true) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if ((await readdir(path)).length) fail('Katalog backup belum didukung sebelum Milestone 7. Folder aset katalog tidak kosong; backup dibatalkan agar tidak mengabaikan berkas.')
  }
}

async function tree(folder) {
  await safeEntry(folder, true)
  const paths = []
  for (const name of await readdir(folder)) {
    const path = join(folder, name)
    if (['saves', 'game-saves'].includes(name)) {
      await safeEntry(path, true)
      for (const file of await readdir(path)) {
        if (!blobName.test(file)) fail('Isi folder backup tidak dikenal.')
        await safeEntry(join(path, file))
        paths.push(name + '/' + file)
      }
    } else {
      if (![databaseName, 'manifest.json'].includes(name)) fail('Isi folder backup tidak dikenal; WAL/SHM atau berkas ekstra tidak diterima.')
      await safeEntry(path)
      paths.push(name)
    }
  }
  return paths
}

async function verify(folder) {
  const actual = await tree(folder)
  if ((await safeEntry(join(folder, 'manifest.json'))).size > 64 * 1024 * 1024) fail('Manifest backup terlalu besar.')
  const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'))
  if (manifest?.format !== 'maindulu-data-backup' || manifest.formatVersion !== 1 || ![7, schemaVersion].includes(manifest.schemaVersion) || !Array.isArray(manifest.files) || manifest.files.length > 500000 || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))) fail('Format/versi manifest backup tidak didukung.')
  const files = new Map()
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !allowedFile(file.path) || files.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 1 || !checksum.test(file.checksum)) fail('Daftar berkas manifest backup tidak valid.')
    files.set(file.path, file)
  }
  if (!files.has(databaseName) || actual.length !== files.size + 1 || actual.some(path => path !== 'manifest.json' && !files.has(path))) fail('Daftar berkas backup tidak lengkap atau berlebih.')
  for (const [path, file] of files) {
    const result = await fingerprint(join(folder, path))
    if (result.size !== file.size || result.checksum !== file.checksum) fail('Ukuran/checksum backup tidak sesuai; jangan gunakan backup ini.')
  }
  const db = new DatabaseSync(join(folder, databaseName), { readOnly: true })
  let info
  try { info = inspectDatabase(db, { legacy: true }) } finally { db.close() }
  if (info.version !== manifest.schemaVersion || info.installationId !== manifest.installationId || JSON.stringify(info.counts) !== JSON.stringify(manifest.counts) || info.files.size + 1 !== files.size) fail('Metadata manifest tidak cocok dengan database.')
  for (const [path, row] of info.files) {
    const file = files.get(path)
    if (!file || file.size !== row.size || file.checksum !== row.checksum) fail('Referensi blob backup hilang/tidak cocok dengan database.')
  }
  return manifest
}

async function publish(stage, target) {
  for (const folder of ['saves', 'game-saves']) await sync(join(stage, folder), true)
  await sync(stage, true)
  await absent(target)
  await rename(stage, target)
  await sync(dirname(target), true)
}

// Callers provide a config from readConfig; no application database migrations run here.
export async function createDataBackup(config, input) {
  const source = config.dataDir
  const target = await privatePath(config, input)
  disjoint(source, target)
  await safeEntry(source, true)
  await safeEntry(join(source, databaseName))
  await absent(target)
  const releaseSource = await acquireDataLock(source, true)
  let releaseTarget, stage
  try {
    await refuseCatalogAssets(source)
    releaseTarget = await acquireDataLock(target, true)
    stage = await mkdtemp(join(dirname(target), '.' + basename(target) + '.partial-'))
    await chmod(stage, 0o700)
    for (const folder of ['saves', 'game-saves']) await mkdir(join(stage, folder), { mode: 0o700 })
    const db = new DatabaseSync(join(source, databaseName), { readOnly: true })
    let info
    try { info = inspectDatabase(db); await backup(db, join(stage, databaseName)) } finally { db.close() }
    // Make the snapshot self-contained, with no WAL/SHM dependency.
    const snapshot = new DatabaseSync(join(stage, databaseName))
    try { snapshot.exec('PRAGMA journal_mode = DELETE;') } finally { snapshot.close() }
    await chmod(join(stage, databaseName), 0o600)
    await sync(join(stage, databaseName))
    const files = [{ path: databaseName, ...await fingerprint(join(stage, databaseName)) }]
    for (const [path, row] of info.files) {
      await safeEntry(dirname(join(source, path)), true)
      await copy(join(source, path), join(stage, path))
      const result = await fingerprint(join(stage, path))
      if (result.size !== row.size || result.checksum !== row.checksum) fail('Blob sumber hilang/rusak; backup dibatalkan tanpa mengubah data.')
      files.push({ path, ...result })
    }
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    let engineBuildsChecksum = null
    try { engineBuildsChecksum = (await fingerprint(join(config.distDir, 'player/builds.json'))).checksum }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const configuration = {}
    for (const key of ['host', 'port', 'registrationOpen', 'publicOrigin', 'allowInsecureHttp', 'stateMaxBytes', 'gameSaveMaxBytes', 'saveQuotaBytes']) configuration[key] = config[key]
    const manifest = { format: 'maindulu-data-backup', formatVersion: 1, schemaVersion, createdAt: new Date().toISOString(), appVersion: pkg.version, nodeVersion: process.versions.node, engineBuildsChecksum, installationId: info.installationId, counts: info.counts, configuration, files }
    await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await sync(join(stage, 'manifest.json'))
    await verify(stage)
    await publish(stage, target)
    stage = null
    return manifest
  } finally {
    try { if (stage) await rm(stage, { recursive: true, force: true }) }
    finally { try { releaseTarget?.() } finally { releaseSource() } }
  }
}

export async function verifyDataBackup(config, input) {
  const source = await privatePath(config, input)
  disjoint(source, config.dataDir)
  const release = await acquireDataLock(source, true)
  try { return await verify(source) } finally { release() }
}

export async function restoreDataBackup(config, input, destination) {
  const source = await privatePath(config, input)
  const target = await privatePath(config, destination)
  disjoint(source, target)
  disjoint(source, config.dataDir)
  // Restoring onto the configured data path is allowed only when it does not exist.
  if (target !== config.dataDir) disjoint(target, config.dataDir)
  await absent(target)
  const releaseSource = await acquireDataLock(source, true)
  let releaseCurrent, releaseTarget, stage
  try {
    // Also exclude the currently configured installation: its old players must
    // not continue writing while the operator prepares a rollback alongside it.
    if (target !== config.dataDir) releaseCurrent = await acquireDataLock(config.dataDir, true)
    releaseTarget = await acquireDataLock(target, true)
    const manifest = await verify(source)
    stage = await mkdtemp(join(dirname(target), '.' + basename(target) + '.partial-'))
    await chmod(stage, 0o700)
    for (const folder of ['saves', 'game-saves']) await mkdir(join(stage, folder), { mode: 0o700 })
    for (const file of manifest.files) await copy(join(source, file.path), join(stage, file.path))
    // Verify the copied bytes too; never mutate the source backup to revoke sessions.
    for (const file of manifest.files) {
      const result = await fingerprint(join(stage, file.path))
      if (result.size !== file.size || result.checksum !== file.checksum) fail('Salinan restore berubah/rusak; pemulihan dibatalkan.')
    }
    const db = new DatabaseSync(join(stage, databaseName))
    try {
      inspectDatabase(db, { legacy: true })
      db.exec('PRAGMA query_only = OFF; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; BEGIN IMMEDIATE; DELETE FROM sessions; COMMIT;')
      inspectDatabase(db, { legacy: true })
    } finally { db.close() }
    await sync(join(stage, databaseName))
    await publish(stage, target)
    stage = null
    return manifest
  } finally {
    try { if (stage) await rm(stage, { recursive: true, force: true }) }
    finally {
      try { releaseTarget?.() }
      finally { try { releaseCurrent?.() } finally { releaseSource() } }
    }
  }
}
