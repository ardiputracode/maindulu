# maindulu

**Dulu pulang sekolah. Sekarang pulang kerja.**

Frontend emulator berbahasa Indonesia, bertema hijau hutan/mint. Logo dan banner menggunakan SVG yang disediakan. Engine **EmulatorJS v4.2.3** beserta enam core awal sudah berada di proyek—tidak membutuhkan CDN EmulatorJS saat dijalankan.

## Jalankan

Node.js **24+** disarankan (tes unit memakai dukungan TypeScript native Node).

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
- Tidak ada akun, cloud save, netplay, admin, backend upload, atau PWA offline.

## Privasi dan progres

File lokal tidak dikirim ke server dan cache ROM/BIOS engine dinonaktifkan. LocalStorage hanya menyimpan pengaturan dan metadata; progres/state emulator tersimpan terpisah di browser melalui fasilitas engine. File ROM/BIOS mungkin perlu dipilih ulang setelah sesi ditutup. Riwayat **bukan** save state. Mematikan riwayat tidak menghapus riwayat lama, favorit, atau save. Ekspor save dari menu emulator untuk cadangan sebelum membersihkan data situs.

## Engine, sumber, dan kemandirian

`RENCANA.md` memuat rencana produk. `third_party/emulatorjs/README.md` menjelaskan sumber, lisensi, provenance, dan patch yang dapat direproduksi. Runtime sekitar 15 MB, dimuat sesuai kebutuhan, bukan seluruh core sekaligus.

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

## Deployment

Gunakan hosting statis yang mendukung fallback route SPA ke `index.html`, **tetapi jangan menulis ulang permintaan aset yang hilang menjadi HTML**. Folder `/vendor/`, `/player/`, `/catalog/`, `/games/`, `/bios/`, `/covers/`, dan `/assets/` harus mengembalikan 404 nyata untuk file yang tidak ada. Contoh Nginx tersedia di `deploy/nginx.conf`.

Gunakan HTTPS, MIME JavaScript/CSS/WASM yang benar, dan cache panjang hanya untuk aset ber-versi/ber-hash. Manifest sebaiknya revalidate. Player membutuhkan WebAssembly serta script blob; jangan menerapkan CSP global yang menolak kebutuhan tersebut. Threaded cores tidak diaktifkan sehingga COOP/COEP tidak diwajibkan MVP.

## Pengujian

```sh
npm test
npm run test:e2e
npm run build
npm run test:e2e:production
```

Tes browser menggunakan Microsoft Edge yang terpasang di Windows. Jika tidak tersedia, ubah `channel` di `playwright.config.ts` atau instal Chromium Playwright. Tes mencakup desktop/mobile, file lokal, BIOS plumbing lokal/server, riwayat/favorit/pengaturan, peluncuran demo server, round-trip save/load state, penutupan player, core yang hilang, serta cold-cache dengan semua request origin eksternal diblokir. BIOS sintetis pada tes hanya menguji jalur file, bukan kompatibilitas firmware proprietary. Screenshot hasil uji berada di `test-results/` (diabaikan Git). Build sebelum menjalankan `test:e2e:production` agar yang diuji benar-benar aset produksi terbaru.

Regresi HTTP LAN memakai alamat IPv4 non-loopback yang ditemukan otomatis, dengan emulasi layar/sentuhan ponsel. Tes memastikan origin benar-benar tidak aman (`isSecureContext === false`) dan API `subtle`/`randomUUID` memang tidak tersedia, kemudian menjalankan game lokal dan server. Tes ini dilewati bila tidak ada interface IPv4 jaringan. Unit test membandingkan hasil SHA-256 native/fallback agar identitas ROM lama tetap cocok. Penyimpanan browser tetap terpisah per origin: berpindah alamat IP, port, atau HTTP/HTTPS tidak otomatis memindahkan favorit/save.
