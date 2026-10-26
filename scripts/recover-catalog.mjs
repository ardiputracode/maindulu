import { readConfig } from '../server/config.mjs'
import { recoverCatalogStorage } from '../server/catalog/recovery.mjs'

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--apply')) throw new Error('Gunakan: npm run storage:recover -- [--apply]. Tanpa --apply hanya memeriksa; hentikan server terlebih dahulu.')
  const remove = args[0] === '--apply'
  const result = await recoverCatalogStorage(await readConfig(), { remove })
  console.log(JSON.stringify({ mode: remove ? 'cleanup' : 'inspect', ...result }, null, 2))
  if (result.damaged.length || result.unsafe.length || result.unknown.length || result.failed.length) process.exitCode = 1
}

main().catch(error => {
  const safe = /^(Gunakan:|Data sedang|Lock data|Versi skema recovery|Integritas SQLite recovery|Referensi katalog recovery|Storage katalog)/
  console.error(safe.test(error.message) ? error.message : 'Recovery katalog gagal. Periksa konfigurasi, database, izin, dan storage. Jangan hapus berkas aktif atau save.')
  process.exitCode = 1
})
