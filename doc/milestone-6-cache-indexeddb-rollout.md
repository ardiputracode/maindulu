# M6 — Dokumentasi, Rollout, dan Verifikasi Deployment

Lanjutan [rencana IndexedDB](rencana-cache-indexeddb-rom-bios.md) dan [bukti M5](milestone-5-cache-indexeddb-verification.md).

Status 2026-11-05: **M6 selesai untuk cakupan penggunaan lokal/HTTP LAN yang disepakati**. Dokumentasi, rem darurat build-time, dan verifikasi otomatis Node/HTTP LAN tersedia; pengguna mengonfirmasi Docker backend sudah diuji di mesin lain serta seluruh skenario manual CHD besar legal, cold/warm/restart browser, gameplay aktif, dan pemulihan progres lama lulus. Default cache **aktif hanya untuk database/profil baru**; preferensi lama tetap dihormati. **HTTPS reverse proxy dilewati/ditunda atas keputusan pengguna karena belum diperlukan**, bukan dinyatakan lulus atau menjadi penghalang penutupan cakupan lokal. Ini bukan klaim kesiapan deployment publik atau dukungan semua perangkat/game.

## Implementasi dan Cakupan

- `README.md` dan `deploy/README.backend.md`: cara aktivasi/status/hapus, kuota/RAM, inspeksi DevTools, HTTP LAN, privasi origin/profil, perbedaan cache dengan save, dan operasi proxy. Tidak perlu Redis, volume cache Docker atau `.env` cache untuk penggunaan normal.
- Dokumen HTTP cache lama mendapat tautan lanjutan tanpa mengubah hasil tes historis. HTTP cache dan IndexedDB bukan mekanisme yang sama: pipeline IndexedDB memakai fetch `no-store`, sementara header respons backend tetap `private, no-cache` untuk jalur URL lama.
- `src/lib/asset-cache.ts`: commit `13ea2b2` mengubah pengaturan awal menjadi `enabled: true` saat database baru dibuat. Tidak ada migrasi preferensi pada database lama atau perubahan skema v1.
- `src/lib/asset-cache-rollout.ts`, `src/lib/player-assets.ts`, `vite.config.ts`: rem darurat **build-time** `VITE_ASSET_CACHE_DISABLED=true`, default `false` (artinya tidak ada override; pilihan cache mengikuti settings DB, bukan nilai flag ini).
- Pada build darurat, Player tidak membuka IndexedDB atau memanggil resolver untuk menyiapkan aset; jalur URL/HEAD/engine yang sudah ada tetap berjalan. File lokal/statis tetap seperti sebelumnya. UI menjelaskan override, switch efektif nonaktif, tetapi daftar, budget, dan penghapusan tetap tersedia. Pengaturan asli di DB tidak ditimpa.
- Kedua Dockerfile mempunyai build argument tersebut, kedua Compose meneruskannya di `build.args`, bukan runtime environment. Unit test memverifikasi kontrak konfigurasi; penerimaan Docker di mesin lain berasal dari konfirmasi pengguna, bukan hasil suite otomatis ini.
- `tests/browser/catalog-indexeddb-deployment.spec.ts` dan `tests/fixtures/asset-cache-deployment.mjs`: backend aplikasi produksi di proses Node terpisah, data fixture privat dan port/origin sama; shutdown penuh/SQLite ditutup lalu proses baru. PID berbeda diperiksa. Bukan hanya menghentikan listener seperti salah satu tes M5.
- Suite memeriksa byte/hash frontend module, helper, bridge, dan `builds.json` yang benar-benar disajikan terhadap file `dist/`; helper/bridge/fingerprint juga sama dengan `public/`. Build darurat Vite terisolasi dibuat di direktori sementara, tanpa menimpa `dist/` yang sedang dipakai suite lain.
- Engine NES nyata dan BIOS sintetis menguji cold lalu reuse setelah pergantian proses backend pada loopback dan HTTP LAN non-loopback. HTTP cache dimatikan melalui CDP. Origin lain tidak mewarisi preferensi/bytes; kembali ke origin lama masih mempunyai keduanya.
- Tes build darurat memakai profil yang sebelumnya sudah opt-in dan terisi: download URL lama berjalan, entry/generation/last-used tidak berubah oleh Player, hapus satu BIOS tetap bekerja. Kembali ke build biasa memulihkan pilihan aktif dan ROM hit tanpa GET; BIOS yang dihapus diunduh lagi. Preferensi **nonaktif** juga diuji melintasi pergantian build darurat → normal.

## Panduan Pengguna dan Inspeksi

1. Buka **Pengaturan → Cache ROM/BIOS perangkat** dan periksa **Gunakan cache ROM/BIOS backend**. Default aktif untuk database/profil baru; database lama mempertahankan pilihannya dan dapat diaktifkan manual jika masih nonaktif. Budget awal **2 GiB** adalah batas aplikasi, bukan jaminan kuota browser. Cache bisa berjalan pada HTTP LAN tanpa storage estimate/persistence API.
2. Pilih upload backend dari Library, lalu **Main sekarang**. Persiapan hanya dimulai sesudah tindakan ini. Server tetap diperiksa; tombol **Mulai bermain** emulator masih manual.
3. **Tersimpan di perangkat** baru sah setelah commit; **Cache perangkat dipakai** berarti hasil baca lokal diverifikasi; **Dimainkan tanpa disimpan** berarti sesi berjalan tetapi reuse belum dijamin. Error sumber/integritas bukan warning cache dan tetap menahan boot.
4. Gunakan daftar/hapus satu/semua di Pengaturan. Mematikan toggle hanya menonaktifkan penggunaan/pengisian berikutnya, bukan menghapus data lama. Sesi yang sudah memegang File/Blob tetap berjalan ketika cache dihapus.
5. Di Edge/Chromium: **DevTools → Application → IndexedDB → `maindulu-asset-cache`**, refresh tampilan metadata bila perlu:
   - `entries`: manifest committed yang siap, dengan ID/jenis/SHA/size/generation dan jumlah chunk.
   - `chunks`: Blob maksimal **4 MiB**; chunk tersendiri tidak membuktikan aset lengkap/siap.
   - `staging`: persiapan sementara, bukan koleksi siap pakai; bisa tersisa sampai cleanup aman.
   - `control`: preferensi/budget, epoch, pin/reservation administratif; jangan mengedit manual.
6. Menghapus cache lewat UI tidak menghapus database save tamu, state/progres server, akun, favorit, atau riwayat. **Clear site data** browser berbeda: seluruh storage origin/sesi dan save tamu bisa ikut hilang. Ekspor save sebelum tindakan menyeluruh itu.

Cache dibagi semua akun pada **origin + profil browser** yang sama, tidak terenkripsi, tidak dihapus saat logout, dan bukan mode offline/permanen. Penggantian domain/IP/skema/port atau profil membuat storage berbeda. Penghapusan server menolak peluncuran baru sesudah pemeriksaan, bukan menghapus paksa bytes yang sudah diterima perangkat. RAM emulator tetap batas terpisah; keberhasilan transport sintetis 500 MiB bukan jaminan boot PS1 atau perangkat kecil.

## Build, Fingerprint, Skema, dan Rollback

Build normal:

```text
npm run build
npm start
```

`npm run build` menjalankan generator **helper aplikasi** `scripts/build-player-assets.mjs` sebelum frontend menyalin `public/` ke `dist/`. **Tidak ada regenerasi engine** lewat `scripts/vendor-engine.mjs`, perubahan core/provenance, atau fingerprint baru pada M6. Runtime engine 4.2.3 tetap:

```text
529804cb39f576ca60472329626eb35c278a6866ea74c18665d5fb38a76cf858
```

Skema `maindulu-asset-cache` tetap **v1**; tidak ada migrasi SQLite/save/progres, perubahan saveIdentity, atau perluasan allowlist kompatibilitas. Fingerprint frontend berubah sewajarnya karena UI/rem darurat, tetapi itu bukan `runtimeBuild` engine. Aplikasi lama yang menemukan DB cache versi lebih baru harus fallback tanpa cache, bukan downgrade/menghapus DB.

Rollback paling ringan: matikan toggle Pengaturan. Untuk menghentikan fitur pada semua profil yang memuat build baru, bangun frontend darurat. Contoh PowerShell dari akar repo (hanya memengaruhi command anak; nilai environment lama dipulihkan):

```powershell
$previous = $env:VITE_ASSET_CACHE_DISABLED
try {
  $env:VITE_ASSET_CACHE_DISABLED = 'true'
  npm run build
} finally { $env:VITE_ASSET_CACHE_DISABLED = $previous }
```

Contoh shell POSIX:

```sh
VITE_ASSET_CACHE_DISABLED=true npm run build
```

Restart backend agar menyajikan build yang diperbarui, tutup sesi Player lalu reload halaman. Ini bukan switch runtime backend: sekadar mengubah env lalu `restart` tanpa rebuild tidak mengganti bundle. Untuk Docker, gunakan perintah build-arg pada [panduan backend](../deploy/README.backend.md#cache-perangkat-rombios-indexeddb). Docker tidak dijalankan di mesin verifikasi otomatis ini; pengguna mengonfirmasi pengujiannya di mesin lain, dengan batas pencatatan pada bagian penerimaan manual di bawah.

Untuk kembali normal, build dengan `VITE_ASSET_CACHE_DISABLED=false` (atau hapus override dari lingkungan build), deploy/reload. Pilihan pengguna yang tersimpan kembali berlaku. Baik mengaktifkan maupun melepas rem darurat **tidak menghapus DB, memaksa preferensi menjadi true, atau mengubah header cache backend**. Jangan menghapus volume, memakai `down -v`, menghapus seluruh storage origin, atau mengubah save untuk rollback cache. Jika rollback ke aplikasi/engine release berbeda, periksa fingerprint/format save dan backup tersendiri; tidak menjanjikan seluruh state kompatibel lintas build engine.

## Hasil Aktual M6

### Verifikasi Otomatis Historis Sebelum Aktivasi Default

Angka dan artefak berikut berasal dari implementasi M6 sebelum commit aktivasi default `13ea2b2`. Suite tidak dijalankan ulang untuk pembaruan dokumentasi penutupan ini; tabel ini bukan bukti regresi otomatis baru setelah perubahan default.

Perintah reproduksi dari akar repo:

```text
npm test
npm run build
npm run test:e2e:backend -- tests/browser/catalog-indexeddb-deployment.spec.ts
npm run test:e2e:backend
npm run test:e2e:production
```

Jalankan suite backend/production berurutan sesudah build, jangan rebuild `dist/` di tengah run. Gunakan `--output <direktori-terpisah>` untuk mempertahankan artefak masing-masing suite. Tes build darurat menghasilkan build sendiri di direktori sementara dan tidak mengubah `dist/` utama. Suite besar M5 tetap opt-in terpisah: `npm run test:e2e:asset-cache:large`, tidak dijalankan ulang pada M6 ini.

Lingkungan: Windows x64 **10.0.26300**, Node **v26.12.1**, Edge headless **156.0.4314.58**. Profil/data fixture terisolasi; bukan profil pribadi, perangkat mobile, atau deployment produksi pengguna.

| Verifikasi | Hasil aktual |
| --- | --- |
| Unit/integrasi `npm test` | **317/317 lulus**, tanpa fail/skip/cancel, sekitar **38,9 detik** |
| `npm run build` | **Lulus**, frontend 534,50 kB sebelum gzip; warning >500 kB bukan failure |
| TypeScript aplikasi | **Lulus** lewat build |
| Strict TypeScript spec/fixture deployment | **Lulus** dengan `allowJs` untuk impor `.mjs` backend |
| Bridge dan pemisahan fixture | `node --check public/player/player.js` **lulus**; tidak ada global harness/fixture M5/M6 pada JavaScript `dist/` |
| Suite M6 terfokus | **3/3 lulus**, tanpa retry/skip, sekitar **43,4 detik**; sebelum penambahan assertion PID/exit code, kemudian ketiga skenario final lulus pada regresi penuh |
| Backend penuh | **154/154 lulus**, tanpa fail/retry/skip, sekitar **12,0 menit**; termasuk tes M6 final dengan assertion PID/exit code, seluruh regresi M1–M5, HTTP cache historis, akun/katalog, state/SRAM/autosave/impor/backup |
| Production statis penuh | **66 lulus/93 skip**, tanpa fail/retry, sekitar **1,7 menit**; tiga skip tambahan adalah tes deployment M6 yang membutuhkan backend, bukan bukti cache upload tersedia pada hosting statis |
| Suite sintetis besar opt-in | **Tidak diulang pada M6**; bukti 329.641.708 byte/500 MiB tetap laporan M5, bukan hasil run M6 |
| Docker backend | **Tidak dijalankan pada suite lokal ini** karena Docker CLI tidak tersedia; kemudian dikonfirmasi pengguna sudah diuji di mesin lain, lihat penerimaan manual |
| HTTPS reverse proxy | **Dilewati/ditunda oleh pengguna**, di luar cakupan rilis lokal saat ini; belum diuji dan tidak dinyatakan lulus |
| CHD legal/gameplay PS1/progres lama | **Lulus manual menurut konfirmasi pengguna**, terpisah dari pipeline otomatis ini; lihat penerimaan manual |

Percobaan TypeScript awal tanpa `allowJs` ditolak karena impor `.mjs` backend tidak mempunyai declaration; perintah dengan `--allowJs --checkJs false` kemudian lulus tanpa menonaktifkan strict pada TS. Tidak ada perubahan backend/keamanan untuk meluluskan typecheck.

### Bukti Transfer pada Tes Deployment Terfokus

| Fase (masing-masing loopback dan HTTP LAN) | HEAD origin | GET origin | Body origin | Hasil |
| --- | --- | --- | --- | --- |
| Cold ROM NES 24.592 byte | 1 | 1 | 24.592 byte | committed, engine aktif |
| Cold BIOS sintetis 512 byte | 1 | 1 | 512 byte | committed; bukan uji firmware asli |
| Setelah proses backend diganti, ROM | 1 | 0 | 0 byte | generation lama dipakai, engine aktif |
| Setelah proses backend diganti, BIOS | 1 | 0 | 0 byte | generation lama dipakai |

Respons sukses 200 dengan strong ETag sesuai SHA dan `private, no-cache`; resolver memvalidasi Content-Length. Total metadata committed **25.104 byte/2 aset**, staging/reservation nol. Browser tetap hidup pada tes pergantian proses **backend** ini; restart seluruh proses **browser** merupakan bukti terpisah suite M5 yang tetap ada. HTTP cache nonaktif; hit bukan GET 304 yang disalahartikan sebagai reuse IndexedDB.

Artefak pada parent `C:\Users\Ardi Putra\AppData\Local\Temp\opencode`:

- `maindulu-m6-deployment`: run terfokus awal, `deployment-summary.json`, `rollback-summary.json`, dan log build darurat.
- `maindulu-m6-backend`: regresi backend penuh, termasuk summary final M6 dengan PID berbeda dan verifikasi shutdown normal.
- `maindulu-m6-production`: regresi statis production, tanpa skenario upload/backend.

Summary mencakup hash file yang disajikan, environment, metadata/generation dan request/body origin. Tidak menyimpan ROM proprietary, cookie, atau token. Output regresi memakai direktori terpisah agar tidak membersihkan artefak run lain.

Build utama tidak diganti selama regresi backend/production. `git diff --check` dan pemeriksaan tautan file Markdown lokal lulus. Tidak ada kegagalan browser pada run M6 terfokus maupun regresi penuh; kegagalan pemeriksaan lingkungan Docker dan percobaan awal TypeScript tetap dicatat di atas, bukan disamarkan sebagai hasil lulus.

### Penerimaan Manual Pengguna dan Batas Bukti

- **Docker backend:** pengguna mengonfirmasi pengujian sudah dilakukan di mesin lain. Ini diterima sebagai hasil manual untuk penutupan cakupan lokal, bukan klaim Docker berjalan pada mesin Windows suite di atas. OS, versi Docker/Compose, browser, revisi/image digest, origin, hash file yang disajikan, log request/body, dan rincian restart/recreate container belum diberikan; tidak dianggap otomatis terverifikasi dari konfirmasi umum ini.
- **CHD besar legal + progres lama:** pengguna mengonfirmasi seluruh skenario yang diminta **lulus**: peluncuran pertama/cold, sesi kedua/warm, restart browser pada profil/origin yang sama, canvas/gameplay aktif, serta pemulihan save/progres yang sudah ada. Ini penerimaan manual cache M6, bukan pengangkatan bukti sintetis M5 atau hasil milestone sinkronisasi progres lain.
- Rincian CHD seperti judul/region, ukuran/hash, BIOS/HLE, browser/OS, core/varian/build, nama filesystem/memcard, metode isolasi HTTP cache dan log HEAD/GET/body belum disertakan. Jangan menebak nilainya atau menyamakan hasil manual ini dengan matriks transfer otomatis di atas. Seluruh game/card/slot, multi-disk, perangkat kecil, serta browser lain tidak ikut dinyatakan lulus.
- **HTTPS reverse proxy:** pengguna memilih melewatinya karena belum diperlukan. Verifikasi TLS/proxy tetap belum dilakukan; harus dikerjakan jika HTTPS/deployment publik masuk cakupan berikutnya. Keputusan ini tidak mengubah proteksi akun/origin/CSRF/cookie atau mengizinkan HTTP tidak aman di internet. HTTP akun hanya untuk LAN tepercaya sesuai [panduan backend](../deploy/README.backend.md).
- Tidak ada ROM/BIOS, dump proprietary, cookie, atau token ditambahkan ke repo. Rincian lingkungan/log nonrahasia dapat dilengkapi kemudian untuk reproduksi; ketiadaan rincian itu dicatat, bukan diganti angka hasil rekaan.

## Runbook Verifikasi Ulang dan Perluasan Deployment

Runbook berikut dipertahankan untuk reproduksi dan perluasan cakupan, **bukan daftar gate lokal yang semuanya masih terbuka**. Bukti otomatis Node/LAN, konfirmasi manual Docker/CHD, dan penundaan HTTPS dipisahkan di atas. Rincian tambahan Docker, termasuk hash image/file dan recreate container, belum tercatat. Lulus Windows loopback/LAN tidak membuktikan Docker/Linux/HTTPS; konfirmasi Docker tidak membuktikan HTTPS atau seluruh distro Linux.

Saat mengulang, jalankan setiap baris sebagai environment terpisah; catat browser/OS, revisi/build hash, origin, ukuran byte/MiB, API storage, durasi dan request/body. Baris HTTPS hanya diperlukan ketika cakupan tersebut digunakan.

1. **Docker backend:** build image dari revisi ini dengan `public/vendor` lengkap, jalankan dengan project/volume/origin yang benar, periksa health dan file frontend/helper yang disajikan. Bandingkan byte/hash dengan build di image, bukan sekadar tag image. Pastikan helper tidak hilang dan image benar-benar memakai hasil build baru.
2. **HTTPS reverse proxy:** pakai sertifikat tepercaya perangkat dan domain nyata yang cocok konfigurasi akun. Teruskan endpoint aset ke Node, jangan static alias ke volume. Pertahankan Host publik, strong ETag SHA-256, Content-Length, HEAD, dan status/error asli; jangan mengubah error ke HTML. Hindari transformasi/kompresi representasi ROM/BIOS; jika tetap digunakan, buktikan validator/panjang/bytes konsisten. Tes proxy HTTP test-only M5 bukan bukti TLS/proxy produksi ini.
3. **Cold/warm/restart:** pastikan cache aktif lewat UI pada profil tes, nonaktifkan HTTP cache dan blokir service worker untuk pengukuran. Cold harus tepat satu GET/body penuh per aset, commit/hash benar. Sesi kedua dan restart proses browser profil/origin sama harus HEAD segar, GET/body aset nol. Terapkan ulang pengaturan CDP setiap proses browser.
4. **Restart/recreate backend:** gunakan volume dan origin sama, hentikan Player dahulu, restart lalu recreate backend secara terpisah. Pastikan cache browser tetap ada, server metadata sehat, engine dapat dimainkan, serta HEAD sukses tanpa GET/body pada hit. Jangan menghapus volume untuk menguji recreate.
5. **Origin baru:** ganti satu dari domain/IP/skema/port dan buktikan cache terpisah; jangan menganggap volume Docker ikut memindahkan IDB browser. Kembali ke origin lama harus masih mengenali datanya selama tidak dihapus/evicted.
6. **Penolakan sumber:** cache terisi lalu hapus satu aset/simulasikan file hilang dan offline/5xx pada lingkungan tes. Peluncuran baru harus ditolak, tanpa diam-diam boot memakai cache. Jangan merusak storage/metadata produksi pengguna.
7. **CHD besar yang sah:** gunakan file dan BIOS yang operator berhak gunakan, tanpa mengunggah bytes ke laporan/repo. Catat ukuran/hash, core/build, nama filesystem/memcard, profil/origin, dan resource yang teramati. Cold → sesi kedua → tutup seluruh proses browser → profil/origin sama harus playable/canvas aktif; HEAD segar dan GET/body nol pada hit. Pulihkan progres **lama** lewat Continue/Load dalam game; uji state lama secara terpisah, jangan menghitung pembuatan save baru sebagai bukti kompatibilitas. Simpan backup dahulu.
8. **Rollback:** uji toggle dan build darurat pada profil opt-in yang terisi; boot sehat lewat URL, cache/save tetap utuh, daftar/hapus tersedia. Kembali ke build normal harus menghormati pilihan aktif **dan** nonaktif yang lama.

## Keputusan Aktivasi Default

- **Sudah diaktifkan** pada commit `13ea2b2`, hanya untuk **database/profil baru**. Database lama mempertahankan preferensinya, termasuk nilai nonaktif dari default sebelumnya.
- Tidak ada migrasi massal `enabled: false → true`: skema v1 tidak menyimpan apakah `false` berasal dari default atau pilihan eksplisit pengguna. Pengguna lama dapat mengaktifkannya sendiri melalui Pengaturan tanpa menghapus DB/save.
- Tidak perlu variabel lingkungan baru untuk kebijakan normal. Rem darurat build-time tetap tersedia sebagai override yang dapat dilepas tanpa memodifikasi preferensi/DB/save.
- **M6 ditutup untuk penggunaan lokal/HTTP LAN** berdasarkan implementasi M0–M6, bukti otomatis historis, penerimaan manual Docker di mesin lain dan CHD/progres lama, serta keputusan pengguna menunda HTTPS. Checklist rilis dipetakan ke sumber bukti pada rencana utama; HTTPS tidak dicentang sebagai hasil lulus. Tidak ada klaim “500 MB pasti tersimpan di semua perangkat” atau kesiapan deployment publik.
