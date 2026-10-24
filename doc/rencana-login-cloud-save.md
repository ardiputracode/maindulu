# Rencana Login Opsional dan Penyimpanan Progres Server

Status: M1–M3 selesai. Akun lokal, sesi, ganti password, dan kode pemulihan saat daftar tersedia. M4 dan milestone berikutnya belum dimulai; reset password serta penyimpanan progres server belum diimplementasikan.

Pelaksanaan dilakukan per milestone. Lihat bagian [Milestone Implementasi](#milestone-implementasi) untuk checklist dan kriteria selesai, serta [hasil pembuktian M1](milestone-1-integrasi-save.md) untuk kontrak engine, bukti pengujian, dan batasan integrasi berikutnya.

## Tujuan

Menambahkan login opsional agar pengguna dapat menyimpan progres permainan di server, tanpa menghilangkan kemampuan maindulu untuk digunakan sebagai web statis dan tanpa mewajibkan Docker.

Target deployment utama adalah satu komputer yang menjalankan aplikasi beserta penyimpanan datanya. Emulator tetap berjalan di browser pengguna, bukan di server.

## Keputusan Utama

- Login tidak wajib untuk membuka katalog atau bermain.
- Akun hanya menggunakan username dan password lokal, tanpa Google, email wajib, atau layanan autentikasi eksternal.
- Pemulihan password menggunakan kode pemulihan sekali pakai; reset oleh admin lokal menjadi jalur bantuan jika kode hilang.
- Tanpa login, penyimpanan lokal di browser tetap digunakan seperti sekarang.
- Setelah login, server menjadi sumber penyimpanan permanen utama untuk save game/memcard dan save state.
- Backend dapat dijalankan langsung menggunakan Node.js, tanpa database server terpisah.
- Satu proses Node.js menyajikan hasil build frontend dan API pada origin yang sama.
- SQLite menyimpan akun dan metadata save; berkas save disimpan di folder data lokal.
- Docker hanya menjadi opsi deployment tambahan, bukan prasyarat.
- ROM dan BIOS lokal tidak diunggah sebagai bagian dari fitur sinkronisasi.

## Kondisi Aplikasi Saat Ini

- Frontend menggunakan React dan Vite.
- Player EmulatorJS berjalan dalam iframe melalui `src/components/Player.tsx` dan `public/player/player.js`.
- Pengaturan, favorit, dan riwayat menggunakan penyimpanan browser.
- Bridge player saat ini mengatur lokasi save state ke browser.
- Backend lokal menyajikan hasil build, health API, SQLite persisten, serta API akun/sesi M3. API reset password dan penyimpanan progres belum tersedia.

Implementasi akun tidak boleh menjadikan backend sebagai syarat agar katalog dan mode tamu dapat digunakan.

## Arsitektur Target

```text
Satu komputer
└─ Server Node.js
   ├─ Frontend maindulu hasil build
   ├─ API akun dan sesi
   ├─ API simpan/muat progres
   └─ Folder data persisten
      ├─ Database SQLite: akun, sesi, metadata save
      └─ Berkas save game/memcard dan save state

Browser pengguna
├─ Antarmuka React
└─ EmulatorJS: menjalankan game secara lokal
```

Contoh alamat penggunaan lokal: `http://localhost:7777`. Nomor port merupakan contoh dan harus dapat dikonfigurasi.

### Pilihan Penggunaan

| Mode | Kemampuan |
| --- | --- |
| Frontend statis saja | Bermain sebagai tamu dan menyimpan progres di browser |
| Frontend dan backend Node.js | Login opsional dan penyimpanan progres server |
| Deployment Docker opsional | Kemampuan sama dengan backend Node.js langsung |

Alur backend M2: instal Node.js 24+, instal dependensi, jalankan `npm run build`, lalu `npm start` untuk menyalakan web dan API dalam satu proses. Lihat [panduan M2](milestone-2-backend-lokal.md) untuk konfigurasi dan batas kemampuan yang sudah tersedia.

Frontend statis harus dapat beroperasi tanpa konfigurasi backend. Jika backend tidak diaktifkan, fitur akun dan cloud save disembunyikan. Bedakan kondisi tersebut dengan backend yang dikonfigurasi tetapi sedang tidak dapat dihubungi; kondisi kedua harus menampilkan status gangguan.

## Jenis Data yang Disimpan

### 1. Save Game / Memcard

Progres yang ditulis melalui fitur save di dalam game, termasuk SRAM, battery save, atau memory card sesuai dukungan core.

- Menjadi jalur utama penyimpanan progres permainan.
- Disinkronkan otomatis saat ada perubahan, dengan pembatasan frekuensi upload.
- Dipulihkan ke emulator pada fase yang tepat sebelum permainan mengakses data simpanannya.
- Mekanisme ekspor/impor dan waktunya harus dibuktikan per core; jangan menganggap semua konsol memiliki format atau perilaku yang sama.

### 2. Save State

Snapshot kondisi emulator untuk melanjutkan dari suatu posisi tertentu.

- Mendukung aksi simpan dan muat secara eksplisit dari antarmuka.
- Mendukung beberapa slot; jumlah slot ditentukan saat implementasi.
- Mencatat versi engine dan core untuk pemeriksaan kompatibilitas.
- Tidak otomatis memuat state yang tidak kompatibel tanpa peringatan.
- Autosave state dapat menjadi pengembangan lanjutan setelah save manual dan memcard stabil.

Save state bukan pengganti save dalam game. Pembaruan engine atau core dapat memengaruhi kompatibilitas save state.

### Di Luar Cakupan Awal

- Upload atau sinkronisasi ROM dan BIOS.
- Sinkronisasi favorit, riwayat, dan pengaturan antarperangkat.
- Menjalankan emulator di server.
- Netplay atau permainan multiplayer.
- Login melalui Google atau penyedia identitas eksternal.
- Verifikasi akun dan pengiriman tautan reset password melalui email.

## Alur Pengguna

### Tamu

1. Buka maindulu dan pilih game tanpa login.
2. Mainkan game menggunakan perilaku penyimpanan browser yang tersedia sekarang.
3. Tetap dapat bermain jika fitur backend tidak diaktifkan atau sedang bermasalah, selama aset yang diperlukan tersedia.

### Pengguna Login

1. Login menggunakan akun lokal.
2. Pilih game dan periksa save yang tersedia di server.
3. Ambil serta pasang save game/memcard sebelum permainan berjalan pada fase yang memerlukannya.
4. Sinkronkan perubahan memcard selama bermain; save state disimpan melalui aksi pengguna.
5. Saat keluar melalui navigasi aplikasi, tunggu upaya sinkronisasi dan tampilkan pilihan jika penyimpanan gagal.

Jangan hanya mengandalkan event penutupan tab untuk mengunggah progres. Browser dapat berhenti mendadak, sehingga sinkronisasi perlu dilakukan selama sesi bermain.

### Save Lokal yang Sudah Ada

- Tawarkan impor save browser ke akun secara eksplisit.
- Jika server juga memiliki save, tampilkan pilihan versi sebelum menimpa.
- Jangan otomatis menggabungkan data biner memcard atau save state.
- Pertahankan save asal sampai impor berhasil dikonfirmasi.

### Perangkat Lain

- Pengguna login ke server yang sama untuk mengakses simpanannya.
- Untuk ROM lokal, pengguna tetap harus memilih berkas ROM yang sesuai di perangkat tersebut.
- Komputer server harus menyala dan dapat dijangkau melalui jaringan.
- Alamat `localhost` hanya mengarah ke perangkat yang sedang digunakan; perangkat lain harus memakai alamat komputer server.
- Penggunaan lokal tidak memerlukan internet setelah aplikasi dan aset tersedia. Login lokal tidak bergantung pada layanan email atau identitas eksternal.

## Identitas dan Metadata Save

Setiap simpanan dipisahkan berdasarkan:

- ID pengguna yang ditentukan oleh sesi server.
- Identitas game yang stabil.
- Console dan core.
- Jenis simpanan: save game/memcard atau save state.
- Slot, jika berlaku.

Metadata tambahan mencakup versi engine/core yang tersedia, versi format penyimpanan aplikasi, ukuran, checksum, waktu pembaruan server, dan nomor revisi.

Pertahankan identitas ROM lokal berbasis hash yang sudah digunakan aplikasi. ID katalog server juga harus stabil. ROM yang berbeda region, revisi, atau isi tidak boleh dianggap kompatibel hanya karena memiliki judul yang sama. Penggabungan identitas antara ROM lokal dan katalog server bukan asumsi awal.

## Sinkronisasi dan Kegagalan

Status antarmuka minimum:

- `Memuat progres…`
- `Menyimpan…`
- `Tersimpan di server`
- `Gagal sinkron — coba lagi`
- `Ada konflik simpanan`

Aturan sinkronisasi:

- Status berhasil hanya muncul setelah server mengonfirmasi penyimpanan.
- Upload yang tertunda tidak boleh menimpa revisi lebih baru secara diam-diam.
- Gunakan pemeriksaan revisi di server untuk mendeteksi permainan bersamaan dari beberapa tab atau perangkat.
- Jika konflik terjadi, pengguna memilih versi yang dipertahankan; sediakan cadangan sebelum penggantian.
- Gangguan backend tidak boleh otomatis mengganti sumber save pengguna login ke data tamu yang berbeda.
- Jika save server gagal dimuat, jangan mengunggah save kosong sebagai penggantinya.
- Data kerja dan antrean retry dapat berada di memori browser. Cache persisten browser untuk pengguna login bukan persyaratan awal dan harus menjadi keputusan eksplisit.
- Tawarkan ekspor cadangan jika sinkronisasi tidak dapat diselesaikan. Jelaskan risiko kehilangan perubahan yang belum tersinkron saat tab ditutup.
- Saat logout atau berganti akun, hentikan antrean sinkronisasi akun sebelumnya dan bersihkan data sesi dari player; jangan memuat progres akun lain.

## Akun dan Keamanan

Metode yang dipilih adalah username dan password lokal saja. Pendaftaran, login, dan pemulihan akun tidak memerlukan internet atau layanan email. Google/OAuth dan login pihak ketiga tidak termasuk dalam rencana implementasi ini.

### Pendaftaran

1. Pengguna membuka formulir daftar ketika backend tersedia dan pendaftaran diizinkan oleh pengelola server.
2. Pengguna mengisi username, password, dan konfirmasi password; email tidak diwajibkan.
3. Server memvalidasi aturan username, keunikannya, dan kebijakan password, lalu membuat akun dengan ID pengguna yang stabil.
4. Server menghasilkan kode pemulihan acak berentropi tinggi menggunakan generator acak kriptografis.
5. Kode ditampilkan sekali untuk disalin atau diunduh pengguna, disertai peringatan agar disimpan di tempat aman di luar browser maindulu.

Aturan M3: username ASCII 3–24 karakter (huruf, angka, garis bawah), spasi tepi dipangkas dan disimpan huruf kecil; password 6–128 karakter tanpa normalisasi. Pendaftaran terbuka secara default pada localhost dan dapat ditutup melalui `MAIN_DULU_REGISTRATION_OPEN=false`. Normalisasi username yang sama harus digunakan pada pemulihan M4.

### Login dan Pengelolaan Password

- Pengguna login menggunakan username dan password.
- Gunakan pesan kegagalan login umum agar tidak membocorkan apakah username terdaftar.
- Pengguna yang sudah login dapat mengganti password setelah membuktikan password saat ini.
- Setelah pergantian password, cabut sesi lama dan minta login ulang menggunakan password baru.
- Penggantian password tidak mengubah ID akun atau kepemilikan save.
- Pengguna dapat menerbitkan ulang kode pemulihan setelah membuktikan password saat ini; penerbitan baru membatalkan kode sebelumnya.

### Lupa Password dengan Kode Pemulihan

1. Pengguna membuka formulir lupa password.
2. Pengguna mengisi username, kode pemulihan, password baru, dan konfirmasi password baru.
3. Server memvalidasi pasangan akun dan kode, serta kebijakan password baru.
4. Dalam satu transaksi, server mengganti hash password, menghabiskan kode lama, membatalkan seluruh sesi akun, dan menyimpan hash kode pemulihan baru.
5. Pengguna mendapat kode pemulihan baru yang ditampilkan sekali, lalu login menggunakan password baru.

Kode hanya berlaku untuk satu akun dan satu kali pemulihan. Pemakaian bersamaan harus tetap menghasilkan paling banyak satu pemulihan yang berhasil. Kode baru tidak dapat dilihat ulang; jika gagal disimpan oleh pengguna, penerbitan ulang memerlukan pembuktian password atau bantuan admin lokal.

Gunakan pesan kegagalan umum untuk kombinasi username/kode yang tidak valid dan pembatasan percobaan berdasarkan sumber permintaan serta akun, tanpa mengunci akun secara permanen karena permintaan pihak lain.

### Jika Kode Pemulihan Juga Hilang

- Tampilkan petunjuk menghubungi pemilik/pengelola komputer server.
- Sediakan perintah administrasi lokal untuk reset password setelah pengelola memverifikasi identitas pemilik akun melalui cara yang sesuai.
- Perintah hanya dijalankan dengan akses sistem operasi ke server; jangan menyediakan endpoint publik yang melewati pembuktian kepemilikan akun.
- Pengelola tidak dapat membaca password lama atau kode lama karena keduanya hanya disimpan sebagai hash.
- Reset admin mempertahankan ID akun dan seluruh save, tetapi membatalkan sesi serta kode pemulihan lama dan menyediakan kode baru secara aman.
- Input password baru dilakukan secara tersembunyi/interaktif, bukan melalui argumen yang mudah tertinggal di riwayat shell atau daftar proses.
- Pemulihan akun bukan pemulihan berkas: save yang terhapus tetap memerlukan backup server.

Nama dan bentuk perintah admin akan ditentukan saat implementasi; belum ada perintah reset yang tersedia saat ini.

### Pengamanan Teknis

- Simpan password sebagai hash adaptif yang sesuai, bukan plaintext.
- Simpan hanya hash kode pemulihan. Jangan memasukkan password atau kode mentah ke log, URL, analitik, atau penyimpanan browser persisten.
- Gunakan sesi server dengan cookie `HttpOnly`, `SameSite`, dan masa berlaku yang jelas.
- Gunakan cookie `Secure` dan HTTPS untuk deployment jaringan/produksi; konfigurasi pengembangan localhost perlu dibedakan.
- Lindungi endpoint yang mengubah data terhadap CSRF dan batasi percobaan daftar, login, serta pemulihan password.
- Rotasi identitas sesi setelah login. Pencabutan sesi berlaku di server, bukan hanya menghapus cookie pada browser pengguna.
- Backend menentukan pemilik data dari sesi, bukan mempercayai ID pengguna yang dikirim frontend.
- Validasi ukuran, jenis, slot, dan identitas save; terapkan kuota penyimpanan.
- Jangan gunakan input pengguna secara langsung sebagai path berkas.
- Gunakan penulisan berkas atomik dan mekanisme konsistensi metadata untuk menghindari save setengah tertulis.
- Pertahankan pemeriksaan origin, source-window, channel, dan session ID pada komunikasi iframe player.
- Jangan menyimpan rahasia autentikasi dalam pesan konfigurasi player.

Saat sesi dicabut akibat pergantian atau pemulihan password, player mengikuti aturan sesi kedaluwarsa: hentikan sinkronisasi terautentikasi, tampilkan kebutuhan login ulang, dan jangan diam-diam mengganti akun atau menimpa save server.

## Penyimpanan dan Backup

- Folder data berada di luar hasil build frontend dan tidak boleh dilayani sebagai aset publik.
- Lokasi data dapat dikonfigurasi dan harus tetap sama setelah aplikasi direstart atau diperbarui.
- Database serta berkas save harus dicadangkan sebagai satu kumpulan yang konsisten, misalnya melalui operasi backup terkoordinasi atau saat server dihentikan.
- Menyalin database SQLite yang sedang aktif secara sembarang bukan prosedur backup yang memadai.
- Backup perlu mencakup metadata, berkas save, dan informasi konfigurasi yang diperlukan untuk pemulihan.
- Uji pemulihan backup, bukan hanya pembuatan salinannya.
- Folder atau volume persisten bukan pengganti backup di lokasi lain.

## Milestone Implementasi

### Cara Pengerjaan

- Kerjakan satu milestone dalam satu lingkup pekerjaan, lalu tinjau hasilnya sebelum melanjutkan.
- Checklist hanya dicentang setelah implementasi dan pengujiannya selesai; keberadaan kode saja belum cukup.
- Catat hasil pengujian, batas dukungan core, dan blocker pada milestone terkait saat dikerjakan.
- Pengujian serta pengamanan dilakukan di setiap milestone, bukan ditunda sampai milestone terakhir.
- Detail arsitektur dan perilaku pada bagian sebelumnya tetap menjadi acuan penerimaan.

| Milestone | Hasil utama | Dependensi | Status |
| --- | --- | --- | --- |
| M1 | Bukti ekspor/impor save pada engine nyata | — | Selesai — otomatis NES, manual PS1 |
| M2 | Web dan API lokal satu proses, SQLite persisten | M1 | Selesai |
| M3 | Daftar, login, logout, dan sesi akun lokal | M2 | Selesai |
| M4 | Pemulihan password dan reset admin lokal | M3 | Belum dimulai |
| M5 | Save/load state manual ke server | M1–M4 | Belum dimulai |
| M6 | Sinkronisasi save game/memcard | M5 | Belum dimulai |
| M7 | Penyelesaian konflik dan impor save browser | M6 | Belum dimulai |
| M8 | Backup/restore, verifikasi akhir, dan panduan operasi | M7 | Belum dimulai |

### M1 — Pembuktian Integrasi Player

Tujuan: membuktikan jalur ekspor/impor sebelum membangun penyimpanan server.

- [x] Identifikasi API ekspor/impor save state dan save game pada engine yang dipaketkan.
- [x] Buktikan save state demo NES dapat dimuat pada sesi emulator baru.
- [x] Buktikan save game menggunakan fixture sah yang mendukung penyimpanan dalam game; demo NES tidak otomatis membuktikan SRAM.
- [x] Uji memory card PS1 menggunakan aset lokal pengguna: pengguna mengonfirmasi memcard dan save state, termasuk ekspor/impor lintas sesi/browser, lulus manual; bukan hasil tes otomatis.
- [x] Tentukan fase pemulihan save sebelum boot, cara mendeteksi perubahan, dan metadata kompatibilitas. Layout save aktif PS1 sudah diobservasi; integrasi pemulihan sebelum boot PS1 masih harus diuji di M6.
- [x] Catat matriks dukungan core, hasil pengujian, dan keterbatasan. Core yang belum diuji tidak dinyatakan didukung.
- [x] Evaluasi kebutuhan perubahan engine: pembuktian NES tidak membutuhkan patch; mode storage akun di M5/M6 perlu isolasi dari IDBFS browser. Jika perlu patch nanti, gunakan proses vendoring yang dapat direproduksi.

Hasil: tiga tes browser M1 NES lulus (state lintas context, SRAM sebelum boot, serta event ekspor/impor pada core berjalan), ditambah verifikasi manual pengguna untuk memcard dan state PS1 lintas sesi/browser. M1 selesai. Lihat [laporan M1](milestone-1-integrasi-save.md) untuk pemisahan bukti otomatis/manual dan batasan yang harus diuji kembali saat integrasi server.

**Selesai jika:** hasil save dapat dipulihkan pada sesi baru melalui engine nyata, dan kontrak integrasi serta batas dukungan sudah jelas. Jika fixture PS1 belum tersedia, catat sebagai blocker dan jangan menyatakan dukungan memcard PS1 selesai.

### M2 — Fondasi Backend Tanpa Docker

Tujuan: menjalankan web dan API di satu komputer melalui satu proses Node.js.

Implementasi dan panduan operasi: [M2 — Backend Lokal](milestone-2-backend-lokal.md). Pilihan teknologi: Fastify 5, `@fastify/static` 10, SQLite bawaan Node.js 24+.

- [x] Tentukan framework backend, library SQLite, versi Node.js minimum, serta sistem operasi yang didukung. Fastify 5, SQLite bawaan Node.js 24+, Windows terverifikasi; Linux menjadi target portabilitas yang belum diuji langsung.
- [x] Tambahkan server untuk hasil build frontend dan API same-origin, dengan port serta folder data yang dapat dikonfigurasi.
- [x] Tambahkan SQLite dan migrasi skema; simpan data di luar folder aset publik/build.
- [x] Sediakan satu perintah menjalankan server (`npm start`) dan petunjuk penggunaan awal.
- [x] Bedakan frontend tanpa backend dengan backend terkonfigurasi yang sedang gagal dihubungi, termasuk timeout dan retry.
- [x] Uji persistensi setelah restart proses CLI serta pastikan database/folder data tidak dapat diunduh sebagai aset web.
- [x] Uji bahwa frontend statis, katalog, dan permainan tamu tetap berjalan tanpa backend.

Hasil: build lulus, 34 unit/integrasi lulus, 22 tes browser development lulus, 22 tes browser production statis lulus, dan 17 tes terhadap backend Node.js nyata lulus. Suite server juga lulus pada Node.js 24.22.1. M2 selesai; login serta save server belum tersedia. Detail verifikasi ada pada [laporan M2](milestone-2-backend-lokal.md#hasil-verifikasi).

**Selesai jika:** web dan API berjalan tanpa Docker dalam satu proses, data bertahan setelah restart, dan mode statis tidak mengalami regresi.

### M3 — Akun Lokal dan Sesi

Tujuan: menyediakan autentikasi opsional tanpa Google atau email.

Panduan dan kontrak: [M3 — Akun Lokal dan Sesi](milestone-3-akun-lokal.md).

- [x] Tetapkan kebijakan pendaftaran, normalisasi username, aturan password, masa berlaku sesi, dan pembatasan percobaan.
- [x] Implementasikan daftar akun, login, logout, pemeriksaan sesi, dan pergantian password.
- [x] Terbitkan kode pemulihan saat daftar, tampilkan sekali, dan simpan hanya hash-nya.
- [x] Gunakan hash password adaptif, sesi server, cookie yang sesuai, proteksi CSRF, dan rotasi sesi setelah login.
- [x] Cabut sesi lama setelah pergantian password dan pertahankan ID akun.
- [x] Tambahkan UI akun opsional; pengguna tamu tidak dipaksa login.
- [x] Uji username duplikat/normalisasi, kredensial salah, sesi kedaluwarsa, logout, CSRF, pembatasan percobaan, dan tidak adanya rahasia dalam log/URL.

Hasil: 48 unit/integrasi lulus; build lulus; masing-masing suite development/production statis 22 lulus dan 4 tes akun sengaja dilewati; suite backend nyata 21 lulus, termasuk empat tes akun. Suite autentikasi/server pada Node.js 24.22.1 juga lulus. M3 selesai; lihat [hasil verifikasi M3](milestone-3-akun-lokal.md#hasil-verifikasi). Pemulihan password masih M4 dan progres tetap di browser sampai integrasi save server.

**Selesai jika:** pengguna dapat daftar, login, mengganti password, dan logout tanpa internet; sesi terlindungi dan mode tamu tetap berfungsi. Alur lupa password lengkap dilanjutkan di M4.

### M4 — Pemulihan Akun

Tujuan: memulihkan akses akun tanpa layanan email.

- [ ] Tambahkan formulir reset menggunakan username, kode pemulihan, dan password baru.
- [ ] Konsumsi kode lama, ganti password, cabut semua sesi, dan simpan hash kode baru dalam satu transaksi.
- [ ] Tambahkan penerbitan ulang kode setelah pembuktian password saat ini.
- [ ] Sediakan perintah reset admin lokal dengan input password tersembunyi, tanpa endpoint reset publik yang melewati pembuktian akun.
- [ ] Dokumentasikan penyimpanan kode dan prosedur verifikasi pemilik akun oleh pengelola.
- [ ] Uji kode salah, lintas akun, terpakai, dibatalkan, dan dipakai bersamaan; maksimal satu pemulihan berhasil per kode.
- [ ] Uji pencabutan sesi, penolakan password/kode lama, serta pembatasan percobaan tanpa membocorkan keberadaan akun.
- [ ] Pastikan reset mempertahankan ID akun dan tidak menghapus data milik pengguna.

**Selesai jika:** pemulihan dengan kode serta bantuan admin lokal berhasil, kode tidak dapat digunakan ulang, dan seluruh sesi lama ditolak server.

### M5 — Save State Server Manual

Tujuan: menyediakan alur cloud save pertama dari browser sampai penyimpanan server.

- [ ] Tetapkan jumlah slot, batas ukuran, kuota, metadata kompatibilitas, dan format identitas save.
- [ ] Implementasikan API daftar, baca, tulis, dan hapus save dengan pemeriksaan kepemilikan di server.
- [ ] Terapkan checksum, penulisan atomik, konsistensi metadata/berkas, dan pemeriksaan revisi untuk menolak overwrite usang sejak awal.
- [ ] Integrasikan pesan save/load antara host React dan bridge iframe dengan validasi origin, source, channel, serta session ID.
- [ ] Pisahkan jalur save state pengguna login dari store browser tamu; `EJS_disableDatabases` tidak mematikan store state engine.
- [ ] Tambahkan tombol save/load state, slot, status upload, dan peringatan kompatibilitas.
- [ ] Tangani sesi kedaluwarsa, pergantian akun, dan kegagalan jaringan tanpa mencampurkan data tamu atau akun lain.
- [ ] Uji save lalu restart server/buka sesi browser baru dan pulihkan state melalui engine nyata.
- [ ] Uji isolasi dua akun, akses tanpa izin, path berbahaya, upload tidak valid, kuota, revisi usang, dan versi engine/core berbeda.
- [ ] Verifikasi bahwa reset password/admin tetap mempertahankan akses pemilik ke save yang sudah ada.

**Selesai jika:** pengguna login dapat menyimpan dan memuat state lintas sesi dari server; kegagalan serta konflik revisi terlihat jelas dan tidak menimpa data diam-diam.

### M6 — Save Game dan Memcard Otomatis

Tujuan: menjadikan server penyimpanan utama progres dalam game pada core yang sudah diverifikasi.

- [ ] Ambil serta pasang save game/memcard sebelum fase permainan yang memerlukannya.
- [ ] Isolasi storage pengguna login dari IDBFS tamu/akun lain; pertahankan persistence browser untuk tamu. Buktikan mode memori akun tanpa otomatis membaca/menulis store bersama.
- [ ] Tambahkan deteksi perubahan, pembatasan frekuensi upload, dan retry terbatas selama sesi berlangsung.
- [ ] Tampilkan status tersimpan hanya setelah konfirmasi server; jangan mengandalkan penutupan tab sebagai jalur sinkronisasi utama.
- [ ] Cegah save kosong menimpa server ketika pengambilan save awal gagal.
- [ ] Tangani navigasi keluar, logout, sesi dicabut, dan pergantian akun; hentikan antrean lama dan tawarkan ekspor jika sinkronisasi gagal.
- [ ] Uji round-trip save dalam game/memcard pada sesi baru, termasuk PS1 sesuai hasil M1.
- [ ] Uji gangguan jaringan, retry, pencabutan sesi saat bermain, dan antrean yang tidak boleh diteruskan ke akun lain.
- [ ] Pastikan fitur tidak mengunggah ROM atau BIOS lokal.

**Selesai jika:** progres dalam game pulih dari server pada core terverifikasi dan perubahan tersinkron selama bermain, dengan kegagalan yang aman serta terlihat.

### M7 — Konflik dan Migrasi Save Lokal

Tujuan: membantu pengguna memilih versi progres tanpa kehilangan simpanan yang sudah ada.

- [ ] Tetapkan retensi cadangan konflik dan pilihan versi yang ditawarkan pengguna.
- [ ] Tambahkan UI penyelesaian konflik revisi dari dua tab/perangkat, melanjutkan penolakan overwrite usang yang sudah ada di M5.
- [ ] Buat cadangan sebelum penggantian versi; jangan menggabungkan save biner secara otomatis.
- [ ] Tambahkan impor save browser ke akun dengan konfirmasi dan pemeriksaan identitas/kompatibilitas.
- [ ] Pertahankan save lokal asal sampai server mengonfirmasi impor berhasil.
- [ ] Uji dua perangkat menulis save yang sama, retry usang, impor gagal, dan impor saat server sudah mempunyai save.

**Selesai jika:** konflik dapat diselesaikan secara eksplisit dan impor tidak menghapus atau menimpa progres tanpa konfirmasi.

### M8 — Backup, Verifikasi Akhir, dan Dokumentasi

Tujuan: menyiapkan penggunaan sehari-hari serta pemulihan ketika komputer/server bermasalah.

- [ ] Sediakan prosedur backup konsisten untuk SQLite dan berkas save, serta prosedur restore.
- [ ] Uji restore ke folder data bersih dan verifikasi akun, metadata, serta save dapat digunakan kembali.
- [ ] Dokumentasikan instalasi, build, satu perintah menjalankan server, konfigurasi data/port, pembaruan aplikasi, dan reset admin tanpa Docker.
- [ ] Dokumentasikan akses localhost versus perangkat lain, kebutuhan server tetap menyala, dan HTTPS untuk akses jaringan.
- [ ] Jalankan regresi mode frontend statis, tamu, akun lokal, pemulihan, save state, memcard, konflik, serta kegagalan backend.
- [ ] Publikasikan matriks core yang benar-benar diuji dan keterbatasan kompatibilitasnya.
- [ ] Cocokkan hasil dengan seluruh kriteria selesai di bawah; catat batasan yang masih ada sebelum menyatakan fitur siap digunakan.

**Selesai jika:** aplikasi dapat dipasang tanpa Docker, backup terbukti dapat dipulihkan, dan alur utama serta skenario kegagalan lolos pengujian yang terdokumentasi.

## Kriteria Selesai

- Web dan backend dapat berjalan di satu komputer tanpa Docker.
- Pengguna dapat bermain tanpa akun.
- Pengguna dapat membuat dan memakai akun lokal tanpa Google atau layanan email.
- Pengguna dapat memulihkan akun dengan kode sekali pakai, atau dibantu admin lokal jika kode hilang, tanpa kehilangan kepemilikan save.
- Pengguna login dapat menyimpan dan memuat progres dari server pada core yang sudah diverifikasi.
- Data server bertahan setelah restart dan dapat dipulihkan dari backup.
- Kegagalan sinkronisasi terlihat jelas dan tidak menyebabkan penimpaan progres secara diam-diam.
- ROM/BIOS lokal tetap tidak diunggah oleh fitur sinkronisasi.
- Deployment statis tanpa backend tetap didukung.

## Keputusan Lanjutan

- Framework backend dan library SQLite yang digunakan.
- Dukungan sistem operasi serta versi Node.js minimum backend.
- Bentuk perintah reset admin serta prosedur verifikasi pemilik akun oleh pengelola; kebijakan akun dan format kode awal telah ditetapkan pada M3.
- Jumlah slot, batas ukuran save, kuota per akun, dan retensi cadangan konflik.
- Kebijakan cache offline untuk pengguna login.
- Penyajian HTTPS jika server diakses perangkat lain.
- Daftar core yang dinyatakan mendukung sinkronisasi setelah pengujian nyata.
