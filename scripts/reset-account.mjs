import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { readConfig } from '../server/config.mjs'
import { openDatabase } from '../server/database.mjs'
import { normalizeUsername } from '../server/auth/crypto.mjs'
import { resetAccountByAdmin } from '../server/auth/mutations.mjs'
import { readHiddenPassword } from '../server/auth/terminal.mjs'

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 1 || !normalizeUsername(args[0])) throw new Error('Gunakan: npm run account:reset -- <username>. Jangan masukkan password sebagai argumen.')
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) throw new Error('Reset admin memerlukan terminal interaktif; input/output redirect tidak diizinkan.')
  const config = await readConfig()
  try { await access(join(config.dataDir, 'maindulu.sqlite')) }
  catch { throw new Error('Database akun tidak ditemukan. Periksa MAIN_DULU_DATA_DIR; reset tidak membuat database baru.') }
  process.stderr.write(`Reset akun ${normalizeUsername(args[0])} pada folder data: ${config.dataDir}\nPastikan identitas pemilik akun telah diverifikasi di luar aplikasi. Ctrl+C untuk membatalkan.\n`)
  const password = await readHiddenPassword('Password baru (tersembunyi): ')
  const confirmation = await readHiddenPassword('Ulangi password baru (tersembunyi): ')
  const db = await openDatabase(config.dataDir)
  try {
    const result = await resetAccountByAdmin(db, args[0], password, confirmation)
    process.stdout.write(`Reset berhasil untuk ${result.username}. Semua sesi dan kode lama dibatalkan.\nKode pemulihan baru (hanya sekali):\n${result.recoveryCode}\nSerahkan secara privat kepada pemilik akun; simpan di luar browser. Jangan membagikan tangkapan layar/riwayat terminal ini.\n`)
  } finally { db.close() }
}

main().catch(error => {
  // No stack, request data, or raw database errors in administrative output.
  const safe = /^(Gunakan:|Reset admin|Database akun|Username tidak valid|Password baru harus|Konfirmasi password|Akun tidak ditemukan|Akun berubah|Reset dibatalkan|Input terminal|Input password)/
  process.stderr.write((safe.test(error.message) ? error.message : 'Reset gagal. Periksa konfigurasi dan akses folder data; tidak ada rahasia yang dicetak.') + '\n')
  process.exitCode = 1
})
