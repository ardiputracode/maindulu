import { constants, lstatSync, realpathSync } from 'node:fs'
import { lstat, mkdir, open, opendir, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isWithin } from '../config.mjs'
import { transaction } from '../auth/mutations.mjs'
import { CatalogHttpError } from './errors.mjs'
import { platformSlugs, safeStorageName, storagePlatform, storageNameIdentity } from './paths.mjs'

export const catalogFolders = Object.freeze(['games', 'bios', 'covers', 'uploads'])
export const catalogLimits = Object.freeze({ games: 768 * 1024 * 1024, bios: 32 * 1024 * 1024, covers: 8 * 1024 * 1024 })
// Absolute end: JavaScript's $ also accepts a trailing line terminator.
export const storageKeyPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.bin(?![\s\S])/
export const stagingKeyPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp(?![\s\S])/
const unsafe = () => new Error('Storage katalog tidak aman; path, symlink/junction, hard link, atau berkas khusus ditolak.')

export async function safeDirectory(path) {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== resolve(path)) throw unsafe()
}

export async function syncDirectory(path) {
  if (process.platform === 'win32') return
  const file = await open(path, 'r')
  try { await file.sync() } finally { await file.close() }
}

// The configured volume is operator-controlled. Check both the pathname and the
// opened inode; do not follow a final symlink or trust an earlier stat alone.
export async function openRegular(path) {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw unsafe()
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const after = await file.stat()
    if (!after.isFile() || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino) throw unsafe()
    return file
  } catch (error) { await file.close(); throw error }
}

export async function fingerprintFile(file, check = () => {}) {
  const before = await file.stat()
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(1024 * 1024)
  let size = 0, n
  while ((n = (await file.read(buffer, 0, buffer.length, size)).bytesRead)) {
    check()
    if (size + n > before.size) throw new Error('Berkas katalog berubah saat verifikasi.')
    hash.update(buffer.subarray(0, n)); size += n
  }
  const after = await file.stat()
  if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Berkas katalog berubah saat verifikasi.')
  return { size, sha256: hash.digest('hex') }
}

export async function createCatalogStorage(config, db) {
  const root = resolve(config.dataDir)
  for (const served of [config.publicDir, config.distDir]) {
    if (isWithin(root, served) || isWithin(served, root)) throw unsafe()
  }
  await safeDirectory(root)
  for (const folder of [...catalogFolders, 'roms']) {
    try { await mkdir(join(root, folder), { mode: 0o700 }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    await safeDirectory(join(root, folder))
  }
  const staged = new WeakSet()
  const adopted = new WeakMap()
  const promoted = new WeakSet()
  const externalRoots = config.externalCatalog ?? {}
  // Validate, never create or chmod operator-owned source directories.
  for (const directory of Object.values(externalRoots)) await safeDirectory(directory)
  const externalMapping = (folder, key) => db?.prepare('SELECT * FROM catalog_external_files WHERE folder = ? AND storage_key = ?').get(folder, key)
  const shared = kind => !!config.externalWritable && !!externalRoots[kind]
  const retireExternal = key => db.prepare("UPDATE catalog_external_files SET state = 'retired' WHERE storage_key = ?").run(key)
  const mapping = (folder, key) => db?.prepare('SELECT * FROM catalog_asset_files WHERE folder = ? AND storage_key = ?').get(folder, key)
  const referenced = (folder, key) => db?.prepare(`SELECT 1 FROM ${folder} WHERE storage_key = ? AND deleted_at IS NULL`).get(key)
  async function namedPath(row, create = false) {
    if (!['games', 'bios'].includes(row.folder) || !platformSlugs.includes(row.platform) || !safeStorageName(row.file_name)
      || storageNameIdentity(row.file_name) !== row.name_identity) throw unsafe()
    await safeDirectory(root)
    if (row.source_root && ((create && !shared(row.folder)) || row.source_root !== externalRoots[row.folder] || row.state === 'retired')) throw Object.assign(new Error('Sumber eksternal tidak terpasang atau konfigurasi berubah.'), { code: 'ENOENT' })
    const base = row.source_root ?? join(root, row.folder === 'games' ? 'roms' : 'bios')
    await safeDirectory(base)
    const directory = join(base, row.platform)
    if (create) {
      try { await mkdir(directory, { mode: row.source_root ? 0o775 : 0o700 }); await syncDirectory(base) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    await safeDirectory(directory)
    return join(directory, row.file_name)
  }
  async function pathFor(folder, key) {
    if (!catalogFolders.includes(folder) || typeof key !== 'string' || !(folder === 'uploads' ? stagingKeyPattern : storageKeyPattern).test(key)) throw unsafe()
    await safeDirectory(root)
    await safeDirectory(join(root, folder))
    const row = externalMapping(folder, key) ?? mapping(folder, key)
    if (row) return namedPath(row)
    return join(root, folder, key)
  }
  async function remove(folder, key) {
    const external = externalMapping(folder, key)
    if (external) {
      if (external.state === 'retired' || referenced(folder, key)) return
      if (external.delete_intent === 'none') {
        // An abandoned scan/reattachment never grants permission to delete.
        if (shared(folder)) retireExternal(key)
        return
      }
      if (!shared(folder) || external.source_root !== externalRoots[folder]) throw new CatalogHttpError(409, 'EXTERNAL_READ_ONLY', 'Pembersihan folder bersama menunggu mode writable dan mount sumber yang sesuai.')
      await safeDirectory(external.source_root)
      const claimed = transaction(db, () => {
        if (referenced(folder, key)) return false
        if (externalMapping(folder, key)?.state === 'deleting') throw new CatalogHttpError(409, 'STORAGE_BUSY', 'Berkas sedang dibersihkan; ulangi nanti.')
        return !!db.prepare("UPDATE catalog_external_files SET state = 'deleting' WHERE storage_key = ? AND state IN ('ready','reserved')").run(key).changes
      })
      if (!claimed) return
      let file
      try {
        const path = await namedPath(external)
        file = await openRegular(path)
        const before = await file.stat()
        // Never delete a RomM replacement, even if it has the same filename.
        if (before.size !== external.size || before.mtimeMs !== external.mtime_ms || before.ctimeMs !== external.ctime_ms) throw unsafe()
        const actual = await fingerprintFile(file)
        if (actual.sha256 !== external.sha256 || actual.size !== external.size) throw unsafe()
        const current = await lstat(path)
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(k => current[k] !== before[k])) throw unsafe()
        await file.close(); file = null
        await unlink(path)
        await syncDirectory(join(external.source_root, external.platform))
        retireExternal(key)
      } catch (error) {
        if (error.code === 'ENOENT' && external.source_root === externalRoots[folder]) retireExternal(key)
        else {
          db.prepare("UPDATE catalog_external_files SET state = ? WHERE storage_key = ? AND state = 'deleting'").run(external.state, key)
          throw error
        }
      } finally { await file?.close() }
      return
    }
    const row = mapping(folder, key)
    if (row) {
      // Hold the unique path claim until unlink has finished. An old cleanup
      // token can never resolve to a newer file at the same platform/basename.
      const claimed = transaction(db, () => {
        if (referenced(folder, key)) return false
        if (mapping(folder, key)?.state === 'deleting') throw new CatalogHttpError(409, 'STORAGE_BUSY', 'Berkas sedang dibersihkan; ulangi sebentar lagi.')
        return !!db.prepare("UPDATE catalog_asset_files SET state = 'deleting' WHERE folder = ? AND storage_key = ? AND state != 'deleting'").run(folder, key).changes
      })
      if (!claimed) return
      try {
        const path = await namedPath(row)
        const file = await openRegular(path)
        await file.close()
        await unlink(path)
        await syncDirectory(join(root, folder === 'games' ? 'roms' : 'bios', row.platform))
      } catch (error) {
        if (error.code !== 'ENOENT') {
          db.prepare("UPDATE catalog_asset_files SET state = 'ready' WHERE storage_key = ? AND state = 'deleting'").run(key)
          throw error
        }
      }
      db.prepare("DELETE FROM catalog_asset_files WHERE storage_key = ? AND state = 'deleting'").run(key)
      return
    }
    const path = await pathFor(folder, key)
    try {
      const file = await openRegular(path)
      await file.close()
      await unlink(path)
      await syncDirectory(join(root, folder))
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  async function promoteShared(value, options) {
    const kind = value.kind, sourceRoot = externalRoots[kind]
    const platform = storagePlatform(options.consoleId, options.fileName, kind)
    const row = { folder: kind, source_root: sourceRoot, platform, file_name: options.fileName, name_identity: storageNameIdentity(options.fileName) }
    const source = await pathFor('uploads', value.key)
    const target = await namedPath(row, true)
    let count = 0
    // Also protect pre-existing, unindexed case/Unicode aliases on Linux.
    for await (const entry of await opendir(join(sourceRoot, platform))) {
      options.check?.()
      if (++count > 100000) throw unsafe()
      if (storageNameIdentity(entry.name) === row.name_identity) throw new CatalogHttpError(409, 'CATALOG_FILENAME_CONFLICT', 'Nama berkas sudah ada di folder bersama; berkas sumber tidak ditimpa.')
    }
    const key = randomUUID() + '.bin'
    transaction(db, () => {
      if (options.replaceMissingKey) {
        const old = externalMapping(kind, options.replaceMissingKey)
        if (old && old.source_root === sourceRoot && old.platform === platform && old.name_identity === row.name_identity && old.state === 'ready') retireExternal(old.storage_key)
      }
      if (db.prepare("SELECT 1 FROM catalog_external_files WHERE folder = ? AND source_root = ? AND platform = ? AND name_identity = ? AND state != 'retired'").get(kind, sourceRoot, platform, row.name_identity)) throw new CatalogHttpError(409, 'CATALOG_FILENAME_CONFLICT', 'Nama berkas folder bersama sedang dipakai; ulangi setelah pemulihan/pembersihan selesai.')
      db.prepare("INSERT INTO catalog_external_files (storage_key, folder, source_root, platform, file_name, name_identity, size, sha256, mtime_ms, ctime_ms, state, delete_intent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'reserved', 'upload')")
        .run(key, kind, sourceRoot, platform, options.fileName, row.name_identity, value.size, value.sha256)
      db.exec('UPDATE catalog_capacity SET generation = generation + 1 WHERE id = 1')
    })
    let output, input, owned = false, size = 0
    const hash = createHash('sha256')
    async function snapshot(state) {
      const file = await openRegular(target)
      try {
        const actual = await fingerprintFile(file)
        if (actual.size !== size || actual.sha256 !== hash.copy().digest('hex')) throw unsafe()
        const stat = await file.stat()
        db.prepare('UPDATE catalog_external_files SET size = ?, sha256 = ?, mtime_ms = ?, ctime_ms = ?, state = ? WHERE storage_key = ?')
          .run(actual.size, actual.sha256, stat.mtimeMs, stat.ctimeMs, state, key)
      } finally { await file.close() }
    }
    try {
      options.check?.()
      output = await open(target, 'wx', 0o664); owned = true
      input = await openRegular(source)
      const buffer = Buffer.alloc(1024 * 1024)
      let n
      while ((n = (await input.read(buffer, 0, buffer.length, size)).bytesRead)) {
        options.check?.()
        if (size + n > value.size) throw unsafe()
        await output.writeFile(buffer.subarray(0, n)); hash.update(buffer.subarray(0, n)); size += n
      }
      if (size !== value.size || hash.copy().digest('hex') !== value.sha256) throw unsafe()
      await output.sync(); await output.close(); output = null
      await input.close(); input = null
      await snapshot('ready')
      await syncDirectory(join(sourceRoot, platform))
      await unlink(source); await syncDirectory(join(root, 'uploads'))
      staged.delete(value)
      const result = Object.freeze({ kind, key, size: value.size, sha256: value.sha256 })
      promoted.add(result)
      return result
    } catch (error) {
      await output?.close(); await input?.close()
      if (owned) {
        try { await snapshot('reserved'); await remove(kind, key) } catch { /* Never delete an unverified shared replacement; recovery reports it. */ }
      } else retireExternal(key)
      if (error.code === 'EEXIST') throw new CatalogHttpError(409, 'CATALOG_FILENAME_CONFLICT', 'Berkas folder bersama sudah ada; tidak ditimpa.')
      throw error
    }
  }
  return {
    pathFor,
    isExternal(kind, key) { return !!externalMapping(kind, key) },
    storageMode(kind, key) {
      const row = externalMapping(kind, key)
      return row ? shared(kind) && row.source_root === externalRoots[kind] ? 'shared' : 'external' : 'managed'
    },
    requestDelete(kind, key) {
      const row = externalMapping(kind, key)
      if (!row) return
      if (!shared(kind) || row.source_root !== externalRoots[kind]) throw new CatalogHttpError(409, 'EXTERNAL_READ_ONLY', 'Sumber eksternal hanya-baca atau mount berubah. Aktifkan folder bersama yang sesuai untuk menghapus file.')
      if (row.state !== 'retired') db.prepare("UPDATE catalog_external_files SET delete_intent = 'user' WHERE storage_key = ?").run(key)
    },
    capacityRoots(kind) { return shared(kind) ? [root, externalRoots[kind]] : [root] },
    scanRoot(kind) { return externalRoots[kind] ?? join(root, kind === 'games' ? 'roms' : 'bios') },
    scanMapping(kind, platform, name) {
      return externalRoots[kind]
        ? db.prepare("SELECT * FROM catalog_external_files WHERE folder = ? AND source_root = ? AND platform = ? AND name_identity = ? AND state != 'retired'").get(kind, externalRoots[kind], platform, storageNameIdentity(name))
        : db.prepare('SELECT * FROM catalog_asset_files WHERE folder = ? AND platform = ? AND name_identity = ?').get(kind, platform, storageNameIdentity(name))
    },
    async physicalUsage(check = () => {}) {
      await safeDirectory(root)
      let bytes = 0, count = 0
      async function walk(directory, depth = 0) {
        if (depth > 16) throw unsafe()
        await safeDirectory(directory)
        for await (const entry of await opendir(directory)) {
          check()
          if (++count > 500000) throw unsafe()
          const path = join(directory, entry.name)
          if (entry.isDirectory()) await walk(path, depth + 1)
          else {
            let file
            try { file = await openRegular(path); bytes += (await file.stat()).size }
            catch (error) {
              // Online cleanup can unlink between lstat/open/fstat (nlink=0).
              // Only forgive a freshly confirmed missing pathname, not an
              // unsafe file that still exists or a permission failure.
              if (error.code !== 'ENOENT') {
                try { await lstat(path) } catch (fresh) { if (fresh.code === 'ENOENT') continue; throw fresh }
                throw error
              }
            }
            finally { await file?.close() }
          }
        }
      }
      for (const folder of [...catalogFolders, 'roms']) await walk(join(root, folder))
      if (config.externalWritable) for (const directory of Object.values(externalRoots)) await walk(directory)
      return bytes
    },
    async adoption(kind, platform, fileName, check, minAge = 10000) {
      const sourceRoot = externalRoots[kind]
      const path = await namedPath({ folder: kind, platform, file_name: fileName, name_identity: storageNameIdentity(fileName), source_root: sourceRoot })
      const file = await openRegular(path)
      try {
        const stat = await file.stat()
        if (!stat.size || stat.size > catalogLimits[kind]) throw Object.assign(new Error('Berkas kosong atau melebihi batas ukuran.'), { scanStatus: 'invalid' })
        if (Date.now() - Math.max(stat.mtimeMs, stat.ctimeMs) < minAge) throw Object.assign(new Error('Berkas terlalu baru; ulangi scan setelah transfer selesai.'), { scanStatus: 'not_ready' })
        const actual = await fingerprintFile(file, check)
        const value = Object.freeze({ kind, key: randomUUID() + '.bin', ...actual })
        adopted.set(value, { path, stat, platform, fileName, sourceRoot })
        this.claimAdoption(value, false)
        return value
      } finally { await file.close() }
    },
    ownsAdoption(value, kind, consoleId, fileName) {
      const candidate = adopted.get(value)
      return !!candidate && value.kind === kind && candidate.fileName === fileName && candidate.platform === storagePlatform(consoleId, fileName, kind)
    },
    externalAdoption(value) { return !!adopted.get(value)?.sourceRoot },
    refreshAdoption(value, key) {
      const candidate = adopted.get(value)
      if (!candidate?.sourceRoot) return
      this.claimAdoption(value, false)
      const row = externalMapping(value.kind, key)
      if (!row || row.source_root !== candidate.sourceRoot || row.platform !== candidate.platform || row.file_name !== candidate.fileName || row.sha256 !== value.sha256 || row.size !== value.size) throw unsafe()
      db.prepare("UPDATE catalog_external_files SET mtime_ms = ?, ctime_ms = ? WHERE storage_key = ? AND state = 'ready'").run(candidate.stat.mtimeMs, candidate.stat.ctimeMs, key)
    },
    claimAdoption(value, insert = true) {
      const candidate = adopted.get(value)
      if (!candidate) throw unsafe()
      const { path, stat, platform, fileName, sourceRoot } = candidate
      const base = sourceRoot ?? join(root, value.kind === 'games' ? 'roms' : 'bios')
      for (const dir of [root, base, join(base, platform)]) {
        const s = lstatSync(dir)
        if (!s.isDirectory() || s.isSymbolicLink() || realpathSync(dir) !== resolve(dir)) throw unsafe()
      }
      const current = lstatSync(path)
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => current[key] !== stat[key])) throw Object.assign(new Error('Berkas berubah atau pathname diganti; ulangi scan.'), { scanStatus: 'not_ready' })
      if (insert) {
        if (sourceRoot) {
          db.prepare('INSERT INTO catalog_external_files (storage_key, folder, source_root, platform, file_name, name_identity, size, sha256, mtime_ms, ctime_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(value.key, value.kind, sourceRoot, platform, fileName, storageNameIdentity(fileName), value.size, value.sha256, stat.mtimeMs, stat.ctimeMs)
          if (shared(value.kind)) db.exec('UPDATE catalog_capacity SET generation = generation + 1 WHERE id = 1')
          return
        }
        if (db.prepare('SELECT 1 FROM catalog_asset_files WHERE folder = ? AND platform = ? AND name_identity = ?').get(value.kind, platform, storageNameIdentity(fileName))) throw Object.assign(new Error('Path sedang diklaim operasi lain.'), { scanStatus: 'busy' })
        db.prepare("INSERT INTO catalog_asset_files VALUES (?, ?, ?, ?, ?, 'ready')").run(value.key, value.kind, platform, fileName, storageNameIdentity(fileName))
        db.exec('UPDATE catalog_capacity SET generation = generation + 1 WHERE id = 1')
      }
    },
    async stage(kind, source) {
      if (!Object.hasOwn(catalogLimits, kind)) throw unsafe()
      const key = randomUUID() + '.tmp'
      const path = await pathFor('uploads', key)
      const file = await open(path, 'wx', 0o600)
      const hash = createHash('sha256')
      let size = 0
      try {
        for await (const chunk of source) {
          if (!(chunk instanceof Uint8Array)) throw new Error('Stream berkas katalog harus berupa byte.')
          size += chunk.byteLength
          if (size > catalogLimits[kind]) throw new Error('Berkas katalog melebihi batas ukuran.')
          hash.update(chunk)
          await file.writeFile(chunk)
        }
        if (!size) throw Object.assign(new Error('Berkas katalog kosong.'), { code: 'CATALOG_EMPTY' })
        await file.sync()
      } catch (error) {
        await file.close()
        // A failed cleanup is retried offline; preserve the original failure.
        try { await remove('uploads', key) } catch { /* leave an orphan */ }
        throw error
      }
      await file.close()
      const result = Object.freeze({ kind, key, size, sha256: hash.digest('hex') })
      staged.add(result)
      return result
    },
    ownsStage(value, kind) { return staged.has(value) && value.kind === kind },
    async discard(value) {
      if (!staged.has(value)) throw unsafe()
      await remove('uploads', value.key)
      staged.delete(value)
    },
    async promote(value, options) {
      if (!staged.has(value)) throw unsafe()
      if (options && shared(value.kind)) return promoteShared(value, options)
      const source = await pathFor('uploads', value.key)
      const file = await openRegular(source)
      try {
        const actual = await fingerprintFile(file)
        if (actual.size !== value.size || actual.sha256 !== value.sha256) throw new Error('Staging katalog berubah/rusak.')
      } finally { await file.close() }
      const key = randomUUID() + '.bin'
      if (options && ['games', 'bios'].includes(value.kind)) {
        if (!db) throw new Error('Database storage katalog diperlukan.')
        const platform = storagePlatform(options.consoleId, options.fileName, value.kind)
        const row = { folder: value.kind, platform, file_name: options.fileName, name_identity: storageNameIdentity(options.fileName) }
        const target = await namedPath(row, true)
        // Missing active assets restored explicitly can release their old claim.
        // Never replace an existing file or trust a client-provided path.
        if (options.replaceMissingKey) {
          const previous = mapping(value.kind, options.replaceMissingKey)
          if (previous) {
            try {
              await lstat(await namedPath(previous))
              throw new CatalogHttpError(409, 'CATALOG_FILENAME_CONFLICT', 'Berkas sudah tersedia atau sedang dipulihkan. Muat ulang katalog sebelum mengulang upload.')
            }
            catch (error) { if (error.code !== 'ENOENT') throw error }
            db.prepare('DELETE FROM catalog_asset_files WHERE storage_key = ?').run(options.replaceMissingKey)
          }
        }
        transaction(db, () => {
          if (db.prepare('SELECT 1 FROM catalog_asset_files WHERE folder = ? AND platform = ? AND name_identity = ?').get(value.kind, platform, row.name_identity)) {
            throw new CatalogHttpError(409, 'CATALOG_FILENAME_CONFLICT', 'Nama berkas sudah dipakai pada platform ini. Ganti nama berkas sebelum upload; berkas lama tidak ditimpa.')
          }
          db.prepare("INSERT INTO catalog_asset_files VALUES (?, ?, ?, ?, ?, 'reserved')").run(key, value.kind, platform, row.file_name, row.name_identity)
        })
        let output, owned = false, input
        try {
          // wx is the final no-clobber guard, including unmanaged host files.
          output = await open(target, 'wx', 0o600); owned = true
          input = await openRegular(source)
          const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
          let size = 0, n
          while ((n = (await input.read(buffer, 0, buffer.length, size)).bytesRead)) {
            options.check?.()
            if (size + n > value.size) throw new Error('Staging katalog berubah/rusak.')
            await output.writeFile(buffer.subarray(0, n)); hash.update(buffer.subarray(0, n)); size += n
          }
          if (size !== value.size || hash.digest('hex') !== value.sha256) throw new Error('Staging katalog berubah/rusak.')
          await output.sync(); await output.close(); output = null
          await input.close(); input = null
          await syncDirectory(join(root, value.kind === 'games' ? 'roms' : 'bios', platform))
          db.prepare("UPDATE catalog_asset_files SET state = 'ready' WHERE storage_key = ?").run(key)
          await unlink(source); await syncDirectory(join(root, 'uploads'))
          staged.delete(value)
          const result = Object.freeze({ kind: value.kind, key, size: value.size, sha256: value.sha256 })
          promoted.add(result)
          return result
        } catch (error) {
          await output?.close(); await input?.close()
          if (owned) {
            try { await remove(value.kind, key) } catch { /* Recovery retains the claim and partial file. */ }
          } else db.prepare('DELETE FROM catalog_asset_files WHERE storage_key = ?').run(key)
          if (error.code === 'EEXIST') throw new CatalogHttpError(409, 'CATALOG_FILENAME_CONFLICT', 'Nama berkas sudah ada di folder platform. Berkas yang ada tidak ditimpa.')
          throw error
        }
      }
      const target = await pathFor(value.kind, key)
      try { await lstat(target); throw unsafe() }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      await rename(source, target)
      staged.delete(value)
      await syncDirectory(join(root, value.kind))
      await syncDirectory(join(root, 'uploads'))
      const result = Object.freeze({ kind: value.kind, key, size: value.size, sha256: value.sha256 })
      promoted.add(result)
      return result
    },
    ownsFile(value, kind) { return promoted.has(value) && value.kind === kind },
    async open(kind, key) {
      const external = externalMapping(kind, key)
      if (external) {
        if (external.state !== 'ready') throw Object.assign(new Error('Aset folder bersama belum tersedia.'), { code: 'ENOENT' })
        const file = await openRegular(await pathFor(kind, key))
        try {
          const stat = await file.stat()
          if (stat.size !== external.size || stat.mtimeMs !== external.mtime_ms || stat.ctimeMs !== external.ctime_ms) throw new Error('Sumber eksternal berubah; jalankan scan ulang sebelum dimainkan.')
          return file
        } catch (error) { await file.close(); throw error }
      }
      const row = mapping(kind, key)
      if (row && row.state !== 'ready') throw Object.assign(new Error('Aset belum tersedia.'), { code: 'ENOENT' })
      return openRegular(await pathFor(kind, key))
    },
    // Server-only convenience for a child process that must open the file by
    // path. Validation still goes through pathFor + openRegular. Never expose
    // this absolute path through an API or browser payload.
    async assetPath(kind, key) {
      const path = await pathFor(kind, key)
      const file = await this.open(kind, key)
      await file.close()
      return path
    },
    // Online callers must prove that the immutable key is unreferenced. This
    // primitive intentionally cannot delete arbitrary staging from other uploads.
    async removeUnreferenced(kind, key) {
      if (!['games', 'bios', 'covers'].includes(kind)) throw unsafe()
      await remove(kind, key)
    },
    async verify(kind, reference) {
      const path = await pathFor(kind, reference.key)
      const file = await openRegular(path)
      try {
        const actual = await fingerprintFile(file)
        if (actual.size !== reference.size || actual.sha256 !== reference.sha256) throw new Error('Ukuran/checksum berkas katalog tidak sesuai.')
        return actual
      } finally { await file.close() }
    },
    async entries(folder) {
      if (!catalogFolders.includes(folder)) throw unsafe()
      await safeDirectory(root)
      await safeDirectory(join(root, folder))
      const result = [], base = folder === 'games' ? 'roms' : folder
      for (const name of await readdir(join(root, folder))) {
        if (folder === 'bios' && platformSlugs.includes(name)) continue
        result.push(name)
      }
      if (!['games', 'bios'].includes(folder)) return result
      await safeDirectory(join(root, base))
      const rows = db?.prepare('SELECT * FROM catalog_asset_files WHERE folder = ?').all(folder) ?? []
      const byPath = new Map(rows.map(row => [row.platform + '/' + row.file_name, row.storage_key]))
      for (const platform of await readdir(join(root, base))) {
        if (!platformSlugs.includes(platform)) {
          if (folder === 'games') result.push('@roms/' + platform)
          continue
        }
        await safeDirectory(join(root, base, platform))
        for (const name of await readdir(join(root, base, platform))) result.push(byPath.get(platform + '/' + name) ?? '@' + base + '/' + platform + '/' + name)
      }
      // Include crashed reservations even with no file so offline recovery can
      // release them; quota sampling skips missing physical files.
      for (const row of rows) if (!result.includes(row.storage_key)) result.push(row.storage_key)
      if (shared(folder)) {
        const sharedRows = db.prepare("SELECT * FROM catalog_external_files WHERE folder = ? AND source_root = ? AND state != 'retired'").all(folder, externalRoots[folder])
        const sharedPaths = new Map(sharedRows.map(row => [row.platform + '/' + row.file_name, row.storage_key]))
        await safeDirectory(externalRoots[folder])
        for (const platform of await readdir(externalRoots[folder])) {
          if (!platformSlugs.includes(platform)) { result.push('@shared/' + platform); continue }
          await safeDirectory(join(externalRoots[folder], platform))
          for (const name of await readdir(join(externalRoots[folder], platform))) result.push(sharedPaths.get(platform + '/' + name) ?? '@shared/' + platform + '/' + name)
        }
        for (const row of sharedRows) if (!result.includes(row.storage_key)) result.push(row.storage_key)
      }
      return result
    },
    // Maintenance only. The caller must hold an exclusive data lease and must
    // determine references from SQLite before using this destructive primitive.
    remove,
  }
}
