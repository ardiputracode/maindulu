# Milestone 5 — Library dan integrasi player

Bagian dari [rencana Admin/Library/BIOS](rencana-admin-library-game.md). Tidak mengubah skema SQLite, format save, namespace emulator, atau bundle engine.

## Menggunakan Library

- Buka **Library game** (`/library`). Backend melayani refresh/deep link halaman ini. Game upload aktif dari API database digabung dengan manifest bawaan, tanpa duplikasi ID. Demo `jalan-pulang-v1` tetap konten bawaan, tidak menjadi entri admin yang bisa dihapus.
- Cari judul, pilih console, dan urutkan **Terbaru** atau **Judul A–Z**. Grid menampilkan 12 game per halaman; `q`, `console`, `sort`, dan `page` tersimpan di URL. Perubahan pencarian/filter mengembalikan halaman awal; pencarian mengganti entri URL agar tombol kembali tidak melewati setiap ketukan huruf.
- **Jelajahi console** berfokus pada platform dan menautkan ke Library berfilter, bukan menampilkan katalog kedua. Tautan beranda `/console?console=...` tetap dapat dipakai untuk informasi format/BIOS dan membuka ROM lokal.
- Pencarian kosong, halaman di luar hasil, loading, gangguan, retry, dan muat ulang katalog memiliki tampilan tersendiri. Backend yang dikonfigurasi tetapi gagal tidak dianggap deployment statis.

## Sumber data dan pagination

- Frontend statis tetap membaca manifest `/catalog/`, tidak melakukan discovery/request API, dan tidak menampilkan menu admin. Backend online memakai capability `gameCatalog` dan `biosCatalog`; backend lama tanpa capability tetap dapat memakai konten manifest.
- Parser katalog terpisah dari `readGames` untuk metadata tersimpan. Manifest dan katalog API tidak dipotong ke 100 item; favorit tetap maksimum 100, riwayat maksimum 50. Parser metadata kini menerima judul 200 karakter sesuai batas API, tanpa mengganti storage key atau identitas lama.
- Implementasi MVP membaca **metadata** hasil pencarian/filter dalam seluruh halaman API berukuran maksimum 100 entri, lalu menggabung/menyortir konten bawaan dan memaginasi grid di browser. Ini membuat urutan dan jumlah gabungan konsisten tanpa memindahkan demo ke database. Tidak mengunduh byte ROM/BIOS. Koleksi sangat besar masih memerlukan pengukuran/perbaikan pagination gabungan; tidak ada klaim performa skala besar.
- Seluruh halaman BIOS per console dibaca agar pilihan di luar 100 entri pertama tidak hilang. Respons tidak lengkap, ID berulang, dan total yang berubah saat pagination dianggap gangguan dengan retry, bukan diterima sebagai katalog lengkap.

## Membuka game dan memilih BIOS

- Game upload diperiksa melalui metadata API saat dialog dibuka, termasuk dari favorit/riwayat. Judul, deskripsi, dan lisensi terbaru ditampilkan; metadata diperiksa ulang sebelum launch. Entri terhapus atau backend gagal ditampilkan jelas tanpa mencoba URL ROM lama. Player tetap melakukan preflight aset untuk penghapusan di antara pemeriksaan metadata dan unduh.
- ID upload dari backend dipertahankan untuk favorit, riwayat, namespace engine, save state, dan progres akun. Mengedit judul/cover tidak mengganti ID. Tidak menggabungkan save lokal/server berdasarkan hash.
- Jalur `source: 'server'` memang sudah tidak menjalankan `hashRom` sebelum milestone ini. Integrasi baru tetap memakai jalur tersebut; bukan klaim optimasi hashing baru.
- ROM yang dipilih dari perangkat tetap di-hash untuk ID/verifikasi lokal dan tidak diunggah. BIOS lokal juga tidak diunggah otomatis. Checksum save/progres akun tetap diverifikasi secara terpisah; larangan hashing ulang hanya berlaku untuk aset ROM/BIOS server.
- BIOS API aktif ditampilkan sesuai console untuk ROM server maupun lokal, digabung dengan BIOS manifest tanpa duplikasi ID. Tidak ada auto-select firmware. Pilihan raw/arsip dan URL/nama firmware dipertahankan.
- BIOS upload terpilih diperiksa ulang sebelum launch; hash SHA-256 yang dihitung backend ditampilkan/dibawa dalam metadata sesi tanpa membaca ulang byte firmware untuk hashing di browser. Hash bukan bukti kompatibilitas/keamanan/legalitas.
- Gangguan API BIOS menampilkan retry, bukan daftar kosong yang dianggap sukses. BIOS lokal atau tanpa BIOS tetap dapat dipilih bila aturan core mengizinkan. BIOS wajib, termasuk FDS, tidak dapat dilewati. Pilihan server yang dihapus ditolak; pengguna harus memilih ulang secara eksplisit.
- Entri manifest dengan ID berbentuk UUID tetap diperlakukan sebagai konten bawaan, bukan otomatis sebagai upload database.

## Verifikasi dan batas

Pengujian pada **2026-11-03**:

| Perintah / cakupan | Hasil |
| --- | --- |
| `npm test` | **194 lulus**, tanpa gagal/skip |
| `npm run build` | **Lulus**, setelah penyempurnaan metadata/retry |
| `npm run test:e2e:backend -- --output=test-results/m5-backend-final` | **70 lulus** tanpa retry/skip (5,9 menit), termasuk akun/save/progres/player/admin |
| `npm run test:e2e:backend -- library.spec.ts catalog-api.spec.ts --output=test-results/m5-catalog-final` | **11 lulus** tanpa retry/skip (27,5 detik); sesudah penambahan satu skenario race BIOS, tanpa perubahan runtime |
| `npm run test:e2e -- app.spec.ts backend.spec.ts http-lan.spec.ts library.spec.ts --output=test-results/m5-static-dev-final` | **24 lulus**, 6 skenario khusus backend dilewati, tanpa gagal/retry (48 detik) |
| `npm run test:e2e:production -- app.spec.ts backend.spec.ts http-lan.spec.ts library.spec.ts --output=test-results/m5-static-production` | **24 lulus**, 6 skenario khusus backend dilewati, tanpa gagal/retry (42,2 detik) |

**Milestone 5 ditutup dalam cakupan integrasi ini.** Regresi backend awal **69 lulus** tanpa retry/skip (5,6 menit), diikuti penyempurnaan metadata saat dialog dibuka dan kompatibilitas ID UUID manifest. Regresi lengkap akhir **70 lulus**, lalu satu tes race BIOS ditambahkan dan smoke akhir **11 lulus** pada build/runtime yang sama. Pada percobaan statis awal, hook skip khusus backend ikut melewatkan dua tes portabel; skip dipindahkan ke fixture backend dan kedua tes portabel lulus pada pengulangan akhir di atas.

- Tes unit/client: parser katalog versus batas metadata tersimpan, pagination 205 entri, URL/checksum, merge demo, pencarian/urutan, respons HTML/404/identitas salah, dan abort.
- Tes browser memakai backend/API/engine nyata: upload melalui UI admin → tamu menemukan di Library → main dengan BIOS sintetis; tidak menyuntikkan manifest hasil API. Guard pembacaan Blob dan Web Crypto di host menguji bahwa aset server tidak dibaca/di-hash, termasuk jalur fallback.
- Tes BIOS mencakup 101 pilihan satu console, isolasi console, pilihan eksplisit, ROM lokal dengan ID hash, penghapusan sebelum launch maupun setelah metadata diperiksa tetapi sebelum HEAD player, serta error/retry. Firmware sintetis hanya membuktikan plumbing/nama, bukan boot BIOS proprietary.
- Fixture battery NES berlisensi untuk tes membuktikan progres yang ditulis CPU dan state tersimpan tetap dapat dipulihkan setelah edit metadata, restart backend, dan login pada browser baru dengan ID game upload yang sama. Ini bukan bukti seluruh core/game.
- **Revisi sesudah penutupan M5:** pengguna tidak memerlukan backup berkas ROM/BIOS. Backup format 2 kini menyimpan akun/save/metadata tanpa aset ROM/BIOS/cover; katalog berisi data/tombstone tidak lagi memblokir backup. Restore mempertahankan ID dan memungkinkan upload ulang byte identik secara eksplisit. Lihat [cakupan backup metadata](backup-metadata-katalog.md). Milestone 6 dan verifikasi deploy Milestone 7 tetap belum ditutup; backup byte koleksi tidak lagi menjadi syarat MVP.
- Docker/Alpine, HTTPS/proxy nyata, disk penuh fisik, upload 768 MiB penuh, dan gameplay semua core tidak diklaim.
