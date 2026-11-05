# M4 — Pengelola Cache dan Pengalaman Kegagalan

Lanjutan [rencana cache IndexedDB ROM/BIOS](rencana-cache-indexeddb-rom-bios.md) dan [integrasi Player M3](milestone-3-cache-indexeddb-player.md).

Status: **selesai pada 2026-11-05 dalam cakupan pengelola cache/UX kegagalan**, termasuk regresi penuh. **Default tetap nonaktif**. Pengguna dapat memilih opt-in melalui Pengaturan; ini bukan aktivasi default/rollout M6 atau pembuktian file besar M5.

## Implementasi dan Kebijakan UI

- `src/components/AssetCacheSettings.tsx`, `src/App.tsx`, `src/styles.css`: panel Pengaturan dengan toggle, budget 256 MiB–8 GiB (default 2 GiB), daftar metadata ROM/BIOS, jumlah aset, ukuran terkomit, serta staging/reservation secara terpisah. Nilai budget lama/custom tetap dapat ditampilkan. Statistik memakai `stats()` metadata-only, bukan enumerasi payload Blob.
- Hapus satu versi aset atau semua cache memerlukan Dialog konfirmasi. Operasi memakai `AssetCache.delete()`/`clear()` yang sudah memiliki fencing; tidak memanggil penghapusan database origin generik. Clear mencakup staging aktif tetapi mempertahankan pengaturan cache. Save state, SRAM, progres, akun, favorit dan riwayat bukan sasaran operasi ini.
- Mematikan cache mempertahankan entry lama, membatalkan writer lewat kebijakan M1, dan memakai jalur URL lama pada peluncuran berikutnya. Pengaktifan kembali dapat menjalankan LRU sesuai budget. Penurunan budget meminta konfirmasi karena saat cache aktif dapat langsung menghapus entry lama; perubahan yang tidak dapat memenuhi budget gagal tanpa klaim berhasil.
- `src/lib/asset-cache-ui.ts`: label status membedakan download selesai/verifikasi, penyimpanan yang belum dikomit, cache dipakai, tersimpan, dan dimainkan tanpa disimpan beserta alasan. Helper ini tidak mengubah hasil transaksi resolver menjadi sukses.
- Player memiliki progressbar download berlabel dan tombol Batalkan persiapan melalui lifecycle keluar yang sudah ada. Download dimulai pada fase menunggu header GET, bukan masih menampilkan membaca cache. Tombol start engine tetap manual. Status cache tidak dicampur dengan notifikasi Autosave/sinkronisasi progres akun.
- `src/lib/player-assets.ts`: pembacaan settings cache yang gagal tetap memilih jalur URL lama (tidak mengasumsikan aktivasi), tetapi sekarang memberi pesan cache tidak tersedia. Kegagalan storage sesudah settings aktif tetap ditangani resolver M2 sebagai satu download terverifikasi dengan hasil tidak disimpan.
- `navigator.storage.estimate()`, `persisted()`, dan `persist()` bersifat opsional. Permintaan persistence hanya lewat tombol pengguna; tidak ada/ditolak/throw ditampilkan tanpa menghalangi penggunaan cache atau game. Estimasi ditandai sebagai **seluruh origin**, bukan ukuran cache. Persetujuan persistence tidak disebut permanen.
- Penjelasan UI mencakup origin/profil browser, penggunaan bersama semua akun, logout tidak menghapus cache, data tidak terenkripsi, risiko eviction, dan bukan mode offline. File lokal/demo tetap tidak eligible.

## Sinkronisasi dan Lifecycle

`src/lib/asset-cache-events.ts` menyediakan notifikasi same-tab serta BroadcastChannel opsional. `AssetCache` mengirim notifikasi hanya **sesudah transaction complete** untuk perubahan metadata yang relevan; abort tidak mengirim klaim perubahan berhasil. Isi pesan hanya nama database, tanpa bytes/descriptor/token/akun. Pesan tidak membawa data otoritatif: penerima selalu membaca ulang metadata IndexedDB.

Panel juga membaca ulang saat fokus/visibility kembali serta polling metadata setiap lima detik ketika terlihat. Ini mencakup browser tanpa BroadcastChannel dan perubahan staging per chunk tanpa membanjiri kanal. Tidak ada dedup download lintas tab atau jaminan sinkronisasi instan yang ditambahkan.

Pembacaan metadata dikoaleskan; koneksi berumur pendek ditutup dalam `finally`. Unmount/StrictMode cleanup membatalkan transaksi milik panel dan melepas listener, kanal, serta timer. Permintaan browser storage memiliki fencing hasil UI setelah unmount. Error mutasi tidak dihapus oleh refresh/polling sukses; kegagalan hapus ditampilkan **di dalam** Dialog dan bisa dicoba ulang.

Escape/Batal mengembalikan fokus ke pemicu Dialog. Setelah mutasi sukses, fokus dipindahkan ke tombol Perbarui cache sesudah cleanup Dialog, sehingga tidak tertinggal pada tombol aset yang dihapus oleh refresh metadata. Tes akhir juga mengonfirmasi penurunan budget melalui UI, bukan hanya pembatalannya.

## Pengujian

Suite tambahan:

- `tests/asset-cache-ui.test.mjs`: unit ukuran biner, tahapan/status persistence, API storage absen/invalid/ditolak/throw/disetujui dan receiver metode.
- `tests/browser/asset-cache-settings.spec.ts`: UI aplikasi nyata + transaksi IndexedDB browser; helper hanya mengisi fixture/menginjeksi kegagalan di `tests/fixtures/asset-cache-settings.ts`, tidak dikirim dalam build.
- Tambahan M4 pada `tests/browser/catalog-indexeddb-cache.spec.ts`: Player/engine NES/backend nyata, kegagalan chunk quota/commit abort, clear dari tab lain, pembatalan, API opsional tidak ada, settings IDB gagal, serta HTTP LAN non-loopback.

Perintah reproduksi:

```text
npm test
npm run build
npm run test:e2e:backend -- tests/browser/asset-cache-settings.spec.ts tests/browser/catalog-indexeddb-cache.spec.ts
npm run test:e2e:backend
npm run test:e2e:production
```

Build diselesaikan sebelum browser suite. Output production dipisah dari `test-results/` backend agar suite tidak saling membersihkan artefak/data. Tes transfer IndexedDB mematikan HTTP cache melalui CDP; tes HTTP cache historis tetap memakai pengaturan aslinya.

### Hasil verifikasi akhir

Lingkungan: Windows x64, Node.js **v26.12.1**, Microsoft Edge headless **156.0.4314.58**; context tes terisolasi, bukan profil pribadi.

- Unit terakhir: **305/305 lulus**, tanpa fail/skip/cancel, sekitar **45,8 detik**.
- Build **lulus** dengan warning bundle frontend >500 kB (sekitar **534 kB sebelum gzip**), bukan build failure.
- TypeScript aplikasi serta pemeriksaan strict spec/fixture M4 dan spec aplikasi yang diperbarui **lulus**.
- Run terfokus kedua: **27/27 lulus**, tanpa retry/skip, sekitar **2,2 menit**, sebelum penambahan skenario LAN terakhir.
- Run terfokus M4 pada build terakhir: **18/18 lulus**, tanpa retry/skip, sekitar **47,6 detik** (11 panel + 7 Player, termasuk HTTP LAN nyata).
- Suite production statis penuh pada build terakhir: **66 lulus/77 skip**, tanpa fail/retry, sekitar **2,0 menit**. Sebelas skenario panel cache berjalan juga pada hosting statis. Skip mencakup tujuh tes Player/backend M4 dan skenario backend lain, bukan kelulusan implisit.
- Suite backend penuh pada build terakhir: **138/138 lulus**, tanpa fail/retry/skip, sekitar **11,5 menit**. Termasuk 18 tes M4, sepuluh integrasi M3, storage M1/resolver M2, HTTP cache historis, katalog, akun, state/SRAM/autosave, import/export dan pergantian akun.
- `node --check public/player/player.js` dan `git diff --check`: **lulus**. Hash helper dan bridge di `dist/player/` cocok dengan `public/player/`; fixture/injeksi tes tidak ditemukan dalam JS distribusi.

Screenshot Dialog pada viewport **375×812** disimpan di output tes; pemeriksaan visual menunjukkan teks panjang dan tombol konfirmasi tetap muat. Output production berada di `C:\Users\Ardi Putra\AppData\Local\Temp\opencode\maindulu-m4-production-results`.

### Kegagalan selama pengembangan

Run browser terfokus awal: **19 lulus/3 gagal**. Dua masalah fixture diperbaiki: quota diinjeksikan ke `put` padahal chunk memakai `add`, serta query sentinel memakai nama tabel/key save yang tidak sesuai schema. Satu masalah UX diperbaiki: menunggu header GET masih menampilkan fase membaca cache; fase downloading sekarang dimulai sebelum request GET sehingga progress/cancel tersedia saat koneksi menunggu. Kegagalan ini tidak dihitung sebagai hasil lulus.

Production awal: **64 lulus/76 skip/2 gagal** karena tes riwayat lama mencari satu `switch` tanpa nama, padahal sekarang ada switch cache tambahan. Locator diperjelas memakai label riwayat; assertion perilaku tidak dikurangi. Percobaan berikutnya backend/production berhenti saat koleksi karena salah satu edit locator memiliki kurung berlebih; sintaks dibetulkan sebelum run ulang. Pemeriksaan TypeScript standalone pertama tanpa mode strict juga menghasilkan dua error narrowing pada modul akun yang tidak diubah; pemeriksaan ulang memakai strict/allowJs seperti konteks proyek lulus.

Backend penuh pertama: **137 lulus/1 gagal**, sekitar **11,8 menit**. Fixture LAN tidak mengaktifkan akun melalui HTTP, sehingga guard aplikasi benar-benar meminta konfirmasi eksplisit untuk bermain sebagai tamu. Playwright secara default membatalkan prompt tersebut; tes kini memeriksa teks dan menerima prompt selama peluncuran tamu. Guard/config keamanan aplikasi tidak dilemahkan. Run 18 tes M4 sesudah perbaikan lulus termasuk LAN; suite penuh diulang pada build terakhir.

### Bukti utama M4

1. Commit abort setelah request sukses dan quota pada transaksi chunk menghasilkan status **Dimainkan tanpa disimpan**, bukan tersimpan; engine NES tetap aktif, satu GET/body origin penuh, tanpa entry siap/staging palsu. Hit berikutnya tetap HEAD segar dengan GET/body origin nol pada tes M3 dan LAN M4.
2. Toggle/budget bertahan setelah reload dokumen. Penurunan budget dapat dikonfirmasi/dibatalkan. Daftar mengikuti entry committed, delete, clear, eviction dan tab lain tanpa reload, dengan fallback fokus saat BroadcastChannel tidak ada.
3. Staging ditampilkan terpisah dari aset siap. Clear melalui UI membuat writer yang masih pending tidak dapat commit. Clear yang transaksi request-nya sukses lalu abort mempertahankan entry dan menampilkan error di Dialog; retry sukses dilaporkan setelah commit.
4. Delete/clear tidak mengubah database sentinel guest `EmulatorJS-states` atau LocalStorage sentinel. Pada akun nyata, clear di tab lain mempertahankan CPU-written SRAM aktif, checksum state/progres server, riwayat dan sesi login. Peluncuran ulang dengan toggle off dari UI memulihkan progres akun tanpa mengisi cache.
5. Dialog menangani Escape/Tab/Shift+Tab, pemulihan fokus saat batal maupun sesudah entry dihapus, label progressbar/status terpisah, pembatalan persiapan serta viewport ponsel tanpa overflow.
6. API storage absen/ditolak/throw/disetujui diuji terpisah. Origin HTTP LAN non-loopback nyata memiliki `isSecureContext = false` dan tanpa `crypto.subtle`; toggle UI, download/commit, engine NES, hit tanpa GET dan daftar sesudah reload tetap bekerja. Akun HTTP tidak diaktifkan diam-diam; konfirmasi bermain sebagai tamu tetap dilakukan.

## Batas Bukti

- Reload dokumen/metadata bukan restart seluruh proses browser. Profil persistent setelah restart, transfer produksi 329.641.708 byte/500 MiB dan pengukuran resource tetap **M5**.
- Quota/abort diuji secara deterministik pada transaksi IndexedDB browser nyata melalui fixture; bukan bukti disk fisik penuh atau actual browser quota exhaustion.
- Engine otomatis menggunakan NES legal orisinal 24.592 byte dan BIOS sintetis 512 byte. Tidak ada gameplay CHD/PS1, firmware proprietary, atau memcard PS1 nyata baru pada M4.
- Pengujian keyboard/fokus, label aksesibel dan viewport ponsel bukan audit manual screen reader atau perangkat mobile fisik. Persetujuan/penolakan persistence diuji lewat API injeksi, bukan klaim browser tertentu selalu memberi izin.
- Tidak ada perubahan vendor/core/fingerprint engine, schema cache v1, backend SQLite, identitas save, atau format progres. Tidak membuktikan Docker/Linux, HTTPS reverse proxy, Firefox/Safari, atau rollout deployment.

**Gate M4 terpenuhi:** hasil simpan/gagal dapat diketahui pengguna, dan pengelolaan hanya menyasar cache ROM/BIOS tanpa merusak save/progres. Berikutnya **M5 — restart proses browser, file besar, LAN/resource dan race produksi**.
