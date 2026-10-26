# Rencana Implementasi Admin, Library Game, dan Pengelolaan BIOS

Status: **Milestone 1–3 selesai dan terverifikasi pada 2026-10-26 dalam cakupan masing-masing di bawah. Milestone 4–7 belum diimplementasikan.** Jalankan berurutan per milestone. Setiap milestone ditutup setelah checklist dan kriteria selesainya terverifikasi.

## Milestone 1 — Role Akun dan Otorisasi Admin

**Target:** akun admin dapat dikenali dengan aman tanpa mengubah pengalaman akun biasa.

- [x] Tambahkan migrasi kolom role pada `users`: `user` atau `admin`; akun lama dan registrasi baru selalu menjadi `user`.
- [x] Sertakan role pada respons sesi dan kontrak akun frontend di `src/lib/account.ts`.
- [x] Buat pemeriksaan admin bersama di backend; periksa role terbaru dari database pada setiap operasi pengelolaan.
- [x] Sediakan perintah terminal untuk promosi/demosi akun yang sudah ada, mengikuti mekanisme penguncian direktori data: `npm run account:role -- username admin` atau `user`.
- [x] Jangan izinkan pemilihan role lewat registrasi, perubahan profil, atau payload frontend. Jangan otomatis menjadikan pendaftar pertama admin.
- [x] Pertahankan proteksi origin, cookie sesi, dan CSRF; perluas secara terbatas untuk upload multipart melalui opt-in guard per route (parser/upload produksi tetap Milestone 3).
- [x] Tambahkan capability admin/katalog pada health API sesuai kebutuhan discovery frontend: `admin: true`, `gameCatalog: false`, `biosCatalog: false`.

**Kriteria selesai:** tamu ditolak dengan 401, pengguna biasa ditolak dengan 403, dan hanya admin dapat memanggil operasi pengelolaan. Perubahan role berlaku juga pada sesi yang sudah aktif. Login, pemulihan akun, dan save pengguna lama tetap berfungsi.

**Area utama:** `server/database.mjs`, `server/auth/`, `scripts/`, `src/lib/account.ts`, `src/lib/useAccount.ts`.

**Implementasi dan verifikasi Milestone 1:** [panduan role akun](admin-role-akun.md). Endpoint pemeriksaan akses `GET /api/admin/status` memakai guard bersama; tidak ada API/UI pengelolaan katalog pada tahap ini. `npm test`: **125 lulus**; `npm run build`: **lulus**. Pengujian role mencakup sesi aktif lintas koneksi/proses, 401/403/200, bypass payload, CSRF multipart sebelum parsing, migrasi skema 6 yang mempertahankan akun/sesi/state/progres, CLI/data lock, dan role setelah backup/restore. Tes discovery/tamu mode statis: **5 lulus dev + 5 lulus produksi**. Verifikasi akhir browser `account.spec.ts`, `server-saves.spec.ts`, dan `server-game-saves.spec.ts`: **30 lulus, tanpa retry/skip** (11,9 menit), termasuk login/pemulihan, konflik dua tab, isolasi tamu/akun, restart, dan backup/restore save NES. Race pada tes status/autosync, klik toolbar, dan penulisan IndexedDB diperbaiki pada tes saja; runtime player/save tidak diubah. **Milestone 1 ditutup dalam cakupan ini.** Docker/HTTPS nyata dan gameplay semua core tidak diklaim terverifikasi.

## Milestone 2 — Metadata Game/BIOS dan Storage Persisten

Rincian keputusan, urutan implementasi, dan gerbang verifikasi: [fondasi katalog dan storage](milestone-2-katalog-storage.md).

**Target:** database menjadi sumber katalog game dan BIOS dinamis, sedangkan ROM, BIOS, dan cover berada di direktori data yang sudah dikonfigurasi melalui `MAIN_DULU_DATA_DIR`.

```text
data/
├── maindulu.sqlite
├── games/          # ROM yang diunggah admin
├── bios/           # firmware/arsip BIOS yang diunggah admin
├── covers/         # cover yang diunggah admin
├── uploads/        # staging sementara; tidak boleh dilayani ke browser
├── saves/          # penyimpanan yang sudah ada
└── game-saves/     # penyimpanan yang sudah ada
```

- [x] Tambahkan tabel game dengan ID stabil, judul, console, deskripsi, lisensi, nama asli berkas, storage key, ukuran, SHA-256, pembuat, waktu pembuatan/perubahan, dan penanda penghapusan.
- [x] Tambahkan tabel BIOS dengan ID stabil, nama tampilan, console, deskripsi, keterangan hak distribusi, nama asli firmware/arsip, storage key, ukuran, SHA-256, pembuat, waktu pembuatan/perubahan, dan penanda penghapusan. Satu console dapat memiliki beberapa pilihan BIOS.
- [x] Catat storage key, tipe, ukuran, dan checksum cover jika tersedia agar berkas dapat diverifikasi saat backup.
- [x] Pisahkan ID game dari hash ROM: mengganti judul atau cover tidak mengubah identitas save. Penggantian ROM tidak termasuk MVP.
- [x] Tetapkan duplikat secara terpisah untuk game dan BIOS berdasarkan pasangan console dan SHA-256 byte berkas upload. Hash ZIP adalah hash arsip, bukan hasil normalisasi ROM/firmware di dalamnya.
- [x] Gunakan nama berkas internal yang dibuat server, bukan path/nama yang diberikan admin. Simpan nama asli hanya sebagai metadata.
- [x] Pertahankan pemisahan direktori data dari `public/` dan `dist/`, termasuk perlindungan traversal dan symlink.
- [x] Siapkan aturan pemulihan staging/berkas yatim setelah proses terhenti, tanpa menghapus berkas aktif atau save pengguna.
- [x] Sesuaikan pemeriksaan skema backup yang sudah ada agar perubahan tabel tidak membuat backup tampak berhasil tetapi mengabaikan ROM/BIOS. Backup belum boleh dinyatakan lengkap sebelum Milestone 7 selesai.

**Kriteria selesai:** migrasi menjaga akun dan save lama; lokasi storage mengikuti konfigurasi yang ada; katalog dan berkas tidak bergantung pada hasil build. Dua upload identik yang bersamaan tidak menghasilkan dua entri aktif.

**Area utama:** `server/database.mjs`, `server/config.mjs`, modul katalog/storage baru, `server/data-backup.mjs`.

**Implementasi dan verifikasi Milestone 2:** migrasi skema **8**, repository internal game/BIOS, storage privat/staging streaming, dan recovery offline dengan `npm run storage:recover` (`-- --apply` untuk pembersihan). Duplikat diuji lintas koneksi/proses; tombstone mempertahankan ID untuk pemulihan eksplisit. Backup baru hanya boleh pada skema 8 dengan tabel/aset katalog kosong; verify/restore backup skema 7 tetap didukung. `npm test`: **153 lulus**; build **lulus**; regresi browser akun/discovery/state/progres NES: **35 lulus**, tanpa retry/skip (8,3 menit). **Milestone 2 ditutup dalam cakupan persistence ini.** Belum ada API upload/katalog/unduh atau UI; capability katalog tetap `false`. Runtime Docker/HTTPS, disk penuh nyata, dan backup koleksi lengkap tidak diklaim. Rincian kontrak internal, recovery, hasil tes, dan batas verifikasi ada pada [panduan fondasi katalog/storage](milestone-2-katalog-storage.md).

## Milestone 3 — API Upload, Katalog, Unduh, dan Delete

Rincian keputusan, kontrak HTTP, konfigurasi, dan hasil verifikasi: [API katalog dan upload](milestone-3-api-katalog.md).

**Target:** siklus pengelolaan game dan BIOS berfungsi penuh di backend sebelum dibuatkan antarmuka.

Usulan endpoint, disesuaikan dengan pola proyek saat implementasi:

| Endpoint | Akses | Fungsi |
| --- | --- | --- |
| `GET /api/games` | Publik | Katalog aktif dengan pencarian, filter console, dan pagination |
| `GET /api/games/:id` | Publik | Metadata satu game aktif |
| `GET/HEAD /games/:id/rom/:filename` | Publik | Byte ROM dengan ekstensi asli untuk player dan pemeriksaan aset |
| `GET/HEAD /games/:id/rom` | Publik | Redirect tanpa cache ke URL ROM kanonis |
| `GET/HEAD /games/:id/cover` | Publik | Cover game aktif |
| `GET /api/admin/games` | Admin | Daftar pengelolaan beserta status berkas |
| `POST /api/admin/games` | Admin + CSRF | Upload ROM dan metadata |
| `PATCH /api/admin/games/:id` | Admin + CSRF | Edit metadata/cover tanpa mengganti ROM |
| `DELETE /api/admin/games/:id` | Admin + CSRF | Hapus dari katalog dan jadwalkan pembersihan berkas |
| `GET /api/bios` | Publik | Daftar BIOS aktif dengan filter console dan pagination |
| `GET /api/bios/:id` | Publik | Metadata satu BIOS aktif |
| `GET/HEAD /bios/:id/:filename` | Publik | Byte BIOS dengan nama firmware/arsip yang sesuai kebutuhan core |
| `GET /api/admin/bios` | Admin | Daftar BIOS beserta status berkas |
| `POST /api/admin/bios` | Admin + CSRF | Upload BIOS dan metadata |
| `PATCH /api/admin/bios/:id` | Admin + CSRF | Edit metadata tanpa mengganti byte firmware |
| `DELETE /api/admin/bios/:id` | Admin + CSRF | Hapus BIOS dari pilihan server dan jadwalkan pembersihan berkas |

- [x] Tambahkan dukungan multipart streaming. Hitung SHA-256 ROM/BIOS sambil menulis upload ke staging, bukan menampung seluruh berkas dalam RAM.
- [x] Lakukan autentikasi, otorisasi, dan pemeriksaan CSRF sebelum menerima pemrosesan berkas besar.
- [x] Terapkan batas ukuran ROM awal 768 MiB dan BIOS 32 MiB, panjang metadata, jumlah field/berkas multipart, upload bersamaan, dan penggunaan storage; selaraskan timeout serta batas reverse proxy jika digunakan. Jangan menaikkan body limit global API akun/save.
- [x] Validasi console yang didukung, ekstensi yang diizinkan, dan berkas tidak kosong. Pemeriksaan ini bukan jaminan ROM dapat dimainkan atau aman secara semantik.
- [x] Untuk BIOS, ikuti format awal `.bin`, `.rom`, `.bios`, `.img`, `.zip`, `.7z`, dan `.rar` yang sudah diizinkan aplikasi. Hash, ukuran, dan ekstensi bukan bukti firmware kompatibel atau legal untuk didistribusikan.
- [x] Pertahankan nama firmware pada URL BIOS raw karena EmulatorJS menurunkan nama firmware dari URL. Validasi `:filename` terhadap metadata dan nama basename yang aman, bukan menggunakannya sebagai path filesystem; Content-Disposition saja tidak cukup. Arsip mempertahankan nama file di dalamnya tanpa ekstraksi di server.
- [x] Batasi cover upload ke format raster yang divalidasi, misalnya PNG/JPEG/WebP, dengan batas ukuran dan dimensi. Tolak SVG/HTML upload pada MVP.
- [x] Publikasikan entri hanya setelah upload lengkap, hash final, dan berkas siap. Jika transaksi database gagal, lakukan kompensasi/pembersihan; filesystem dan SQLite bukan satu transaksi atomik.
- [x] Tangani upload dibatalkan, disk penuh, kegagalan rename, duplikat, dan proses terhenti tanpa meninggalkan entri aktif yang tidak lengkap.
- [x] Streaming unduhan harus mendukung HEAD, Content-Length, tipe konten yang tepat, dan byte range yang valid. Pertahankan origin yang sama serta kompatibilitas pemeriksaan aset player.
- [x] Jangan mengekspos seluruh folder `data/` melalui static server. Hanya berkas game/BIOS aktif yang dapat diambil lewat endpoint terkontrol.
- [x] Delete menandai entri terhapus terlebih dahulu sehingga katalog dan URL ROM/cover menolak akses baru, lalu membersihkan berkas dengan mekanisme retry. Save, backup save, dan akun tidak ikut dihapus.
- [x] Delete BIOS mengikuti aturan yang sama: hapus dari daftar pilihan, tolak akses baru, dan bersihkan berkas dengan retry. Jangan mengganti pilihan BIOS pengguna secara diam-diam atau menghapus game/save yang terkait dengan console tersebut.
- [x] Upload ulang berkas yang pernah dihapus pada console yang sama menawarkan pemulihan ID lama secara eksplisit, bukan membuat ID baru diam-diam. Pemulihan memerlukan berkas valid tersedia kembali.
- [x] Gunakan kebijakan cache yang tidak membuat ROM/BIOS terhapus terus tersedia dari cache browser/proxy. Byte yang sudah diunduh tidak dapat ditarik kembali; sesi yang sudah memuat aset dapat tetap berjalan.

**Kriteria selesai:** upload ROM/BIOS sekali menghasilkan hash yang sesuai perhitungan independen; game dan BIOS bisa diambil player dengan nama firmware yang benar; duplikat ditangani jelas; delete memblokir akses baru tanpa menghapus progres. Database dan save tidak dapat diunduh melalui URL aset.

**Area utama:** `server/app.mjs`, modul routes/storage game baru, `package.json`, `package-lock.json`, `public/player/player.js` bila diperlukan untuk kompatibilitas.

**Implementasi dan verifikasi Milestone 3:** API katalog publik/admin, multipart streaming dengan `@fastify/multipart`, validasi cover raster lengkap dengan `sharp`, GET/HEAD/range tanpa cache, dan skema **9** untuk reservasi upload bersama serta antrean cleanup/retry. Publikasi memeriksa ulang sesi/role; delete/restore mempertahankan identitas dan save. URL ROM mempertahankan nama/ekstensi; BIOS raw mempertahankan nama ASCII aman. Capability katalog menjadi `true`, tanpa mengubah frontend/player/engine. `npm test`: **183 lulus**; build **lulus**; regresi browser backend akun/state/progres + smoke katalog: **37 lulus**, tanpa retry/skip (11,3 menit); smoke backend/katalog akhir **7 lulus** (22,2 detik); discovery/tamu statis **5 dev + 5 produksi lulus**. Satu pengulangan browser yang dijalankan bersamaan dengan build mendapat 404 demo ketika `dist/` diganti; pengulangan berurutan lulus, bukan perubahan runtime untuk menutupi kegagalan. **Milestone 3 ditutup dalam cakupan backend ini.** UI admin/Library/pilihan BIOS dinamis tetap Milestone 4–5; backup koleksi tetap Milestone 7. Docker/Alpine, HTTPS/proxy nyata, disk penuh fisik, upload ROM 768 MiB penuh, dan boot BIOS proprietary/semua core tidak diklaim terverifikasi. Rincian bukti dan batas ada pada [panduan API](milestone-3-api-katalog.md).

## Milestone 4 — Halaman Admin, Manage Game, dan Manage BIOS

**Target:** admin dapat mengelola koleksi melalui UI berbahasa Indonesia.

- [ ] Tambahkan halaman `/admin`, `/admin/games`, dan `/admin/bios`, menu khusus admin, serta registrasi route HTML backend agar refresh/deep link berfungsi. Pisahkan menu Manage Game dari Manage BIOS.
- [ ] Tampilkan status pemeriksaan sesi; jangan tampilkan konten admin sebelum role terkonfirmasi. Pemeriksaan frontend bukan pengganti otorisasi backend.
- [ ] Sediakan daftar game dengan pencarian, console, ukuran, tanggal upload, dan status ketersediaan/pembersihan.
- [ ] Sediakan form judul, console, ROM, cover opsional, deskripsi, dan lisensi/keterangan hak distribusi.
- [ ] Sediakan daftar BIOS dengan pencarian/filter console, ukuran, SHA-256, nama firmware, dan status; form upload berisi nama tampilan, console, berkas BIOS/arsip, deskripsi, dan keterangan hak distribusi.
- [ ] Tampilkan progress upload serta fase pemrosesan server secara terpisah. Progress 100% pengiriman belum berarti game/BIOS sudah diterbitkan.
- [ ] Tangani pembatalan, sesi kedaluwarsa, role dicabut, duplikat, validasi gagal, dan storage penuh dengan pesan yang jelas.
- [ ] Sediakan edit metadata dan konfirmasi delete yang menyebut bahwa save pengguna tidak dihapus; perbarui daftar setelah operasi berhasil.
- [ ] Pada delete BIOS, jelaskan bahwa game yang membutuhkan firmware tersebut akan memerlukan pilihan BIOS lain atau berkas lokal untuk sesi berikutnya.
- [ ] Gunakan komponen dialog dan pola aksesibilitas proyek, termasuk fokus keyboard, Escape, label input, dan tampilan mobile.
- [ ] Jangan menambahkan pengelolaan role akun lewat UI pada MVP; penetapan admin tetap melalui terminal server.

**Kriteria selesai:** admin dapat upload game maupun BIOS, melihat hasil, edit metadata, dan delete tanpa mengedit JSON atau build ulang. Pengguna biasa tidak mendapat akses meskipun membuka URL admin langsung.

**Area utama:** `src/App.tsx`, komponen admin baru di `src/components/`, client API di `src/lib/`, `src/styles.css`, `server/app.mjs`.

## Milestone 5 — Library dan Integrasi Player

**Target:** pengguna dapat mencari dan memainkan game upload admin tanpa hashing lokal.

- [ ] Tambahkan `/library` dengan grid game, pencarian, filter console, urutan A–Z/terbaru, pagination, serta kondisi kosong/loading/error/retry.
- [ ] Simpan filter, urutan, dan halaman pada query parameter agar deep link dan tombol kembali konsisten.
- [ ] Jadikan Library pusat penelusuran game; Jelajahi console tetap berfokus pada platform dan menautkan ke Library dengan filter console, bukan menduplikasi katalog penuh.
- [ ] Pada backend dengan capability katalog, ambil game dari API database. Gabungkan demo statis sebagai konten bawaan dengan ID `jalan-pulang-v1` tetap, tanpa duplikasi; demo bukan entri upload yang dapat dihapus lewat admin.
- [ ] Pada deployment statis, gunakan manifest bawaan seperti saat ini dan sembunyikan fitur admin. Backend yang dikonfigurasi tetapi gagal harus menampilkan gangguan/retry, bukan diam-diam dianggap mode statis.
- [ ] Pisahkan parser katalog dari parser metadata tersimpan: `readGames` sekarang membatasi daftar ke 100 item. Jangan menaikkan batas favorit/riwayat hanya demi menampung katalog besar.
- [ ] Gunakan ID stabil untuk favorit, riwayat, namespace emulator, save state, dan progres server. Jangan mengubah ID game lama atau menyatukan save lokal/server otomatis berdasarkan hash.
- [ ] Saat membuka game dari favorit/riwayat server, periksa metadata/ketersediaan terbaru; game terhapus menampilkan pesan, bukan mencoba URL usang tanpa penjelasan.
- [ ] Pertahankan jalur `source: 'server'` pada `SetupDialog`: gunakan metadata server tanpa `hashRom`. Jalur ini sebenarnya sudah melewati hashing lokal; jangan mengklaimnya sebagai optimasi baru.
- [ ] ROM yang dipilih sendiri dari perangkat tetap di-hash lokal untuk identitas dan verifikasi, serta tidak diunggah. BIOS lokal juga tetap dapat dipilih dan tidak diunggah otomatis.
- [ ] Ambil daftar BIOS dinamis dari API pada backend yang mendukungnya; pilihan BIOS server di `SetupDialog` menampilkan entri aktif sesuai console, termasuk untuk sesi ROM lokal. Tangani pagination agar tidak menyembunyikan firmware yang tersedia.
- [ ] Pada mode statis, pertahankan manifest BIOS bawaan. Pada mode backend, gabungkan entri bawaan bila ada tanpa duplikasi; kegagalan API BIOS ditampilkan sebagai gangguan dengan retry, bukan daftar kosong yang menyesatkan.
- [ ] Pengguna tetap memilih BIOS server/lokal secara eksplisit; jangan otomatis memilih salah satu dari beberapa firmware. Periksa ulang BIOS server terpilih sebelum launch dan tangani penghapusan di antara pemilihan dan unduh.
- [ ] Gunakan hash BIOS hasil upload server tanpa menghitungnya ulang di browser. Pertahankan aturan BIOS wajib/opsional dan nama firmware/arsip saat diteruskan ke EmulatorJS; jangan menganggap semua BIOS satu console saling kompatibel.
- [ ] Tampilkan informasi lisensi, kebutuhan BIOS, serta kegagalan unduh/player secara jelas. Hash server bukan jaminan kompatibilitas ROM atau save.

**Kriteria selesai:** game upload admin dapat dimainkan oleh tamu maupun akun; BIOS upload admin muncul sesuai console dan dapat diteruskan ke player untuk ROM server maupun lokal. Pengujian membuktikan jalur aset server tidak menghitung ulang hash di browser. Save dapat dimuat kembali setelah metadata diedit dan aplikasi di-restart. Mode statis, ROM lokal, dan BIOS lokal tetap berfungsi.

**Area utama:** `src/App.tsx`, `src/components/GameCard.tsx`, `src/components/SetupDialog.tsx`, `src/lib/domain.ts`, `src/components/Player.tsx`, `public/player/player.js`.

## Milestone 6 — Pengujian Keamanan dan Regresi End-to-End

**Target:** menguji alur lengkap dan batas kegagalannya, bukan hanya keberhasilan API.

- [ ] Tambahkan unit/integration test untuk migrasi, role, bypass payload, pencabutan role, CSRF multipart, hash, duplikat konkuren, pagination, dan validasi metadata/berkas.
- [ ] Uji traversal, symlink, cover berbahaya, ukuran berlebih, disk penuh, koneksi upload putus, dan pembersihan setelah crash secara terkontrol.
- [ ] Uji GET/HEAD/range, game/BIOS terhapus, berkas hilang, validasi nama firmware URL, dan larangan mengakses database/save melalui endpoint ROM/BIOS.
- [ ] Tambahkan browser test: admin login → upload homebrew fixture → muncul di Library → tamu main → akun main dan menyimpan progres → edit metadata → progres tetap terbaca → delete → URL lama ditolak.
- [ ] Tambahkan alur admin upload BIOS → muncul hanya pada pilihan console yang sesuai → dipilih bersama ROM lokal/server → diteruskan ke engine dengan nama firmware benar → delete → pilihan/URL lama ditolak. Uji beberapa BIOS per console, duplikat, batas 32 MiB, dan kondisi BIOS wajib belum dipilih.
- [ ] Uji duplikat, pemulihan ID setelah upload ulang, pencarian/filter, navigasi mobile, keyboard, serta akses admin oleh pengguna biasa.
- [ ] Gunakan ROM/BIOS uji yang boleh didistribusikan. BIOS sintetis hanya membuktikan plumbing/nama/validasi, bukan keberhasilan boot firmware nyata; catat pengujian BIOS/core nyata secara terpisah. Bedakan bukti gameplay NES dari uji struktur aset atau hasil manual console lain.
- [ ] Jalankan `npm test`, `npm run build`, `npm run test:e2e`, `npm run test:e2e:production`, dan `npm run test:e2e:backend` sesuai kebutuhan lingkungan; catat hasil aktual dan skenario yang belum diuji.

**Kriteria selesai:** alur admin–Library–player dan pengelolaan/pemilihan BIOS lulus otomatis dalam cakupan yang dinyatakan; akun/save lama, ROM/BIOS lokal, dan mode statis tidak mengalami regresi. Hasil manual tidak disajikan sebagai bukti otomatis semua core.

**Area utama:** `tests/`, `tests/browser/`, konfigurasi Playwright yang sudah ada.

## Milestone 7 — Backup, Deploy, dan Dokumentasi Operasional

**Target:** koleksi game, BIOS, dan progres dapat dipertahankan serta dipulihkan di luar siklus deploy aplikasi.

- [ ] Perluas `data:backup`, `data:verify`, dan `data:restore` untuk menyertakan tabel katalog game/BIOS, ROM, BIOS, dan cover yang masih direferensikan, lengkap dengan ukuran/checksum serta nama firmware yang diperlukan.
- [ ] Sesuaikan allowlist path, manifest, perhitungan jumlah record, dan pemeriksaan versi skema. Tentukan penanganan backup versi lama secara eksplisit; jangan mengasumsikan format lama menerima tabel/berkas baru.
- [ ] Tetap gunakan alur backup offline dengan data lock yang sudah ada; jangan menjanjikan backup konsisten saat server aktif tanpa dukungan baru.
- [ ] Kecualikan staging upload dan sampah yang sudah tidak direferensikan dari backup. Restore menolak referensi berkas hilang, checksum salah, atau path berbahaya.
- [ ] Gunakan volume backend Docker yang sudah ada untuk seluruh direktori data; frontend statis tetap dapat dipakai secara terpisah tanpa fitur upload/admin.
- [ ] Selaraskan batas multipart, timeout, konfigurasi storage, izin tulis, dan dokumentasi reverse proxy bila digunakan. Folder aplikasi dapat tetap read-only; hanya volume data yang perlu writable.
- [ ] Dokumentasikan pembuatan admin, upload/delete game dan BIOS, hak distribusi ROM/firmware, batas ukuran, backup/restore, serta penanganan disk penuh dan berkas yatim.
- [ ] Tegaskan bahwa lokasi di luar `public/` tidak otomatis membuat ROM/BIOS privat: MVP mengizinkan akses aset game/BIOS aktif tanpa login agar tamu dapat bermain. Jangan menyertakan firmware proprieter dalam repository, image, atau fixture pengujian tanpa hak distribusi.
- [ ] Buktikan restart/rebuild/recreate container tanpa menghapus volume tetap menjaga akun, game, BIOS, cover, serta progres. Operasi penghapusan volume bukan bagian prosedur deploy rutin.
- [ ] Buktikan backup → verify → restore ke direktori bersih → game dan pilihan BIOS tampil → aset firmware tetap memiliki nama/checksum yang benar → game dapat dimainkan dan save lama dapat dimuat dalam cakupan core yang diuji.

**Kriteria selesai:** instalasi dapat dipindahkan/dipulihkan beserta koleksi dan progresnya; deploy tidak menghilangkan upload. Perbarui README, panduan backend, dan changelog dengan hasil verifikasi aktual.

**Area utama:** `server/data-backup.mjs`, `scripts/data-backup.mjs`, `deploy/docker-compose.backend.yml`, `deploy/README.backend.md`, `README.md`, `CHANGELOG.md`.

## Batas MVP dan Urutan Rilis

- Milestone 1–3 membangun fondasi backend; Milestone 4–5 membuka alur pengguna; Milestone 6–7 menjadi gerbang rilis penggunaan nyata.
- Pengujian dasar tetap ditambahkan bersama milestone masing-masing, bukan ditunda seluruhnya ke Milestone 6.
- Upload, edit metadata, delete BIOS, pilihan BIOS server per console, dan backup/restore BIOS termasuk MVP; penggantian byte firmware pada ID BIOS lama tidak termasuk MVP.
- Di luar MVP: upload massal, ekstraksi/normalisasi arsip di server, scraping metadata, penggantian ROM pada ID lama, perpindahan save lokal/server otomatis, pengelolaan akun lengkap lewat admin, dan penyimpanan cloud eksternal.
- Tidak perlu memodifikasi bundle engine EmulatorJS atau mengganti sistem identitas/save yang sudah ada untuk fitur ini.
