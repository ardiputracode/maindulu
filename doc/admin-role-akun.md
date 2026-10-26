# Role akun dan otorisasi admin

Fondasi Milestone 1 pada [rencana Admin/Library/BIOS](rencana-admin-library-game.md), **selesai dan terverifikasi pada 2026-10-26** dalam cakupan pengujian di bawah. **Belum menyediakan halaman admin, katalog dinamis, atau upload game/BIOS.**

## Promosi dan demosi

Daftarkan akun biasa melalui aplikasi terlebih dahulu. Dari terminal server di akar proyek:

```sh
npm run account:role -- username admin
npm run account:role -- username user
```

Gunakan `MAIN_DULU_DATA_DIR` yang sama dengan server. CLI menolak database/akun yang tidak ada, tidak membuat akun, dan tidak menerima role selain `user`/`admin`. Username dinormalisasi seperti saat login. Menetapkan role yang sama aman diulang. Tidak ada rahasia yang diminta atau dicetak; input interaktif tidak diperlukan. Akses terminal/OS harus dibatasi kepada pengelola tepercaya.

Untuk Docker backend aktif, gunakan **exec ke container yang sama**:

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml exec backend npm run account:role -- username admin
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml exec backend npm run account:role -- username user
```

Tanpa env-file untuk instalasi localhost default. Jika server sudah berhenti, gunakan `run --rm --no-deps backend npm run account:role -- username admin` dengan volume/environment yang sama. Jangan jalankan container maintenance terpisah terhadap server aktif: lock namespace berbeda sengaja ditolak. Jangan menghapus lock hidup untuk melewatinya.

CLI mengambil lease shared melalui `openDatabase`, sama seperti reset akun. Backup/verify/restore dengan lease eksklusif memblokir perubahan role. Perubahan mempertahankan ID, password, kode pemulihan, sesi, dan seluruh save. Tidak ada larangan menurunkan admin terakhir; operator OS dapat mempromosikan akun lagi.

## Kontrak dan keamanan

- Migrasi SQLite **6 → 7** menambahkan `users.role`, `NOT NULL`, default `user`, dengan CHECK `user`/`admin`. Seluruh akun lama dan pendaftar baru menjadi `user`; pendaftar pertama bukan admin otomatis.
- Respons register/login/session/csrf menyertakan `user.role`. Parser frontend menolak role hilang/tidak dikenal. `useAccount` menerapkan role dari sesi server, termasuk refresh saat fokus dan setiap 60 detik; bukan dari LocalStorage atau payload frontend.
- `GET /api/admin/status` mengembalikan `200 {"ok":true}` untuk admin, **401** untuk tamu/sesi kedaluwarsa/palsu, dan **403** untuk akun biasa. Respons tidak di-cache. Sesi akun biasa tetap bisa memakai API save seperti sebelumnya.
- Guard bersama `security.requireAdmin(request)` membaca sesi dan role terkini dari database setiap kali dipanggil. Promosi/demosi berlaku pada request berikutnya tanpa login ulang, termasuk lintas koneksi server. Tampilan frontend mungkin baru berubah saat refresh sesi; backend tidak menunggu refresh tersebut.
- Operasi pengelolaan berikutnya harus memakai `security.protectAdmin` pada hook `onRequest`, sebelum parsing body/upload. Setelah pekerjaan asinkron, periksa kembali `requireAdmin` di dalam transaksi penerbitan/perubahan agar role yang sudah dicabut tidak dapat commit.
- Multipart hanya diizinkan jika route server memilih `protectAdmin(request, { multipart: true })`; ini tetap mewajibkan origin tepat, cookie sesi, dan header `X-CSRF-Token`. Tidak ada parser/upload multipart produksi pada milestone ini. API akun tetap JSON 64 KiB, API save tetap pada batas/tipe masing-masing; tidak ada pelonggaran global.
- Payload register/login/password/recovery tidak dapat menetapkan role. Tidak tersedia endpoint atau UI pengelolaan role. Reset/pemulihan kredensial mempertahankan role; operator perlu mendemosikan secara eksplisit bila ingin mencabut akses admin.
- Health API mengiklankan `admin: true`, `gameCatalog: false`, `biosCatalog: false`. Capability admin berarti guard dan pemeriksaan akses tersedia, **bukan** upload/UI siap.

## Update dan backup

Sebelum migrasi, hentikan server/CLI dan buat backup offline dengan versi aplikasi lama. Setelah database versi 7 dibuat, jangan paksa downgrade. CLI backup saat ini menerima format 1 dengan skema **7**; backup skema 6 harus diverifikasi/di-restore memakai versi lama terlebih dahulu, lalu hasil restore dapat dimigrasikan oleh server baru. Sumber backup tidak dimigrasikan otomatis.

Backup skema 7 menyertakan role melalui snapshot tabel `users`; restore mempertahankannya dan mencabut semua sesi seperti sebelumnya. ROM/BIOS/cover belum tercakup—backup koleksi dinamis baru boleh dinyatakan lengkap setelah Milestone 7 rencana Admin/Library/BIOS.

## Cakupan pengujian

`tests/admin-roles.test.mjs` mencakup status 401/403/200, perubahan sesi aktif lintas koneksi/proses, bypass payload, pemulihan/reset admin, validasi role database, CSRF sebelum parsing multipart, pembatasan tipe/batas akun, migrasi akun/sesi/state/progres skema 6, dan penolakan CLI selama maintenance. `tests/data-backup.test.mjs` memverifikasi role admin tetap ada setelah backup/restore. Uji terminal reset lama tetap berada di `tests/admin.test.mjs`.

Pengujian guard multipart memakai route/parser khusus tes, bukan klaim upload streaming produksi sudah tersedia. Build/runtime Docker dan reverse proxy HTTPS nyata perlu diverifikasi terpisah di lingkungan tujuan.

### Hasil verifikasi pengembangan (2026-10-26)

- `npm test`: **125 lulus**, tanpa gagal/skip pada pengulangan terakhir setelah seluruh perbaikan tes; mencakup penolakan backup skema 6 oleh CLI baru.
- `npm run build`: **lulus**.
- `npm run test:e2e -- tests/browser/backend.spec.ts --output=test-results/role-static-dev-final`: **5 lulus**.
- `npm run test:e2e:production -- tests/browser/backend.spec.ts --output=test-results/role-static-production`: **5 lulus**.
- `npm run test:e2e:backend -- tests/browser/account.spec.ts tests/browser/server-saves.spec.ts tests/browser/server-game-saves.spec.ts --output=test-results/m1-backend-final`: **30 lulus dalam 11,9 menit**, tanpa gagal/retry/skip. Mencakup 8 skenario akun, state/progres NES, konflik dua tab, isolasi tamu/akun, kegagalan upload/fetch, kuota, Autosave, restart, dan backup/restore. Ini rangkaian tiga file tersebut, bukan seluruh skenario browser proyek atau bukti semua core.
- Sebelum rangkaian akhir, kedua tes konflik SRAM lulus terisolasi (**2/2**), lalu lima tes state yang sebelumnya gagal lulus terisolasi (**5/5**). Semua tes browser dijalankan berurutan, tidak bersamaan dengan rangkaian engine lain.

**Riwayat kegagalan dan perbaikan tes:** percobaan awal terpotong timeout shell; rangkaian lama berikutnya selesai dengan **23 lulus / 7 gagal**. Pemeriksaan teks sementara diganti dengan checksum snapshot di database. Kedua tab memakai nilai SRAM yang berbeda dari semua nilai perantara tab lain, sehingga pengakuan idempoten atas snapshot identik tidak keliru diharapkan sebagai konflik. Tes menunggu konflik otomatis alih-alih menekan tombol manual yang memang dinonaktifkan saat konflik, serta membandingkan revisi terhadap baseline aktual. Helper overlay memakai event DOM toolbar yang sama seperti tes progres agar tidak berebut hit testing dengan canvas/auto-hide; pembacaan state tamu menunggu penulisan IndexedDB selesai. Pemeriksaan checksum, konflik, revisi, snapshot, dan pemulihan tetap dipertahankan. Perbaikan ini hanya pada tes, bukan perubahan runtime akun/player/save atau pelonggaran keamanan.

**Kesimpulan:** kriteria Milestone 1 terpenuhi dalam cakupan tersebut; milestone ditutup. Docker runtime, reverse proxy HTTPS nyata, gameplay core selain NES, dan pengelolaan katalog/upload tetap di luar bukti otomatis penutupan ini.
