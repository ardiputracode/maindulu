# Rencana Scan Koleksi dari Folder Default

Status: **diimplementasikan; verifikasi otomatis dan catatan operasional di bagian 13** — 2026-11-09.

Panduan operator: [Scan Koleksi dari folder server](scan-koleksi-folder.md). Implementasi memakai skema 16, usia minimum perubahan 10 detik, lease 30 detik/heartbeat 5 detik, hashing satu file sekaligus, batas 100.000 item, serta 10.000 detail per job pada 20 job terbaru (counter disimpan 7 hari). Nilai API `kind`: `games`, `bios`, atau `both`; default `both`.

## 1. Tujuan dan keputusan pengguna

Admin menyalin ROM/BIOS lewat WinSCP ke direktori data maindulu, kemudian menjalankan scan dari menu admin agar berkas masuk ke katalog aplikasi tanpa upload melalui browser.

- Struktur folder **sama persis dengan penyimpanan hasil upload yang sekarang**, bukan direktori impor baru.
- Menu **Admin → Scan Koleksi**, dengan pilihan jenis ROM/BIOS/keduanya dan platform semua/beberapa.
- Setelah **Mulai Scan**, berkas baru yang memenuhi validasi **langsung didaftarkan otomatis**. Tidak ada tahap pratinjau, centang hasil, atau tombol “Daftarkan berkas valid”.
- Berkas yang sudah terdaftar dilewati, tidak membuat entri ganda atau mengubah metadata lama.
- Berkas tetap di tempatnya: tidak disalin, dipindah, di-rename, atau dihapus oleh scan.
- Hasil menampilkan progres, jumlah ditambahkan/dilewati/bermasalah, serta alasan per berkas.
- Opsi **“Cari metadata dan cover untuk game baru”** tersedia saat scan. Jika diaktifkan, hanya game yang baru berhasil didaftarkan masuk antrean ScreenScraper; metadata game existing dan BIOS tidak ikut diperbarui.
- Upload browser yang sudah ada tetap tersedia; fitur ini menambahkan jalur pendaftaran dari disk, bukan menghapus fitur lama.

## 2. Dasar implementasi saat ini

Rujukan: [storage nama berkas per platform](storage-nama-berkas-platform.md).

- `server/catalog/paths.mjs`: slug platform, pemetaan console, validasi basename, dan identitas nama NFC + huruf kecil.
- `server/catalog/storage.mjs`: direktori aman, pemeriksaan regular file, hash streaming, dan pemetaan `catalog_asset_files`.
- `server/catalog/repository.mjs`: publikasi katalog, duplikat console + SHA-256, pemulihan ID eksplisit, metadata game, dan revisi katalog.
- `server/catalog/validation.mjs`: ekstensi per console, nama BIOS raw, dan validasi metadata.
- `server/catalog/routes.mjs`: otorisasi, lifecycle operasi, worker metadata, serta maintenance.
- `src/components/AdminCatalog.tsx`: menu dan routing admin yang sudah ada.

Publikasi saat ini mensyaratkan staging upload dan promosi berkas. Scanner **tidak boleh memalsukan stage upload** atau menggunakan promosi yang mencoba membuat ulang berkas tujuan. Dibutuhkan jalur adopsi berkas existing yang aman, dengan aturan publikasi bersama agar kedua jalur tidak menyimpang.

## 3. Folder dan pemetaan platform

```text
MAIN_DULU_DATA_DIR/
├── roms/
│   ├── nes/
│   ├── snes/
│   ├── gb/
│   ├── gbc/
│   ├── gba/
│   ├── genesis/
│   └── psx/
└── bios/
    └── <platform>/<nama-berkas>
```

| Folder | Console aplikasi | Ketentuan |
| --- | --- | --- |
| `nes` | `nes` | ROM/BIOS mengikuti validasi existing. |
| `snes` | `snes` | ROM/BIOS mengikuti validasi existing. |
| `gb` | `gb` | ROM harus konsisten dengan hasil `storagePlatform`. |
| `gbc` | `gb` | ROM `.gbc`; bukan console baru. |
| `gba` | `gba` | ROM/BIOS mengikuti validasi existing. |
| `genesis` | `megadrive` | Jangan membuat console ID `genesis`. |
| `psx` | `psx` | Jangan membuat folder alternatif `ps1`. |

- Scanner memakai allowlist dan pemetaan bersama dari kode storage, bukan menduplikasi aturan secara bebas.
- Hanya basename langsung di folder platform yang dipindai pada versi pertama. Subfolder tidak didukung karena mapping storage sekarang tidak menyimpan nested path.
- Jika lokasi fisik tidak sesuai `storagePlatform(consoleId, fileName, kind)`, lewati sebagai ketidaksesuaian platform. Contoh: `.gbc` di `roms/gb/`, atau arsip di `roms/gbc/` yang menurut aturan upload seharusnya berada di `roms/gb/`.
- BIOS mengikuti pemetaan upload: console `gb` memakai `bios/gb/`, bukan otomatis `bios/gbc/`.
- Folder tidak ada diperlakukan sebagai kosong; folder yang ada tetapi tidak aman dilaporkan dan tidak diikuti.
- `games/` dan BIOS UUID lama tetap kompatibel untuk aset existing, tetapi bukan sumber adopsi scan. `uploads/`, `covers/`, save, database, serta folder platform tak dikenal tidak dipindai.
- Admin tidak dapat memasukkan absolute path atau memilih direktori di luar root yang dikonfigurasi server.

## 4. Alur pengguna dan UI

1. Copy berkas ke folder platform yang benar melalui WinSCP.
2. Buka **Admin → Scan Koleksi** (`/admin/scan`).
3. Pilih jenis: **ROM**, **BIOS**, atau **Keduanya**; default Keduanya.
4. Pilih platform: **Semua** atau beberapa platform folder; default Semua.
5. Opsional, centang **“Cari metadata dan cover untuk game baru”** (default tidak dicentang). Opsi hanya aktif jika jenis mencakup ROM dan layanan metadata tersedia/siap. Tampilkan pemberitahuan data yang dibagikan ke ScreenScraper sebelum scan dimulai.
6. Klik **Mulai Scan**. Tampilkan bahwa berkas valid otomatis masuk katalog dan aset aktif dapat diunduh publik, termasuk oleh tamu.
7. Tampilkan progres dan hasil bertahap; tombol **Batalkan scan** tersedia. Jika opsi metadata aktif, tampilkan jumlah game baru yang masuk antrean metadata secara terpisah.
8. Setelah selesai, katalog dan halaman Manage Game/BIOS memperlihatkan entri baru tanpa restart server. Metadata/cover dapat menyusul karena diproses di background.

Filter tampilan hasil: status dan pencarian nama/path relatif. Filter ini hanya mengubah tampilan hasil, bukan membatalkan pendaftaran yang telah terjadi. Tidak ada opsi overwrite, pemulihan massal, atau scan ulang metadata existing.

Contoh ringkasan: **25 ditambahkan · 120 sudah terdaftar/duplikat · 3 bermasalah**. Detail menggunakan kategori terpisah agar jumlah tidak dihitung ganda.

## 5. Aturan klasifikasi dan pendaftaran

| Kondisi | Tindakan |
| --- | --- |
| Path terpetakan ke entri aktif dan berkas konsisten | `already_registered`; lewati tanpa mengubah entri. |
| Hash sama pada jenis + console yang sama, tetapi nama/path lain | `duplicate`; lewati dan sertakan ID existing untuk admin. File tambahan tidak dihapus. |
| Berkas baru, aman, stabil, format dan ukuran memenuhi aturan | `added`; daftarkan otomatis. |
| Path terdaftar tetapi byte/ukuran berubah | `conflict`; jangan memperbarui hash, ID, atau save. |
| Metadata lama/tombstone cocok tetapi perlu pemulihan aset | `restore_required`; jangan membuat ID baru atau memulihkan diam-diam. |
| Klaim path `reserved`/`deleting` atau cleanup masih berkepentingan | `busy`; lewati, jangan merebut klaim. |
| Nama/ekstensi/platform tidak sesuai, kosong, atau melewati limit | `invalid`; lewati dengan alasan. |
| Symlink/junction, hard link, atau berkas khusus | `unsafe`; tolak. |
| Transfer sementara, terlalu baru, atau berubah saat pemeriksaan | `not_ready`; lewati dan sarankan scan berikutnya. |
| Kegagalan I/O per berkas | `failed`; catat pesan aman dan lanjutkan jika bukan kegagalan sistemik. |

Duplikat mengikuti kontrak existing: **jenis + console + SHA-256 byte berkas**, bukan nama atau isi arsip yang dinormalisasi. ROM dan BIOS tidak saling menduplikasi; console `gb` mencakup GB/GBC seperti model saat ini.

Pemeriksaan path/mapping dilakukan lebih dahulu untuk mencegah publikasi ulang. Konsistensi byte tidak boleh disimpulkan hanya dari nama dan ukuran; verifikasi hash streaming diperlukan sebelum menyatakan aset existing tidak berubah.

### Metadata awal

- Judul game menggunakan pembentukan judul dari nama berkas seperti upload, dengan sumber field `filename` dan tidak dianggap edit manual terkunci.
- Nama BIOS diturunkan dari nama berkas, mengikuti batas nama tampilan repository.
- Deskripsi dan keterangan hak distribusi kosong, cover menggunakan fallback existing. Scanner tidak mengarang lisensi/hak distribusi.
- “Valid” berarti lolos pemeriksaan storage/format/ukuran, **bukan** jaminan ROM playable atau BIOS autentik. Verifikasi database hash BIOS bukan syarat MVP dan jangan ditampilkan seolah sudah tersedia.
- Opsi **“Cari metadata dan cover untuk game baru”** default tidak dicentang. Jika aktif, publikasi game baru membuat job metadata `queued` menggunakan antrean/worker ScreenScraper existing; jika tidak aktif, job metadata tetap `disabled` sesuai kontrak repository.
- Opsi hanya berlaku untuk entri game yang benar-benar baru berhasil dibuat oleh job scan tersebut. Entri already registered, duplikat, konflik, pemulihan ID, serta BIOS tidak mendapat job metadata baru.
- Sebelum mengaktifkan opsi, UI menjelaskan bahwa nama berkas, ukuran, hash, dan sistem ROM dapat dikirim ke ScreenScraper; byte ROM/BIOS tidak dikirim. Metadata/cover hasil provider disimpan dan disajikan lokal sesuai mekanisme existing.
- Pendaftaran katalog tidak menunggu provider. Provider gagal, tidak menemukan kecocokan, atau perlu review tidak membatalkan pendaftaran game; status dan tindak lanjut menggunakan UI metadata existing. Field manual/terkunci tidak ditimpa, dan identitas game/save tidak berubah.
- Jika layanan metadata tidak tersedia/siap, opsi dinonaktifkan dengan alasan yang jelas. Backend memvalidasi kesiapan saat mulai job; permintaan eksplisit metadata yang tidak dapat dipenuhi ditolak dengan pesan terarah, bukan diam-diam diubah menjadi tanpa metadata. Jika kesiapan berubah setelah job berjalan, antrean mengikuti kebijakan worker existing dan masalah ditampilkan tanpa menggagalkan adopsi berkas valid.
- Pembatalan scan folder menghentikan pendaftaran berikutnya, tetapi tidak otomatis membatalkan job metadata dari game yang sudah terdaftar. Pengelolaan/pembatalan metadata tetap melalui mekanisme existing.

### Format disc dan arsip

- Tidak mengekstrak arsip dan tidak memindai isi ZIP/7z/RAR menjadi beberapa game.
- Dukungan paket multi-file `.cue` + track `.bin` dan playlist `.m3u` **bukan bagian MVP**. Jangan mengimpor track sebagai game terpisah atau mengklaim paket tersebut playable.
- Pada folder PSX, `.cue`, `.m3u`, dan `.bin` diperlakukan konservatif sebagai `unsupported_multifile` pada jalur scan. Format single-file yang sudah didukung seperti CHD/PBP/ISO dapat melalui validasi existing.
- Pembatasan scan ini tidak mengubah daftar ekstensi atau perilaku upload existing. Tambahkan pesan agar operator memakai format single-file yang didukung.

## 6. Adopsi storage, transaksi, dan race

1. Enumerasi folder allowlist dengan batas jumlah item dan pemrosesan bertahap; jangan memuat seluruh ROM ke RAM.
2. Periksa root, direktori platform, basename, jenis berkas, limit ukuran, dan status mapping sebelum membaca.
3. Buka melalui mekanisme pemeriksaan file aman existing, hitung SHA-256 streaming, lalu periksa ulang inode/identitas file, ukuran, mtime, dan ctime serta keterikatan pathname. Penukaran path saat hash harus ditolak.
4. Sebelum publikasi, periksa ulang status job, sesi/role admin, duplikat, mapping, dan cleanup yang pending.
5. Buat token `storage_key` internal baru; **nama fisik tidak diubah**. Dalam transaksi singkat, klaim nama dan insert entri katalog + metadata internal + revisi katalog secara atomik.
6. Terapkan unique constraint dan pemeriksaan transaksi yang sama dengan upload untuk menangani dua scan, dua koneksi SQLite, atau scan bersamaan dengan upload.
7. Jangan menahan transaksi SQLite selama hashing. Jika transaksi gagal, rollback mapping/entri milik operasi saja; **jangan unlink berkas operator**.
8. Setelah publikasi sukses, aset mengikuti lifecycle pengelolaan katalog existing, termasuk delete oleh admin. UI/dokumentasi harus menjelaskan bahwa delete katalog dapat membersihkan file yang sudah diadopsi.

Refactor publikasi bersama harus mempertahankan metadata field sources, metadata jobs berstatus `queued` atau `disabled` sesuai opsi scan, ID stabil, katalog revision, DTO, URL aset, cache, quota, dan mekanisme cleanup. Pembuatan job metadata dilakukan atomik bersama publikasi game, tanpa antrean ganda ketika scan diulang atau berlomba dengan upload. Penghapusan rollback upload tidak boleh tanpa sengaja diterapkan pada sumber scan.

Scan tidak memperbaiki aset hilang/tombstone secara otomatis. Prosedur pemulihan eksplisit existing tetap berlaku; penambahan pemulihan langsung dari disk memerlukan rancangan tersendiri.

## 7. Transfer WinSCP dan batas jaminan

- Abaikan berkas sementara seperti `.filepart`, `.part`, `.tmp`, dan berkas tersembunyi yang tidak memenuhi aturan input.
- Dokumentasikan penggunaan nama sementara selama transfer lalu rename ke nama final setelah selesai. Jangan overwrite file yang sudah dikelola aplikasi melalui WinSCP.
- Terapkan usia minimum perubahan dan pemeriksaan kestabilan sebelum/sesudah hashing; angka awal ditetapkan dan diuji pada milestone storage.
- Usia minimum/kestabilan saja **tidak membuktikan transfer selesai**: transfer yang berhenti sementara dapat tampak stabil. Prosedur rename final merupakan pengamanan operasional utama.
- Berkas yang berubah/hilang saat scan tidak diterbitkan. Jika operator mengubah byte setelah publikasi, scanner tidak dapat mencegahnya; pemeriksaan aset existing tetap menolak aset yang tidak konsisten sesuai kontraknya.
- Berkas yang sudah didaftarkan sebelum pembatalan tetap terdaftar. Pembatalan tidak menghapus file atau membatalkan entri sukses sebelumnya.

## 8. Job background dan API usulan

Nama endpoint berikut adalah rancangan, disesuaikan dengan pola backend saat implementasi.

| Endpoint | Fungsi |
| --- | --- |
| `POST /api/admin/catalog-scans` | Mulai job dengan `kind`, daftar slug `platforms`, dan boolean `scanMetadata` (default `false`). Respons `202` + ID job. |
| `GET /api/admin/catalog-scans/active` | Menemukan job aktif setelah refresh halaman. |
| `GET /api/admin/catalog-scans/:id` | Status, scope, progres, counter, dan waktu mulai/selesai. |
| `GET /api/admin/catalog-scans/:id/results` | Detail hasil dengan pagination dan filter status/pencarian. |
| `POST /api/admin/catalog-scans/:id/cancel` | Meminta pembatalan job. |

- Semua endpoint hanya untuk admin; mutasi memakai guard origin/session/CSRF existing. Detail path absolut server tidak diekspos.
- Validasi `scanMetadata` secara ketat dan simpan nilainya sebagai scope job. Nilai `true` ditolak untuk scan BIOS saja. Respons progres membedakan jumlah game yang diantrekan untuk metadata dari jumlah hasil pencarian metadata; scan folder selesai tidak berarti worker metadata selesai.
- Tambahkan capability opsional `catalogScan` pada health dan parser frontend; mode statis/backend lama tetap berjalan dan tidak menampilkan fitur aktif.
- Satu job scan aktif per direktori data; penegakan lintas koneksi/proses melalui database, bukan flag dalam memori saja. Permintaan kedua mendapat `409` dengan referensi job aktif bagi admin.
- Status: `queued`, `running`, `completed`, `cancelled`, `failed`, `interrupted`. Kegagalan beberapa file tidak otomatis menggagalkan seluruh job; kegagalan database/storage sistemik menghentikannya.
- Persist job dan hasil minimum di SQLite agar refresh dapat kembali menampilkan progres. Tetapkan retensi terbatas, misalnya 7 hari dan batas detail hasil; ketika detail dipangkas, counter akhir tetap akurat dan UI memberi tahu.
- Migrasi baru mengikuti nomor skema terbaru saat implementasi, bukan mengasumsikan skema 14 masih yang terakhir.
- Worker memakai lease/heartbeat dan fencing untuk mencegah worker lama menerbitkan entri setelah kepemilikan hilang. Job sisa crash ditandai `interrupted` setelah lease kedaluwarsa; tidak lanjut otomatis, admin dapat scan lagi secara idempoten.
- Worker memeriksa sesi pemulai dan role terbaru sebelum setiap publikasi. Sesi kedaluwarsa/dicabut atau role dicabut menghentikan job, meskipun halaman sudah ditutup.
- Penutupan tab tidak membatalkan job. Shutdown server menghentikan worker dengan tertib; jangan menunggu hash besar tanpa titik pembatalan.
- Batas concurrency hashing rendah, default satu file; total penemuan, hasil, request rate, dan antrean harus dibatasi. Progres membedakan jumlah ditemukan/diproses; jangan menjanjikan persentase total sebelum enumerasi selesai.

## 9. Recovery, quota, dan backup

- Recovery existing tetap memperlakukan berkas belum terdaftar sebagai unknown, bukan menghapusnya. Scan adalah proses eksplisit yang mengadopsinya.
- Koordinasikan scan dengan data lock, maintenance, upload, delete, serta recovery; recovery offline eksklusif tidak boleh berjalan bersamaan dengan worker server.
- Quota tetap menghitung ukuran fisik aktual. Adopsi tidak menambah byte dan tidak boleh menghitung file dua kali. Jika volume sudah over-quota, scan tidak boleh menyamarkan kondisi itu atau menghapus file untuk mengatasinya.
- Backup tetap metadata/akun/save, tidak menyertakan ROM/BIOS/cover. Penambahan tabel job/result memerlukan penyesuaian validasi skema backup.
- Job/result/lease adalah data operasional: jangan melanjutkan job dari snapshot. Normalisasi/exclude saat backup dan restore harus diuji. Ikuti kontrak existing yang menghapus pemetaan aset dari snapshot.
- Scan setelah restore tidak boleh membuat ID baru bagi konten yang membutuhkan pemulihan ID lama. Hasil `restore_required` harus mengarahkan ke prosedur pemulihan yang berlaku.

## 10. Milestone implementasi

### Milestone 1 — Fondasi adopsi berkas existing

- [x] Tambahkan enumerasi folder default dan pemetaan balik platform yang konsisten dengan upload.
- [x] Tambahkan validasi kandidat, kestabilan transfer, hash streaming yang bisa dibatalkan, dan pemeriksaan pathname/inode.
- [x] Refactor publikasi bersama dan buat jalur adopt-in-place tanpa staging/salin/unlink sumber.
- [x] Uji mapping + entri atomik, rollback, duplikat, konflik, tombstone, serta race dengan upload/delete.

**Kriteria selesai:** berkas baru dapat menjadi aset katalog tanpa mengubah byte/nama/lokasi; scan berulang tidak membuat duplikat; kegagalan tidak menghapus sumber atau mengubah identitas lama.

### Milestone 2 — Job, API, dan operasi

- [x] Migrasi job/result serta lease/fencing lintas proses.
- [x] Worker background, pembatalan, shutdown, recovery job crash, batas resource, dan retensi hasil.
- [x] API admin + CSRF, otorisasi selama job, capability opsional, dan pagination hasil.
- [x] Integrasikan revisi katalog, maintenance, quota, data lock, dan normalisasi backup/restore.
- [x] Integrasikan `scanMetadata` dengan kesiapan provider dan antrean existing, hanya untuk game baru, tanpa menggandakan job atau menghambat publikasi saat provider gagal.

**Kriteria selesai:** scan mendaftarkan otomatis, dapat dipantau setelah refresh, hanya satu job aktif, dan tidak dapat dilanjutkan oleh worker/sesi yang kehilangan izin.

### Milestone 3 — UI Admin Scan Koleksi

- [x] Tambahkan tab/link ringkasan dan route `/admin/scan`, termasuk daftar halaman backend untuk fallback SPA.
- [x] Form jenis + multi-platform, opsi “Cari metadata dan cover untuk game baru”, pemberitahuan ScreenScraper, penjelasan publikasi otomatis, progres, batal, filter hasil, dan ringkasan akhir.
- [x] Reuse pola polling saat halaman terlihat, error handling admin, label Indonesia, fokus keyboard, dan tampilan mobile.
- [x] Refresh/invalidate katalog frontend yang relevan setelah perubahan tanpa mengganggu sesi player aktif.

**Kriteria selesai:** copy lewat WinSCP lalu satu klik scan cukup untuk memasukkan file valid ke aplikasi, tanpa upload ulang atau konfirmasi impor kedua.

### Milestone 4 — Regresi dan dokumentasi operasional

- [x] Tes unit/integrasi storage, repository, worker, API, migrasi, backup, dan restart.
- [x] Tes browser scan ROM/BIOS, filter platform, pendaftaran otomatis, duplikat, error, batal, dan refresh halaman.
- [x] Regresi upload, Manage Game/BIOS, library, aset GET/HEAD/range/cache, metadata, serta ID save.
- [x] Dokumentasikan jalur host/volume Docker yang benar, permission WinSCP, transfer sementara + rename, hasil scan, delete aset teradopsi, dan pemulihan eksplisit.

**Kriteria selesai:** skenario operasional utama terverifikasi; hasil tes dicatat nyata, bukan dianggap lulus berdasarkan dokumen ini.

## 11. Matriks pengujian minimum

- Semua folder ROM, GB/GBC dan Genesis, BIOS, pilihan jenis/platform, folder kosong/tidak ada, serta subfolder yang dilewati.
- Nama case/Unicode berbenturan, basename invalid, symlink/junction direktori dan file, hard link, file khusus, traversal payload API.
- File kosong/oversize, ekstensi salah, BIOS raw dengan nama tidak sesuai, arsip, serta disc multi-file yang dilewati secara jelas.
- Transfer sementara, file terlalu baru, file berubah saat hash, pathname diganti, file hilang, permission ditolak, dan hash ROM besar dengan RAM terbatas.
- Duplikat berbeda nama, scan berulang, dua koneksi/proses, race scan-upload/delete/cleanup, serta mapping `reserved`/`deleting`.
- Aset existing berubah byte dengan ukuran sama, metadata missing, tombstone, dan restore metadata tanpa aset: tidak ada overwrite/pemulihan/ID baru diam-diam.
- Batal sebelum dan sesudah commit, crash di sekitar transaksi, lease expired, refresh browser, shutdown, sesi expired, dan demosi admin saat hashing.
- Tamu 401, user 403, CSRF/origin invalid, job ID invalid, capability tidak tersedia, serta request berlebihan.
- Katalog langsung menampilkan entri baru; byte URL aset identik, metadata existing tidak berubah, save existing tetap memakai identitas lama.
- Opsi metadata default mati; saat aktif hanya game baru mendapat satu job `queued`, saat mati job `disabled`; BIOS/duplikat/existing tidak dipindai ulang. Uji provider belum siap, perubahan kesiapan saat berjalan, timeout/gagal/review provider, field terkunci, cover lokal, pembatalan scan dengan metadata yang sudah diantrekan, serta race scan-upload tanpa job metadata ganda. Gunakan provider fixture untuk tes otomatis agar tidak bergantung layanan eksternal nyata.
- Recovery tidak menghapus file operator; quota tidak menggandakan byte; backup/restore tidak menghidupkan job lama.

Perintah verifikasi existing yang relevan setelah implementasi:

```sh
npm test
npm run build
npm run test:e2e:backend -- tests/browser/admin-catalog.spec.ts tests/browser/library.spec.ts
```

Tambahkan suite scan baru pada konfigurasi backend yang memakai daftar `testMatch` eksplisit, lalu jalankan suite tersebut. Pengujian Docker/WinSCP nyata dilaporkan terpisah dari pengujian filesystem/API otomatis.

## 12. Di luar cakupan versi pertama

- Watch folder otomatis atau jadwal scan berkala.
- Memilih direktori bebas, rekursi subfolder, mengganti struktur folder default, atau migrasi file UUID lama.
- Overwrite byte aset, pemulihan ID otomatis, dan menghapus katalog karena file hilang.
- Ekstraksi arsip, paket multi-file/multi-disc, konversi ROM, pembaruan metadata/cover otomatis untuk game existing, dan database verifikasi BIOS. Pencarian metadata/cover opsional untuk game baru termasuk cakupan.
- Menghapus menu upload atau mengubah protokol player/save.

## 13. Realisasi dan hasil verifikasi — 2026-11-09

Implementasi:

- `server/catalog/paths.mjs` menyediakan pemetaan balik slug bersama; `storage.mjs` menyediakan tiket adopsi server-only, hash streaming yang memeriksa pembatalan, dan pemeriksaan ulang pathname/inode/stat sebelum klaim.
- `repository.mjs` memakai publikasi bersama untuk upload/adopsi. Adopsi hanya membuat entri baru, tidak menerima restore/cover dari jalur upload, dan mapping + entri + metadata job + revisi + counter/result sukses scan berada dalam satu transaksi. Rollback adopsi tidak unlink sumber.
- Migrasi **16** menambah `catalog_scans`/`catalog_scan_results`, unique index satu job aktif, dan indeks retensi. `scans.mjs` memasang worker/API admin, heartbeat/lease, fencing pada hash dan commit, otorisasi sesi terbaru, pembatalan, shutdown, interrupt recovery, pagination/filter, rate/resource limits, serta retensi.
- `maintenance.mjs` menghitung byte fisik termasuk file operator sebelum adopsi, tanpa menghitung dua kali setelah adopsi; race unlink cleanup saat sampling ditangani tanpa mengabaikan file unsafe yang masih ada. Job menampilkan warning sampling gagal/over-quota.
- `data-backup.mjs` mengeluarkan job/result/lease scan dari snapshot dan mempertahankan dukungan verifikasi backup skema 7–15 sebelum migrasi. Restore metadata tidak membuat ID baru saat scan menemukan aset yang memerlukan pemulihan eksplisit.
- Capability opsional `catalogScan`, fallback SPA `/admin/scan`, tab/link admin dan `CatalogScan.tsx` tersedia. Polling mengikuti visibilitas, hasil dapat dipulihkan setelah refresh, dan katalog memakai revisi/pembacaan API existing tanpa merombak protokol player/save.

Verifikasi yang benar-benar dijalankan:

| Perintah | Hasil |
| --- | --- |
| `npm test` | Regresi awal 574/574 lulus. Setelah penambahan dua tes, eksekusi default mencapai 575/576 dengan satu timeout startup CLI; verifikasi penuh final dengan concurrency dibatasi tercatat di baris berikutnya. |
| `node --test --test-concurrency=4 tests/*.test.mjs` | **576/576 lulus**, termasuk startup/restart CLI yang sebelumnya timeout; tidak ada tes dilewati. |
| `node --test tests/catalog-scans.test.mjs` | **16/16 lulus**, termasuk adopsi semua platform/BIOS, idempotensi, klasifikasi, rollback, penggantian pathname saat hash, CSRF/role/sesi, pembatalan/lease, SQLite lintas koneksi/proses, race upload, fixture metadata/cover, backup/restore ID lama, shutdown/restart, dan retensi/kuota. |
| `node --test tests/catalog-scans.test.mjs tests/catalog-api.test.mjs` | **76/76 lulus** saat dijalankan, termasuk regresi cleanup/upload, aset GET/HEAD/range/ETag, dan pemulihan BIOS. |
| `npm run build` | **Lulus** (TypeScript + Vite); warning bundle utama >500 kB tetap ada, bukan build error. |
| `npm run test:e2e:backend -- tests/browser/library.spec.ts --timeout=180000` | **10/10 lulus**, termasuk player, BIOS, save, restart server dan backup metadata. |
| `npm run test:e2e:backend -- tests/browser/catalog-scans.spec.ts tests/browser/admin-catalog.spec.ts --timeout=180000` | **14/14 lulus**; suite scan tercantum dalam `testMatch` backend. |
| `npm run test:e2e:backend -- tests/browser/catalog-scans.spec.ts --timeout=180000` | **2/2 lulus lagi** setelah penambahan tampilan scope asli job setelah refresh; build final juga lulus. |

Total browser ketiga suite: **24 skenario berbeda lulus**, ditambah pengulangan dua skenario scan pada build final. Percobaan gabungan sebelumnya terkena timeout per tes/batas waktu proses di mesin Windows; hasil itu tidak dihitung sebagai kelulusan. Pengulangan final memakai batas 180 detik per tes dan selesai bersih. Suite unit final membatasi concurrency menjadi empat untuk menghindari timeout startup CLI saat seluruh file tes bersaing atas resource mesin; timeout produksi dan konfigurasi tes existing tidak dilonggarkan.

**Verifikasi manual operator:** pengguna mengonfirmasi bahwa deployment Docker, transfer WinSCP, dan ScreenScraper live sudah diuji manual dan berhasil. Hasil ini dilaporkan pengguna, terpisah dari tes otomatis yang dijalankan agen memakai filesystem/API/backend/browser nyata serta provider/cover fixture. Kelulusan tersebut bukan jaminan semua ROM playable atau BIOS autentik; batas jaminan dan prosedur operasional tetap berlaku.
