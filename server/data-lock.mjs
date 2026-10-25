import { mkdirSync, lstatSync, openSync, closeSync, writeFileSync, readFileSync, readdirSync, unlinkSync, realpathSync, readlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { hostname } from 'node:os'

function processNamespace() {
  // PIDs only identify a process inside its own Linux PID namespace. A one-off
  // maintenance container MUST NOT reap the live server container's leases.
  if (process.platform === 'linux') {
    try { return `${hostname()}:${readlinkSync('/proc/self/ns/pid')}` }
    catch { throw new Error('Lock data tidak dapat memeriksa namespace PID Linux. Periksa akses /proc; jangan lewati lock.') }
  }
  return `${process.platform}:${hostname()}`
}

// Shared leases allow the existing multi-connection server/admin contract.
// Maintenance requires an exclusive lease BEFORE opening SQLite or touching data.
// Keep locks beside data, so a restore can reserve a not-yet-created directory.
export async function acquireDataLock(directory, exclusive = false) {
  const namespace = processNamespace()
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
    writeFileSync(fd, JSON.stringify({ pid: process.pid, namespace }))
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
      // Old Linux leases have no namespace and cannot be proven dead here.
      // Legacy Windows/macOS leases remain compatible on the same local host.
      if (owner.namespace !== namespace && !(owner.namespace === undefined && process.platform !== 'linux')) throw new Error('Lock data berasal dari host/namespace lain atau versi Linux lama. Hentikan semua proses terkait dan periksa lock secara manual.')
      try { process.kill(owner.pid, 0) }
      catch (error) {
        if (error.code === 'ESRCH') { unlinkSync(path); continue }
        // Access denied / unknown process state is not proof that it has exited.
      }
      if (exclusive || owner.exclusive) throw new Error('Data sedang dipakai server/admin/backup. Hentikan proses terkait sebelum backup atau restore.')
    }
    writeFileSync(lease, JSON.stringify({ pid: process.pid, namespace, exclusive }), { flag: 'wx', mode: 0o600 })
  } finally { closeSync(fd); unlinkSync(gate) }
  let released = false
  return () => {
    if (released) return
    unlinkSync(lease)
    released = true
  }
}
