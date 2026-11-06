import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { SmokeError, initSmokeSecrets, parseSmokeOptions, readSmokeConfig, runSmokeProbe, smokeErrorDiagnostic, smokeEvidenceDiagnostic, smokeSecretName, withSmokeLock } from './lib/screenscraper-m0.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const help = `Probe manual ScreenScraper M0 (tidak mengaktifkan scan otomatis).

  npm run metadata:m0 -- init
    Buat ${smokeSecretName} kosong, tanpa menimpa file yang sudah ada.
  npm run metadata:m0 -- check
    Validasi secret lokal/environment; tanpa request jaringan.
  npm run metadata:m0 -- check --live
    Dua request: akun/kuota dan daftar sistem, tanpa retry otomatis.
  npm run metadata:m0 -- check --live --console nes --rom "path/ROM-legal.nes"
    Tambahkan satu pencocokan hash ROM raw. Isi ROM tidak dikirim.
  npm run metadata:m0 -- check --live --console nes --rom "path/ROM-legal.nes" --not-found
    Tambahkan satu probe hash acak yang diharapkan 404; memakai kuota negatif.
  npm run metadata:m0 -- check --live --console nes --rom "path/ROM-legal.nes" --cover
    Tambahkan satu unduh/decode box-2D sementara di memori; tidak disimpan.
    Boleh digabung --not-found: maksimum lima request, cover diuji terakhir.

Secret hanya di ${smokeSecretName} atau environment, bukan argumen CLI.
ENABLED harus false. Jangan jalankan bersamaan dengan scan RomM/provider lain.
--live membagikan nama/hash/ukuran ROM bila --rom diberikan. Tidak menyimpan
respons mentah, metadata katalog, cover, database, atau laporan ke file.
--cover hanya dijalankan setelah bukti ROM lolos, ke endpoint media API tetap,
tanpa mengikuti URL provider/redirect. Maksimum 8 MiB dan 4096 x 4096 piksel.
Pastikan izin uji media sesuai konteksmu; sukses teknis bukan verifikasi hak.
Kegagalan HTTP/JSON menampilkan diagnostik aman: basename endpoint, status,
kategori MIME, byte yang dibaca dan batas endpoint (2 MiB akun/ROM; 16 MiB sistem;
8 MiB cover). Kegagalan cover tidak berarti game tidak ditemukan.
Kegagalan bukti ROM menampilkan step evidence: alasan, boolean kecocokan dan
kategori bentuk field, tanpa nilai hash, ID, nama game atau respons mentah.
Jika bukti utama cocok, rom.warnings mencatat referensi romid tambahan yang
tidak valid/berbeda; bukan kegagalan hash dan tidak mengaktifkan scan otomatis.
`

export async function main(args = process.argv.slice(2), { directory = root, env = process.env,
  output = line => process.stdout.write(line + '\n'), errorOutput = line => process.stderr.write(line + '\n'), ...probeDependencies } = {}) {
  let cancel
  try {
    const options = parseSmokeOptions(args)
    if (options.command === 'help') { output(help); return 0 }
    if (options.command === 'init') { await initSmokeSecrets(directory); output(`File ${smokeSecretName} dibuat. Isi secret sendiri; jangan kirim nilainya ke chat/Git.`); return 0 }
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const config = await readSmokeConfig({ root: directory, env, version: pkg.version })
    const controller = new AbortController()
    cancel = () => controller.abort()
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
    const task = () => runSmokeProbe(config, options, { ...probeDependencies, signal: controller.signal,
      onStep: step => output(JSON.stringify(step)) })
    const report = options.live ? await withSmokeLock(directory, task) : await task()
    output(JSON.stringify(report, null, 2))
    return 0
  } catch (error) {
    // Never print arbitrary Error.message, stack, cause, fetch URL or body.
    const safe = new SmokeError(error instanceof SmokeError ? error.code : 'FAILED')
    const diagnostic = smokeErrorDiagnostic(error)
    if (diagnostic) errorOutput(JSON.stringify({ step: 'diagnostic', code: safe.code, ...diagnostic }))
    const evidence = smokeEvidenceDiagnostic(error)
    if (safe.code === 'EVIDENCE' && evidence) errorOutput(JSON.stringify({ step: 'evidence', code: safe.code, endpoint: 'jeuInfos.php', ...evidence }))
    errorOutput(`${safe.code}: ${safe.message}`)
    return 1
  } finally {
    if (cancel) { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main()
