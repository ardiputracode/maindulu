# Milestone 4 — UI Pengelolaan Game dan BIOS

Bagian dari [rencana Admin/Library/BIOS](rencana-admin-library-game.md). Implementasi ini memakai API Milestone 3 tanpa perubahan skema, identitas save, player, atau bundle engine.

**Kelanjutan:** batas di bawah menjelaskan kondisi saat Milestone 4 ditutup. [Milestone 5](milestone-5-library-player.md) menambahkan Library/pilihan BIOS API. Sesuai keputusan pengguna berikutnya, backup byte ROM/BIOS tidak diperlukan; [backup metadata format 2](backup-metadata-katalog.md) mempertahankan akun/save/ID katalog tanpa menyalin aset dan tidak mensyaratkan katalog kosong.

## Menggunakan admin

1. Jalankan backend (`npm run build`, lalu `npm start`), buat akun biasa, dan simpan kode pemulihan.
2. Pada terminal server dengan direktori data yang sama, jalankan `npm run account:role -- username admin`. Pendaftar pertama tidak otomatis admin. Untuk Docker ikuti [panduan role backend](../deploy/README.backend.md#role-admin-fondasi-belum-dirilis).
3. Login atau muat ulang halaman. Menu **Admin** hanya muncul setelah sesi mengonfirmasi role admin. `/admin` menampilkan ringkasan; **Manage Game** di `/admin/games` dan **Manage BIOS** di `/admin/bios` terpisah. URL langsung dan refresh didukung backend.
4. Pilih **Upload game** atau **Upload BIOS**, isi console, judul/nama, berkas, deskripsi, dan lisensi/hak distribusi. Cover game opsional. Form memakai batas backend: ROM 768 MiB, BIOS 32 MiB, cover PNG/JPEG/WebP 8 MiB dan 4096 × 4096 piksel tanpa animasi. SVG/HTML tidak diterima.
5. Untuk BIOS raw, pertahankan nama firmware yang diharapkan core; nama hanya ASCII huruf/angka/titik/garis bawah/minus. Arsip mempertahankan nama anggotanya. Format/nama/checksum bukan jaminan kompatibilitas atau hak distribusi.

**Aset aktif bersifat publik**, meskipun disimpan di luar `public/`. Jangan upload ROM/firmware tanpa hak distribusi. Berkas lokal yang dibuka melalui **Buka ROM** tetap tidak diunggah otomatis.

## Daftar, edit, delete, dan restore

- Daftar admin memiliki pencarian, filter console/status aktif/terhapus, pagination 12 entri, ukuran, tanggal upload, nama berkas, SHA-256, status ketersediaan, dan antrean pembersihan. Filter/halaman disimpan pada query URL. **Muat ulang daftar** memeriksa ulang status; status bukan pemantauan realtime.
- Edit hanya mengubah metadata dan, untuk game, mengganti/menghapus cover. Console, byte ROM/firmware, serta ID tidak dapat diganti. ID lama dan hubungan save tidak berubah.
- Delete selalu memerlukan dialog konfirmasi. Save/progres/akun tidak dihapus; katalog dan akses baru ditutup sebelum berkas dibersihkan dengan retry. Byte yang sudah diunduh tidak bisa ditarik kembali.
- Delete BIOS mengingatkan bahwa sesi berikutnya mungkin membutuhkan firmware lain atau BIOS lokal. Pilihan pengguna tidak dialihkan otomatis.
- Duplikat aktif ditampilkan sebagai error. Untuk berkas terhapus, upload ulang byte yang sama pada console yang sama lalu pilih **Pulihkan ID lama** secara eksplisit. Berkas dikirim ulang bersama `restoreId`; judul/deskripsi/lisensi lama dipertahankan, cover memakai upload baru atau kosong. Edit metadata sesudah restore bila diperlukan. Mengganti berkas/console membatalkan kandidat restore di form.

## Upload dan keamanan sesi

- UI membedakan pemeriksaan sesi, persentase pengiriman (XHR), dan pemrosesan server. **100% terkirim bukan konfirmasi penerbitan**; form menunggu respons sukses server.
- **Batalkan permintaan** menghentikan request; Escape/tutup dialog dinonaktifkan selama operasi. Saat tidak sibuk, dialog memakai fokus terperangkap, Escape, dan pengembalian fokus dari komponen `Dialog` bersama.
- Pembatalan/koneksi putus bisa terjadi setelah server commit. UI meminta admin memeriksa daftar sebelum mencoba lagi, dan memuat ulang daftar setelah operasi gagal/dibatalkan atau form ditutup. Duplikat tetap ditangani server.
- Setiap mutasi mengambil sesi/CSRF terbaru, memastikan akun yang sama masih admin sebelum mengirim berkas, lalu backend tetap mengotorisasi ulang. HTTP 401/403 menghentikan tampilan pengelolaan dan memperbarui sesi. Role terbaru juga diperiksa backend saat publikasi, bukan hanya frontend.
- CSRF hanya berada dalam memori/header, tidak pada URL atau browser storage. Multipart boundary dibuat browser; batas body API akun/save tidak dinaikkan. Bootstrap sesi dibatasi 10 detik; daftar, delete, dan edit JSON 15 detik; upload mengikuti deadline backend dan bisa dibatalkan.

## Batas cakupan

- **Upload belum muncul pada UI bermain.** Library dan pemilihan BIOS dari API tetap Milestone 5. Katalog manifest, demo, ROM/BIOS lokal, player, dan namespace save tidak diubah.
- **Backup hanya akun/save/metadata, bukan byte koleksi.** Format 2 tidak menyalin ROM/BIOS/cover dan tidak memerlukan penghapusan katalog agar backup berjalan. Setelah restore bersih, admin menandai berkas hilang; upload ulang byte identik pada console yang sama menawarkan pemulihan ID lama secara eksplisit, termasuk pada entri aktif. Berkas aktif yang masih ada tidak dapat diganti. Cover dapat diunggah ulang lewat edit metadata. Gerbang pengujian/deploy Milestone 6–7 tetap terpisah.
- Mode statis tidak memanggil API dan tidak menampilkan menu admin. Membuka URL admin pada host statis dengan SPA fallback menampilkan keterangan fitur tidak tersedia.
- Tidak ada UI pengelolaan role, upload massal, penggantian byte ROM/BIOS, atau ekstraksi arsip di server.

## Verifikasi

Ditutup **2026-11-03** dalam cakupan UI pengelolaan. Tes baru: `tests/admin-catalog-client.test.mjs` (kontrak respons, CSRF, penolakan sesi/role sebelum upload, fase XHR, abort) dan `tests/browser/admin-catalog.spec.ts` (backend nyata + UI). `tests/server.test.mjs` memeriksa HTML deep link admin.

| Perintah / cakupan | Hasil aktual |
| --- | --- |
| `npm test` | **189 lulus**, tanpa skip/gagal |
| `npm run build` | **Lulus**; diulang setelah penyempurnaan akhir |
| `npm run test:e2e:backend -- --output=test-results/m4-backend` | **62 lulus** tanpa retry/skip, 5,3 menit: akun, UI admin, app/player, discovery, API katalog, state, dan progres NES |
| `npm run test:e2e:backend -- admin-catalog.spec.ts backend.spec.ts catalog-api.spec.ts --output=test-results/m4-final` | **18 lulus** tanpa retry/skip, 26,1 detik, setelah perubahan akhir |
| `npm run test:e2e -- backend.spec.ts --output=test-results/m4-static-dev` | **6 lulus**: discovery/tamu/deep link admin statis |
| `npm run test:e2e:production -- backend.spec.ts --output=test-results/m4-static-production` | **6 lulus** pada build produksi statis, cakupan discovery/tamu yang sama |

Sepuluh tes UI membuktikan login admin, refresh/deep link, upload game + cover, penggantian/penghapusan cover, edit metadata tanpa mengubah ID/hash, delete, upload/edit/delete BIOS + nama/SHA-256, duplikat dan restore ID, pagination/pencarian/filter, mobile/keyboard, penyembunyian konten selama pemeriksaan sesi, penolakan tamu/user, storage error, fase pemrosesan setelah seluruh body diterima, pembatalan, sesi kedaluwarsa, validasi berkas, retry daftar, dan pencabutan role sebelum upload maupun saat finalisasi server. Pemeriksaan screenshot desktop/mobile dilakukan pada hasil tes. Fokus setelah delete dikembalikan ke tombol upload yang tetap ada, bukan tombol baris yang sudah dihapus.

Percobaan awal tes pemrosesan menahan request melalui intersepsi Playwright sehingga XHR belum benar-benar mengirim body dan tetap 0%. Tes diperbaiki untuk menunda promosi berkas pada server nyata setelah body diterima; runtime tidak diubah untuk memalsukan fase pemrosesan. Fixture juga menutup context browser sebelum server agar koneksi tertunda tidak memperlambat cleanup.

BIOS/ROM sintetis pada tes UI hanya membuktikan pengelolaan, bukan gameplay/boot. Smoke engine Milestone 3 tetap terpisah. Docker/Alpine, HTTPS/proxy nyata, disk penuh fisik, dan upload ROM 768 MiB penuh bukan klaim verifikasi milestone ini.
