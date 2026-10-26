# Milestone 3 — API Katalog, Upload, Unduh, dan Delete

Status: **Milestone 3 selesai dan terverifikasi pada 2026-10-26 dalam cakupan backend di bawah.** Dokumen ini menyimpan rencana, keputusan implementasi, kontrak operasional, serta hasil aktual Milestone 3 dari [rencana utama](rencana-admin-library-game.md).

## Cakupan dan keputusan

- Backend saja; UI admin dan Library tetap Milestone 4–5. Tidak mengubah identitas game/save, bundle engine, atau hashing ROM lokal.
- Gunakan staging/hash/publikasi dan pemulihan ID dari Milestone 2. Multipart diproses streaming setelah guard admin, origin, dan CSRF; sesi dan role diperiksa kembali dalam transaksi publikasi.
- POST game: `title`, `consoleId`, dan file `rom` wajib; `description`, `license`, `restoreId`, dan file `cover` opsional. POST BIOS: `name`, `consoleId`, dan file `bios` wajib; `description`, `distributionRights`, `restoreId` opsional.
- PATCH menerima JSON untuk metadata atau multipart untuk metadata/cover game. Field `removeCover: true` pada JSON atau `removeCover=true` pada multipart menghapus cover. Tidak ada penggantian ROM, firmware, console, atau nama firmware pada ID aktif.
- Limit ROM 768 MiB, BIOS 32 MiB, cover 8 MiB; batas field/part/total request, upload bersamaan, quota katalog, ruang disk minimum, dan timeout eksplisit. Limit global akun/save tidak dinaikkan.
- Cover PNG/JPEG/WebP harus lolos decoder, bukan hanya MIME/signature; maksimum 4096 × 4096, tanpa animasi. Arsip ROM/BIOS tidak diekstrak di server.
- List publik/admin memakai `q`, `console`, `sort=newest|title`, `page`, `pageSize` (maksimum 100), respons `{ items, page, pageSize, total }`. Admin juga menerima `status=active|deleted|all`.
- DTO publik tidak mengekspos storage key/path/pembuat. Admin memperoleh status file dan cleanup, bukan path privat. Error duplikat 409 memuat `code` dan `existingId`.
- URL ROM kanonis `/games/:id/rom/:filename`; `/games/:id/rom` redirect tanpa cache. BIOS `/bios/:id/:filename`; cover `/games/:id/cover`. Nama URL divalidasi terhadap metadata dan basename aman, tidak dipakai sebagai path filesystem. Ekstensi ROM dipertahankan karena EmulatorJS menurunkan nama berkas dari URL.
- Aset aktif terbuka untuk tamu. GET/HEAD mendukung panjang, MIME, single byte range (206/416), dan `Cache-Control: no-store`. Multi-range diabaikan menjadi 200. Aset dinamis tidak boleh jatuh ke static/SPA fallback.
- Delete menulis tombstone dan antrean cleanup persisten dalam satu transaksi; akses baru langsung ditolak. Worker hanya menghapus key immutable yang tidak aktif, dengan retry setelah kegagalan/restart. Pemulihan memakai key baru. Save/akun tidak disentuh.
- Staging upload lain tidak dibersihkan online. Recovery umum tetap offline/exclusive. Kompensasi gagal publikasi hanya dilakukan pada berkas milik operasi yang aman dipastikan tidak direferensikan; hasil commit tidak pasti mengutamakan orphan.
- Reservasi upload bersama di SQLite membatasi konkurensi lintas proses. Quota memperhitungkan berkas fisik katalog termasuk staging/orphan, bukan hanya row aktif; quota save tetap terpisah.
- Capability katalog diaktifkan setelah API lengkap. Backup format lama tetap fail-closed untuk katalog berisi data; kompatibilitas backup kosong skema lama dipertahankan. Backup koleksi penuh tetap Milestone 7.

## Urutan implementasi

1. Kontrak HTTP, validasi, serializer, query SQL pagination.
2. Migrasi antrean cleanup dan reservasi upload; konfigurasi quota/timeout; pengaman backup/recovery.
3. Multipart streaming, validasi raster, finalisasi, kompensasi, pemeriksaan ulang sesi.
4. Route katalog/admin dan aset terkontrol GET/HEAD/range.
5. Worker cleanup aman, retry dan shutdown.
6. Tes keamanan/kegagalan, regresi akun/save, smoke player ROM/BIOS, dan dokumentasi hasil aktual.

## Gerbang verifikasi

- 401/403/CSRF sebelum parsing; sesi berakhir/role dicabut selama I/O tidak dapat menerbitkan entri.
- Hash independen sesuai; multipart terpotong, abort, batas ukuran, gambar palsu, rename/disk/commit gagal tidak menerbitkan entri parsial.
- Duplikat konkuren dan pemulihan eksplisit mempertahankan identitas; edit/delete tidak menghapus save.
- Pagination/filter/search SQL; DTO tidak membocorkan key privat.
- GET/HEAD/range, nama firmware, deleted/missing assets, traversal/link, dan larangan mengunduh database/save.
- Cleanup retry setelah restart tidak menghapus aset aktif/hasil restore atau staging upload lain.
- `npm test`, `npm run build`, regresi browser backend dan smoke player relevan; catat batas verifikasi Windows/Linux/Docker/HTTPS/core nyata secara jujur.

## Hasil verifikasi

| Perintah | Hasil aktual |
| --- | --- |
| `npm test` | **183 lulus**, tanpa gagal/skip/cancel; pengulangan lengkap akhir 40,8 detik |
| `npm run build` | **Lulus**, TypeScript dan Vite |
| `npm run test:e2e:backend -- catalog-api.spec.ts account.spec.ts server-saves.spec.ts server-game-saves.spec.ts backend.spec.ts` | **37 lulus**, tanpa retry/skip, 11,3 menit |
| `npm run test:e2e:backend -- catalog-api.spec.ts backend.spec.ts` | Pengulangan akhir **7 lulus**, tanpa retry/skip, 22,2 detik |
| `npm run test:e2e -- backend.spec.ts` | **5 lulus**, mode statis dev |
| `npm run test:e2e:production -- backend.spec.ts` | **5 lulus**, mode statis build produksi |

Tes API baru mencakup SHA-256 independen, DTO privat, nama ROM/BIOS termasuk basename panjang dan UTF-8, GET/HEAD/range, katalog/filter/pagination SQL, guard sebelum staging, pencabutan role/sesi sebelum handler dan saat finalisasi, duplikat konkuren, restore ID lama, edit cover/metadata, save tetap utuh setelah restart, gambar palsu/rusak/animasi/dimensi berlebih, batas BIOS/cover/part/body, boundary hilang, multipart terputus, timeout selama body maupun setelah body lengkap saat finalisasi, dan error disk/rename/database terkontrol. Deadline wall upload tetap aktif sesudah body selesai, terpisah dari timer framework, dan tidak dapat menerbitkan entri setelah timeout. Cleanup diuji rollback atomik bersama tombstone, retry sesudah restart, referensi aktif/restore tetap aman, serta staging upload lain tidak tersentuh. Reservasi diuji lintas koneksi **dan proses**, quota fisik/orphan, serta ruang disk minimum. Migrasi 8 → 9 mempertahankan katalog/aset/sesi/identitas. Backup lama skema 7/8 tetap verify/restore tanpa migrasi sumber; antrean/reservasi yang tertinggal menolak backup dan hanya dibersihkan apply offline.

Smoke browser memakai upload homebrew Jalan Pulang CC0 dan byte BIOS sintetis, endpoint aset sungguhan, serta engine NES nyata. Test hanya mengadaptasi input manifest lama agar mengarah ke DTO upload; **bukan** implementasi atau bukti alur UI Library/admin. Browser menolak native digest pada smoke server, tetapi optimasi tanpa hashing server sudah ada sebelumnya dan tes ini bukan bukti baru seluruh jalur hash fallback. Firmware muncul dengan nama `test-firmware.bin` di filesystem engine; delete menolak URL baru sementara engine yang sudah menerima byte tetap berjalan. BIOS yang dihapus setelah dipilih menghasilkan error preflight 404. Regresi akun/state/SRAM NES lama, restart, dan backup/restore save tanpa katalog lulus pada rangkaian 37 tes.

Satu pengulangan 7 tes sempat gagal pada demo statis karena build dijalankan paralel dan Vite mengganti `dist/` ketika HEAD ROM berlangsung (404). Ini kegagalan orkestrasi verifikasi, bukan klaim tes lulus; build dan tes browser yang membaca `dist/` harus **berurutan**. Pengulangan berurutan akhir lulus 7/7 tanpa mengubah runtime player atau menambah retry. Rangkaian 37 tes dijalankan sebelum hardening terakhir pada basename/deadline/validasi; setelah hardening, seluruh 183 unit/integrasi dan 7 smoke backend/katalog diulang dan lulus.

**Batas verifikasi:** Docker CLI tidak tersedia; build/runtime Alpine dan HTTPS/reverse proxy belum diuji. ENOSPC/rename/commit disimulasikan pada boundary I/O, bukan memenuhi disk fisik atau memutus listrik. Batas ROM 768 MiB diperiksa pada helper/header, bukan upload 768 MiB penuh di browser. Crash staging/final/commit dan recovery diuji pada fondasi storage, bukan mematikan proses HTTP pada setiap fase baru. BIOS sintetis hanya membuktikan transport/nama/preflight, bukan boot firmware/core proprietary. Rangkaian statis penuh selain `backend.spec.ts` tidak diulang; frontend, player, dan bundle engine tidak diubah. UI admin/Library dan backup koleksi bukan cakupan milestone ini. Jangan gunakan instalasi berisi koleksi upload sebagai produksi sebelum Milestone 6–7 selesai.

## Kontrak HTTP

| Metode/path | Akses | Respons berhasil |
| --- | --- | --- |
| `GET /api/games`, `GET /api/bios` | Publik | `{ items, page, pageSize, total }` |
| `GET /api/games/:id`, `GET /api/bios/:id` | Publik | `{ item }`; 404 untuk ID invalid/terhapus/tidak ada |
| `GET /api/admin/games`, `GET /api/admin/bios` | Admin | Pagination yang sama + status berkas/tombstone/cleanup |
| `POST /api/admin/games`, `POST /api/admin/bios` | Admin + CSRF | Multipart; 201 baru atau 200 pemulihan; `{ item }` |
| `PATCH /api/admin/games/:id` | Admin + CSRF | JSON metadata/removeCover atau multipart metadata/cover; 200 `{ item }` |
| `PATCH /api/admin/bios/:id` | Admin + CSRF | JSON metadata saja; 200 `{ item }` |
| `DELETE /api/admin/games/:id`, `DELETE /api/admin/bios/:id` | Admin + CSRF | JSON `{}`; 200 `{ ok, id, deletedAt, cleanupPending }`; idempoten pada tombstone |
| `GET/HEAD /games/:id/rom/:filename` | Publik | Streaming ROM; ekstensi dipertahankan |
| `GET/HEAD /games/:id/rom` | Publik | 302 ke URL ROM kanonis |
| `GET/HEAD /games/:id/cover` | Publik | Raster cover saat ini; 404 bila tidak ada |
| `GET/HEAD /bios/:id/:filename` | Publik | Streaming firmware/arsip dengan nama asli |

- Seluruh mutasi memakai cookie sesi `/api`, `Origin` yang cocok, dan header `X-CSRF-Token` dari sesi login. Gunakan `GET /api/auth/session` untuk membaca token; jangan menaruhnya pada query URL atau log. Registrasi tidak dapat memilih role; promosi tetap CLI `account:role`.
- Field file bernama `rom`, `bios`, atau `cover`, bukan `file`. Field teks multipart harus string biasa, bukan part JSON. Urutan file/metadata bebas. Field tak dikenal/berulang ditolak; maksimal 6 field teks, 2 file untuk POST game, dan 1 file untuk operasi upload lainnya, maksimal 8 part, 40.000 byte per field. Header multipart harus memiliki boundary 1–70 karakter.
- Judul/nama maksimum 200 karakter, deskripsi 10.000, lisensi/hak distribusi 2.000, nama asli 240; batas sebelum trim. Console: `nes`, `snes`, `gb`, `gba`, `megadrive`, `psx`. Ekstensi ROM mengikuti manifest console ditambah ZIP/7z/RAR; firmware BIN/ROM/BIOS/IMG/ZIP/7z/RAR. Validasi bukan pemeriksaan malware, kompatibilitas, atau izin distribusi.
- Nama BIOS raw hanya ASCII `[A-Za-z0-9_.-]` dan harus basename aman. Nama dengan spasi/karakter yang berubah saat URL encoding ditolak, bukan diubah diam-diam; EmulatorJS tidak men-decode basename raw. Nama arsip boleh lebih luas karena yang dipakai core adalah nama anggota arsip. Server tidak mengekstrak arsip.
- DTO game memuat ID UUID, `title`, `consoleId`, `source: 'server'`, `fileName`, `url`, cover opsional, `size`, `sha256`, `description`, `license`, `createdAt`, `updatedAt`. BIOS memakai `name`/`distributionRights`. Waktu berupa epoch milidetik. Semua SHA-256 adalah byte upload, bukan hasil ekstraksi/normalisasi.
- Detail/mutasi memakai envelope `{ item }`, tidak langsung objek game. Admin list menambahkan `deletedAt`, `fileStatus`, `coverStatus` untuk game, serta `cleanupPending` untuk referensi berkas entri tersebut. Status `available` hanya memastikan file aman dan ukuran sesuai, **bukan** hashing ulang seluruh koleksi; checksum lengkap diperiksa oleh recovery offline. DTO tidak membocorkan key/path/pembuat.
- List default halaman 1, 24 item, `newest`; maksimum 100 item/halaman. Pencarian literal substring pada judul/nama, `%`/`_` bukan wildcard. Case folding SQLite bawaan terutama ASCII, bukan pencarian linguistik Unicode lengkap. Urutan memakai ID sebagai tie-breaker; pagination berbasis offset bukan snapshot lintas perubahan katalog.
- 400 validasi/multipart tidak lengkap, 401 sesi hilang/berakhir, 403 role/origin/CSRF, 404 entri/aset, 409 duplikat/pemulihan, 413 batas body/file/part, 415 POST bukan multipart, 429 upload sibuk (`Retry-After: 1`), 507 quota/disk, 503 timeout/storage tidak aman. Kegagalan tak terduga menjadi 500 tanpa membocorkan path/error internal.
- Pada 409 `CATALOG_RESTORE_REQUIRED`, admin memilih pemulihan lalu mengirim **upload lengkap kembali** beserta `restoreId=existingId`. ID, pembuat, tanggal pembuatan, judul/deskripsi/lisensi lama dipertahankan; cover memakai upload baru atau kosong. Edit metadata sesudah restore bila diperlukan. Upload dengan hash/console berbeda tidak dapat memulihkan ID itu.
- Unduh mendukung satu rentang `bytes=start-end`, `bytes=start-`, atau `bytes=-suffix`. Range tidak satisfiable mendapat 416; multi-range/sintaks yang tidak didukung diabaikan menjadi 200. Tanpa validator aset yang dapat digunakan, `If-Range` menyebabkan pengiriman penuh. Tidak ada respons 304 untuk aset dinamis. Delete memblokir permintaan baru, bukan menarik kembali byte atau stream yang sudah dibuka.

## Konfigurasi dan operasional

| Variabel | Default | Fungsi |
| --- | --- | --- |
| `MAIN_DULU_CATALOG_QUOTA_BYTES` | `21474836480` (20 GiB) | Kuota fisik katalog, terpisah dari quota akun/save |
| `MAIN_DULU_CATALOG_MIN_FREE_BYTES` | `268435456` (256 MiB) | Ruang disk yang disisakan saat admission, 0 untuk menonaktifkan reserve minimum |
| `MAIN_DULU_CATALOG_UPLOAD_LIMIT` | `2` | Batas reservasi upload bersama antarproses yang memakai direktori data sama; 1–16 |
| `MAIN_DULU_CATALOG_UPLOAD_TIMEOUT_MS` | `1800000` (30 menit) | Deadline upload/publikasi; 1 detik–1 jam |

Quota katalog menerima 1 KiB–1 TiB; reserve disk maksimum 1 TiB. Admission menghitung file fisik di empat folder katalog, termasuk staging/orphan/tombstone yang belum bersih, ditambah **reservasi penuh** upload aktif. Perhitungan sengaja konservatif dan dapat sementara menolak upload meskipun jumlah aset aktif belum mencapai quota. Sampel disk di luar transaksi SQLite dibatalkan bila generasi reservasi berubah; reservasi dibuat dalam transaksi singkat bersama antarproses. Tidak menahan transaksi selama streaming/hash.

Request multipart tanpa Content-Length mereservasi batas maksimum route. Dengan Content-Length valid, reservasi mengikuti ukuran request. Total body dibatasi ROM + cover + 128 KiB overhead (POST game), BIOS + 128 KiB (POST BIOS), cover + 128 KiB (PATCH game); field/file tetap memiliki limit terpisah. Counter wire juga membatasi preamble/header/epilogue; request yang melampaui batas dapat ditutup setelah penolakan. API akun tetap 64 KiB; limit state/progres tidak dinaikkan. Deadline lifecycle API biasa tetap 30 detik; streaming unduhan tidak diberi batas lifecycle upload.

Reservasi proses mati kedaluwarsa pada deadline; stagingnya tetap dihitung sebagai penggunaan disk dan tidak dihapus online. Untuk segera membersihkan, hentikan semua proses dan jalankan `npm run storage:recover`, tinjau laporan, lalu `npm run storage:recover -- --apply`. Apply offline juga membersihkan reservasi dan menyelesaikan antrean yang berkasnya sudah tidak ada. File asing/tidak aman membuat admission fail-closed; jangan menaruh catatan atau berkas manual di folder internal.

Worker cleanup memeriksa maksimal 32 pekerjaan per detik, retry eksponensial 1 detik–5 menit, dan melanjutkan antrean SQLite setelah restart. Key final tidak pernah dipakai ulang; restore selalu mempromosikan key baru. Worker tidak menyapu staging atau semua orphan. File yang masih terbuka dapat gagal dihapus pada Windows; akses baru tetap 404 dan penghapusan dicoba lagi. Kegagalan setelah rename sebelum descriptor final kembali dapat meninggalkan orphan untuk recovery offline. Shutdown menunggu pekerjaan katalog yang masih berjalan sebelum menutup database.

Quota/reserve bukan jaminan disk tidak pernah penuh: save, proses lain, dan operator juga dapat memakai volume. Jika mendapat 507, jangan menghapus database/save; periksa ruang disk dan laporan recovery. Jika mendapat timeout/lost response, periksa katalog dahulu; retry dapat mengembalikan duplikat bila commit sebenarnya berhasil. Hanya unggah ROM/firmware yang berhak didistribusikan. Storage di luar `public/` **tidak menjadikan aset aktif privat**.

Backend Docker meneruskan empat variabel di atas dan memasang dependensi produksi multipart/decoder. Lockfile mencakup paket sharp Linux musl; **build/runtime Alpine belum diklaim** karena Docker CLI tidak tersedia pada lingkungan Windows ini. Jangan menghapus optional dependencies ketika memasang sharp.

### Reverse proxy

Default Nginx sering menolak upload di atas 1 MiB. Untuk deployment proxy yang sudah dikonfigurasi operator, sesuaikan **location API admin katalog saja**, bukan body limit akun/save di aplikasi. Contoh tambahan, bukan konfigurasi TLS lengkap:

```nginx
location ~ ^/api/admin/(games|bios)(/|$) {
    client_max_body_size 777m;
    client_body_timeout 1800s;
    proxy_request_buffering off;
    proxy_send_timeout 1800s;
    proxy_read_timeout 1800s;
    proxy_set_header Host $http_host;
    proxy_pass http://127.0.0.1:7777;
}
```

`proxy_request_buffering off` mencegah proxy menampung ROM penuh sebelum guard backend bisa menolak akses. Timeout Nginx di atas adalah idle timeout, bukan deadline total aplikasi. Selaraskan bila deadline server diubah, jangan cache/menimpa `Cache-Control: no-store` pada API/aset dinamis, dan jangan mengganti error API/aset dengan HTML. Batas BIOS 32 MiB dan cover 8 MiB tetap ditegakkan aplikasi walaupun location menerima request lebih besar. Contoh proxy/HTTPS ini belum diuji runtime pada milestone ini.
