import { hashPassword, validPassword } from '../server/auth/crypto.mjs'
import { readHiddenPassword } from '../server/auth/terminal.mjs'

try {
  if (process.argv.length !== 2 || !process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Gunakan npm run gate:hash di terminal interaktif, tanpa argumen atau redirect.')
  const password = await readHiddenPassword('Password pintu masuk (tersembunyi): ')
  const confirmation = await readHiddenPassword('Ulangi password (tersembunyi): ')
  if (!validPassword(password) || password !== confirmation) throw new Error('Password harus 6–128 karakter dan konfirmasi harus sama.')
  // This explicit operator command is the ONLY intentional hash output. It is
  // not startup/request logging; never print the plaintext or a session token.
  process.stdout.write(`Simpan baris ini secara privat di .env, lalu hapus MAIN_DULU_GATE_PASSWORD:\nMAIN_DULU_GATE_PASSWORD_HASH='${await hashPassword(password)}'\n`)
} catch (error) {
  process.stderr.write((/^(Gunakan |Password harus |Input |Reset dibatalkan)/.test(error.message) ? error.message : 'Hash belum bisa dibuat. Coba lagi di terminal interaktif.') + '\n')
  process.exitCode = 1
}
