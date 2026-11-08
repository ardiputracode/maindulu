# Storage ROM/BIOS per platform dengan nama berkas asli

Status: **diimplementasikan pada 2026-11-08**. Dokumen ini menjelaskan perubahan storage setelah Milestone 7 ScreenScraper dan penggantian nama internal `<uuid>.bin`.

## Tujuan

1. Berkas ROM/BIOS yang di-upload disimpan dengan **nama dan ekstensi aslinya** agar mudah diperiksa operator di volume.
2. Setiap platform memiliki foldernya sendiri:
   - ROM: `MAIN_DULU_DATA_DIR/roms/<platform>/<nama-asli>`
   - BIOS: `MAIN_DULU_DATA_DIR/bios/<platform>/<nama-asli>`
3. Nama yang sama tidak boleh saling menimpa. Upload kedua dengan nama yang sama pada platform yang sama ditolak dengan `CATALOG_FILENAME_CONFLICT`, bukan diganti nama secara diam-diam.
4. ID game/BIOS, byte aset, hash, save, dan URL player tetap sama. Edit judul/nama/metadata ScreenScraper tidak mengganti nama berkas di disk.

## Slug platform

Folder mengikuti kolom **Folder Name** pada [RomM 5.4.0 — Supported Platforms](https://docs.romm.app/5.4.0/platforms/supported-platforms/#platform-slugs-coverage), bukan slug IGDB. Console aplikasi dipetakan sebagai berikut:

| Console aplikasi | Folder platform |
| --- | --- |
| `nes` | `nes` |
| `snes` | `snes` |
| `gb` | `gb` |
| `gba` | `gba` |
| `megadrive` | `genesis` |
| `psx` | `psx` |

Game Boy Color menggunakan file `.gbc`; berkas game `.gbc` pada console `gb` disimpan di `roms/gbc/`. Arsip ZIP/7z/RAR yang tidak menunjukkan platform secara eksplisit tetap berada di folder console yang dipilih admin. BIOS selalu mengikuti folder console (`gb` tetap `gb`).

## Skema database 14

Migrasi 14 menambahkan `catalog_asset_files` sebagai pemetaan kepemilikan berkas:

| Kolom | Arti |
| --- | --- |
| `storage_key` | Token UUID internal yang tetap dan unik; masih dipakai tabel `games`/`bios`, URL aset, cleanup, dan antrean metadata. |
| `folder` | `games` atau `bios`. |
| `platform` | Salah satu slug di atas. |
| `file_name` | Nama berkas asli yang disimpan. |
| `name_identity` | Normalisasi NFC + huruf kecil untuk mendeteksi benturan lintas Windows/Linux. |
| `state` | `reserved` saat promosi, `ready` setelah byte terverifikasi, `deleting` selama unlink. |

`UNIQUE(folder, platform, name_identity)` mencegah dua pemilik aktif memakai path fisik yang sama. `storage_key` tetap menjadi token kepemilikan; penghapusan lama tidak bisa menghapus berkas baru yang memakai nama sama karena token lama tidak lagi punya pemetaan.

## Aturan nama

Nama harus berupa basename aman:

- Maksimum 240 karakter dan 255 byte UTF-8.
- Ditolak: `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`, karakter kontrol, spasi/titik di akhir, nama `.`/`..`, dan nama perangkat Windows yang direservasi (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, termasuk varian superskrip).
- Nama tidak di-trim atau di-rename secara diam-diam; spasi di awal/akhir ditolak.
- Perbandingan benturan memakai NFC + case-fold sederhana. `Pokémon.zip`, `POKÉMON.ZIP`, dan `Poke\u0301mon.zip` dianggap sama.
- Platform dan jenis berkas berbeda memiliki namespace terpisah: `roms/nes/Game.zip` dan `roms/snes/Game.zip` boleh ada bersamaan.

Penolakan terjadi sebelum berkas final dibuat. Folder platform dan file sementara (`uploads/<uuid>.tmp`) tidak memakai nama pengguna.

## Alur upload

1. Multipart ditulis streaming ke `uploads/<uuid>.tmp` dengan batas ukuran dan SHA-256 inkremental.
2. Validasi metadata/nama dan (bila ada) cover dilakukan sebelum publikasi.
3. Token UUID baru dibuat, lalu baris `catalog_asset_files` berstatus `reserved` di-insert dalam transaksi. Benturan nama menghasilkan `409 CATALOG_FILENAME_CONFLICT`.
4. Berkas disalin dari staging ke tujuan dengan flag eksklusif `wx` sehingga berkas yang sudah ada di disk tidak pernah ditimpa, termasuk berkas yang dibuat operator di luar aplikasi.
5. Ukuran/hash diverifikasi selama penyalinan, file di-`fsync`, status menjadi `ready`, staging di-unlink, lalu baris katalog dipublikasikan.
6. Batal, sesi berubah, atau kegagalan I/O menghapus hanya berkas parsial milik token tersebut dan melepas klaim nama.

Metadata game/BIOS hanya di-update di SQLite. Nama physical tidak berubah pada edit admin atau penerapan metadata ScreenScraper.

## Kompatibilitas aset lama

Aset lama berbentuk `<uuid>.bin` di `games/` dan `bios/`, serta cover di `covers/`, tetap dapat dibaca tanpa migrasi nama. Nama asli lama tetap dipakai untuk URL dan ditampilkan di UI. Upload baru memakai folder platform. Tidak ada pemindahan otomatis berkas lama; operator dapat membiarkannya atau meng-upload ulang bila menginginkan layout baru.

## Cleanup, quota, dan recovery

- `npm run storage:recover` (tanpa `--apply`) hanya menginspeksi. Dengan `--apply`, server harus berhenti dan data lock eksklusif diambil.
- Recovery memeriksa baris `reserved`/`deleting` yang tertinggal akibat crash, melepas klaim yang tidak punya berkas, dan tidak mengikuti symlink/junction, hard link, atau direktori platform pengganti.
- Berkas tak dikenal di bawah folder platform dilaporkan sebagai `unknown`/`unsafe`, tidak dihapus otomatis dan tidak dianggap aset aktif.
- Quota menghitung ukuran fisik berkas yang ada. Klaim `reserved` yang belum punya berkas tidak menambah pemakaian, tetapi tetap terlihat oleh recovery.
- Cleanup lama memakai token UUID. Jika nama fisik sudah dipakai pemilik baru, token lama tidak punya pemetaan dan tidak bisa menghapus path baru.

## Backup

Backup format 2 tetap **hanya metadata/akun/save**, tanpa byte ROM/BIOS/cover. Snapshot menghapus `catalog_asset_files` karena pemetaan path adalah data operasional dan aset tidak disertakan. Restore memerlukan upload ulang byte identik; konfirmasi ID lama akan membuat pemetaan baru dengan nama asli dari unggahan baru. Untuk entry aktif yang hanya kehilangan berkas (misalnya setelah restore metadata), nama asli lama dipertahankan saat perbaikan.

## Verifikasi

Perintah yang relevan:

```sh
node --test tests/catalog-platform-storage.test.mjs tests/catalog.test.mjs tests/catalog-backup.test.mjs tests/catalog-api.test.mjs
npm run build
npm run test:e2e:backend -- tests/browser/admin-catalog.spec.ts tests/browser/library.spec.ts
npm test
```

Tes baru mencakup pemetaan slug, nama/ekstensi/byte asli, benturan case/Unicode, upload bersamaan pada dua koneksi SQLite, berkas operator yang sudah ada, symlink platform, edit metadata yang tidak mengganti path, cleanup basi, pembatalan salin, aset UUID lama, recovery klaim crash, hard link, dan normalisasi pemetaan pada backup/restore.
