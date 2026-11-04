# Milestone 6 — Keamanan dan regresi Admin/Library/BIOS

Bagian dari [rencana Admin/Library/BIOS](rencana-admin-library-game.md), bukan Milestone 6 sinkronisasi progres pada rencana akun/save yang lebih lama.

**Status: ditutup pada 2026-11-04 dalam cakupan otomatis dan batas lingkungan di bawah. Verifikasi deploy Milestone 7 tetap terbuka.**

**Catatan revisi cache setelah gerbang ini:** sebutan `no-store` untuk seluruh aset pada matriks/hasil historis di bawah mencatat kondisi saat M6 ditutup. ROM/BIOS upload sukses kini memakai `private, no-cache` + ETag dan conditional GET/HEAD 304; cover, redirect, API, dan error tetap `no-store`. Validasi aset tetap mendahului 304. Bukti terbaru (234 tes unit/integrasi, build, 75 browser backend, termasuk restart browser persisten) dan batasnya ada pada [implementasi cache ROM/BIOS](rencana-cache-rom-bios.md#hasil-implementasi-dan-verifikasi); angka gerbang M6 tidak diganti dengan hasil pengujian fitur berikutnya.

## Cakupan dan bukti

Gerbang ini mencocokkan pengujian yang sudah ditambahkan pada Milestone 1–5 dengan checklist keamanan/regresi, lalu melengkapi celahnya. Pengujian menggunakan database/direktori data sementara; tidak menghapus koleksi pengguna. Tidak mengganti bundle engine, format save, skema SQLite, atau identitas game lama.

| Checklist | Bukti otomatis yang dapat ditelusuri |
| --- | --- |
| Migrasi, role, bypass payload, pencabutan role, CSRF | `tests/admin-roles.test.mjs`: migrasi skema 6, kredensial/sesi/state/progres lama, role dari database pada sesi aktif/lintas koneksi, payload registrasi/login/pemulihan, CLI dan data lock. `tests/catalog.test.mjs`: migrasi skema 7/rollback. `tests/catalog-api.test.mjs`: migrasi skema 8, matriks POST/PATCH/DELETE game/BIOS (termasuk PATCH cover multipart) untuk tamu, user, CSRF kosong/salah, origin asing, dan cross-site; tidak ada staging/reservasi atau perubahan record. Role/logout/sesi kedaluwarsa saat finalisasi tidak dapat commit. |
| Hash, duplikat konkuren, metadata/pagination | `tests/catalog.test.mjs`: SHA-256 byte stream, duplikat terpisah per console/kind, dua koneksi dan dua proses, restore ID eksplisit, field immutable dan batas SQL. `tests/catalog-api.test.mjs`: checksum independen hasil upload, duplikat game/BIOS konkuren, pencarian literal/sort/pagination, field/berkas berulang/asing, nama firmware, cover raster rusak/SVG/HTML/animasi/dimensi. `tests/catalog-client.test.mjs` dan `tests/admin-catalog-client.test.mjs`: kontrak frontend, pagination dan validasi respons. |
| Traversal, symlink, kuota dan kegagalan upload | `tests/catalog.test.mjs`: traversal, hardlink, substitusi direktori symlink/junction dan recovery; proses anak benar-benar dihentikan pada fase staging/final/committed. `tests/catalog-api.test.mjs`: substitusi direktori ROM/BIOS/cover ke berkas privat ditolak pada GET/HEAD, batas multipart/ukuran/kuota/reservasi, kegagalan disk/rename/database, ENOSPC sesudah penulisan parsial staging, upload HTTP benar-benar diputus dan timeout. Cleanup/retry tidak menghapus aset aktif/save/staging upload lain. |
| Aset publik terkontrol | `tests/catalog-api.test.mjs`: byte utuh, GET/HEAD/suffix/open/single/invalid range dan Content-Range pada ROM, BIOS, serta cover; `no-store`; nama firmware URL salah/encoded traversal; berkas hilang/hardlink; database/save/staging tidak dapat diunduh. Delete di antara open dan stream juga menolak GET/HEAD dan menutup file handle. `tests/server.test.mjs`: pembatasan static server, dotfile dan traversal. |
| Alur lengkap game | `tests/browser/library.spec.ts`, tes `complete admin login/upload …`: login admin UI → upload homebrew battery asli → tamu menemukan/main dari Library → akun **user biasa** main dan menyimpan SRAM hasil CPU serta state → admin edit metadata lewat UI → sesi player baru memulihkan progres/state → admin delete lewat UI → URL GET/HEAD lama ditolak dan identitas record save/progres tetap. Tes terpisah membuktikan restart server dan browser akun baru tidak mengganti ID/save. |
| Alur lengkap BIOS | `tests/browser/library.spec.ts`: upload BIOS lewat UI → pilihan server eksplisit → engine nyata menerima nama firmware untuk ROM server **dan lokal** → delete UI → URL lama ditolak dan pilihan baru tidak lagi memuat firmware, tanpa menghentikan engine yang sudah mengunduh byte. Termasuk 101 pilihan BIOS NES, isolasi dari BIOS GBA, tidak auto-select, BIOS wajib FDS, serta guard agar host tidak membaca/hash ulang byte server. `tests/browser/catalog-api.spec.ts`: delete sebelum launch dan race delete setelah metadata sebelum HEAD player. |
| Duplikat/pemulihan BIOS dan batas | `tests/browser/admin-catalog.spec.ts`: duplikat game maupun BIOS ditampilkan jelas; delete lalu upload ulang dengan konfirmasi memulihkan ID/hash dan nama tampilan lama. Tombstone memakai basename upload ulang dan URL basename lama ditolak; ini berbeda dari pemulihan entri aktif yang berkasnya hilang sesudah restore metadata, yang mempertahankan nama firmware lama (`tests/browser/library.spec.ts` dan `tests/catalog-backup.test.mjs`). `tests/catalog-api.test.mjs`: **tepat 32 MiB diterima** dengan checksum independen, **32 MiB + 1 ditolak**, tidak memublikasikan byte terpotong. |
| Mobile/keyboard/admin UI | `tests/browser/admin-catalog.spec.ts`: pencarian/filter/pagination/deep link, viewport 390×844 tanpa overflow, Tab/Shift+Tab/Escape/pemulihan fokus, guest/user ditolak dan UI tersembunyi selama pemeriksaan sesi. `tests/browser/library.spec.ts`: query URL, tombol kembali dan fokus mobile. Pengujian role dicabut sebelum upload tidak mengirim multipart; pencabutan di server saat finalisasi menghilangkan UI admin. |
| Regresi akun/save/lokal/statis | `tests/browser/account.spec.ts`, `server-saves.spec.ts`, `server-game-saves.spec.ts`: akun/pemulihan, isolasi tamu/akun, state/progres/konflik/impor/backup. `app.spec.ts`, `save-proof.spec.ts`, `http-lan.spec.ts`, `backend.spec.ts`, dan dua tes portabel Library: ROM/BIOS lokal, save browser, engine tanpa CDN, fallback hash HTTP LAN nyata, discovery statis tanpa API/admin, serta error/retry backend. |

## Fixture dan batas klaim

- `public/games/jalan-pulang.nes` adalah homebrew asli proyek, CC0; sumber/prosedur pembuatannya ada di `scripts/build-demo.mjs` dan lisensinya di `public/games/LICENSE.txt`.
- `tests/fixtures/nes-battery.mjs` menghasilkan homebrew NES CC0 di memori. CPU emulasi menulis penanda `MD` dan byte progres SRAM setelah input A. Pengujian memulihkan progres melalui boot dan state nyata, bukan sekadar menyuntikkan byte ke filesystem virtual.
- Firmware nol/byte sintetis hanya menguji upload, checksum, pilihan console, nama file, unduh, dan penerusan ke filesystem engine. **Bukan bukti boot BIOS proprietary, FDS nyata, atau kompatibilitas semua firmware/core.** Tidak ada firmware pihak ketiga baru dalam repository/fixture.
- Bukti gameplay/state/SRAM otomatis di sini terbatas pada NES `fceumm` dan fixture yang disebutkan. Bukti PS1 manual pada milestone akun/save lama tetap terpisah; tidak dijalankan ulang dan tidak diubah menjadi bukti otomatis katalog ini.
- Disk penuh diuji dengan kuota/reserve disk serta injeksi ENOSPC sebelum/sesudah penulisan parsial, bukan memenuhi disk fisik. Crash memakai terminasi proses anak nyata; upload putus memakai koneksi HTTP nyata. Symlink direktori di Windows diuji sebagai junction.
- Upload batas BIOS 32 MiB dijalankan penuh. Batas ROM 768 MiB diuji melalui validasi/Content-Length; upload ROM 768 MiB penuh dan tekanan RAM/disk produksi belum diukur. Cover berbahaya diuji sebagai raster invalid/berlebih, bukan audit keamanan seluruh decoder native.
- Docker/Alpine, persistensi volume saat recreate/rebuild, HTTPS/reverse proxy nyata, dan performa koleksi sangat besar tetap di luar penutupan Milestone 6. Verifikasi deployment Milestone 7 tetap terbuka. Backup hanya akun/save/metadata, **tanpa byte ROM/BIOS/cover**.

## Cara mengulang gerbang

Gunakan Node.js 24+ dan Microsoft Edge yang tersedia untuk Playwright. Build harus selesai sebelum tes produksi/backend; jangan menjalankan build saat browser masih membaca `dist/`. Jalankan seluruh gerbang berurutan, termasuk unit versus browser, agar proses emulator dan tes hashing/password tidak saling berebut sumber daya. Suite browser juga memakai fixture/output bersama.

```sh
npm test
npm run build
npm run test:e2e -- --output=test-results/m6-static-dev
npm run test:e2e:production -- --output=test-results/m6-static-production
npm run test:e2e:backend -- --output=test-results/m6-backend
```

Mode statis secara sengaja melewatkan skenario yang memerlukan backend akun/katalog. Tes HTTP LAN memerlukan interface IPv4 non-loopback; bila tidak tersedia, catat skip, jangan mengklaim LAN diuji. Lihat konfigurasi `playwright.config.ts`, `playwright.production.config.ts`, dan `playwright.backend.config.ts` untuk port/server/Edge/worker tunggal. Artefak trace hanya dipertahankan untuk kegagalan.

## Hasil aktual

Lingkungan: Windows, Node.js **v26.12.1**, Microsoft Edge headless, satu worker Playwright; backend HTTP loopback nyata. Hasil gerbang pada **2026-11-04**:

| Perintah / cakupan | Hasil aktual |
| --- | --- |
| `npm test` | **210 lulus**, tanpa gagal/skip (85,5 detik). |
| `npm run build` | **Lulus**; runtime frontend/engine tidak diubah. |
| `npm run test:e2e -- --output=test-results/m6-static-dev` | **27 lulus, 52 skip khusus backend**, tanpa gagal/retry (4,1 menit). Termasuk dua tes HTTP LAN dan tiga tes save-proof NES. |
| `npm run test:e2e:production -- --output=test-results/m6-static-production` | **27 lulus, 52 skip khusus backend**, tanpa gagal/retry (3,2 menit). |
| `npm run test:e2e:backend -- --output=test-results/m6-backend-complete` | **74 lulus tanpa retry/skip** (8,2 menit), sesudah seluruh penyempurnaan tes. |
| Pengulangan publikasi katalog dua proses terisolasi | **20 kali lulus** setelah perbaikan gate Windows; tanpa retry otomatis. |
| Tes konflik dua tab sesudah pengurangan input/penutupan engine tab yang selesai | **3 pengulangan lulus** (32,8 / 43,5 / 53,1 detik), tetap deadline 90 detik; kemudian lulus lagi pada regresi lengkap akhir. |
| Smoke tiga regresi save terakhir | **3 lulus**, tanpa retry/skip (46 detik), lalu seluruh suite backend akhir di atas lulus. |

Build, unit, dan kedua suite statis dijalankan berurutan sebelum regresi backend. Perubahan sesudah itu hanya pada tes khusus backend (yang dilewati pada kedua mode statis), bukan runtime/konfigurasi statis/build. Tidak ada perubahan runtime setelah build dan gerbang di tabel ini.

### Diagnosis dan percobaan sebelumnya

Baseline sebelum tambahan Milestone 6: **198 tes unit/integrasi lulus**, tanpa gagal/skip; build lulus.

Percobaan regresi unit bersamaan dengan browser mendapat **208 lulus, 1 gagal** (320,2 detik): tes restart CLI di `tests/server.test.mjs` melewati deadline startup 15 detik tanpa stderr. Pengulangan tes CLI itu sendiri lulus (dua startup/restart tetap memakai deadline yang sama); tes katalog terfokus **39 lulus**. Tidak menaikkan timeout, melonggarkan lock, atau mengubah runtime untuk menutupi timeout itu. Hasil gerbang berurutan dicatat terpisah pada tabel akhir.

Percobaan browser terfokus pertama: **20 lulus, 1 gagal** (9,8 menit), tanpa retry. Tes BIOS baru awalnya keliru mengharapkan tombstone mempertahankan basename lama saat diunggah ulang dengan nama berbeda. Audit kontrak repository menunjukkan hanya pemulihan **entri aktif dengan berkas hilang** yang mempertahankan basename lama. Tes diperbaiki untuk memeriksa nama upload ulang pada tombstone dan penolakan URL basename lama; runtime tidak diubah. Alur lengkap game dan BIOS dengan ROM lokal/server sudah lulus pada percobaan awal itu.

Gerbang unit berurutan pertama mendapat **208 lulus, 1 gagal** (75,6 detik), kali ini pada proses publisher katalog yang keluar sebelum ready. Pesan kegagalan tes dilengkapi stderr proses anak; pengulangan terisolasi membuktikan `EPERM` pada `openSync(gate, 'wx')` ketika proses bersaing membuka/menghapus gate Windows, konsisten dengan kondisi delete-pending. `server/data-lock.mjs` kini memperlakukan **EPERM khusus Windows** sebagai contention dalam jendela retry lama (100 × 20 ms), bukan melewati gate atau menghapus lock proses lain. Permission error permanen tetap ditolak setelah batas tersebut; platform lain tetap meneruskan EPERM. Tes injeksi mencakup transient/permanent EPERM dan pelestarian lease/penolakan maintenance, tanpa memperpanjang timeout. Sesudah perbaikan: **4 tes data lock lulus**, lalu **20 pengulangan terisolasi publikasi konkuren lintas proses lulus**. Hasil lengkap akhir ada pada tabel gerbang.

Regresi backend lengkap pertama sesudah perbaikan gate: **73 lulus, 1 timeout** (17,3 menit). Trace tes konflik dua tab menunjukkan asersi nilai progres, dua cadangan, serta revisi akhir sudah lulus sebelum budget test habis pada penutupan context. Mengaktifkan tab yang sedang diberi input saja belum cukup: pengulangan berikutnya **2 lulus, 1 timeout** (4,3 menit). Fixture lalu memakai lima input CPU alih-alih sepuluh, tetap menjaga snapshot pertama berbeda dari seluruh nilai perantara tab kedua dan tetap membuktikan kedua keputusan/cadangan serta boot ulang. Tab kedua ditutup setelah keputusan pertamanya selesai, bukan menjalankan engine yang tidak diperlukan sepanjang sisa skenario. Tiga pengulangan berikutnya lulus; tidak menambah deadline atau retry.

Regresi lengkap berikutnya: **71 lulus, 3 timeout** (26,9 menit). Tes konflik yang sudah diperbaiki lulus; satu tes dua tab lain masih memakai input redundan/hidden tab, sedangkan dua tes native state tersangkut hit-testing toolbar auto-hide (canvas/player menutup tombol). Tes dua tab kedua memakai pengaturan fokus dan snapshot berbeda yang lebih ringkas; helper gerakan mengaktifkan tab. Empat klik native Save/Load State diganti dengan dispatch ke **handler DOM tombol nyata**, mengikuti pola toolbar server yang sudah ada, tetap menunggu write IndexedDB dan memverifikasi posisi CPU setelah load. Tes UI pointer toolbar tetap ada pada `app.spec.ts`. Tidak ada mock state/engine/backend, perubahan runtime save, penambahan retry, atau pelonggaran timeout. Smoke tiga regresi **3 lulus**, lalu regresi lengkap akhir **74 lulus** seperti tabel.

**Kesimpulan:** checklist Milestone 6 terpenuhi pada lingkungan/cakupan yang dinyatakan. Hasil awal bukan kelulusan; penutupan memakai rangkaian akhir tanpa gagal/retry, dengan pengecualian skip mode statis yang memang tidak memiliki backend.
