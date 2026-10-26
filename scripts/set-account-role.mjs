import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { readConfig } from '../server/config.mjs'
import { openDatabase } from '../server/database.mjs'
import { normalizeUsername } from '../server/auth/crypto.mjs'
import { setAccountRoleByAdmin } from '../server/auth/mutations.mjs'

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 2 || !normalizeUsername(args[0]) || !['user', 'admin'].includes(args[1])) throw new Error('Gunakan: npm run account:role -- <username> <user|admin>. Akun harus sudah ada.')
  const config = await readConfig()
  try { await access(join(config.dataDir, 'maindulu.sqlite')) }
  catch { throw new Error('Database akun tidak ditemukan. Periksa MAIN_DULU_DATA_DIR; perubahan role tidak membuat database baru.') }
  const db = await openDatabase(config.dataDir)
  try {
    const result = setAccountRoleByAdmin(db, args[0], args[1])
    process.stdout.write(`Role ${result.username}: ${result.previousRole} → ${result.role}. Berlaku pada semua sesi aktif.\n`)
  } finally { db.close() }
}

main().catch(error => {
  const safe = /^(Gunakan:|Database akun|Username tidak valid|Role harus|Akun tidak ditemukan|Data sedang dipakai|Lock data)/
  process.stderr.write((safe.test(error.message) ? error.message : 'Perubahan role gagal. Periksa konfigurasi dan akses folder data.') + '\n')
  process.exitCode = 1
})
