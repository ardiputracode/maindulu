import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { projectRoot, canonicalPath } from '../server/config.mjs'

async function main() {
  const args = process.argv.slice(2)
  const roleFilter = parseFilter(args, '--role')
  const usernameFilter = parseFilter(args, '--username')

  const raw = (process.env.MAIN_DULU_DATA_DIR || '').trim() || 'data'
  const dataDir = await canonicalPath(resolve(projectRoot, raw))
  try { await access(join(dataDir, 'maindulu.sqlite')) }
  catch { throw new Error('Database akun tidak ditemukan. Periksa MAIN_DULU_DATA_DIR; daftar akun tidak membuat database baru.') }

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(dataDir, 'maindulu.sqlite'), { readOnly:  true })
  try {
    const rows = db.prepare(
      'SELECT id, username, role, created_at FROM users ORDER BY username COLLATE NOCASE'
    ).all()

    const filtered = rows.filter(row => {
      if (roleFilter && row.role !== roleFilter) return false
      if (usernameFilter && row.username !== usernameFilter) return false
      return true
    })

    if (!filtered.length) {
      process.stdout.write('Tidak ada akun yang cocok.\n')
      return
    }

    const widths = {
      username: Math.max('username'.length, ...filtered.map(r => String(r.username).length)),
      role: Math.max('role'.length, ...filtered.map(r => String(r.role).length)),
      created: 24,
    }
    const header = `${'username'.padEnd(widths.username)}  ${'role'.padEnd(widths.role)}  ${'created_at (UTC)'.padEnd(widths.created)}  id`
    process.stdout.write(header + '\n')
    process.stdout.write('-'.repeat(header.length) + '\n')
    for (const row of filtered) {
      const created = new Date(Number(row.created_at)).toISOString()
      process.stdout.write(
        `${String(row.username).padEnd(widths.username)}  ${String(row.role).padEnd(widths.role)}  ${created.padEnd(widths.created)}  ${row.id}\n`
      )
    }
    process.stdout.write(`\nTotal: ${filtered.length} akun${filtered.length !== rows.length ? ` (dari ${rows.length})` : ''}.\n`)
  } finally {
    db.close()
  }
}

function parseFilter(args, flag) {
  const index = args.indexOf(flag)
  if (index === -1) return null
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Nilai untuk ${flag} wajib diisi.`)
  if (flag === '--role' && !['user', 'admin'].includes(value)) throw new Error('Role harus user atau admin.')
  return value
}

main().catch(error => {
  const safe = /^(Database akun|Nilai untuk|Role harus|MAIN_DULU_DATA_DIR)/
  process.stderr.write((safe.test(error.message) ? error.message : 'Daftar akun gagal. Periksa konfigurasi dan akses folder data.') + '\n')
  process.exitCode = 1
})