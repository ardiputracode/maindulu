# maindulu

**Dulu pulang sekolah. Sekarang pulang kerja.**

Frontend emulator berbahasa Indonesia, bertema hijau hutan/mint. Logo dan banner menggunakan SVG yang disediakan. Engine **EmulatorJS v4.2.3** beserta enam core awal sudah berada di proyek—tidak membutuhkan CDN EmulatorJS saat dijalankan.

## Jalankan

Gunakan Node.js **24+** (backend opsional memakai SQLite bawaan Node, dan tes unit memakai dukungan TypeScript native Node).

```sh
npm install
npm run dev
```

Buka http://localhost:5173. Produksi:

```sh
npm run build
npm run preview
```

Folder `dist/` berisi aplikasi **dan seluruh aset engine**. Tidak ada langkah unduh engine saat build biasa. Jangan hapus `public/vendor` dari deployment.

### Web + backend lokal, tanpa Docker

```sh
npm run build
npm start
```

Buka **http://localhost:7777**. Satu proses Node.js menyajikan frontend dan API, dengan SQLite persisten di `data/maindulu.sqlite`. Default hanya mendengarkan komputer sendiri. Port, host, dan folder data dapat diubah lewat konfigurasi lingkungan; lihat [panduan backend M2](doc/milestone-2-backend-lokal.md).

**Akun lokal opsional**: pilih **Masuk → Daftar**, lalu simpan kode pemulihan yang ditampilkan sekali. Login/logout, ganti password, pemulihan dengan kode sekali pakai, dan penerbitan ulang kode tersedia tanpa Google atau email. Pengelola dengan akses OS dapat menjalankan `npm run account:reset -- <username>` dengan input password tersembunyi. Lihat [panduan akun M3](doc/milestone-3-akun-lokal.md) dan [pemulihan akun M4](doc/milestone-4-pemulihan-akun.md).

**Role admin (belum dirilis):** seluruh akun lama/baru default `user`. Promosi lewat `npm run account:role -- username admin`, demosi lewat `npm run account:role -- username user`; berlaku pada sesi aktif tanpa mengubah akun/save. Pengelolaan lewat API tersedia pada tahap pengembangan; halaman admin belum tersedia. Lihat [panduan role, keamanan, dan migrasi](doc/admin-role-akun.md).

**Katalog persisten (Milestone 2–3 Admin/Library/BIOS, belum dirilis):** metadata game/BIOS memakai SQLite, berkas internal memakai `games/`, `bios/`, `covers/`, dan staging `uploads/` di bawah `MAIN_DULU_DATA_DIR`. API publik katalog/unduh serta API admin upload/edit/delete tersedia; UI admin dan integrasi Library/pilihan BIOS dinamis belum tersedia. Delete menolak akses baru lalu membersihkan berkas dengan retry, tanpa menghapus save. Inspeksi orphan offline: `npm run storage:recover`; pembersihan memerlukan `-- --apply` dan server berhenti. **Jangan gunakan koleksi upload sebagai produksi sebelum backup koleksi Milestone 7 tersedia.** Lihat [fondasi storage](doc/milestone-2-katalog-storage.md) dan [kontrak API, konfigurasi, serta verifikasi Milestone 3](doc/milestone-3-api-katalog.md).

**Save state server manual (M5):** login sebelum membuka game, lalu gunakan tombol **Save state server** di toolbar emulator untuk membuka overlay. Game jeda otomatis saat overlay terbuka dan lanjut kembali saat ditutup. Overlay menyediakan simpan/muat pada tiga slot manual dan slot **Autosave** khusus (slot 99) dengan toggle + interval (Nonaktif default, 30 detik, 1–15 menit). Default 32 MiB per state dan 256 MiB per akun, dengan peringatan 80%, pengelola lintas game, serta unduhan cadangan/retry saat upload gagal. Verifikasi otomatis saat ini NES; core lain masih percobaan. Mode tamu/statis tetap menyimpan di browser. Lihat [panduan M5 dan konfigurasi kuota](doc/milestone-5-save-state-server.md).

**Progres game otomatis (M6):** setelah login, save asli game/SRAM NES dipulihkan sebelum boot dan diperiksa setiap 10 detik saat game aktif. **M6 selesai dalam cakupan terverifikasi:** NES diuji otomatis; ekspor dan pemulihan memcard aktif PS1 lintas sesi/browser dikonfirmasi manual pengguna. Semua game/card/varian PS1 belum dinyatakan terverifikasi. Gunakan Continue/Load dalam game, bukan Muat state M5. Kontrol **Sinkronkan progres sekarang** dan **Unduh cadangan progres** berada di bawah player; pengelola lintas game ada di **Akun → Kelola progres game**. Paket maksimal 8 MiB, memakai kuota gabungan yang sama dengan M5. Gagal ambil save awal menahan boot; konflik tidak ditimpa otomatis. Core lain belum disinkronkan dan progres akun masih sementara di memori. Lihat [panduan M6, hasil manual, dan batas PS1](doc/milestone-6-progres-game.md).

**Konflik dan impor (M7):** pilih **Tinjau konflik progres/state** untuk meninjau dan memilih versi; versi yang ditinggalkan dicadangkan. **Impor progres** tersedia di player; **Impor state** pada overlay Save state server. Sumber dapat berupa save browser pada origin/profil yang sama atau file `.srm`/`.state`; sumber tidak dihapus. Progres server/impor dipasang melalui sesi player baru sebelum boot, sedangkan state tidak dimuat otomatis. **Akun → Kelola cadangan konflik/impor** menyediakan unduh, pulihkan, dan hapus berkonfirmasi. Cadangan **tidak dihapus otomatis** dan memakai kuota gabungan; penggantian ditolak bila ruang tidak cukup. Metadata asal file mentah dapat tidak diketahui, jadi periksa ROM/core dan hasil gameplay. Lihat [panduan M7 dan batas verifikasinya](doc/milestone-7-konflik-impor-save.md).

Verifikasi M7 memakai NES legacy otomatis; pengguna juga mengonfirmasi tes PS1 M7 berhasil manual. Rincian skenario PS1 belum dicatat, sehingga hasil tersebut bukan klaim semua game/card/slot/varian. Lihat [hasil manual dan batas verifikasi M7](doc/milestone-7-konflik-impor-save.md#hasil-manual-ps1-m7--pengguna).

Saat memperbarui backend, hentikan server dan cadangkan seluruh folder data privat dengan versi aplikasi lama terlebih dahulu. Startup pengembangan terbaru memigrasikan SQLite ke versi **9** (role, katalog, reservasi upload, antrean cleanup) tanpa menghapus save lama; jangan downgrade aplikasi/database secara paksa. Verify/restore format 1 menerima skema 7, 8, dan 9 dengan katalog kosong; pembuatan backup baru mensyaratkan skema 9 dengan tabel/aset katalog serta antrean/reservasi kosong. Backup skema 6 harus diverifikasi/di-restore dengan versi lama sebelum hasil restore dimigrasikan.

**Backup instalasi (M8):** sinkronkan progres, tutup seluruh player, dan hentikan server/admin sebelum `npm run data:backup -- <folder-backup-baru>`. Periksa dengan `npm run data:verify -- <folder-backup>`, lalu simpan salinan di perangkat/lokasi lain. Pulihkan melalui `npm run data:restore -- <folder-backup> --to <folder-data-baru>`; tujuan harus belum ada, data lama tidak ditimpa, dan semua sesi hasil restore dicabut. Arahkan `MAIN_DULU_DATA_DIR` ke hasil restore, tinjau konfigurasi, lalu login ulang. Backup tidak terenkripsi, berisi data privat semua akun, dan tidak mencakup ROM/BIOS/aplikasi/progres tamu. Lihat [panduan operasi, backup/restore, dan batas verifikasi M8](doc/milestone-8-backup-operasi.md).

**M8 selesai untuk penggunaan lokal:** restore NES dibuktikan otomatis; pengguna mengonfirmasi progres PS1 terbaca setelah restore instalasi secara manual, tanpa klaim semua game/card/varian. HTTPS belum diimplementasikan atau diuji oleh pengguna. Sejak **0.3.1**, tersedia pengecualian HTTP akun untuk LAN tepercaya yang harus diaktifkan secara eksplisit; ini bukan HTTPS atau koneksi terenkripsi.

Overlay tersusun vertikal dan responsif; tutup dengan tombol **×** atau **Escape** saat tidak ada operasi manual berlangsung. Overlay dan pengelola tetap tersedia saat fullscreen sesi akun. Notifikasi autosave muncul singkat di pojok kanan atas player; **Autosave tersimpan** hanya muncul setelah konfirmasi server. Menu **Save States** di dalam gerigi disembunyikan untuk semua pengguna, tetapi tombol native Save State/Load State tamu dan pengaturan internal **System Save interval** tetap tidak diubah.

`npm run dev`, `npm run preview`, dan deployment statis tetap berfungsi tanpa backend atau request API. Mode backend aktif otomatis hanya saat halaman dilayani server Node.js (atau melalui opt-in frontend yang dikonfigurasi khusus). Akun dapat dipakai lewat HTTP localhost; default akses jaringan memerlukan origin HTTPS. Untuk **LAN tepercaya saja**, `MAIN_DULU_ALLOW_INSECURE_HTTP=true` bersama `MAIN_DULU_PUBLIC_ORIGIN=http://IP-SERVER:7777` mengizinkan akun HTTP. Origin harus sama dengan URL browser; flag tanpa origin ditolak. **Password, cookie sesi dan save dapat disadap; jangan buka mode HTTP ini ke internet atau gunakan password layanan lain.** Lihat [panduan deploy backend](deploy/README.backend.md).

Untuk mencoba dari HP di Wi-Fi yang sama, buka `http://IP-KOMPUTER:5173`. Server dev/preview mendengarkan pada semua interface. Membuka ROM lokal juga bekerja lewat HTTP jaringan: SHA-256 memiliki fallback JavaScript yang dibundel lokal, dan ID sesi memakai `crypto.getRandomValues` bila `randomUUID` tidak tersedia. Tidak perlu mematikan pengamanan browser. Gunakan HTTP hanya di jaringan tepercaya; HTTPS tetap disarankan untuk deployment publik.

## Yang tersedia

- Beranda, Jelajahi console, Terakhir dimainkan, Favoritku, Cara bermain, Pengaturan.
- Membuka ROM/BIOS lokal lewat file picker atau drop ROM. File tidak di-upload atau disimpan permanen.
- Game/BIOS pada UI melalui manifest; backend menyediakan API upload/katalog/unduh terpisah, belum UI admin/Library.
- Pilihan BIOS lokal/server independen dari sumber ROM.
- Favorit, metadata riwayat, volume awal, dan toggle riwayat di LocalStorage.
- Player iframe terisolasi, validasi pesan/sesi, konfirmasi keluar, dan pembersihan instance.
- Core lokal NES (`fceumm`), SNES (`snes9x`), GB/GBC (`gambatte`), GBA (`mgba`), Mega Drive (`genesis_plus_gx`), PS1 (`pcsx_rearmed`). Varian non-threaded normal dan legacy dibundel.
- **Jalan Pulang**, homebrew NES orisinal berlisensi CC0, dapat dimainkan langsung. Gerakkan karakter kiri/kanan untuk menangkap bintang. Ini contoh teknis, bukan ROM komersial.
- Backend Node.js opsional, dengan atau tanpa Docker: web + API satu proses, SQLite persisten, akun lokal dengan sesi cookie HttpOnly, pemulihan akun, save state server berkuota, dan sinkronisasi progres NES; ekspor/pemulihan memcard aktif PS1 lulus manual pada skenario pengguna, bukan semua game/card/varian.

## Tambahkan game server (manifest statis)

Untuk upload backend tanpa build ulang, lihat [API katalog Milestone 3](doc/milestone-3-api-katalog.md). Langkah di bawah tetap untuk manifest statis; UI saat ini belum membaca katalog database.

1. Simpan ROM yang berhak didistribusikan di `public/games/`.
2. Simpan cover lokal di `public/covers/`.
3. Tambahkan entri ke `public/catalog/games.json`:

```json
{
  "id": "id-game-stabil",
  "title": "Judul permainan",
  "consoleId": "nes",
  "source": "server",
  "url": "/games/permainan.nes",
  "cover": "/covers/permainan.svg",
  "license": "Informasi izin distribusi"
}
```

Pertahankan ID agar riwayat dan save tidak berganti. Jika isi/versi ROM tidak kompatibel dengan save lama, gunakan ID baru. UI tidak mengindeks direktori otomatis. Path harus berasal dari origin yang sama. Untuk deployment produksi, build ulang setelah menambah konten.

## Tambahkan BIOS server

Tidak ada BIOS proprietary yang disertakan. Tambahkan berkas yang berhak didistribusikan ke `public/bios/`, lalu isi `public/catalog/bios.json`:

```json
[
  { "id": "bios-psx", "name": "BIOS PlayStation", "consoleId": "psx", "url": "/bios/scph1001.bin" }
]
```

Semua isi `public/` dapat diunduh pengunjung, **bukan penyimpanan privat**. BIOS yang salah dapat membuat game gagal walaupun ekstensi lolos validasi. Pertahankan nama firmware sesuai core. Untuk banyak firmware gunakan satu ZIP. Jalur BIOS lokal dikemas sebagai ZIP tanpa kompresi di memori agar nama file yang diharapkan core tidak hilang karena URL blob.

## Format dan batas MVP

- ROM maksimal 768 MB; BIOS maksimal 32 MB. RAM perangkat/browser tetap menjadi batas nyata.
- ZIP/7z/RAR diproses engine; satu arsip harus berisi satu game, bukan koleksi.
- CUE/BIN multi-file: kemas CUE dan semua BIN dalam satu ZIP, pertahankan nama dan struktur.
- Game lokal diidentifikasi melalui SHA-256 isi ROM dan console. HTTPS/localhost memakai Web Crypto jika tersedia; HTTP jaringan memakai fallback lokal dengan hasil identik, sehingga ID favorit/save tetap cocok. File besar di-hash bertahap untuk membatasi penggunaan memori.
- Ekstensi bukan bukti integritas atau kompatibilitas. Console ambigu (misalnya BIN) harus dipilih manual.
- PS1 menggunakan HLE bila tanpa BIOS; BIOS asli disarankan dan tidak semua game kompatibel dengan HLE.
- Tidak menjanjikan semua game pada enam console kompatibel. Uji per core dan perangkat.
- Sinkronisasi save game saat ini mencakup SRAM NES dan jalur memcard aktif PS1 percobaan, bukan semua core/card/multi-disk. Impor browser/file dan UI konflik tersedia melalui M7; validasi metadata/format bukan jaminan kompatibilitas semua file. Netplay, panel admin web, Library database pada UI, dan PWA offline tidak tersedia. Upload ROM/BIOS tersedia melalui API admin backend pengembangan. Akun dan save server memerlukan backend; reset admin memakai perintah lokal, bukan endpoint publik.

## Privasi dan progres

ROM/BIOS lokal tidak dikirim ke server dan cache engine dinonaktifkan. LocalStorage hanya menyimpan pengaturan dan metadata. Progres tamu tersimpan terpisah di browser melalui engine; sesi akun memakai storage memori terisolasi, save state server, serta sinkronisasi progres pada core yang dicakup M6. Periksa konfirmasi server dan unduh cadangan bila gagal/core belum didukung; menutup tab bukan jaminan upload. File ROM/BIOS perlu dipilih ulang setelah sesi ditutup. Riwayat **bukan** save state. Mematikan riwayat tidak menghapus riwayat lama, favorit, atau save. Ekspor cadangan sebelum membersihkan data situs.

Akun lokal menyimpan username, hash password, hash kode pemulihan, dan hash sesi di SQLite privat. Password dikirim hanya ke API akun same-origin; ROM/BIOS yang dipilih untuk bermain lokal tetap tidak diunggah. Upload katalog hanya lewat operasi admin eksplisit; aset aktif dapat diunduh tamu meskipun storage berada di luar folder publik. Sesi login memakai cookie HttpOnly, bukan LocalStorage. Save state diunggah manual atau melalui Autosave opsional; progres dalam game disinkronkan otomatis pada sesi akun/core M6 yang dicakup. Login tidak mengimpor progres browser tamu; M7 membaca kandidat secara read-only hanya saat pengguna memilih impor. Byte state/progres/cadangan berada di folder data privat dan metadata di SQLite. Reset password/kode/admin mempertahankan ID serta kepemilikan save; reset password mencabut seluruh sesi. Simpan kode baru secara privat di luar browser; lihat [prosedur M4](doc/milestone-4-pemulihan-akun.md).

## Engine, sumber, dan kemandirian

`RENCANA.md` memuat rencana produk, dan `CHANGELOG.md` daftar perubahan per rilis. `third_party/emulatorjs/README.md` menjelaskan sumber, lisensi, provenance, dan patch yang dapat direproduksi. Runtime sekitar 15 MB, dimuat sesuai kebutuhan, bukan seluruh core sekaligus.

Paket rilis lengkap diverifikasi dengan SHA-256:

```text
07d451bc06fa3ad04ab30d9b94eb63ac34ad0babee52d60357b002bde8f3850b
```

Patch lokal menonaktifkan pengecekan versi, fallback CDN, dan alamat netplay publik bawaan. CSP player membatasi koneksi ke origin sendiri. Jika core lokal hilang, player menampilkan error alih-alih mengunduh ke CDN. Source readable tersedia di `public/vendor/emulatorjs/4.2.3/data/src/`; sumber upstream asli dan provenance di `third_party/emulatorjs/4.2.3/`. Build ulang bundle dengan:

```sh
npm run vendor:engine -- "path/ke/4.2.3.7z"
npm run build:demo
```

`tar` dengan dukungan 7z diperlukan untuk vendoring ulang (tersedia pada Windows). Tidak dibutuhkan untuk menjalankan aplikasi yang sudah dibundel.

EmulatorJS: GPL-3.0-or-later; core memiliki lisensi tersendiri. Saat mendistribusikan hasil build, sertakan akses ke corresponding source/build yang diwajibkan lisensi, termasuk core, bukan hanya file minified. Manrope disimpan lokal beserta SIL Open Font License di `public/assets/Manrope-OFL.txt`. Lucide menggunakan lisensi ISC di paket dependensi. Hak atas dua SVG merek tetap milik penyedianya.

Fallback SHA-256 menggunakan `@noble/hashes` (MIT), dibundel bersama aplikasi, bukan dimuat dari CDN.

## Kredit

- maindulu: dirakit oleh [ArdiputraCode](https://github.com/ardiputracode/maindulu).
- Kode: full assisted by AI.
- Engine emulator & core: EmulatorJS v4.2.3 (Ethan O'Brien, GPL-3.0-or-later) dan core upstream masing-masing — lihat `third_party/emulatorjs/README.md`.

## Deployment

Gunakan hosting statis yang mendukung fallback route SPA ke `index.html`, **tetapi jangan menulis ulang permintaan aset yang hilang menjadi HTML**. Folder `/vendor/`, `/player/`, `/catalog/`, `/games/`, `/bios/`, `/covers/`, dan `/assets/` harus mengembalikan 404 nyata untuk file yang tidak ada. Contoh Nginx tersedia di `deploy/nginx.conf`.

Untuk opsi container siap pakai (build Node 24 + Nginx dalam satu image), gunakan:

```sh
docker compose -f deploy/docker-compose.yml up --build
```

Default porta host `7777`, dapat diubah lewat `MAIN_DULU_PORT`. Perilaku serving container sama persis dengan template `deploy/nginx.conf`; detail arsitektur dan verifikasi dituang di `deploy/README.md`.

Compose di atas menyajikan frontend statis lewat Nginx, tanpa API akun. Untuk **backend Docker 0.3.1** (akun, state/progres server, volume privat), gunakan:

```sh
# Default hanya localhost
docker compose -f deploy/docker-compose.backend.yml up -d --build
```

Untuk LAN tanpa domain/HTTPS, salin `deploy/backend.env.example` ke `.env.backend`, ganti IP server, lalu gunakan `docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d --build`. Ini mengaktifkan HTTP tanpa enkripsi secara eksplisit, hanya untuk jaringan tepercaya. Panduan lengkap: **[Docker backend: konfigurasi, build, deploy, backup/update, dan troubleshooting](deploy/README.backend.md)**. Jangan jalankan Compose statis dan backend pada port host sama.

Gunakan `npm start` untuk web + API tanpa Docker. Jangan menaruh database/folder data di `public/` atau `dist/`; seluruh aset publik, termasuk berkas yang diabaikan Git, tetap ikut hasil build dan dapat diunduh pengunjung.

Gunakan HTTPS, MIME JavaScript/CSS/WASM yang benar, dan cache panjang hanya untuk aset ber-versi/ber-hash. Manifest sebaiknya revalidate. Player membutuhkan WebAssembly serta script blob; jangan menerapkan CSP global yang menolak kebutuhan tersebut. Threaded cores tidak diaktifkan sehingga COOP/COEP tidak diwajibkan MVP.

## Pengujian

```sh
npm test
npm run test:e2e
npm run build
npm run test:e2e:production
npm run test:e2e:backend
```

Tes browser menggunakan Microsoft Edge yang terpasang di Windows. Jika tidak tersedia, ubah `channel` di `playwright.config.ts` atau instal Chromium Playwright. Tes mencakup desktop/mobile, file lokal, BIOS plumbing lokal/server, riwayat/favorit/pengaturan, peluncuran demo server, round-trip save/load state, penutupan player, core yang hilang, serta cold-cache dengan semua request origin eksternal diblokir. BIOS sintetis pada tes hanya menguji jalur file, bukan kompatibilitas firmware proprietary. Screenshot hasil uji berada di `test-results/` (diabaikan Git). Build sebelum menjalankan `test:e2e:production` agar yang diuji benar-benar aset produksi terbaru.

Regresi HTTP LAN memakai alamat IPv4 non-loopback yang ditemukan otomatis, dengan emulasi layar/sentuhan ponsel. Tes memastikan origin benar-benar tidak aman (`isSecureContext === false`) dan API `subtle`/`randomUUID` memang tidak tersedia, kemudian menjalankan game lokal dan server. Tes ini dilewati bila tidak ada interface IPv4 jaringan. Unit test membandingkan hasil SHA-256 native/fallback agar identitas ROM lama tetap cocok. Penyimpanan browser tetap terpisah per origin: berpindah alamat IP, port, atau HTTP/HTTPS tidak otomatis memindahkan favorit/save.
