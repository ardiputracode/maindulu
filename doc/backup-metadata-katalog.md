# Backup akun, save, dan metadata — tanpa ROM/BIOS

## Keputusan cakupan

Sesuai keputusan pengguna pada **2026-11-03**, backup berkas ROM/BIOS bukan fitur yang diperlukan dan bukan gerbang MVP. Backup aplikasi hanya menyimpan **akun, save state, progres game/cadangannya, serta metadata katalog**. Berkas ROM, BIOS, cover, staging upload, dan orphan **tidak disalin**. Kehilangan volume berarti aset tersebut harus disediakan ulang jika ingin bermain kembali; aplikasi tidak menjanjikan pemulihan byte koleksi.

Metadata tetap dicadangkan supaya ID game/BIOS, console, hash, ukuran, nama firmware, judul/lisensi, referensi cover, serta status aktif/terhapus tidak hilang. Tanpa ID katalog lama, upload ulang sebagai game baru akan memutus hubungan otomatis dengan namespace save lama. Save lokal/server tidak digabung berdasarkan hash.

## Format dan kompatibilitas

- Backup baru memakai `formatVersion: 2`, `catalogAssets: "excluded"`, dan skema SQLite **9**. Tidak ada migrasi skema atau perubahan format/identitas save/engine untuk keputusan ini.
- Folder backup tetap hanya berisi `manifest.json`, `maindulu.sqlite`, `saves/`, dan `game-saves/`. Allowlist tidak menerima tambahan folder/berkas aset katalog, walaupun ditambahkan manual ke manifest.
- Verify memeriksa integritas SQLite, record/count, path metadata katalog, dan seluruh ukuran/checksum blob save aktif/cadangan yang direferensikan. ROM/BIOS/cover yang tidak disertakan **tidak** diverifikasi keberadaan atau isinya; hasil verify bukan bukti koleksi lengkap/kompatibel.
- Format 1 lama tetap diterima untuk skema 7/8/9 dengan katalog kosong sesuai kontrak lamanya. Format 1 yang berisi katalog ditolak, bukan ditafsirkan sebagai format 2 tanpa deklarasi. CLI/aplikasi lama tidak dapat membaca format 2.
- Untuk skema 6, gunakan aplikasi lama untuk verify/restore, lalu buka hasil restore dengan server baru untuk migrasi. CLI tidak memigrasikan backup asal atau memaksa downgrade.
- Reservasi upload dan antrean cleanup tidak dibawa ke instalasi hasil restore. Saat backup offline, keduanya dikosongkan **hanya pada snapshot**, bukan sumber. File staging/orphan sumber tidak dihapus oleh backup. Sesi login pada snapshot tetap dicabut saat restore seperti sebelumnya.

## Membuat backup

1. Sinkronkan progres dan simpan state yang diperlukan. Tutup seluruh player, lalu hentikan semua server/CLI yang memakai direktori data tersebut.
2. Pastikan `MAIN_DULU_DATA_DIR` benar. Dengan parent tujuan sudah ada, jalankan:

```powershell
npm run data:backup -- 'D:\maindulu-backups\metadata-2026-11-03'
npm run data:verify -- 'D:\maindulu-backups\metadata-2026-11-03'
```

Tujuan harus belum ada. CLI menyatakan secara eksplisit bahwa ROM/BIOS/cover tidak disertakan. Katalog berisi entri aktif, tombstone, atau aset hilang tidak lagi memblokir backup akun/save. Blob **save** yang hilang/rusak tetap menggagalkan backup. Salin seluruh folder hasil backup secara privat ke lokasi lain jika perlu; backup tidak terenkripsi.

## Restore dan mengisi kembali aset

1. Hentikan server dan semua player/CLI lama; jangan menghapus volume/data asal. Verifikasi backup, lalu pulihkan ke direktori baru yang belum ada:

```powershell
npm run data:restore -- 'D:\maindulu-backups\metadata-2026-11-03' --to 'C:\maindulu-data-restored'
$env:MAIN_DULU_DATA_DIR = 'C:\maindulu-data-restored'
npm start
```

2. Login ulang. Akun, role, save, dan metadata katalog dipertahankan; password/kode pemulihan kembali ke waktu snapshot. Konfigurasi environment tidak diterapkan otomatis.
3. Entri aktif tetap aktif; entri yang sudah dihapus tetap tombstone, tidak dipulihkan diam-diam. Admin menampilkan **Berkas hilang** untuk ROM/BIOS yang tidak ada. URL aset menolak download sampai berkas tersedia lagi; bermain tidak otomatis memilih ROM/BIOS lain.
4. Di **Manage Game** atau **Manage BIOS**, gunakan **Upload game/BIOS**, pilih console yang sama dan **byte berkas yang sama persis**. Upload awal menawarkan **Pulihkan ID lama**; konfirmasi secara eksplisit. Aplikasi memeriksa SHA-256 server, mempertahankan ID/metadata lama, dan mempromosikan storage key baru. Arsip yang dikemas ulang memiliki hash berbeda walau isinya serupa dan tidak dapat dipakai untuk memulihkan ID tersebut.
5. Untuk entri aktif yang berkasnya hilang, nama ROM/firmware lama dipertahankan meskipun berkas upload bernama lain. Berkas aktif yang masih tersedia tidak boleh ditimpa melalui jalur ini; file rusak/unsafe juga tidak dianggap hilang. Dua pemulihan bersamaan hanya dapat menerbitkan satu hasil.
6. Referensi metadata cover dipertahankan untuk entri aktif; byte cover tidak ada pada backup. Gunakan **Edit metadata** untuk upload cover lagi atau hapus referensinya. Pemulihan tombstone mengikuti kontrak lama: cover memakai upload baru atau kosong.
7. Buka Library, pilih BIOS secara eksplisit jika diperlukan, lalu periksa progres melalui Continue/Load dalam game dan muat state secara terpisah. Membuka ROM itu melalui **Buka ROM lokal** bukan pemulihan ID upload server. ID game tetap sama bila dipulihkan melalui admin; checksum bukan jaminan kompatibilitas semua firmware/core/save.

Jika tidak lagi memiliki ROM/BIOS yang diperlukan, akun/save/metadata tetap dapat dipulihkan, tetapi game tidak bisa dimainkan sampai aset yang sesuai tersedia. Backup ROM/BIOS tidak diwajibkan dan tidak dilakukan aplikasi.

## Deploy dan batas verifikasi

Rebuild/recreate normal memakai volume data yang sama, sehingga aset upload tetap berada di volume; ini berbeda dari restore metadata ke direktori bersih. Jangan memakai `down -v`, menghapus volume, atau membersihkan data untuk deploy rutin. Volume bukan jaminan terhadap kerusakan disk.

Milestone 7 katalog kini mencakup backup metadata/save, deploy, dan dokumentasi — **bukan** backup byte ROM/BIOS. Implementasi ini tidak otomatis menutup gerbang pengujian: [Milestone 6](milestone-6-keamanan-regresi-katalog.md) diverifikasi terpisah dan ditutup pada 2026-11-04, sedangkan verifikasi Docker/Alpine/volume/HTTPS/proxy nyata tetap belum dijalankan. BIOS sintetis menguji transport/nama, bukan boot firmware proprietary.

Verifikasi 2026-11-03:

| Perintah / cakupan | Hasil |
| --- | --- |
| `npm test` | **198 lulus**, tanpa gagal/skip, setelah penyempurnaan snapshot SQLite |
| `npm run build` | **Lulus** |
| `npm run test:e2e:backend -- --output=test-results/metadata-backup-backend-final` | **72 lulus** tanpa retry/skip (7,6 menit), termasuk akun, admin, Library, player, backup, state, dan progres |
| `npm run test:e2e:backend -- library.spec.ts admin-catalog.spec.ts catalog-api.spec.ts --output=test-results/metadata-backup-integration` | **22 lulus** tanpa retry/skip (44,1 detik) |
| `npm run test:e2e:backend -- server-game-saves.spec.ts --grep 'M8: offline backup' --repeat-each=8 --output=test-results/metadata-backup-m8-final-repeat` | **8 lulus** tanpa retry/skip (1,4 menit), tanpa log diagnostik atau kenaikan timeout |
| `npm run test:e2e -- backend.spec.ts library.spec.ts --output=test-results/metadata-backup-static-dev` | **8 lulus**, 7 skenario khusus backend dilewati sesuai mode (18,9 detik) |
| `npm run test:e2e:production -- backend.spec.ts library.spec.ts --output=test-results/metadata-backup-static-production` | **8 lulus**, 7 skenario khusus backend dilewati sesuai mode (17,2 detik) |

Rangkaian integrasi membuktikan restore bersih tanpa aset, label berkas hilang, upload ulang UI admin yang mempertahankan ID/nama/hash, serta pemulihan state dan progres CPU NES. Unit/integrasi mencakup format 1 lama, manifest/scope/path berbahaya, metadata/tombstone, blob save, snapshot tanpa koordinasi sumber berubah, dan konkurensi pemulihan lintas koneksi.

Percobaan regresi lengkap awal mendapat **71 lulus + 1 timeout** pada tes backup M8 lama. Pengulangan terisolasi awal juga menghasilkan 2 lulus + 1 timeout. Error pelepasan lease/cleanup terjadi sesudah batas waktu tes; itu bukan alasan untuk menghapus lock atau melonggarkan proteksinya. Setelah diagnosis, pemeriksaan metadata memakai koneksi tersendiri yang ditutup sebelum snapshot SQLite asinkron dimulai, sehingga statement/iterator dan GC tidak menyentuh koneksi yang sedang dipakai worker backup. Log diagnostik sementara dihapus. Delapan pengulangan tanpa log lulus; tes tambahan menggunakan database lebih dari 100 halaman dan GC dipaksa juga lulus. Timeout player/tes, data lock, dan jalur save/engine tidak dilonggarkan. Regresi lengkap kemudian diulang: **72 lulus tanpa retry/skip**, bukan klaim kelulusan berdasarkan pengulangan terisolasi saja.
