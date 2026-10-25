# Rencana Login Opsional dan Penyimpanan Progres Server

Status: **M1–M8 selesai dalam cakupan terverifikasi masing-masing; M8 ditutup untuk penggunaan lokal.** Konflik, impor browser/file, dan cadangan M7 dibuktikan otomatis pada NES legacy; pengguna juga mengonfirmasi tes PS1 M7 berhasil manual, tanpa rincian skenario/konfigurasi. M8 menyediakan backup/verify/restore offline melalui CLI dan pembuktian pemulihan instalasi NES ke folder bersih; pengguna mengonfirmasi progres PS1 terbaca setelah restore instalasi. Bukti manual M6, M7, dan M8 tetap terpisah, bukan tes otomatis PS1 atau klaim seluruh game/card/varian. **HTTPS belum diimplementasikan/diuji oleh pengguna dan ditunda; akun dari perangkat lain belum dinyatakan siap.** Lihat [panduan M6 dan hasil manual PS1](milestone-6-progres-game.md), [panduan M7](milestone-7-konflik-impor-save.md), serta [operasi dan bukti M8](milestone-8-backup-operasi.md).

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
- Player tamu tetap memakai storage browser; player akun memakai store state dummy dan filesystem save memori terisolasi. State dapat disimpan/dimuat manual melalui server; progres NES dan memcard aktif PS1 pada cakupan M6 dipulihkan sebelum boot/disinkronkan. Core tanpa adapter tetap sementara di memori.
- Backend lokal menyajikan hasil build, health API, SQLite persisten, akun/pemulihan M3–M4, save state M5, progres M6, serta cadangan/keputusan eksplisit M7. Byte save berada di folder data privat, bukan aset publik.

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
- Autosave state opsional tersedia pada M5: nonaktif secara default, memakai satu slot khusus terpisah dari slot manual, dan hanya berjalan saat permainan aktif. Ini bukan sinkronisasi save dalam game/memcard M6.

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

Perintah M4: `npm run account:reset -- <username>`, menggunakan folder data backend yang sama dan input password tersembunyi melalui terminal interaktif. Lihat [prosedur verifikasi pemilik dan reset admin](milestone-4-pemulihan-akun.md#bantuan-admin-lokal-jika-kode-hilang).

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
| M4 | Pemulihan password dan reset admin lokal | M3 | Selesai |
| M5 | Save/load state manual ke server | M1–M4 | Selesai — NES otomatis; core lain belum terverifikasi |
| M6 | Sinkronisasi save game/memcard | M5 | Selesai — NES otomatis; round-trip memcard aktif PS1 manual pengguna |
| M7 | Penyelesaian konflik dan impor save browser/file | M6 | Selesai — NES legacy otomatis; PS1 manual pengguna, cakupan rinci belum dicatat |
| M8 | Backup/restore, verifikasi akhir, dan panduan operasi | M7 | Selesai untuk lokal — NES otomatis, PS1 manual; HTTPS ditunda |

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

Panduan, kontrak API, dan prosedur administrasi: [M4 — Pemulihan Akun](milestone-4-pemulihan-akun.md).

- [x] Tambahkan formulir reset menggunakan username, kode pemulihan, dan password baru.
- [x] Konsumsi kode lama, ganti password, cabut semua sesi, dan simpan hash kode baru dalam satu transaksi.
- [x] Tambahkan penerbitan ulang kode setelah pembuktian password saat ini.
- [x] Sediakan perintah reset admin lokal dengan input password tersembunyi, tanpa endpoint reset publik yang melewati pembuktian akun.
- [x] Dokumentasikan penyimpanan kode dan prosedur verifikasi pemilik akun oleh pengelola.
- [x] Uji kode salah, lintas akun, terpakai, dibatalkan, dan dipakai bersamaan; maksimal satu pemulihan berhasil per kode.
- [x] Uji pencabutan sesi, penolakan password/kode lama, serta pembatasan percobaan tanpa membocorkan keberadaan akun.
- [x] Pastikan reset mempertahankan ID akun dan tidak menghapus data milik pengguna. Data terkait diuji dengan record kepemilikan sentinel; save server nyata tetap diuji di M5.

Hasil: 65 unit/integrasi lulus; build lulus; suite development/production statis masing-masing 22 lulus dan 7 tes akun sengaja dilewati; suite backend nyata 24 lulus, termasuk tujuh tes akun. Suite autentikasi/admin/server pada Node.js 24.22.1: 39 lulus. Pengujian CLI menggunakan proses nyata dengan stream TTY simulasi, bukan terminal Windows native. M4 selesai; lihat [hasil verifikasi dan batasan M4](milestone-4-pemulihan-akun.md#hasil-verifikasi). Cloud save belum tersedia.

**Selesai jika:** pemulihan dengan kode serta bantuan admin lokal berhasil, kode tidak dapat digunakan ulang, dan seluruh sesi lama ditolak server.

### M5 — Save State Server Manual

Tujuan: menyediakan alur cloud save pertama dari browser sampai penyimpanan server.

Panduan, kontrak API, konfigurasi kuota, dan batasan: [M5 — Save State Server Manual](milestone-5-save-state-server.md).

- [x] Tetapkan jumlah slot, batas ukuran, kuota, metadata kompatibilitas, dan format identitas save. Tiga slot; default 32 MiB/state dan 256 MiB/akun, dapat dikonfigurasi.
- [x] Implementasikan API daftar, baca, tulis, dan hapus save dengan pemeriksaan kepemilikan di server; slot 1–3 manual dan slot khusus 99 (Autosave).
- [x] Terapkan checksum, penulisan atomik, konsistensi metadata/berkas, dan pemeriksaan revisi untuk menolak overwrite usang sejak awal. Tombstone menjaga revisi setelah penghapusan; startup membersihkan orphan secara terkoordinasi.
- [x] Integrasikan pesan save/load antara host React dan bridge iframe dengan validasi origin, source, channel, serta session ID.
- [x] Pisahkan jalur save state pengguna login dari store browser tamu; `EJS_disableDatabases` tidak mematikan store state engine. Patch vendoring menambahkan mode state dummy/MEMFS akun tanpa mengubah persistence tamu.
- [x] Tambahkan tombol **Save state server** di toolbar emulator (bar bawah, di sebelah Import Save File) untuk sesi akun, serta overlay tunggal yang mem-pause permainan saat terbuka dan melanjutkan hanya permainan yang berjalan saat overlay ditutup. Panel berisi tiga slot manual, slot Autosave terpisah, toggle/interval autosave (Nonaktif 0 detik, 30 detik, 1–15 menit), pengelola lintas game, peringatan kuota 80%, hapus berkonfirmasi, ekspor cadangan, dan retry eksplisit; tidak ada penghapusan otomatis.
- [x] Rapikan overlay menjadi dialog vertikal responsif dengan navigasi keyboard. Pastikan overlay/pengelola tersedia saat fullscreen sesi akun, tambahkan notifikasi autosave singkat di kanan atas player, dan sembunyikan menu **Save States** di gerigi untuk semua pengguna tanpa mengubah **System Save interval** atau tombol save/load tamu. Pengguna mengonfirmasi tes manual perubahan terakhir berhasil.
- [x] Tangani sesi kedaluwarsa, pergantian akun, dan kegagalan jaringan tanpa mencampurkan data tamu atau akun lain.
- [x] Uji save lalu restart server/buka sesi browser baru dan pulihkan state melalui engine nyata. Posisi RAM NES benar-benar pulih setelah server dibuat ulang dan database dibuka ulang, bukan hanya pengujian byte.
- [x] Uji isolasi dua akun, akses tanpa izin, path berbahaya, upload tidak valid, kuota, revisi usang, dan versi engine/core berbeda.
- [x] Verifikasi bahwa reset password/admin tetap mempertahankan akses pemilik ke save yang sudah ada. Ganti password, pemulihan kode, dan reset admin diuji terhadap byte state serta ID pemilik nyata.

Hasil: 75 unit/integrasi lulus; build lulus. Verifikasi awal development/production statis masing-masing 22 lulus dan 13 tes akun/save server sengaja dilewati. Setelah penambahan regresi tata letak overlay, backend nyata 32 lulus, termasuk delapan tes integrasi M5 (termasuk autosave slot 99). Perubahan notifikasi/fullscreen/menu gerigi sesudahnya telah lolos build dan dikonfirmasi lewat tes manual pengguna; regresi browser penuh belum diulang untuk perubahan terakhir tersebut. Suite autentikasi/admin/save/server pada Node.js 24.22.1: 48 lulus pada verifikasi awal. Dukungan server dibuktikan otomatis pada NES legacy sesuai filename loader yang direkam; PS1/core lain dan varian normal belum dinyatakan terverifikasi. M5 selesai; rincian serta batasan pada [hasil M5](milestone-5-save-state-server.md#hasil-verifikasi).

**Selesai jika:** pengguna login dapat menyimpan dan memuat state lintas sesi dari server; kegagalan serta konflik revisi terlihat jelas dan tidak menimpa data diam-diam.

### M6 — Save Game dan Memcard Otomatis

Tujuan: menjadikan server penyimpanan utama progres dalam game pada core yang sudah diverifikasi.

Panduan, API, konfigurasi, batas layout, dan checklist penerimaan: [M6 — Progres Game](milestone-6-progres-game.md).

- [x] Ambil serta pasang save sebelum boot; hook sinkron sesudah ekstraksi ROM dan sebelum `callMain`. NES dibuktikan engine nyata; pemulihan PS1 lintas sesi/browser dikonfirmasi manual pengguna tanpa impor atau muat state M5.
- [x] Pertahankan MEMFS akun dan persistence IDBFS tamu; tidak ada impor otomatis browser/file ke akun.
- [x] Deteksi checksum melalui flush 10 detik saat aktif, satu upload berjalan, replay idempoten, dan maksimal tiga retry otomatis.
- [x] Konfirmasi tersimpan hanya setelah respons server; tutup tab bukan jalur sinkronisasi utama.
- [x] Gagal ambil save awal menahan boot; `null` tidak menghapus/menimpa progres server.
- [x] Tangani navigasi keluar dengan flush, logout, sesi dicabut, dan pergantian akun; antrean tidak direbinding, ekspor `.srm` tersedia.
- [x] Terima round-trip memcard aktif PS1 berdasarkan konfirmasi manual pengguna: ekspor berhasil dan progres server pulih pada sesi/browser baru melalui Continue/Load dalam game. Seluruh card/slot/varian tidak diklaim; detail konfigurasi belum dicatat. Round-trip SRAM NES lintas restart server/browser baru sudah lulus otomatis.
- [x] Uji gangguan jaringan/retry, revisi usang, logout/pencabutan sesi, serta antrean yang tidak boleh diteruskan ke akun lain.
- [x] Payload jalur aplikasi hanya progres native yang dikemas, bukan ROM/BIOS lokal.

M6 selesai untuk cakupan tersebut. Konfirmasi manual PS1 menutup penerimaan pemulihan progres aktif, bukan bukti semua game/card/slot atau tes otomatis PS1. Core lain serta semua varian tidak diklaim terverifikasi hanya karena asetnya tersedia. Hasil pengujian dan batasan dicatat pada panduan M6; impor file/browser serta UI penyelesaian konflik tetap M7.

**Selesai jika:** progres dalam game pulih dari server pada core terverifikasi dan perubahan tersinkron selama bermain, dengan kegagalan yang aman serta terlihat.

### M7 — Konflik dan Migrasi Save Lokal

Tujuan: membantu pengguna memilih versi progres tanpa kehilangan simpanan yang sudah ada.

Panduan aktual dan keputusan persiapan: [M7 — Konflik dan Impor Save Lokal](milestone-7-konflik-impor-save.md). Keputusan pengguna: impor browser + file `.srm`/`.state`, cadangan tanpa penghapusan otomatis dan memakai kuota akun, serta sesi player baru untuk progres server/impor sebelum boot. Cadangan bukan riwayat setiap tick/autosave; M8 tetap terpisah.

- [x] Tetapkan retensi cadangan konflik dan pilihan versi yang ditawarkan pengguna: tidak ada penghapusan otomatis, kuota gabungan, pilihan server/sesi dan cadangan versi tersisih.
- [x] Tambahkan UI penyelesaian konflik revisi dari dua tab/perangkat, melanjutkan penolakan overwrite usang M5. Penulisan ditahan selama peninjauan; pilihan progres server membuka sesi baru sebelum boot.
- [x] Buat cadangan sebelum penggantian versi; tidak ada merge biner. Cadangan dapat diunduh/pulihkan/hapus eksplisit; kuota/gagal backup menahan penggantian.
- [x] Tambahkan impor save browser serta file `.srm`/`.state` ke akun dengan konfirmasi identitas/kompatibilitas. Build sumber yang tidak diketahui tidak diklaim terverifikasi; pengguna mengonfirmasi build tujuan.
- [x] Pertahankan save lokal asal, termasuk sesudah impor berhasil. Pembaca IndexedDB read-only, mempertahankan byte Int8Array/Uint8Array dan tidak membuat database kosong.
- [x] Uji penulisan bersamaan lewat dua tab/koneksi, retry usang, respons impor hilang setelah commit, impor gagal/target terisi, restart/cadangan, serta keutuhan storage tamu pada NES otomatis. PS1 M7 dikonfirmasi berhasil manual oleh pengguna; dua perangkat fisik dan setiap skenario PS1 tidak diklaim terverifikasi satu per satu.

Hasil M7: 100 unit/integrasi lulus; build/sintaks/TypeScript tes lulus; backend browser penuh 45 lulus dan M7 terarah pada guard akhir 5 lulus. Jalur M7+M5/M6/server pada Node.js 24.22.1: 44 lulus. Pengguna mengonfirmasi tes manual PS1 M7 berhasil; rincian skenario/konfigurasi belum dicatat. Regresi statis dan batas verifikasi lengkap ada di [panduan M7](milestone-7-konflik-impor-save.md). Sesi percobaan impor sebelum commit belum tersedia; source dan cadangan dipertahankan untuk pemulihan.

**Selesai jika:** konflik dapat diselesaikan secara eksplisit dan impor tidak menghapus atau menimpa progres tanpa konfirmasi.

### M8 — Backup, Verifikasi Akhir, dan Dokumentasi

Tujuan: menyiapkan penggunaan sehari-hari serta pemulihan ketika komputer/server bermasalah.

- [x] Sediakan prosedur backup konsisten untuk SQLite dan berkas save, serta prosedur restore: CLI offline, manifest/checksum, integritas dan referensi blob, tujuan baru, sesi hasil restore dicabut.
- [x] Uji restore ke folder data bersih dan verifikasi akun, metadata, serta save dapat digunakan kembali: unit/API seluruh jenis save dan engine NES nyata di browser baru. Pengguna mengonfirmasi progres PS1 terbaca setelah restore instalasi M8.
- [x] Dokumentasikan instalasi, build, satu perintah menjalankan server, konfigurasi data/port, pembaruan aplikasi, dan reset admin tanpa Docker.
- [x] Dokumentasikan akses localhost versus perangkat lain, kebutuhan server tetap menyala, dan HTTPS untuk akses jaringan. Contoh reverse proxy bukan bukti deployment HTTPS nyata.
- [x] Jalankan regresi otomatis mode frontend statis, tamu, akun lokal, pemulihan, save state, paket memcard API, SRAM NES engine nyata, konflik, serta kegagalan backend. Progres PS1 setelah restore M8 dikonfirmasi terbaca oleh pengguna secara manual; bukan tes otomatis atau klaim seluruh konfigurasi PS1.
- [x] Publikasikan matriks core yang benar-benar diuji dan keterbatasan kompatibilitasnya.
- [x] Cocokkan hasil dengan seluruh kriteria selesai di bawah; catat batasan yang masih ada sebelum menyatakan fitur siap digunakan.

Hasil otomatis M8: 109 unit/integrasi lulus, build/sintaks/TypeScript tes lulus, backend browser penuh 46 lulus (guard restore akhir diuji ulang melalui 1 skenario M8), statis development/production masing-masing 22 lulus + 29 skenario akun/server dilewati. Jalur backup/server/admin pada Node.js 24.22.1: 23 lulus. Keputusan pengguna: backup offline manual berformat folder, tanpa enkripsi/scheduler/pruning bawaan, restore hanya ke folder belum ada dan sesi dicabut. **M8 selesai untuk penggunaan lokal** setelah pengguna mengonfirmasi progres PS1 terbaca setelah restore. Bukti ini berasal dari tes manual M8, bukan pengangkatan hasil M6/M7; rincian konfigurasi belum dicatat. HTTPS belum diimplementasikan/diuji oleh pengguna dan ditunda, bukan dinyatakan lulus atau syarat penutupan lokal. Panduan, pemetaan kriteria, serta checklist pencatatan tambahan PS1 dan penerapan HTTPS ada di [M8 — Backup dan Operasi](milestone-8-backup-operasi.md).

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
- Perintah reset admin dan prosedur verifikasi pemilik telah ditetapkan pada [M4](milestone-4-pemulihan-akun.md); kebijakan akun dan format kode awal ditetapkan pada M3.
- Slot, batas ukuran state, dan kuota akun telah ditetapkan pada M5; retensi M7 ditetapkan tanpa penghapusan otomatis, dengan kuota gabungan dan hapus eksplisit oleh pengguna.
- Kebijakan cache offline untuk pengguna login.
- Penyajian HTTPS jika server diakses perangkat lain.
- Daftar core yang dinyatakan mendukung sinkronisasi setelah pengujian nyata.
