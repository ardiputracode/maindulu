# Riwayat perubahan maindulu

Perubahan penting per rilis didokumentasikan di sini. Format mengikuti
[Keep a Changelog](https://keepachangelog.com/) dengan kategori
**Ditambahkan / Diubah / Diperbaiki**; versi memakai SemVer.

Selama pengembangan, tulis eksil baru di bagian **[Belum dirilis]**;
saat rilis, promosikan isinya menjadi nomor versi dengan tanggal.

## [Belum dirilis]

### Ditambahkan

- Fondasi Milestone 1 Admin/Library/BIOS: migrasi SQLite 7 untuk role `user`/`admin` (semua akun lama/baru default `user`), role publik pada respons akun dan parser frontend, guard admin berbasis role database terkini, serta `GET /api/admin/status` (401 tamu, 403 akun biasa).
- CLI terminal `npm run account:role -- username admin|user` untuk akun yang sudah ada, memakai data lock bersama server dan menolak maintenance eksklusif. Perubahan langsung berlaku pada sesi aktif tanpa mengubah identitas, kredensial, atau progres. Script ikut allowlist dan image backend; tidak tersedia pengelolaan role lewat frontend/API.
- Guard multipart opt-in per route dengan origin/cookie/CSRF tetap wajib sebelum parsing, tanpa mengubah tipe/batas API akun/save. Health capability `admin: true`, `gameCatalog: false`, `biosCatalog: false`; halaman admin, upload, dan katalog dinamis belum diimplementasikan.
- Tes role, bypass payload, pencabutan akses, migrasi akun/save/sesi lama, CLI/data lock, serta pelestarian role pada backup/restore. Panduan operasional: `doc/admin-role-akun.md`.
- Penutupan Milestone 1 dalam cakupan terverifikasi: **125 tes unit/integrasi**, **30 tes browser akun/state/progres NES** tanpa retry/skip, dan build lulus; discovery/tamu statis dev/produksi masing-masing 5 tes lulus. Bukan bukti Docker/HTTPS nyata atau gameplay semua core.
- Fondasi Milestone 2 Admin/Library/BIOS: migrasi SQLite 8 dengan tabel game/BIOS, UUID stabil, metadata cover, tombstone, dan duplikat unik per console + SHA-256 byte upload termasuk arsip. Storage privat ber-key acak dan staging streaming mengikuti `MAIN_DULU_DATA_DIR`, tanpa API upload/UI atau perubahan identitas save.
- `npm run storage:recover` untuk inspeksi offline; `npm run storage:recover -- --apply` membersihkan staging/orphan yang dikenali dengan exclusive data lock, tanpa menghapus aset aktif/save. Modul katalog dan CLI masuk allowlist image backend. Panduan: `doc/milestone-2-katalog-storage.md`.
- Penutupan Milestone 2 dalam cakupan persistence: **153 tes unit/integrasi**, build, dan **35 tes browser backend akun/discovery/state/progres NES** lulus tanpa retry/skip. Tes katalog mencakup konkurensi lintas proses, crash terkontrol, migrasi/rollback, proteksi storage, dan pengaman backup; belum membuktikan upload HTTP, gameplay katalog dinamis, Docker/HTTPS, atau disk penuh nyata.
- Milestone 3 Admin/Library/BIOS: API katalog publik/admin dengan pencarian/filter/pagination SQL; multipart streaming ROM/BIOS/cover sesudah guard admin/origin/CSRF; pemeriksaan ulang sesi/role saat commit; validasi raster PNG/JPEG/WebP lengkap, dimensi dan animasi; GET/HEAD/single range tanpa cache. URL ROM dan BIOS mempertahankan nama yang dibutuhkan engine, tanpa mount static direktori data atau perubahan player/engine/frontend.
- Skema SQLite 9 untuk reservasi upload bersama lintas proses dan antrean cleanup persisten: quota katalog terpisah, reserve disk, deadline upload, kompensasi gagal publikasi, delete tombstone + retry, restore ID lama dengan key baru, dan shutdown yang menunggu pekerjaan async. Konfigurasi diteruskan Compose; contoh reverse proxy dan kontrak HTTP ada di `doc/milestone-3-api-katalog.md`. Dependensi produksi baru: `@fastify/multipart` dan `sharp`.
- Penutupan Milestone 3 dalam cakupan backend: **183 tes unit/integrasi**, build, **37 tes browser backend** akun/save + smoke ROM upload/nama BIOS sintetis, serta **5 dev + 5 produksi** discovery/tamu statis lulus. Pengulangan smoke akhir 7/7; satu percobaan paralel dengan build gagal 404 saat `dist/` diganti, lalu pengulangan berurutan lulus. UI admin/Library, boot firmware nyata/semua core, Docker/Alpine/HTTPS, disk penuh fisik, dan backup koleksi belum diklaim.

### Diubah

- Backup baru format 1 mensyaratkan skema 8 dengan tabel/aset katalog kosong; entri aktif, tombstone, dan aset yatim memblokir backup agar koleksi tidak diabaikan diam-diam. Verify/restore backup skema 7 tetap didukung tanpa migrasi sumber; untuk skema 6, gunakan aplikasi lama terlebih dahulu. Backup ROM/BIOS/cover lengkap tetap Milestone 7 katalog.
- Setelah Milestone 3, capability `gameCatalog`/`biosCatalog` menjadi `true` untuk API (bukan UI). Backup baru mensyaratkan skema 9 dengan katalog/aset/antrean/reservasi kosong; verify/restore skema 7/8 kosong tetap didukung. Recovery apply offline juga membersihkan koordinasi upload/cleanup mati. Koleksi upload tetap belum boleh digunakan untuk produksi sebelum backup koleksi Milestone 7.

### Diperbaiki

- Sinkronisasi tes regresi browser save: verifikasi checksum tersimpan menggantikan teks status sementara, snapshot konflik dua tab dibuat benar-benar berbeda tanpa bergantung revisi awal tetap, konflik otomatis tidak menunggu klik tombol yang sudah dinonaktifkan, event toolbar menghindari race auto-hide/canvas, dan pembacaan state tamu menunggu write IndexedDB. Tidak mengubah runtime player/save atau batas keamanan untuk membuat tes lulus.

## 0.3.1 — 2026-10-25

### Ditambahkan

- Mode akun HTTP jaringan yang harus diaktifkan dengan `MAIN_DULU_ALLOW_INSECURE_HTTP=true` dan `MAIN_DULU_PUBLIC_ORIGIN` eksplisit. Hanya untuk LAN tepercaya: password, cookie sesi, kode pemulihan, dan save tidak terenkripsi. Default tetap localhost/HTTPS; Host/origin, CSRF, HttpOnly/SameSite, pembatasan akun dan kuota tidak dilemahkan. Startup menampilkan peringatan untuk mode HTTP ini; backup mencatat opsi tersebut sebagai informasi, bukan menerapkannya otomatis saat restore.
- Panduan Docker backend lengkap di `deploy/README.backend.md` dan contoh `deploy/backend.env.example`: deploy LAN tanpa domain/sertifikat, localhost, perpindahan ke HTTPS, env-file, build/recreate, firewall, volume, backup/restore offline, reset admin, update, dan troubleshooting. `deploy/README.md` kini membedakan backend dari Nginx statis.
- Panduan pemeriksaan dan karantina lock namespace container lama setelah semua pemilik berhenti, tanpa menghapus database/save/volume; penjelasan database lokal tidak otomatis diimpor ke image Docker dan perlunya backup/restore seluruh instalasi untuk migrasi.
- Tes regresi opt-in HTTP, konfigurasi fail-closed, cookie HTTPS/HTTP, origin/CSRF/sesi, serta penyalinan modul format save ke image runtime.

### Diubah

- Versi aplikasi, lockfile, dan tag image backend menjadi **0.3.1**, tanpa perubahan versi dependensi, skema SQLite **6**, engine **4.2.3**, atau format save.
- Dokumentasi akun/operasi menjelaskan pengecualian HTTP LAN eksplisit dan risikonya; file `.env`/`.env.*` lokal diabaikan Git.

### Diperbaiki

- Backend Docker gagal start dengan `Cannot find module '/app/src/lib/game-save-format.ts'`: modul bersama kini disalin secara eksplisit ke stage runtime, tidak hanya stage build.

## 0.3.0 — 2026-10-25

### Ditambahkan

- Opsi Docker backend Node.js 24 terpisah dari container Nginx statis: akun/save server, CLI admin/backup, volume privat untuk data dan lock, runtime non-root/read-only, healthcheck API, serta publish port localhost secara default. Konfigurasi/panduan tersedia di `deploy/Dockerfile.backend`, `deploy/docker-compose.backend.yml`, dan `deploy/README.backend.md`. Docker CLI belum tersedia pada lingkungan verifikasi ini; build/runtime container belum diklaim lulus.
- M8 selesai untuk penggunaan lokal: CLI `data:backup`, `data:verify`, dan `data:restore` untuk backup instalasi offline berformat folder + manifest SHA-256. Snapshot SQLite resmi dan blob aktif/cadangan M7 diverifikasi sebagai satu kumpulan; restore hanya ke folder baru, mempertahankan ID/revisi/receipt dan mencabut seluruh sesi. Lease antarproses mengecualikan maintenance dari server/reset admin tanpa menghapus dukungan koneksi bersama. Restore NES dibuktikan otomatis; pengguna mengonfirmasi progres PS1 terbaca setelah restore instalasi secara manual, bukan klaim seluruh game/card/varian. HTTPS belum diimplementasikan/diuji pengguna dan ditunda; akun jaringan belum dinyatakan siap. Panduan operasi/HTTPS/pembaruan dan matriks bukti: `doc/milestone-8-backup-operasi.md`. Tanpa enkripsi, scheduler, pruning, atau backup ROM/BIOS/aplikasi bawaan.
- M7: UI penyelesaian konflik state/progres dengan pilihan eksplisit dan cadangan versi tersisih; impor read-only save browser serta file native `.srm`/`.state`; restart player sebelum boot untuk progres server/impor. Pengelola cadangan lintas game menyediakan unduh/pulihkan/hapus, tanpa penghapusan otomatis. Metadata impor membedakan build tujuan yang dikonfirmasi dari build sumber yang tidak diketahui. NES legacy diverifikasi otomatis; pengguna mengonfirmasi tes PS1 M7 berhasil manual, dengan rincian cakupan/konfigurasi belum dicatat. Panduan dan keputusan persiapan: `doc/milestone-7-konflik-impor-save.md`.
- Migrasi SQLite versi 6: `save_backups` dan receipt `save_decisions` untuk keputusan idempoten, pemeriksaan revisi, kuota aktif+cadangan, serta pembersihan blob yang menghitung semua referensi. Bundle/fingerprint engine M6 tidak diubah.
- M6 selesai dalam cakupan terverifikasi: pemulihan progres asli game sebelum boot, pemeriksaan SRAM NES otomatis setiap 10 detik saat aktif, memcard aktif PS1, checksum/revisi, retry terbatas/idempoten, flush saat navigasi, status dan ekspor `.srm`, serta **Akun → Kelola progres game**. NES lulus otomatis; pengguna mengonfirmasi ekspor dan pemulihan PS1 dari server pada sesi/browser baru melalui Continue/Load dalam game, tanpa impor manual atau muat state M5. Seluruh game/card/varian PS1 belum diklaim. Gagal pengambilan awal menahan boot; konflik tidak ditimpa otomatis. Panduan dan hasil manual: `doc/milestone-6-progres-game.md`.
- Migrasi SQLite versi 5 untuk `game_saves` dan blob privat terpisah; paket M6 maksimal 8 MiB, kuota akun gabungan dengan state M5. Hook vendoring sinkron `EJS_mainduluBeforeBoot` memasang save setelah ekstraksi ROM tetapi sebelum `callMain`, tanpa mengubah persistence tamu.
- Save state server manual M5: tombol **Save state server** di toolbar emulator (di sebelah Import Save File) membuka overlay yang mem-pause permainan saat terbuka dan melanjutkan hanya permainan yang berjalan saat ditutup; tiga slot manual plus slot **Autosave** khusus (slot 99) dengan toggle dan interval (Nonaktif default, 30 detik, 1–15 menit) yang ditimpa otomatis saat aktif. Checksum/revisi, penyimpanan privat atomik, kuota terkonfigurasi dengan peringatan 80%, pengelola lintas game, serta unduhan cadangan dan retry eksplisit. Player akun terisolasi dari storage tamu; sinkronisasi save game/memcard tetap M6. Dukungan server dibuktikan otomatis pada NES.
- Migrasi SQLite versi 4: tabel `saves` dibangun ulang agar slot 99 (Autosave) diizinkan di CHECK constraint; data lama dipindahkan apa adanya.
- Dua patch vendoring engine baru: `togglePlaying` melaporkan transisi play/pause ke bridge (`EJS_onPlayPause` untuk jeda overlay dan gating autosave), dan `buildButtonOptions` menerima tombol bar kustom lengkap (displayName + icon + callback) yang upstream 4.2.3 menolak.
- Notifikasi autosave sederhana di pojok kanan atas player: proses simpan, konfirmasi tersimpan dari server, atau kegagalan. Notifikasi hasil hilang otomatis dan tetap tersedia saat fullscreen sesi akun.
- Pemulihan akun M4 tanpa email: reset dengan kode sekali pakai, penerbitan ulang setelah verifikasi password, dan `npm run account:reset -- <username>` untuk admin lokal dengan password tersembunyi. Reset merotasi kode dan mencabut seluruh sesi secara transaksional tanpa mengubah ID akun; cloud save belum termasuk.
- Kredit/attribution di footer aplikasi dan README: maindulu dirakit oleh
  [ArdiputraCode](https://github.com/ardiputracode/maindulu), kode full assisted
  by AI; engine emulator (EmulatorJS) dan core-nya milik pembuat aslinya.

### Diubah

- Versi aplikasi menjadi **0.3.0**, konsisten dengan lockfile, UI, dan tag image backend. Skema SQLite tetap **6**, engine tetap **4.2.3**.
- Build context Docker menggunakan allowlist sumber agar folder data/backup custom, environment privat, dan artefak host tidak ikut dikirim. Dua CLI administrasi disertakan secara eksplisit untuk image backend; image statis tetap seperti sebelumnya.
- Tombol native **Import Save File** sesi akun tetap disembunyikan; gunakan wizard impor eksplisit M7 agar tidak melewati cadangan/revisi server. Ekspor native dan impor tamu tetap tersedia. Muat state server memperingatkan kemungkinan SRAM/memcard lama ikut dipulihkan dan tersinkron ulang. Dukungan PS1 di luar skenario manual yang dikonfirmasi tetap percobaan, bukan klaim seluruh card/slot/multi-disk atau tes otomatis PS1 M7.
- Menu **Save States** di dalam gerigi emulator disembunyikan untuk akun maupun tamu. Tombol native Save State/Load State untuk tamu serta nilai dan mekanisme internal **System Save interval** tidak diubah.

### Diperbaiki

- Lease data mencatat identitas host/namespace PID. Proses tidak boleh membersihkan lease container/host lain berdasarkan PID lokal; namespace berbeda/tidak diketahui pada Linux ditahan untuk pemeriksaan operator. Ini tidak menggantikan kewajiban menghentikan server saat backup/restore offline.
- Pesan startup backend kini menyatakan kemampuan save server yang tersedia, bukan keterangan fondasi M2 yang sudah usang.
- Overlay **Save state server** tidak lagi menyusun seluruh bagian secara horizontal: satu dialog vertikal responsif, kartu slot manual/Autosave terpisah, status yang lebih jelas, serta navigasi Tab/Escape dan pemulihan fokus.
- Overlay save dan pengelola simpanan sesi akun kini tetap muncul saat fullscreen. Fullscreen mencakup pembungkus player bersama iframe, overlay, dan notifikasi; status tombol fullscreen engine mengikuti keadaan browser.

## 0.2.0 — 2026-10-23

### Ditambahkan

- Toggle **Layar lebar** di menu engine (Settings → Graphics Settings, pilihan
  Nyala/Mati dalam bahasa aplikasi): gambar 4:3 di-stretch mengisi kotak player
  16:9 tanpa menyentuh file ROM, input, atau save. Tidak berpengaruh saat kotak
  sempit (misalnya ponsel potret). Preferensi tersimpan di pengaturan maindulu
  dan diterapkan otomatis pada sesi berikutnya; kotak player ikut menjadi 16:9.
- Nomor versi tampil di halaman Pengaturan (`maindulu v…`), dibaca otomatis
  dari `package.json` saat build.

### Diubah

- Engine EmulatorJS 4.2.3 di-vendor ulang dari arsip asli terpinji SHA-256
  untuk memasang dua patch menu/hook Layar lebar. Daftar patch pada
  `third_party/emulatorjs/4.2.3/provenance.json` diperbarui; bundle dan sumber
  readable terekonstitusi secara identik dari `scripts/vendor-engine.mjs`.

### Diperbaiki

- Game gagal mulai dengan pesan "Failed to start game" ketika preferensi Layar
  lebar masih menyala dari sesi sebelumnya: pengamat ukuran kanvas lari saat
  kanvas belum tersangkut ke DOM pada urutan start engine. Regresinya tercakup
  di `tests/browser/app.spec.ts` (preferensi tersimpan + game tetap mulai).
