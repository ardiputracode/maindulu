# M5 — Save State Server Manual

Status: M5 selesai untuk save state server manual dan autosave opsional pada NES yang terverifikasi. Kuota/pengelola, isolasi akun/tamu, dan regresi telah diuji; pengguna telah mengonfirmasi tes manual perubahan UI terakhir. Batas dukungan core serta fitur lanjutan tetap dicatat di bawah.

M5 menambahkan save/load state manual dari engine nyata ke penyimpanan server privat, tanpa upload ROM/BIOS. **Save dalam game/memcard otomatis tetap M6.** Dukungan server yang dibuktikan otomatis saat ini adalah **NES / fceumm varian legacy**, yaitu pilihan default loader yang teramati pada suite ini. Core/varian lain dapat dicoba dengan peringatan, tetapi tidak dinyatakan terverifikasi hanya karena `supportsStates()` tersedia atau pernah lulus ekspor/impor manual M1.

## Cara Menggunakan

1. Gunakan Node.js 24+, jalankan `npm run build`, lalu `npm start`.
2. Login sebelum membuka game. Mode penyimpanan dipilih saat peluncuran dan tidak berubah diam-diam di tengah sesi.
3. Mulai emulator, lalu buka **Save state server** melalui tombol dengan ikon cloud **di toolbar emulator** (bar bawah, di sebelah **Import Save File**), bukan tombol di halaman React. Tombol ini hanya ada untuk sesi akun. Ketika overlay terbuka, permainan jeda otomatis dan lanjut kembali saat ditutup; jika game sudah dijeda pengguna, overlay tidak melanjutkannya diam-diam.
4. Ketuk **Ganti** pada salah satu dari tiga slot manual untuk menyimpan kondisi terbaru, atau **Muat** untuk memuat state server. Slot **Autosave** hanya bisa dimuat. Status **Tersimpan di server** hanya muncul setelah API mengonfirmasi commit.
5. Untuk melanjutkan, login pada browser/perangkat lain ke server yang sama, buka game yang sama, mulai core, lalu tekan **Muat** pada slot tujuan. Tidak ada auto-load.
6. ROM lokal tetap harus dipilih kembali; identitas berbasis hash isi ROM dipertahankan. Judul yang sama bukan bukti ROM/region/revisi yang sama.

**Autosave state** — di overlay Save state server, aktifkan **Aktifkan autosave state** lalu pilih interval **Nonaktif (default) / 30 detik / 1 menit / 2 menit / 5 menit / 10 menit / 15 menit**. Saat aktif, slot khusus **Autosave** (slot 99) ditimpa secara otomatis sesuai interval, hanya saat game benar-benar berjalan: autosave berhenti saat dijeda, saat overlay terbuka, dan saat tab tersembunyi. Membuka game tanpa konfirmasi tidak pernah memicu autosave. Jika upload sebelumnya belum selesai, jadwal berikutnya dilewati (tidak ditumpuk), dan hanya satu upload berjalan dalam satu waktu. Slot Autosave terpisah dari tiga slot manual dan tidak mengubah slot manual. Setiap penulisan menggunakan kuota akun; penggantian dihitung dari selisih ukuran. Kegagalan upload autosave tidak mengubah autosave server terakhir. Interval 30 detik dapat menambah beban perangkat dan jaringan, terutama untuk state besar.

Saat autosave berjalan, notifikasi kecil **Autosave…** muncul di pojok kanan atas player. **Autosave tersimpan** baru ditampilkan setelah respons sukses API dan hilang setelah 3 detik; pesan gagal mengarahkan pengguna membuka **Save state server** dan hilang setelah 6 detik. Notifikasi tidak menangkap klik atau mem-pause permainan selama upload. Saat overlay terbuka, status ditampilkan di dalam panel, bukan lewat notifikasi player.

### Overlay dan Fullscreen

- Konten berada dalam satu dialog vertikal yang dapat digulir, dengan kartu slot manual dan Autosave terpisah. Pada HP, tombol aksi slot ditata di bawah informasi slot agar tidak melebar ke samping.
- Gunakan **×**, **Escape**, atau klik latar untuk menutup saat tidak ada operasi manual berlangsung. Tab/Shift+Tab tetap di dalam dialog; fokus dipulihkan setelah ditutup. Menutup pengelola simpanan mengembalikan pengguna ke overlay tanpa melanjutkan permainan.
- Fullscreen sesi akun memakai pembungkus player, bukan iframe saja. Overlay dan pengelola dipasang ke pembungkus yang sama melalui portal React, sehingga tetap terlihat tanpa keluar fullscreen; notifikasi autosave juga berada di dalamnya. Tombol masuk/keluar fullscreen mengikuti perubahan keadaan browser. Perilaku fullscreen tamu tetap bawaan engine.
- Menu **Save States** di dalam gerigi disembunyikan untuk **semua pengguna**, baik sebelum maupun sesudah core mulai. Ini hanya menyembunyikan entri menu, tidak mengubah nilai, default, atau mekanisme internal **System Save interval**. Tombol native Save State/Load State tamu tetap tersedia.
- Informasi tambahan tentang save browser dan memcard dapat dibuka melalui **Tentang penyimpanan progres** di bagian bawah overlay.

Penggantian slot terisi meminta konfirmasi. Unduh versi lama dari **Kelola simpanan** dahulu jika ingin mempertahankannya; M5 belum menyediakan retensi versi/backup konflik otomatis M7. Slot kosong di server tidak otomatis diisi dari save tamu.

**Penting untuk sesi akun:** save state store engine menjadi dummy/nonpersisten, dan filesystem save menggunakan MEMFS tanpa membaca/menulis IDBFS bersama. Dengan demikian save tamu tidak diimpor dan progres akun tidak bocor ke store tamu. Konsekuensinya, **save dalam game/memcard sesi akun masih sementara di memori sampai M6**. Ekspor melalui menu emulator sebelum keluar, atau simpan state ke server. Save state tetap bukan jaminan pengganti semua berkas memcard suatu core.

Tamu dan hosting statis tetap memakai perilaku browser yang sudah ada, termasuk tombol native Save State/Load State. Login pada tab lain tidak memigrasikan player tamu yang sedang berjalan; buka ulang game untuk menggunakan mode akun. Tombol pengelolaan akun dinonaktifkan selama sesi player agar logout/ganti password eksplisit dilakukan setelah menangani progres sesi tersebut.

## Kuota dan Pengelola Simpanan

| Pengaturan | Default |
| --- | --- |
| Slot | 3 slot manual per identitas game + console + core, plus 1 slot **Autosave** (slot 99) yang ditimpa otomatis saat autosave aktif |
| Satu state | 32 MiB |
| Kuota akun | 256 MiB, gabungan semua game/core/slot |
| Peringatan | Mulai penggunaan 80% |
| Cache/antrean persisten akun | Tidak ada; snapshot retry hanya di memori tab |

Pengelola tersedia dari panel player **Kelola simpanan** dan dari dialog akun **Kelola simpanan server**, termasuk tanpa game aktif. Daftar mencakup semua save state akun lintas game, dengan slot, ukuran, waktu server, revisi, engine, varian, dan fingerprint core singkat. Penghapusan selalu dipilih pengguna dan dikonfirmasi; **tidak ada penghapusan save tertua otomatis**.

Saat kuota tidak cukup:

- Save lama tetap utuh. Snapshot yang gagal diunggah tetap berada di memori tab, dengan ukuran serta sisa ruang ditampilkan.
- Pengguna dapat **Unduh cadangan state terbaru**, menghapus save pilihan melalui pengelola, kemudian **Coba simpan lagi**, atau membatalkan tanpa mengganti server.
- Penggantian slot hanya dihitung selisih ukurannya: `pemakaian - ukuran lama + ukuran baru`. Kuota dicek ulang dalam transaksi, bukan dipercaya dari angka UI. Dua koneksi tidak dapat menghabiskan ruang yang sama secara bersamaan.
- Jika slot tujuan sendiri dihapus/berubah, revisi snapshot tertunda tetap usang. Unduh cadangan, muat ulang daftar, lalu lakukan aksi simpan baru secara eksplisit; retry tidak menaikkan revisi sendiri untuk menimpa versi lain.
- Menutup tab, crash browser, atau berganti akun dapat menghilangkan snapshot yang belum tersinkron. Ini bukan antrean offline persisten.

Unduhan cadangan berupa byte `.state` mentah, bukan ROM, BIOS, atau paket backup server. Simpan juga informasi ROM/core/versi yang sesuai. Impor berkas state lewat UI akun belum termasuk M5; pertahankan berkas untuk jalur impor eksplisit berikutnya. Menu pemilihan lokasi state **download/file** tidak lagi tersedia karena grup **Save States** di gerigi disembunyikan. Tombol **Import Save File** untuk save dalam game bukan jalur impor berkas `.state`. Backup server konsisten tetap memerlukan database beserta folder data, bukan unduhan satu state saja.

### Konfigurasi Pengelola Server

| Variabel | Default | Batas konfigurasi |
| --- | --- | --- |
| `MAIN_DULU_STATE_MAX_BYTES` | `33554432` | 1 KiB–64 MiB |
| `MAIN_DULU_SAVE_QUOTA_BYTES` | `268435456` | 1 KiB–16 GiB |

Contoh PowerShell untuk kuota 512 MiB:

```powershell
$env:MAIN_DULU_SAVE_QUOTA_BYTES = '536870912'
npm start
```

Konfigurasi dimuat saat startup; hentikan dan jalankan ulang server. Menurunkan kuota tidak menghapus save yang sudah ada, tetapi upload berikutnya harus memenuhi batas baru. Batas player absolut 64 MiB. Kuota menghitung byte save aktif, bukan metadata atau ruang sementara filesystem; disk harus memiliki ruang tambahan untuk versi lama + berkas baru saat transaksi. Maksimal 5.000 identitas slot termasuk tombstone per akun membatasi pertumbuhan metadata; batas ini bukan kuota byte dan memerlukan bantuan pengelola bila tercapai.

## Kompatibilitas dan Bridge Player

Metadata state mencatat `formatVersion: 1`, EmulatorJS `engineVersion`, SHA-256 build core `.data`, fingerprint runtime JavaScript, serta varian `normal`/`legacy`. `public/player/builds.json` dihasilkan oleh `scripts/vendor-engine.mjs`; fingerprint runtime memakai kode bundle tanpa header lisensi dengan newline kanonis LF. Perbedaan engine/core/runtime/varian meminta konfirmasi sebelum muat, bukan otomatis dianggap kompatibel. Versi format aplikasi yang belum dikenali ditolak sebagai kontrak tidak valid, bukan dipaksakan ke core.

Bridge menyediakan `export-state` dan `import-state`, masing-masing dengan request ID acak. Host dan iframe memeriksa origin, source-window, channel, serta session ID; respons harus sesuai request ID dan jenis operasi. Byte dan ukuran divalidasi. Tidak ada password, cookie, token CSRF, atau identitas akun dalam konfigurasi iframe; HTTP autentikasi hanya dilakukan host React.

Pesan `pause-session`/`resume-session` mempertahankan keadaan jeda sebelum overlay dibuka; `session-running` menjadi salah satu syarat autosave. Untuk sesi akun, iframe mengirim `fullscreen-request` ke host dan menerima `fullscreen-state` untuk menyelaraskan tombol engine. Pemeriksaan origin, source, channel, dan session ID tetap berlaku. Pengalihan fullscreen dan penyembunyian menu gerigi dilakukan di bridge `public/player/player.js`, bukan melalui perubahan bundle vendor baru.

Engine 4.2.3 tidak menyediakan konfirmasi deserialisasi yang dapat diandalkan dari `loadState()`. Karena itu UI menyatakan **Perintah muat dikirim ke core. Periksa progres permainan**, bukan mengklaim progres berhasil hanya dari berkas yang ditulis. Tes NES membaca posisi karakter dalam RAM core setelah muat untuk membuktikan progres benar-benar dipulihkan.

Patch engine dibuat melalui vendoring yang memverifikasi arsip upstream terpin SHA-256; bundle tidak diedit manual. Untuk M5, dua patch tambahan dipakai: `togglePlaying` melaporkan transisi play/pause ke bridge (`EJS_onPlayPause`, dipakai untuk jeda overlay dan gating autosave), dan `buildButtonOptions` menerima tombol bar kustom yang lengkap terdefinisi (displayName + icon + callback) — upstream 4.2.3 menolak key di luar daftar tombol default sebelum validasi tombol kustomnya berjalan. Sumber asli tetap di `third_party/emulatorjs/4.2.3/upstream-src/`, sumber hasil patch di runtime publik. Guest IDBFS dan store state tetap dipertahankan; pengujian menanam save tamu lalu memverifikasi save itu tetap dapat dipulihkan setelah bermain sebagai akun.

## Kontrak API

Semua endpoint `/api/saves` memerlukan sesi login. Header `X-Save-User` merupakan **assertion konsistensi akun yang meluncurkan player**, bukan pemilih pemilik: server menentukan pemilik dari sesi SQLite dan menolak bila assertion berbeda. Ini mencegah cookie yang berubah antar-tab mengarahkan snapshot lama ke akun baru.

| Endpoint | Kontrak |
| --- | --- |
| `GET /api/saves/` | `{ saves, usage }` seluruh slot akun, termasuk tombstone, tanpa byte state |
| `GET /api/saves/:id` | Byte `application/octet-stream`, dengan `X-Save-Metadata` berisi JSON metadata yang di-URI-encode |
| `PUT /api/saves/` | Byte `application/octet-stream`; `X-Save-Metadata` URI-encoded JSON berisi `gameId`, `consoleId`, `core`, `slot`, `title`, `expectedRevision`, `checksum`, `metadata`; respons `{ save, usage }` |
| `POST /api/saves/:id/delete` | JSON `{ expectedRevision }`; respons `{ ok, usage }` |

PUT/POST menggunakan CSRF serta pemeriksaan origin/Fetch Metadata M3. Host meminta CSRF dan memeriksa kembali identitas akun sebelum mutasi. Semua respons memakai no-store. Tidak ada CORS lintas origin. ID save berupa UUID server; path blob dibangkitkan server dan tidak pernah berasal dari game ID/judul/path klien.

Validasi mencakup pasangan console/core, ID game bounded ASCII, identitas ROM lokal `local-<console>-<sha256>`, slot 1–3 atau slot khusus 99 (Autosave), metadata bounded, ukuran, SHA-256 seluruh payload, dan header state RetroArch `RASTATE`. State merupakan data core opaque: pemeriksaan ini bukan parser menyeluruh format setiap core atau jaminan deserialisasi. API tidak menerima endpoint upload ROM/BIOS.

Error terstruktur antara lain `QUOTA_EXCEEDED`, `REVISION_CONFLICT`, `ACCOUNT_CHANGED`, `SAVE_NOT_FOUND`, `SAVE_DAMAGED`, dan `INVALID_SAVE`. Batas ukuran memakai 413; konflik/kuota memakai 409. Maksimal dua upload diproses per proses; limiter akun 120 request save/menit dan 30 upload/menit, termasuk percobaan gagal. Pembatasan ini tidak terdistribusi dan mengikuti batas single-server lokal proyek.

## Penyimpanan dan Konsistensi

Migrasi SQLite **versi 3** menambahkan tabel `saves`; **versi 4** me-rebuild tabel yang sama agar slot khusus 99 (Autosave) diizinkan di CHECK constraint, tanpa mengganti ID akun/sesi yang sudah ada dan dengan memindahkan data save lama apa adanya. Aplikasi M3/M4 lama akan menolak versi database ini; buat backup konsisten sebelum memperbarui, jangan menurunkan versi/hapus database untuk memaksa aplikasi lama berjalan.

Byte disimpan pada `<dataDir>/saves/<uuid>.bin`, di luar aset publik/build. Setiap upload memakai berkas baru yang immutable: tulis `.tmp`, flush/fsync, rename menjadi `.bin`, lalu commit metadata dalam transaksi `BEGIN IMMEDIATE` dengan pemeriksaan sesi, revisi, dan kuota. Versi lama baru dibersihkan sesudah commit. Kegagalan metadata membersihkan berkas baru dan mempertahankan referensi lama.

Penghapusan menyimpan **tombstone** dan menaikkan revisi, sehingga retry lama tidak dapat membuat ulang slot yang sudah dihapus (masalah ABA). Byte tombstone nol dan tidak memakai kuota. Tidak ada penggabungan state biner otomatis.

Saat startup, pembersihan orphan `.tmp/.bin` dilakukan dengan write lock SQLite yang sama, hanya pada folder save aplikasi dan hanya untuk nama yang dibangkitkan aplikasi. Berkas yang masih direferensikan tidak dihapus. Ini menangani sisa crash antara tahap filesystem dan commit metadata tanpa sweep tak terkoordinasi. GET memeriksa ukuran/checksum; berkas hilang/rusak menghasilkan error, bukan dianggap slot kosong.

SQLite memakai WAL dan `synchronous=FULL`; direktori di-fsync setelah rename pada platform yang mendukungnya. Pengujian meliputi rollback yang diinjeksi dan orphan simulasi, bukan pemadaman listrik nyata. Folder data/volume bukan pengganti backup. Prosedur backup/restore terkoordinasi dan uji pemulihannya tetap M8.

## Kegagalan Sesi dan Jaringan

- Daftar awal gagal: simpan/muat dinonaktifkan sampai daftar berhasil dimuat. Tidak ada upload state kosong sebagai pengganti save server yang gagal dibaca.
- Upload gagal: snapshot dipertahankan dalam memori, tersedia ekspor dan retry eksplisit dengan revisi asal; tidak ada retry otomatis lintas akun.
- Respons upload hilang setelah commit: hasil belum pasti; retry dapat menghasilkan konflik. Muat ulang daftar dan unduh cadangan sebelum memilih penggantian baru. Status keberhasilan tidak ditebak.
- Backend/sesi belum dapat dipastikan: sinkronisasi ditahan; player akun tidak berubah menjadi player tamu.
- Sesi dicabut/logout terdeteksi: iframe dibersihkan dan player tidak dapat digunakan ulang tanpa membuka sesi baru. Snapshot tertunda yang sudah berada di host masih dapat diunduh selama belum berganti akun.
- Akun lain terdeteksi: iframe, antrean/koneksi, dan snapshot akun sebelumnya dibersihkan; snapshot itu tidak ditampilkan/diunggah sebagai data akun baru. Cadangkan **sebelum** mengganti akun di tab lain.
- Perubahan sesi dari tab/perangkat lain terdeteksi lewat pemeriksaan M3 saat fokus/periodik 60 detik. Server menolak sesi dicabut pada setiap request; keterlambatan label UI bukan izin menulis server.
- Navigasi keluar saat operasi berlangsung ditahan. Bila ada snapshot tertunda, konfirmasi menjelaskan risiko kehilangan dan menawarkan kesempatan kembali mengunduh cadangan. Penutupan tab tidak dijadikan jalur upload.

## Pengujian dan Hasil

```sh
npm test
npm run build
npm run test:e2e
npm run test:e2e:production
npm run test:e2e:backend
```

`tests/saves.test.mjs` memeriksa persistensi file/metadata, isolasi dua akun, CSRF/origin, ID/path/slot/payload invalid, checksum, batas ukuran/kuota dan selisih penggantian, tombstone, dua koneksi berebut revisi/kuota, rollback/orphan/rusak, serta kepemilikan byte state sesudah ganti password, pemulihan kode, dan reset admin. `tests/domain.test.mjs` memeriksa patch storage dan fingerprint aset yang benar-benar dipaketkan.

Delapan tes `tests/browser/server-saves.spec.ts` memakai engine nyata: tata letak overlay vertikal tanpa overflow pada ukuran 1280×900, 390×844, 320×568, dan 844×390 beserta navigasi keyboard/pause; pemulihan posisi NES setelah server dibuat ulang/database dibuka ulang dan browser context baru; penolakan versi berbeda tanpa konfirmasi; kuota/hapus/cadangan/retry mobile; initial fetch dan upload gagal; konflik dua tab; pencabutan sesi/pergantian akun; save tamu tetap utuh setelah sesi akun; serta autosave slot 99 (menulis hanya slot Autosave saat game berjalan, berhenti saat overlay terbuka, dan selalu menimpa slot yang sama). Pengelompokan skenario tersebut berada di delapan tes, bukan satu tes per subkasus. Tes restart engine-server ini memakai server in-process yang ditutup/dibuka ulang; suite CLI M2 tetap menguji restart proses server secara terpisah.

### Hasil Verifikasi

Lingkungan: Windows, Node.js 26.12.1 dan Microsoft Edge headless. Suite autentikasi/admin/save/server juga dijalankan pada Node.js 24.22.1.

| Pemeriksaan | Hasil |
| --- | --- |
| `npm test` | 75 lulus; diperiksa ulang pada perubahan akhir M5 |
| `npm run build` | Lulus; diperiksa ulang pada perubahan akhir M5 |
| `node --check public/player/player.js` | Lulus pada bridge akhir M5 |
| `npm run test:e2e` | 22 lulus; 13 tes akun/server save dilewati pada development statis |
| `npm run test:e2e:production` | 22 lulus; 13 tes akun/server save dilewati pada preview statis |
| `npm run test:e2e:backend` | 32 lulus, termasuk delapan tes M5; dijalankan setelah perbaikan tata letak, sebelum perubahan notifikasi/fullscreen/menu gerigi terakhir |
| Tes manual perubahan UI terakhir | Pengguna mengonfirmasi berhasil: overlay/fullscreen, notifikasi autosave, dan penyembunyian menu Save States |
| Autentikasi/admin/save/server pada Node.js 24.22.1 | 48 lulus |
| TypeScript ketat tes akun/M5 dan konfigurasi backend | Lulus |
| `npm audit --omit=dev` | Tidak ada kerentanan yang dilaporkan |
| Vendoring ulang dari arsip terpin | Enam output bundle/sumber/loader/fingerprint/provenance identik byte demi byte |

Angka development/production statis di atas berasal dari verifikasi awal M5 sebelum penambahan tes tata letak overlay. Regresi browser penuh belum dijalankan ulang setelah perubahan notifikasi/fullscreen/menu gerigi terakhir; perubahan terakhir diperiksa melalui build, pemeriksaan sintaks bridge, dan tes manual pengguna. Tes manual ini tidak memperluas klaim dukungan core atau perangkat tertentu.

Suite M5 mengisolasi data dan limiter per skenario melalui server lokal fixture, bukan melonggarkan kebijakan pendaftaran produksi. Pada percobaan regresi awal, gabungan percobaan pendaftaran M3/M4/M5 mencapai limit IP dan suite terhenti; setelah fixture dipisah, regresi backend penuh lulus. Helper pembuka overlay juga diperbaiki untuk memfokuskan tab yang tepat dan menggerakkan pointer ke bawah, sesuai perilaku auto-hide menu engine. Tes terarah awal diperbaiki untuk nilai kosong dummy store (`undefined`) serta selector katalog/riwayat yang ganda. Pemeriksaan varian tambahan mengoreksi asumsi normal menjadi **legacy** berdasarkan metadata filename core yang benar-benar dipilih loader; tes, UI, dan klaim dukungan disesuaikan. Hasil di tabel adalah eksekusi yang lulus, bukan hitungan percobaan gagal.

PS1/core lain, varian normal, reverse proxy HTTPS nyata, serta crash listrik belum dibuktikan pada integrasi server M5. Label varian ditentukan dari filename core yang benar-benar dipilih loader dan direkam pada metadata, bukan dari tersedianya WebGL2 di browser. Bukti manual PS1 M1 tidak dipromosikan menjadi bukti cloud save. Tidak ada ROM komersial atau BIOS yang ditambahkan ke commit atau katalog untuk pengujian ini. M6 melanjutkan sinkronisasi save game/memcard; M7 menangani UI penyelesaian konflik dan impor browser; M8 backup/restore.
