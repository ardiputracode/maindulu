import { mkdirSync, lstatSync, openSync, closeSync, writeFileSync, readFileSync, readdirSync, unlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'

// Shared leases allow the existing multi-connection server/admin contract.
// Maintenance requires an exclusive lease BEFORE opening SQLite or touching data.
// Keep locks beside data, so a restore can reserve a not-yet-created directory.
export async function acquireDataLock(directory, exclusive = false) {
  const parent = realpathSync(dirname(resolve(directory)))
  const folder = join(parent, `.${basename(directory)}.maindulu-lock`)
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  if (!lstatSync(folder).isDirectory() || realpathSync(folder) !== folder) throw new Error('Lock data tidak aman; periksa folder privat.')
  const gate = join(folder, 'gate')
  let fd
  for (let i = 0; i < 100; i++) {
    try { fd = openSync(gate, 'wx', 0o600); break }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      await setTimeout(20)
    }
  }
  if (fd === undefined) throw new Error('Lock data sibuk/tidak lengkap. Hentikan proses terkait dan periksa gate sebelum mencoba lagi.')
  const lease = join(folder, randomUUID() + '.json')
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid }))
    for (const name of readdirSync(folder)) {
      if (name === 'gate') continue
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw new Error('Lock data tidak dikenal; pemeriksaan operator diperlukan.')
      const path = join(folder, name)
      let owner
      try {
        if (!lstatSync(path).isFile() || realpathSync(path) !== path) throw new Error('Unsafe lease')
        owner = JSON.parse(readFileSync(path, 'utf8'))
      } catch (error) {
        if (error.code === 'ENOENT') continue // A closing connection released its lease.
        throw new Error('Lock data rusak; pemeriksaan operator diperlukan.')
      }
      if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.exclusive !== 'boolean') throw new Error('Lock data rusak; pemeriksaan operator diperlukan.')
      try { process.kill(owner.pid, 0) }
      catch (error) {
        if (error.code === 'ESRCH') { unlinkSync(path); continue }
        // Access denied / unknown process state is not proof that it has exited.
      }
      if (exclusive || owner.exclusive) throw new Error('Data sedang dipakai server/admin/backup. Hentikan proses terkait sebelum backup atau restore.')
    }
    writeFileSync(lease, JSON.stringify({ pid: process.pid, exclusive }), { flag: 'wx', mode: 0o600 })
  } finally { closeSync(fd); unlinkSync(gate) }
  let released = false
  return () => {
    if (released) return
    unlinkSync(lease)
    released = true
  }
}
