import { AuthError } from './limits.mjs'
import { hashPassword, hashRecoveryCode, normalizeUsername, recoveryCode, validPassword } from './crypto.mjs'

export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE')
  try { const value = work(); db.exec('COMMIT'); return value }
  catch (error) { db.exec('ROLLBACK'); throw error }
}

// Compare both credentials again at commit, including across separate processes.
// No delete/reinsert: account identity and future save ownership stay unchanged.
export function replaceCredentials(db, user, passwordHash, code, authorize = () => {}, message = 'Username atau kode pemulihan tidak sesuai.') {
  return transaction(db, () => {
    authorize()
    const changed = db.prepare(`UPDATE users SET password_hash = ?, recovery_code_hash = ?
      WHERE id = ? AND password_hash = ? AND recovery_code_hash = ?`)
      .run(passwordHash, hashRecoveryCode(code), user.id, user.password_hash, user.recovery_code_hash)
    if (changed.changes !== 1) throw new AuthError(401, message)
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id)
  })
}

export async function resetAccountByAdmin(db, username, password, confirmation) {
  const name = normalizeUsername(username)
  if (!name) throw new Error('Username tidak valid.')
  if (!validPassword(password)) throw new Error('Password baru harus 6–128 karakter.')
  if (password !== confirmation) throw new Error('Konfirmasi password tidak sama.')
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(name)
  if (!user) throw new Error('Akun tidak ditemukan. Pastikan folder data dan username benar.')
  const passwordHash = await hashPassword(password)
  const code = recoveryCode()
  replaceCredentials(db, user, passwordHash, code, undefined, 'Akun berubah selama reset. Ulangi perintah dan verifikasi kembali.')
  return { username: user.username, recoveryCode: code }
}
