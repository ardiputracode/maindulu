# Milestone 2 — Fondasi Katalog dan Storage

Status: **Milestone 2 selesai dan terverifikasi pada 2026-10-26 dalam cakupan di bawah.** Dokumen ini merinci [Milestone 2](rencana-admin-library-game.md), bukan perluasan ke API/UI Milestone 3–5.

## Keputusan implementasi

1. Migrasi versi 8 menambahkan tabel `games` dan `bios` yang terpisah. UUID merupakan identitas tetap; SHA-256 merupakan identitas byte upload, termasuk byte arsip tanpa ekstraksi/normalisasi.
2. Masing-masing tabel memiliki constraint unik `(console_id, sha256)`, termasuk tombstone. Upload ulang entri terhapus harus meminta pemulihan ID lama secara eksplisit pada Milestone 3. Game dan BIOS tidak berbagi aturan duplikat.
3. Metadata cover opsional tersimpan bersama game: key, MIME, ukuran, checksum; seluruhnya kosong atau terisi lengkap. Tidak ada foreign key dari save ke katalog. Pembuat tidak menyebabkan katalog ikut terhapus ketika akun dihapus.
4. Storage berada di `MAIN_DULU_DATA_DIR`: `games/`, `bios/`, `covers/`, `uploads/`. Semua nama internal dibuat server; nama firmware asli hanya metadata untuk URL player nantinya. Tidak ada mount static direktori data.
5. Modul storage menggunakan I/O asinkron, staging eksklusif, SHA-256 inkremental, dan pemeriksaan path/file. Nama internal dibatasi; traversal, symlink/junction, hard link, dan berkas khusus ditolak. Direktori data tetap harus terpisah dari `public/` dan `dist/`.
6. Finalisasi: tulis staging sampai lengkap → sync → pindahkan ke final → transaksi SQLite singkat menerbitkan entri. Jangan menahan transaksi SQLite saat menunggu stream. Constraint unik menentukan pemenang duplikat konkuren. Kegagalan/hasil commit tidak pasti mengutamakan meninggalkan orphan daripada menghapus berkas yang mungkin direferensikan.
7. Recovery destruktif hanya offline dengan exclusive data lock. Shared lease server/CLI akun bukan bukti bahwa staging proses lain telah mati. Recovery hanya membersihkan berkas internal yang dikenali dan tidak aktif; berkas asing dilaporkan. Save dan akun tidak disentuh. Referensi aktif hilang/rusak dilaporkan, bukan dihapus.
8. Backup format lama belum mencakup aset katalog. Untuk sementara backup skema 8 hanya boleh jika tabel katalog dan direktori aset katalog kosong. Entri terhapus juga memblokir backup; jangan mengklaim backup koleksi lengkap sebelum Milestone 7. Verify/restore backup skema 7 dipertahankan secara eksplisit, tanpa migrasi sumber; aplikasi memigrasikan hasil restore saat dibuka.
9. Capability `gameCatalog`/`biosCatalog` tetap `false`. Tidak ada parser multipart, endpoint katalog/upload/unduh, perubahan frontend/player, atau penggantian byte pada ID lama pada milestone ini. Validasi raster cover dari upload HTTP termasuk Milestone 3; helper storage bukan validator kompatibilitas/legalitas konten.

## Urutan pekerjaan

- Migrasi database dan constraint metadata.
- `server/catalog/storage.mjs`: penyiapan direktori, staging, hash, finalisasi, pembacaan aman.
- `server/catalog/repository.mjs`: operasi internal dan aturan identitas/duplikat/otorisasi terbaru.
- `server/catalog/recovery.mjs`: inspeksi dan pembersihan offline yang dapat diulang.
- Pengaman `server/data-backup.mjs` dan pesan CLI.
- Tes migrasi, konkurensi lintas proses, kegagalan storage, recovery, backup lama, dan regresi akun/save.

## Gerbang verifikasi

- Migrasi mempertahankan akun, role, sesi, state, progres, cadangan, dan identitas instalasi.
- Edit metadata/cover tidak mengubah ID; delete tidak menghapus save.
- Dua publikasi identik konkuren hanya membuat satu entri aktif, termasuk lintas proses.
- Data mengikuti konfigurasi, tetap tersedia setelah restart, dan tidak bergantung pada build.
- Recovery menolak berjalan bersama server, tidak mengikuti link, dan tidak menghapus referensi aktif/save.
- Backup menolak katalog berisi data tanpa menerbitkan backup parsial; backup skema 7 tetap dapat diverifikasi/dipulihkan.
- Jalankan `npm test`, `npm run build`, dan regresi browser backend yang relevan. Catat hasil aktual dan batas verifikasi sebelum menutup milestone.

## Operasional sementara

Jangan gunakan instalasi berisi koleksi upload sebagai deployment produksi sebelum backup koleksi Milestone 7 tersedia. Folder aplikasi dapat read-only; hanya direktori data yang perlu writable. Direktori data harus dikelola operator tepercaya; pemeriksaan path bukan jaminan terhadap administrator lokal yang sengaja mengganti direktori saat operasi sedang berjalan.

### Inspeksi dan pembersihan offline

Sinkronkan/tutup semua player, hentikan seluruh server dan CLI yang memakai data, lalu gunakan konfigurasi data yang sama:

```powershell
$env:MAIN_DULU_DATA_DIR = 'C:\maindulu-data'
npm run storage:recover
# Tinjau hasil inspeksi sebelum memilih penghapusan:
npm run storage:recover -- --apply
```

- Tanpa `--apply`, tidak ada berkas yang dihapus. Penyiapan modul dapat membuat subdirektori storage kosong yang belum ada. Database harus sudah ada pada skema yang sesuai; recovery tidak membuat atau memigrasikannya.
- Hasil JSON memuat `active`, `damaged`, `unknown`, `unsafe`, `candidates`, `removed`, dan `failed`. Kandidat mencakup staging tertinggal, berkas tanpa referensi aktif, cover lama, dan berkas milik tombstone. Metadata tombstone tetap disimpan untuk pemulihan identitas.
- Exit code 1 menandakan kerusakan/referensi hilang, berkas asing/tidak aman, kegagalan penghapusan, atau kegagalan operasi. Berkas asing/link tidak ikut dihapus. Jangan memperbaiki peringatan dengan menghapus database/save.
- Recovery menghitung ulang checksum aset aktif dan dapat membutuhkan waktu sesuai ukuran koleksi. Pemeriksaan memakai exclusive data lock, termasuk pada mode inspeksi; jangan menjalankannya sebagai background sweep ketika server hidup.
- Untuk lock namespace container lama, ikuti [prosedur lock backend](../deploy/README.backend.md#lock-tertinggal-dari-container-lama) setelah semua pemilik benar-benar berhenti; jangan menghapus lock hidup. Modul dan CLI disertakan dalam allowlist image backend, tetapi runtime Docker belum diuji pada milestone ini.

### Kontrak internal untuk Milestone 3

`createCatalogStorage(config)` dipanggil sesudah `openDatabase`, sehingga koneksi pemanggil memegang shared data lease selama staging/finalisasi. `storage.stage(kind, asyncByteStream)` mengembalikan descriptor beku milik instance itu; descriptor tiruan dari payload ditolak. SHA-256 dihitung sambil menulis dan diverifikasi ulang sebelum rename. Batas helper: ROM 768 MiB, BIOS 32 MiB, cover 8 MiB. MIME raster di metadata bukan bukti gambar valid; pemeriksaan signature/decoder/dimensi tetap wajib sebelum API menerima cover pada Milestone 3.

Repository menyediakan `get`, `list`, `publish`, `update`, dan `delete` untuk pemanggil backend tepercaya. `actor` harus berasal dari sesi server, bukan payload. Role terbaru diperiksa sebelum I/O dan dalam transaksi perubahan. Route Milestone 3 tetap wajib memakai guard sesi/origin/CSRF sebelum menerima stream dan memeriksa kembali sesi saat commit; repository ini tidak menggantikan guard HTTP. Operasi baca repository mengembalikan row internal (termasuk key), bukan DTO publik.

Duplikat mengembalikan `CatalogError` berkode `CATALOG_DUPLICATE` atau `CATALOG_RESTORE_REQUIRED` beserta ID yang ada. Pemulihan eksplisit melalui `restoreId` hanya menerima console/hash yang sama dan berkas lengkap yang baru dipromosikan. ID, pembuat, tanggal pembuatan, serta judul/deskripsi/hak distribusi lama dipertahankan; nama asli/storage key diperbarui dan cover memakai pilihan baru (atau kosong). Metadata lain dapat diedit secara terpisah. Byte ROM/firmware pada identitas aktif tidak dapat diganti melalui `update`.

Publikasi gagal/duplikat dapat meninggalkan berkas final yatim yang aman dibersihkan offline. Ini sengaja lebih konservatif daripada menghapus berkas setelah hasil commit yang belum pasti; penanganan kompensasi langsung, abort HTTP, quota upload, retry delete online, dan respons API tetap Milestone 3. Tidak ada URL aset dinamis yang dibuka pada milestone ini.

## Hasil verifikasi (2026-10-26)

| Perintah | Hasil aktual |
| --- | --- |
| `npm test` | **153 lulus**, tanpa gagal/skip/cancel; pengulangan lengkap terakhir 79,7 detik |
| `npm run build` | **Lulus**, TypeScript dan Vite |
| `node --test tests/catalog.test.mjs tests/catalog-backup.test.mjs tests/deploy.test.mjs` | **34 lulus**, termasuk subtes |
| `npm run test:e2e:backend -- account.spec.ts server-saves.spec.ts server-game-saves.spec.ts backend.spec.ts` | **35 lulus**, tanpa retry/skip, 8,3 menit |

Tes baru membuktikan migrasi skema 7 dan rollback migrasi gagal; pelestarian akun/role/sesi/semua tabel save; identitas tetap setelah edit cover/metadata; tidak bergantung pada build; beberapa BIOS per console; constraint duplikat termasuk dua proses bersamaan; hash byte upload; penolakan staging kosong/berlebih/terputus/berubah/hilang; kegagalan insert database; traversal/junction/hard link; pencabutan role selama I/O; recovery setelah proses dihentikan pada fase staging/final/commit; tidak menyentuh save/akun; penolakan backup katalog/tombstone/orphan; serta verify/restore backup skema 7 tanpa mengubah sumber. Fixture katalog sintetis bukan ROM/firmware nyata yang dapat di-boot.

Tes migrasi lama diperbarui agar fixture downgrade benar-benar menghapus tabel migrasi baru sebelum menguji migrasi skema 4/5/6; perilaku produksi akun/player/save tidak diubah. Regresi browser membuktikan akun, tamu, state/progres NES, konflik/impor, isolasi browser, restart, dan backup/restore save lama—bukan launch game/BIOS katalog dinamis yang belum memiliki API. Satu pengulangan unit sempat terpotong timeout shell 120 detik; pengulangan berikutnya dengan batas lebih longgar selesai 153/153, bukan klaim percobaan terpotong lulus.

**Belum diklaim:** API multipart/GET/HEAD/range/delete online, UI admin/Library, gameplay BIOS nyata/semua core, disk penuh nyata, simulasi listrik padam, runtime Docker/Linux/HTTPS, dan backup koleksi lengkap. Rangkaian statis dev/produksi penuh tidak diulang pada milestone ini; frontend/runtime tetap tidak diubah. Fsync direktori dilewati pada Windows mengikuti pola backup yang sudah ada. Milestone 2 ditutup dalam batas fondasi persistence ini.
