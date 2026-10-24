# M1 — Pembuktian Integrasi Save EmulatorJS

Status: M1 selesai. NES lulus tes otomatis; memcard dan save state PS1 lulus verifikasi manual lintas sesi/browser berdasarkan konfirmasi pengguna.

Dokumen ini melengkapi [rencana login dan penyimpanan server](rencana-login-cloud-save.md#milestone-implementasi). M1 tidak menambahkan backend, akun, tombol cloud save, atau protokol save produksi. Hasilnya berupa tes engine nyata, fixture asli, dan kontrak teknis untuk milestone berikutnya.

## Implementasi Pembuktian

| Berkas | Peran |
| --- | --- |
| `tests/browser/save-proof.spec.ts` | Pembuktian lintas sesi, pemulihan SRAM sebelum boot, serta impor pada core yang berjalan |
| `tests/browser/helpers/player.ts` | Helper launch/start player yang juga digunakan tes aplikasi lama |
| `tests/fixtures/nes-battery.mjs` | Generator ROM NES battery-save asli, hanya dibuat di memori untuk tes |
| `tests/fixtures/README.md` | Lisensi dan pemetaan memori fixture |
| `tests/nes-battery.test.mjs` | Validasi determinisme, header, battery flag, dan vektor program |

Tidak ada perubahan pada bundle vendor, bridge produksi, atau ROM demo Jalan Pulang.

## Skenario yang Dibuktikan

### 1. Save State NES Lintas Sesi

1. Jalankan Jalan Pulang melalui antarmuka aplikasi dan engine `fceumm` yang dipaketkan.
2. Gerakkan karakter ke kanan lalu ekspor snapshot dengan `getState()`.
3. Tutup browser context pertama; bawa hanya byte snapshot melalui proses tes.
4. Buka browser context baru tanpa mewarisi IndexedDB/localStorage dari context pertama.
5. Jalankan game yang sama, pastikan posisi awal berbeda, lalu muat snapshot.
6. Serialisasikan kembali keadaan core dan periksa posisi karakter serta sprite dalam CPU RAM.

Pemeriksaan tidak berhenti pada ukuran atau keberadaan `/game.state`: posisi permainan harus benar-benar pulih. Pembacaan tag RAM dalam tes khusus untuk format core yang dipaketkan dan fixture ini, bukan parser save state produksi. Seluruh snapshot tidak dibandingkan byte demi byte karena timer dan keadaan berjalan dapat berubah setelah resume.

### 2. Save Game NES Sebelum Boot

1. Bangun fixture NROM-128 dengan battery RAM tanpa memakai ROM pihak ketiga.
2. Jalankan di emulator; tombol A membuat CPU menulis progres dari 0 menjadi 1 pada `$6002`.
3. Ekspor save melalui API core: menghasilkan SRAM 8 KiB dengan penanda `MD` dan progres 1.
4. Tutup context pertama dan buka context terisolasi yang baru.
5. Pasang byte save setelah filesystem save selesai dimuat, sebelum program game mulai.
6. Pastikan progres 1 tersedia lalu tekan A dan buktikan CPU melanjutkan ke progres 2.

Langkah terakhir membuktikan core mengonsumsi data yang diimpor, bukan sekadar berkas virtual yang berisi byte benar.

### 3. Event Ekspor dan Impor Saat Core Berjalan

- `getSaveFile()` menghasilkan data yang sama dengan payload event `saveSaveFiles` pada flush tersebut.
- Setelah progres dinaikkan ke 2, tulis kembali save progres 1 ke lokasi save aktif dan panggil `loadSaveFiles()`.
- Flush berikutnya tetap menghasilkan progres 1; tombol A dapat melanjutkannya ke 2.
- Tanpa pemuatan kembali ke core, flush akan menimpa berkas dengan progres 2 yang masih berada dalam memori emulasi.

### 4. Memcard dan Save State PS1 — Verifikasi Manual

Pengguna menyediakan aset lokal untuk pengujian:

- Game: `public/games/Suikoden (Asia).chd`.
- BIOS: `public/bios/scph5501.bin`.

Pengguna mengonfirmasi bahwa memcard dan save state PS1 berfungsi normal, termasuk ekspor lalu impor ke sesi/browser baru. Hasil ini diterima sebagai verifikasi manual untuk menutup pembuktian PS1 pada M1, bukan sebagai hasil tes otomatis atau pengujian save server.

Pemeriksaan runtime oleh agen juga berhasil menjalankan game dengan core `pcsx_rearmed` dan mendapati API save aktif menghasilkan berkas 131.072 byte (128 KiB). Pemeriksaan runtime tersebut sendiri tidak membuktikan isi progres; keberhasilan pemulihan progres lintas sesi mengacu pada laporan manual pengguna.

Tidak ada skrip tes otomatis PS1 yang ditambahkan. Detail navigasi save dalam game, validasi seluruh slot/card, dan pemulihan lewat startup barrier produksi belum diotomatisasi. Integrasi cloud save PS1 tetap harus diuji kembali di M5/M6, terutama isolasi akun serta pemulihan sebelum game mengakses memcard.

BIOS/CHD hanya dipakai sebagai aset lokal pengguna, tidak ditambahkan ke katalog atau commit. Berkas di `public/` tetap dapat diunduh saat server berjalan dan ikut tersalin saat build; aturan `.gitignore` tidak mencegah distribusi melalui web atau hasil build.

## Kontrak API Engine yang Ditemukan

Objek engine tersedia sebagai `window.EJS_emulator`; operasi save berada pada `gameManager`.

| API / event | Perilaku dan batasan |
| --- | --- |
| `gameManager.supportsStates()` | Memeriksa dukungan state core, bukan jaminan kompatibilitas lintas versi/game |
| `gameManager.getState()` | Menghasilkan salinan `Uint8Array` snapshot; dapat melempar error jika serialisasi gagal |
| `gameManager.loadState(bytes)` | Menulis berkas state sementara dan meminta core memuatnya; wrapper tidak mengembalikan konfirmasi keberhasilan deserialisasi |
| `gameManager.getSaveFile()` | Flush save dari core lalu membaca berkas aktif; dapat menghasilkan `null` jika berkas tidak tersedia |
| `gameManager.getSaveFile(false)` | Membaca berkas tanpa flush tambahan; bukan jaminan mewakili perubahan terbaru dalam RAM core |
| `gameManager.getSaveFilePath()` | Lokasi save aktif yang ditentukan runtime/core setelah game dimulai |
| `gameManager.writeFile(path, bytes)` | Membuat direktori yang diperlukan lalu menulis byte ke filesystem virtual |
| `gameManager.loadSaveFiles()` | Meminta core membaca ulang save; menulis berkas saja tidak cukup |
| `emulator.on('saveDatabaseLoaded', callback)` | Dipanggil setelah `mountFileSystems()` selesai dan sebelum ROM/BIOS diunduh serta `callMain()` menjalankan game |
| `emulator.on('saveSaveFiles', callback)` | Dipanggil setelah flush save; event dapat terjadi walaupun isi save tidak berubah |

Rujukan sumber:

- `third_party/emulatorjs/4.2.3/upstream-src/GameManager.js`: `mountFileSystems`, `getState`, `loadState`, `getSaveFile`, `saveSaveFiles`, dan `loadSaveFiles`.
- `third_party/emulatorjs/4.2.3/upstream-src/emulator.js`: `on`, `callEvent`, `downloadFiles`, `startGame`, dan opsi `save-save-interval`.
- `public/vendor/emulatorjs/4.2.3/data/loader.js`: pemetaan global `EJS_*` ke konfigurasi dan event engine.

### Urutan Pemulihan Sebelum Boot

```text
Engine ready, tombol mulai tersedia
→ daftarkan listener saveDatabaseLoaded
→ pengguna menekan Mulai bermain
→ filesystem save di-mount dan data browser dimuat
→ saveDatabaseLoaded: tulis byte save yang sudah tersedia di memori
→ unduh ROM/BIOS
→ callMain: core dan game membaca save
→ event start
```

Listener `saveDatabaseLoaded` dipanggil sinkron dan tidak di-await oleh engine. Milestone integrasi server harus mengambil data sebelum fase ini atau menyediakan startup barrier yang benar. Jangan menjalankan fetch asinkron dalam listener lalu berasumsi game akan menunggu. Loader juga tidak menyediakan global `EJS_onSaveDatabaseLoaded`; listener dipasang pada objek emulator sebelum start.

### Lokasi Berkas Tidak Boleh Ditebak

Pada fixture `fceumm`, lokasi save yang terbukti adalah:

```text
/data/saves/FCEUmm/<EJS_gameName>.srm
```

Menulis ke `/data/saves/<EJS_gameName>.srm` tidak memulihkan SRAM karena kehilangan subfolder core. Tes membawa lokasi hasil ekspor yang sama ke sesi baru; itu hanya mekanisme pembuktian, bukan izin menerima path arbitrer dari klien pada API server.

Pada pemeriksaan runtime PS1 dengan CHD dari URL server, lokasi yang teramati adalah:

```text
/data/saves/PCSX-ReARMed/Suikoden%20(Asia).srm
```

Ini menggunakan nama CHD dari URL, bukan `EJS_gameName` (`pcsx_rearmed-ps1-save-proof` pada sesi pemeriksaan). Dengan demikian, jangan menganggap namespace save state dan nama berkas memcard selalu identik. Identitas logis save server tetap menggunakan ID game/core yang stabil; pemetaan ke path runtime harus divalidasi terpisah. Lokasi ini adalah hasil observasi satu konfigurasi, bukan jaminan layout untuk seluruh game PS1 atau ROM lokal.

Implementasi produksi perlu pemetaan layout yang divalidasi untuk setiap core, identitas game yang stabil, dan penolakan traversal path. `getSaveFilePath()` setelah start tidak boleh diasumsikan sudah valid pada fase sebelum boot. Satu jalur API save aktif juga belum membuktikan cakupan seluruh berkas tambahan atau slot memcard suatu core.

### Deteksi Perubahan dan Metadata

- Gunakan flush periodik atau event `saveSaveFiles` untuk memperoleh snapshot save terbaru, lalu checksum untuk membedakan perubahan isi.
- Event flush bukan event perubahan progres. Hindari upload saat checksum sama; batasi frekuensi, urutkan permintaan, dan periksa revisi server.
- Hindari memanggil `getSaveFile()` kembali dari listener `saveSaveFiles`: pemanggilan itu memicu flush dan event yang sama secara rekursif. Gunakan payload event atau pembacaan tanpa flush jika diperlukan.
- Metadata produksi minimal: versi format aplikasi, ID game stabil, console/core ID, EmulatorJS `4.2.3`, identitas build core yang dipaketkan, jenis save, slot jika berlaku, ukuran, checksum, dan revisi server.
- Snapshot di tes berupa byte mentah; format envelope dan protokol host/iframe produksi masih menjadi pekerjaan M5.

## Temuan Penyimpanan Browser yang Wajib Ditangani

`EJS_disableDatabases = true` tidak mematikan seluruh penyimpanan progres browser:

1. `emulator.js` menonaktifkan cache ROM/BIOS/core, tetapi tetap membuat store save state browser.
2. `GameManager.mountFileSystems()` tetap memasang IDBFS pada `/data/saves` dengan `autoPersist: true`, lalu memuat data browser melalui `syncfs(true, ...)`.

Konsekuensi untuk M5/M6:

- Pengguna login memerlukan mode save server yang menghindari pemuatan otomatis save tamu/akun lain dari IDBFS dan penulisan progres akun ke store browser bersama.
- Jangan hanya mengganti tombol save state lalu menganggap memcard sudah server-only.
- Pilihan yang perlu dibuktikan saat integrasi: mode filesystem memori untuk pengguna login, dengan mode IDBFS tamu tetap dipertahankan.
- Jika membutuhkan patch engine, tambahkan melalui sumber dan `scripts/vendor-engine.mjs`, beserta tes isolasi akun/tamu; jangan mengedit bundle vendor secara manual.
- Tidak ada perubahan mode storage produksi di M1. Pengujian context terisolasi membuktikan impor tanpa bergantung pada save browser sebelumnya, bukan membuktikan browser persistence sudah dinonaktifkan.

## Matriks Dukungan yang Terverifikasi

| Console / core | Save state lintas sesi | Save game/memcard lintas sesi | Pemulihan sebelum boot lewat API | Impor lewat API core berjalan | Bukti |
| --- | --- | --- | --- | --- | --- |
| NES / `fceumm` | Lulus | Lulus | Lulus | Lulus | Tes otomatis, Jalan Pulang dan fixture SRAM asli |
| SNES / `snes9x` | Belum diuji | Belum diuji | Belum diuji | Belum diuji | Tidak diklaim mendukung cloud save |
| GB/GBC / `gambatte` | Belum diuji | Belum diuji | Belum diuji | Belum diuji | Tidak diklaim mendukung cloud save |
| GBA / `mgba` | Belum diuji | Belum diuji | Belum diuji | Belum diuji | Tidak diklaim mendukung cloud save |
| Mega Drive / `genesis_plus_gx` | Belum diuji | Belum diuji | Belum diuji | Belum diuji | Tidak diklaim mendukung cloud save |
| PS1 / `pcsx_rearmed` | Lulus manual | Lulus manual | Belum diuji terpisah | Belum diuji terpisah | Konfirmasi pengguna: ekspor/impor lintas sesi/browser |

Tes otomatis memakai engine EmulatorJS `4.2.3`, core normal non-threaded yang dipilih loader, dan Microsoft Edge headless. Hasil PS1 berasal dari verifikasi manual pengguna, bukan suite otomatis Edge tersebut. Ini bukan klaim kompatibilitas semua game NES/PS1, core legacy, atau versi engine lain. Keberadaan aset core dan report pada unit test lama tidak membuktikan fitur save core tersebut. Lulus M1 juga belum berarti fitur cloud save sudah diimplementasikan.

## Pengujian dan Cara Mengulang

```sh
npm test
npm run build
npm run test:e2e -- tests/browser/save-proof.spec.ts
npm run test:e2e
npm run test:e2e:production -- tests/browser/save-proof.spec.ts
```

Hasil verifikasi pada pengerjaan M1:

- Unit test: 22 lulus, termasuk validasi fixture baru.
- Build aplikasi: lulus.
- Tes pembuktian M1: 3 lulus.
- Seluruh tes browser development: 17 lulus, termasuk regresi mode tamu dan HTTP LAN.
- Tes pembuktian M1 terhadap build production: 3 lulus.
- Pengulangan tes M1 dua kali pada development: 6 eksekusi lulus.
- Pemeriksaan TypeScript ketat secara terpisah untuk tes player yang diubah: lulus. Tes browser tidak termasuk cakupan `tsconfig.app.json`.
- PS1: memcard dan save state, termasuk ekspor/impor lintas sesi/browser, lulus manual berdasarkan konfirmasi pengguna. Hasil ini tidak menambah jumlah tes otomatis di atas.

Playwright menggunakan Microsoft Edge terpasang sesuai konfigurasi proyek. Tes menghasilkan trace/screenshot di direktori output yang diabaikan Git. Generator fixture tidak menulis ROM ke `public/` dan tidak mengubah demo yang didistribusikan.

## Penutupan M1 dan Tindak Lanjut

Blocker ketersediaan aset lokal dan verifikasi pemulihan PS1 telah ditutup: aset disediakan pengguna, runtime berhasil dijalankan, dan pengguna mengonfirmasi ekspor/impor memcard serta state lintas sesi/browser berhasil.

M1 selesai dengan bukti otomatis NES dan manual PS1. Milestone berikutnya adalah M2: fondasi backend lokal tanpa Docker. Pengujian otomatis PS1 dan integrasi server bukan bagian yang sudah selesai; pemetaan runtime, startup barrier, isolasi storage, serta cakupan slot/card perlu diverifikasi dalam integrasi M5/M6. Jangan memasukkan ROM komersial atau firmware proprietari ke repository maupun distribusi aplikasi sebagai bagian dari pekerjaan tersebut.
