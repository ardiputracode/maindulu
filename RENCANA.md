# Rencana maindulu

## Tujuan

Frontend emulator modern bertema hijau hutan dan mint, menggunakan EmulatorJS **v4.2.3** yang seluruh kebutuhan runtime-nya disimpan di proyek. Pengguna dapat membuka ROM/BIOS lokal atau memainkan konten yang tersedia di server. Tidak ada akun, backend upload, halaman admin, cloud save, atau netplay pada MVP.

## Identitas

- Logo dan favicon: `maindulu.svg`.
- Banner hero: `retro-world.svg`.
- Tagline: **Dulu pulang sekolah. / Sekarang pulang kerja.**
- Teks pendamping: “Waktunya main lagi. Game lama, kenangan yang nggak pernah usang. Keseruannya masih sama. Buka game favoritmu, dan biarkan jempol yang mengingat.”
- Desktop menggunakan sidebar; mobile menggunakan drawer.
- Warna utama: background `#0D1712`, panel `#14291D`, mint `#A9ECC3`, sage `#3B6650`, teks `#F2F6EE`.

## Navigasi

1. Beranda: hero, akses ROM lokal, pilihan console, game server, ringkasan riwayat.
2. Jelajahi console: filter console, pencarian, katalog server, buka ROM lokal.
3. Terakhir dimainkan: metadata permainan yang pernah dimulai, bukan jaminan progres tersimpan.
4. Favoritku: game server maupun metadata file lokal yang ditandai favorit.
5. Cara bermain: panduan sumber ROM/BIOS, kontrol, save/load, privasi.
6. Pengaturan: volume awal (default 50%) dan simpan riwayat bermain (default aktif).

## Alur permainan

### Lokal

Pilih/drop ROM → pilih console → pilih BIOS lokal/server jika diperlukan → main. File hanya dibaca di browser, **tidak diunggah** dan tidak disimpan permanen oleh antarmuka. File mungkin perlu dipilih lagi setelah sesi berakhir. Ekstensi dan ukuran divalidasi. File yang dipilih sendiri tidak diam-diam diganti sumber server. Identitas ROM lokal menggunakan hash isi file, bukan nama saja.

### Server

Console, game, dan BIOS didefinisikan di manifest JSON. File ditambahkan manual tanpa halaman admin. ROM server dan BIOS lokal dapat dikombinasikan, begitu juga sebaliknya. Tampilkan kebutuhan BIOS sesuai core; jangan mengklaim semua BIOS wajib. Hanya distribusikan konten yang memang berizin. Sertakan homebrew orisinal sebagai game demo, bukan ROM komersial.

### Player

Engine diisolasi dalam iframe satu origin. ROM dan BIOS lokal diteruskan sebagai data file, bukan path perangkat. Pesan antarmuka/player memvalidasi origin, window sumber, dan ID sesi. Pergantian/penutupan sesi membersihkan iframe dan referensi file. Player menyediakan panduan kontrol dan fasilitas bawaan engine untuk fullscreen, volume, save/load. Memulai permainan membutuhkan tindakan pengguna agar audio tidak diblokir browser.

## Penyimpanan

- LocalStorage menyimpan preferensi, favorit, dan metadata riwayat saja.
- Saat riwayat dimatikan, sesi baru tidak menambah/memperbarui riwayat. Riwayat lama dan save tidak dihapus diam-diam.
- Volume awal diterapkan pada sesi baru; volume sesi aktif diatur di player.
- Save game/state memakai fasilitas EmulatorJS yang diuji dan dipisahkan berdasarkan identitas game/core.
- Cache internal engine dapat menyimpan aset/save; hal ini dijelaskan pada panduan privasi.

## Engine mandiri

- Ambil paket rilis lengkap `4.2.3.7z`; verifikasi SHA-256 rilis.
- Simpan loader, JS/CSS, core, report, WASM/worker terkemas, runtime kompresi, bahasa, lisensi, dan dependensi yang diperlukan secara lokal.
- Core awal: NES, SNES, GB/GBC, GBA, Mega Drive, dan PS1. Hanya console dengan core lokal lengkap yang ditampilkan.
- Nonaktifkan pemeriksaan versi otomatis serta fallback core ke CDN melalui patch sumber kecil yang terdokumentasi; bangun kembali bundle lokal.
- Tidak ada font, ikon, cover, atau aset runtime wajib dari layanan eksternal.
- Netplay tidak digunakan. Core threaded tidak diaktifkan pada MVP.
- Ini self-hosted, bukan janji offline/PWA: server maindulu tetap harus dapat dijangkau.

## Teknologi

React, TypeScript, Vite, React Router, Lucide, dan CSS bertoken dengan tema konsisten. CSS khusus dipilih agar layout visual ringan dan tidak memerlukan lapisan styling tambahan. Manifest berada di `public/catalog`, engine di `public/vendor/emulatorjs/4.2.3/data`, sumber/patch/lisensi di `third_party`, ROM server di `public/games`, BIOS server di `public/bios`, cover di `public/covers`.

## Tahapan

1. Fondasi proyek, rencana, tema, aset, navigasi responsif.
2. Manifest, katalog, game homebrew orisinal, pencarian/filter.
3. Vendoring dan patch engine, player terisolasi, sumber lokal/server.
4. Riwayat, favorit, pengaturan, panduan, error/empty/loading state.
5. Pengujian tipe, build, fungsi penyimpanan/validasi, browser desktop/mobile, serta kemandirian runtime.

## Kriteria penerimaan

- Kedua SVG dan tagline digunakan sesuai identitas.
- Enam menu berfungsi; tidak ada tombol pura-pura atau game komersial placeholder.
- Game homebrew server benar-benar dapat dimainkan.
- Alur ROM lokal, BIOS lokal/server, dan validasi tersedia.
- Favorit/riwayat/pengaturan bertahan setelah refresh.
- Tidak ada audio/instance tertinggal setelah player ditutup.
- Cache kosong + akses internet eksternal diblokir tetap bisa menjalankan demo dari server maindulu.
- Kesalahan aset/core/ROM/BIOS ditampilkan dengan pesan yang dapat ditindaklanjuti.
- Lisensi dan perubahan terhadap engine didokumentasikan.

## Status implementasi — 22 Oktober 2026

- [x] Enam menu, layout desktop/mobile, kedua SVG, dan identitas hijau.
- [x] ROM/BIOS lokal, manifest game/BIOS server, validasi, dan player terisolasi.
- [x] Favorit, metadata riwayat, volume awal, dan toggle pencatatan.
- [x] EmulatorJS v4.2.3 beserta enam core lokal; pengecekan versi/fallback CDN dinonaktifkan.
- [x] Homebrew NES orisinal `Jalan Pulang` dan source generator CC0.
- [x] Panduan penggunaan, dokumentasi vendoring/lisensi, contoh konfigurasi Nginx.
- [x] Build TypeScript/Vite dan 12 tes unit lulus.
- [x] 10 tes browser terhadap build produksi lulus, termasuk desktop/mobile, ROM/BIOS lokal/server, pembatasan origin eksternal dengan cache kosong, error aset, konfirmasi keluar, dan save/load state bawaan engine.

Pengujian permainan end-to-end memakai demo NES orisinal. Core lain telah dibundel/divalidasi asetnya, tetapi kompatibilitas game dan BIOS asli tetap harus diuji per perangkat. Tidak ada BIOS proprietary maupun koleksi ROM komersial yang dibundel.

Perkembangan backend/akun setelah catatan MVP di atas ada di [rencana login dan save server](doc/rencana-login-cloud-save.md). M6 selesai untuk SRAM NES yang diuji otomatis serta ekspor/pemulihan memcard aktif PS1 lintas sesi/browser yang dikonfirmasi manual pengguna. Lihat [panduan, hasil manual, dan batas dukungan PS1](doc/milestone-6-progres-game.md); seluruh game/card/varian tidak diklaim terverifikasi. Impor dan penyelesaian konflik tetap M7. Angka tes MVP di atas adalah historis, bukan hasil regresi versi terbaru.
