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

**Save state server manual (M5):** login sebelum membuka game, lalu gunakan tombol **Save state server** di toolbar emulator (bar bawah, di sebelah Import Save File) untuk membuka overlay. Game jeda otomatis saat overlay terbuka dan lanjut kembali saat ditutup. Overlay menyediakan simpan/muat pada tiga slot manual dan slot **Autosave** khusus (slot 99) dengan toggle + interval (Nonaktif default, 30 detik, 1–15 menit) yang ditimpa otomatis saat aktif. Default 32 MiB per state dan 256 MiB per akun, dengan peringatan 80%, pengelola lintas game, serta unduhan cadangan/retry saat upload gagal. Verifikasi otomatis saat ini NES; core lain masih percobaan. **Save dalam game/memcard akun belum tersinkron dan masih sementara di memori**—ekspor sebelum keluar atau simpan state ke server. Mode tamu/statis tetap menyimpan di browser. Lihat [panduan M5 dan konfigurasi kuota](doc/milestone-5-save-state-server.md).

`npm run dev`, `npm run preview`, dan deployment statis tetap berfungsi tanpa backend atau request API. Mode backend aktif otomatis hanya saat halaman dilayani server Node.js (atau melalui opt-in frontend yang dikonfigurasi khusus). Akun dapat dipakai lewat HTTP localhost; akses akun dari perangkat jaringan memerlukan origin HTTPS yang dikonfigurasi.

Untuk mencoba dari HP di Wi-Fi yang sama, buka `http://IP-KOMPUTER:5173`. Server dev/preview mendengarkan pada semua interface. Membuka ROM lokal juga bekerja lewat HTTP jaringan: SHA-256 memiliki fallback JavaScript yang dibundel lokal, dan ID sesi memakai `crypto.getRandomValues` bila `randomUUID` tidak tersedia. Tidak perlu mematikan pengamanan browser. Gunakan HTTP hanya di jaringan tepercaya; HTTPS tetap disarankan untuk deployment publik.

## Yang tersedia

- Beranda, Jelajahi console, Terakhir dimainkan, Favoritku, Cara bermain, Pengaturan.
- Membuka ROM/BIOS lokal lewat file picker atau drop ROM. File tidak di-upload atau disimpan permanen.
- Game/BIOS dari server melalui manifest, tanpa admin/backend upload.
- Pilihan BIOS lokal/server independen dari sumber ROM.
- Favorit, metadata riwayat, volume awal, dan toggle riwayat di LocalStorage.
- Player iframe terisolasi, validasi pesan/sesi, konfirmasi keluar, dan pembersihan instance.
- Core lokal NES (`fceumm`), SNES (`snes9x`), GB/GBC (`gambatte`), GBA (`mgba`), Mega Drive (`genesis_plus_gx`), PS1 (`pcsx_rearmed`). Varian non-threaded normal dan legacy dibundel.
- **Jalan Pulang**, homebrew NES orisinal berlisensi CC0, dapat dimainkan langsung. Gerakkan karakter kiri/kanan untuk menangkap bintang. Ini contoh teknis, bukan ROM komersial.
- Backend Node.js opsional tanpa Docker: web + API satu proses, SQLite persisten, akun lokal dengan sesi cookie HttpOnly, pemulihan akun, dan save state server manual berkuota; sinkronisasi memcard belum tersedia.

## Tambahkan game server

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
- Belum ada sinkronisasi otomatis save game/memcard, impor save browser ke akun, UI penyelesaian konflik, netplay, panel admin web, backend upload ROM, atau PWA offline. Akun dan save state server memerlukan backend; reset admin memakai perintah lokal, bukan endpoint publik.

## Privasi dan progres

File lokal tidak dikirim ke server dan cache ROM/BIOS engine dinonaktifkan. LocalStorage hanya menyimpan pengaturan dan metadata. Progres tamu tersimpan terpisah di browser melalui engine; sesi akun memakai storage memori terisolasi dan save state server manual. Save dalam game/memcard akun belum otomatis dipermanenkan—ekspor atau simpan state sebelum keluar. File ROM/BIOS mungkin perlu dipilih ulang setelah sesi ditutup. Riwayat **bukan** save state. Mematikan riwayat tidak menghapus riwayat lama, favorit, atau save. Ekspor cadangan sebelum membersihkan data situs.

Akun lokal menyimpan username, hash password, hash kode pemulihan, dan hash sesi di SQLite privat. Password dikirim hanya ke API akun same-origin; ROM/BIOS tetap tidak diunggah. Sesi login memakai cookie HttpOnly, bukan LocalStorage. Save state diunggah hanya lewat aksi pengguna; login tidak mengimpor progres browser tamu. Byte state berada di folder data privat dan metadata di SQLite. Reset password/kode/admin mempertahankan ID serta kepemilikan save; reset password mencabut seluruh sesi. Simpan kode baru secara privat di luar browser; lihat [prosedur M4](doc/milestone-4-pemulihan-akun.md).

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

Container lama tetap menyajikan frontend statis lewat Nginx, bukan backend Node.js M2. Gunakan `npm start` untuk web + API tanpa Docker. Jangan menaruh database/folder data di `public/` atau `dist/`; seluruh aset publik, termasuk berkas yang diabaikan Git, tetap ikut hasil build dan dapat diunduh pengunjung.

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
