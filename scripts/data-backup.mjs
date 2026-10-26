import { resolve } from 'node:path'
import { readConfig } from '../server/config.mjs'
import { createDataBackup, verifyDataBackup, restoreDataBackup } from '../server/data-backup.mjs'

async function main() {
  const [action, ...args] = process.argv.slice(2)
  if (!['backup', 'verify', 'restore'].includes(action) || (action === 'restore' ? args.length !== 3 || args[1] !== '--to' : args.length !== 1) || args.some(arg => !arg.trim())) {
    throw new Error('Gunakan: npm run data:backup -- <folder-baru> | npm run data:verify -- <backup> | npm run data:restore -- <backup> --to <folder-data-baru>.')
  }
  const config = await readConfig()
  const source = resolve(args[0])
  let manifest
  if (action === 'backup') manifest = await createDataBackup(config, source)
  else if (action === 'verify') manifest = await verifyDataBackup(config, source)
  else manifest = await restoreDataBackup(config, source, resolve(args[2]))
  console.log(`${action === 'backup' ? 'Backup selesai' : action === 'verify' ? 'Backup terverifikasi' : 'Restore selesai; semua sesi dicabut, silakan login ulang'}. ${manifest.files.length} berkas; skema ${manifest.schemaVersion}.`)
  if (action === 'restore') console.log('Gunakan folder hasil restore sebagai MAIN_DULU_DATA_DIR. Konfigurasi tidak diterapkan otomatis; password/kode pemulihan kembali ke waktu backup. Tutup semua sesi player lama sebelum membuka server hasil restore.')
  else console.log('Backup berisi data privat semua akun. Simpan salinan di perangkat/lokasi lain; checksum bukan bukti keaslian atau enkripsi.')
}

main().catch(error => {
  // Do not print raw SQLite errors, user rows, environment values, or stacks.
  const safe = /^(Gunakan:|Path backup|Backup\/restore|Folder backup|Folder tujuan|Berkas\/folder backup|Lock data|Data sedang|Versi skema|Integritas SQLite|Identitas instalasi|Referensi blob|Isi folder backup|Manifest backup|Format\/versi manifest|Daftar berkas|Ukuran\/checksum|Metadata manifest|Blob sumber|Salinan restore|Berkas berubah|Katalog backup)/
  console.error(safe.test(error.message) ? error.message : 'Operasi data gagal. Periksa konfigurasi, sumber, izin, ruang disk, dan versi aplikasi. Data lama tidak ditimpa; folder .partial-* mungkin perlu diperiksa setelah proses terhenti.')
  process.exitCode = 1
})
