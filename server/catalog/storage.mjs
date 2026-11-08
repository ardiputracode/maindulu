import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
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

export async function fingerprintFile(file) {
  const before = await file.stat()
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(1024 * 1024)
  let size = 0, n
  while ((n = (await file.read(buffer, 0, buffer.length, size)).bytesRead)) {
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
  const promoted = new WeakSet()
  const mapping = (folder, key) => db?.prepare('SELECT * FROM catalog_asset_files WHERE folder = ? AND storage_key = ?').get(folder, key)
  const referenced = (folder, key) => db?.prepare(`SELECT 1 FROM ${folder} WHERE storage_key = ? AND deleted_at IS NULL`).get(key)
  async function namedPath(row, create = false) {
    if (!['games', 'bios'].includes(row.folder) || !platformSlugs.includes(row.platform) || !safeStorageName(row.file_name)
      || storageNameIdentity(row.file_name) !== row.name_identity) throw unsafe()
    await safeDirectory(root)
    const base = join(root, row.folder === 'games' ? 'roms' : 'bios')
    await safeDirectory(base)
    const directory = join(base, row.platform)
    if (create) {
      try { await mkdir(directory, { mode: 0o700 }); await syncDirectory(base) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    await safeDirectory(directory)
    return join(directory, row.file_name)
  }
  async function pathFor(folder, key) {
    if (!catalogFolders.includes(folder) || typeof key !== 'string' || !(folder === 'uploads' ? stagingKeyPattern : storageKeyPattern).test(key)) throw unsafe()
    await safeDirectory(root)
    await safeDirectory(join(root, folder))
    const row = mapping(folder, key)
    if (row) return namedPath(row)
    return join(root, folder, key)
  }
  async function remove(folder, key) {
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
  return {
    pathFor,
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
      const row = mapping(kind, key)
      if (row && row.state !== 'ready') throw Object.assign(new Error('Aset belum tersedia.'), { code: 'ENOENT' })
      return openRegular(await pathFor(kind, key))
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
      return result
    },
    // Maintenance only. The caller must hold an exclusive data lease and must
    // determine references from SQLite before using this destructive primitive.
    remove,
  }
}
