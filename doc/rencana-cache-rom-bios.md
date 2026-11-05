# Rencana Cache ROM/BIOS Server

Status: **diimplementasikan dan terverifikasi pada 2026-11-04** dalam cakupan backend dan browser/fixture di bawah. Commit implementasi: `1c5f8f8`.

Dokumen ini menyimpan desain awal, checklist yang sudah diselesaikan, hasil aktual, batas verifikasi, dan rollback. Ringkasan pengguna ada di [README](../README.md#http-cache-rombios-backend); kontrak endpoint dan reverse proxy ada di [panduan API katalog](milestone-3-api-katalog.md#kontrak-http).

## Tujuan

> **Lanjutan IndexedDB (2026-11-05):** [rencana baru](rencana-cache-indexeddb-rom-bios.md), [bukti restart/file besar M5](milestone-5-cache-indexeddb-verification.md), dan [operasi/rollout M6](milestone-6-cache-indexeddb-rollout.md). Cache HTTP dalam dokumen ini tetap berlaku untuk jalur URL lama; IndexedDB adalah pipeline frontend terpisah, default aktif untuk database/profil baru dan tetap mengikuti preferensi lama. M6 cache ditutup untuk cakupan lokal/HTTP LAN dengan konfirmasi manual Docker/CHD pengguna; HTTPS dilewati/ditunda, bukan dinyatakan lulus. Hasil historis di bawah tidak diubah menjadi klaim pengujian IndexedDB atau deployment baru.

Mengurangi unduhan ulang ROM/BIOS ketika pengguna memulai sesi baru, termasuk setelah menutup dan membuka kembali browser. Browser menyimpan respons HTTP, memvalidasinya ke server, lalu menggunakan salinan lokal jika konten belum berubah.

## Ruang Lingkup

Endpoint yang diubah:

- `GET` dan `HEAD /games/:id/rom/:filename`
- `GET` dan `HEAD /bios/:id/:filename`

Tetap menggunakan `Cache-Control: no-store` untuk:

- API akun, autentikasi, save, dan metadata katalog.
- Cover katalog.
- Redirect `/games/:id/rom`.
- Respons error, termasuk aset yang sudah dihapus atau tidak tersedia.

Di luar ruang lingkup:

- Game bawaan yang disajikan sebagai file statis dari folder `public/games/`.
- Perubahan kebijakan cache global aset engine atau frontend.
- IndexedDB/OPFS, service worker, mode offline, dan fitur pengelolaan cache.
- Resume unduhan terputus.
- Perubahan penyimpanan save, skema database, atau protokol iframe.

## Kondisi Sebelum Implementasi

- `server/app.mjs` menetapkan `Cache-Control: no-store` secara global.
- `server/catalog/assets.mjs` juga menetapkan `no-store` untuk ROM, BIOS, dan cover.
- SHA-256 ROM/BIOS sudah tersedia pada metadata database sebagai `row.sha256`.
- `public/player/player.js` memeriksa aset server melalui HEAD dan memberikan URL aset kepada EmulatorJS.
- Database cache EmulatorJS dinonaktifkan melalui `EJS_disableDatabases = true` dan `EJS_CacheLimit = 0`.
- EmulatorJS mengambil ROM melalui GET penuh; dukungan Range di server tidak otomatis membuat player melanjutkan unduhan sebagian.

## Desain

### Kebijakan HTTP

Untuk ROM/BIOS yang telah lolos validasi:

```http
Cache-Control: private, no-cache
ETag: "<sha256-file>"
```

- `private` melarang shared cache menyimpan respons.
- `no-cache` memperbolehkan penyimpanan, tetapi mewajibkan validasi sebelum penggunaan ulang.
- ETag menggunakan SHA-256 yang sudah tersimpan; jangan membaca dan menghitung hash seluruh file pada setiap request.
- Jangan memakai `public`, `immutable`, atau masa freshness panjang karena server tetap harus memeriksa ketersediaan entri sebelum cache digunakan kembali.
- Jangan mengubah kebijakan global menjadi cacheable. Override header hanya pada respons sukses ROM/BIOS yang dituju.

### Alur Request

1. Validasi ID dan entri katalog yang masih aktif.
2. Validasi nama file dan storage key.
3. Buka file menggunakan mekanisme storage aman yang ada.
4. Periksa ukuran file dan pastikan referensi storage masih sesuai dengan entri terbaru.
5. Bentuk ETag untuk ROM/BIOS yang valid; tetapkan header cacheable hanya pada respons sukses, bukan pada 416 atau error lain.
6. Evaluasi `If-None-Match` sebelum pemrosesan Range.
7. Jika cocok, tutup handle dan kirim `304 Not Modified` tanpa body maupun header panjang body yang keliru.
8. Jika tidak cocok atau header tidak ada, lanjutkan pengiriman file seperti sekarang.

Ketentuan conditional request:

- Gunakan weak comparison untuk `If-None-Match` pada GET/HEAD.
- Dukung daftar ETag dan wildcard `*` sesuai aturan HTTP.
- Header malformed tidak boleh menyebabkan 304 palsu atau error server.
- ETag tidak cocok harus menghasilkan respons file normal.
- Jangan mengembalikan 304 sebelum pemeriksaan file selesai: entri dihapus, file hilang, ukuran tidak cocok, dan path tidak aman tetap harus menghasilkan error.
- Tetap sertakan ETag serta `Cache-Control: private, no-cache` pada 304.
- Pastikan header cacheable tidak tertinggal pada jalur error; respons error tetap `no-store` dan tidak membawa ETag sukses.

### HEAD dan Range

- HEAD sukses memiliki metadata yang konsisten dengan GET, tetapi tanpa body.
- HEAD bersyarat dengan ETag cocok dapat menghasilkan 304.
- Pertahankan dukungan Range tunggal, suffix, open-ended, serta respons 206/416 yang ada.
- Evaluasi `If-None-Match` sebelum Range: kondisi cocok menghasilkan 304, bukan 206.
- Jangan memperluas implementasi `If-Range` dalam pekerjaan ini; pertahankan perilaku fallback penuh yang ada dan uji regresinya.
- Respons 416 tetap `no-store`.
- Tutup handle file pada semua jalur tanpa stream, termasuk HEAD, 304, dan error.

### Player

- Tetap nonaktifkan database cache EmulatorJS.
- Tetap lakukan preflight HEAD untuk memeriksa aset.
- Jangan menambahkan penanganan manual status 304 pada player. Browser menangani validasi HTTP dan menyajikan respons cache kepada fetch/XHR.
- Jangan mengubah URL aset atau menambahkan cache-busting query acak.
- Perjelas komentar pada bridge: database cache EmulatorJS tetap dimatikan, sedangkan respons aset server boleh disimpan dalam HTTP cache browser.
- File lokal yang dipilih pengguna tidak dimasukkan ke penyimpanan persisten oleh fitur ini.

## Tahapan Implementasi

### 1. Conditional response ROM/BIOS

File utama: `server/catalog/assets.mjs`.

- [x] Tambahkan pembentukan ETag dari SHA-256 tersimpan.
- [x] Tambahkan parsing/perbandingan `If-None-Match` yang sesuai untuk GET/HEAD.
- [x] Pisahkan kebijakan cache ROM/BIOS sukses dari cover dan respons error.
- [x] Tambahkan jalur 304 setelah seluruh pemeriksaan aset berhasil.
- [x] Pertahankan status, panjang body, dan pengelolaan handle pada GET/HEAD/Range.
- [x] Pertahankan `no-store` global di `server/app.mjs` sebagai default aman.

### 2. Tinjau integrasi player

File: `public/player/player.js`.

- [x] Pastikan request ROM/BIOS tidak dipaksa memakai `no-store` atau URL acak.
- [x] Pertahankan preflight HEAD dan penanganan aset hilang.
- [x] Perjelas komentar mengenai perbedaan HTTP cache dan database cache EmulatorJS.
- [x] Jangan mengedit bundle engine hasil generate untuk fitur ini.

### 3. Pengujian backend

File utama: `tests/catalog-api.test.mjs`.

- [x] GET pertama: 200, body utuh, ETag berbasis SHA-256, dan `private, no-cache`.
- [x] HEAD pertama: 200, ETag konsisten, ukuran benar, tanpa body.
- [x] GET/HEAD dengan ETag cocok: 304 tanpa body.
- [x] Daftar ETag, weak tag, wildcard, mismatch, dan input malformed tercakup.
- [x] Perubahan metadata saja tidak mengubah ETag file.
- [x] File berbeda memiliki ETag berbeda; request dengan ETag lama menerima file, bukan 304.
- [x] Entri terhapus dan file hilang tidak menghasilkan 304 meskipun ETag cocok.
- [x] Ukuran file tidak cocok dan path tidak aman tetap ditolak.
- [x] Range tetap menghasilkan 206 dengan byte dan header yang benar.
- [x] Range tidak valid tetap 416 dan `no-store`.
- [x] Conditional request cocok didahulukan atas Range.
- [x] Regresi perilaku `If-Range` tetap tercakup.
- [x] Cover, redirect, API metadata, akun, save, dan error tetap `no-store`.
- [x] Perbarui assertion lama yang mewajibkan `no-store` pada ROM/BIOS sukses saja; jangan melonggarkan assertion endpoint lain.

### 4. Pengujian browser nyata

Pengujian khusus cache ada di `tests/browser/catalog-cache.spec.ts`, terdaftar pada `playwright.backend.config.ts`, dengan pola backend nyata dari `tests/browser/catalog-api.spec.ts`.

- [x] Jalankan backend nyata dengan ROM demo NES yang dapat dimainkan.
- [x] Gunakan profil browser persisten dan origin yang sama selama pengujian.
- [x] Peluncuran pertama menghasilkan transfer body ROM lengkap.
- [x] Keluar dari player lalu mulai sesi kedua: ROM dimainkan tanpa transfer ulang body penuh jika cache tersimpan.
- [x] Tutup browser, buka kembali memakai profil yang sama, lalu mainkan game yang sama.
- [x] Verifikasi request validasi dan byte body yang dikirim dari sisi server; jangan hanya mengandalkan loading yang terasa cepat atau status respons yang terlihat di JavaScript.
- [x] Verifikasi perilaku cache BIOS dan preflight HEAD tidak merusak reuse respons GET.
- [x] Hapus game/BIOS di server setelah cache terisi: peluncuran baru tetap ditolak.
- [x] Pastikan canvas emulator nyata aktif dan tidak ada error setelah reuse cache.

Catatan pengujian:

- Jangan menggunakan `page.route`/request interception pada skenario pengukuran cache karena dapat menonaktifkan HTTP cache browser.
- APIRequestContext tidak membuktikan perilaku HTTP cache browser.
- Storage state Playwright bukan salinan disk cache; pengujian restart harus memakai direktori profil persisten yang sama.
- Jangan mengganti port backend di tengah skenario restart karena origin cache akan berubah.
- Pastikan service worker dan pengaturan DevTools tidak menonaktifkan cache.
- Profil uji harus terisolasi dan dibersihkan setelah browser ditutup; jangan memakai profil pribadi pengguna.

### 5. Dokumentasi dan verifikasi

File dokumentasi: `README.md`.

- [x] Jelaskan bahwa ROM/BIOS server dapat tersimpan dalam HTTP cache perangkat.
- [x] Jelaskan validasi ulang server, batasan ukuran, eviction browser, dan tidak adanya jaminan offline.
- [x] Jelaskan bahwa cache berbeda dari save/progres dan bukan fitur penyimpanan ROM lokal permanen.
- [x] Jelaskan cakupan: endpoint upload backend, bukan semua aset statis.
- [x] Catat agar reverse proxy tidak mengganti header ROM/BIOS menjadi `no-store` atau mengabaikan kebijakan `private`.
- [x] Jalankan verifikasi dan catat hasil aktual.

Perintah verifikasi:

```text
npm test
npm run build
npm run test:e2e:backend
```

Build dijalankan sebelum browser test backend agar pengujian memakai bridge dan frontend terbaru.

## Hasil Implementasi dan Verifikasi

Hasil berikut berasal dari verifikasi implementasi `1c5f8f8` pada **2026-11-04**, bukan eksekusi ulang suite untuk commit dokumentasi ini:

| Perintah | Hasil aktual |
| --- | --- |
| `npm test` | **234 lulus**, tanpa gagal/skip/cancel |
| `npm run build` | **Lulus**, sebelum suite browser backend |
| `npm run test:e2e:backend` | **75 lulus**, tanpa gagal/retry/skip, 8,6 menit |
| `npx tsc --noEmit --skipLibCheck --moduleResolution bundler --module esnext --target es2022 --allowJs tests/browser/catalog-cache.spec.ts` | **Lulus** |

Pengukuran Microsoft Edge headless di Windows menggunakan ROM demo NES `jalan-pulang.nes` berlisensi CC0 dan BIOS sintetis 512 byte. Backend tetap hidup pada origin/port yang sama selama restart proses browser; profil uji persisten terisolasi dibersihkan setelah browser ditutup. Tidak ada request interception atau service worker yang menangani aset.

| Fase | GET ROM | Body ROM dari server | GET BIOS | Body BIOS dari server |
| --- | --- | --- | --- | --- |
| Peluncuran pertama, profil kosong | 200 | 24.592 byte | 200 | 512 byte |
| Sesi kedua | 304 | 0 byte | 304 | 0 byte |
| Browser ditutup/dibuka kembali | 304 | 0 byte | 304 | 0 byte |

HEAD juga memvalidasi dengan ETag dan menghasilkan 304 pada reuse tanpa merusak body GET tersimpan. Ketiga peluncuran memiliki canvas emulator nyata, state yang dapat diekspor, ROM/BIOS bernama benar pada filesystem engine, dan tanpa error player. Setelah game/BIOS dihapus, pilihan lama ditolak sebelum membuat player; fetch HEAD/GET browser nyata juga mendapat 404, `no-store`, tanpa ETag sukses. Ini membuktikan transport BIOS sintetis, **bukan boot firmware proprietary atau seluruh core/perangkat/ukuran ROM**.

Bukti per request disimpan oleh tes pada `test-results/catalog-cache-*/server-asset-transfers.json` dan lampiran Playwright `server-asset-transfers`. Pencatat mengamati body `ServerResponse.write/end` serta header akhir `writeHead`, termasuk HEAD/304 yang headernya tidak selalu terlihat lewat `getHeader`. JSON mencatat fase, URL, metode, `If-None-Match`, status, jumlah byte body, ETag, dan Cache-Control. Artefak hasil uji diabaikan Git; jalankan ulang tes untuk menghasilkan bukti baru.

Tes backend juga mencakup delete/perubahan storage key saat file dibuka, ukuran salah, hardlink/junction/path tidak aman, penutupan handle, dan pembersihan header cache pada kegagalan pembuatan stream maupun error baca asinkron sebelum byte pertama. Jalur error asinkron ditangani hook route `onError`; default `no-store` global tidak diubah.

Percobaan browser lengkap awal mendapat **70 lulus, 5 gagal**. Satu kegagalan adalah pencatat header HEAD yang hanya membaca `getHeader`, lalu diperbaiki agar membaca header akhir `writeHead`. Empat lainnya merupakan assertion regresi Library/progres/autosave lama yang mencari ID katalog, bukan kontrak `saveIdentity` (`core-SHA256`) yang sudah ada sebelum fitur cache. Assertion diperbaiki tanpa mengubah runtime/identitas save. Lima tes terfokus kemudian lulus, diikuti seluruh suite akhir **75/75** di atas; hasil awal tidak dihitung sebagai kelulusan.

## Kriteria Penerimaan

Kedelapan kriteria berikut terpenuhi pada cakupan pengujian di atas; batas perangkat/browser/ukuran berkas tetap berlaku.

1. ROM/BIOS pertama kali diunduh penuh dan dapat dipakai engine nyata.
2. Saat cache masih tersedia dan konten tidak berubah, sesi berikutnya memvalidasi lalu memakai cache tanpa transfer body penuh.
3. Skenario tersebut terbukti juga setelah restart browser dengan profil dan origin yang sama.
4. ETag tidak cocok menghasilkan pengiriman konten normal.
5. Penghapusan atau kegagalan pemeriksaan aset tetap menghalangi peluncuran baru meskipun browser memiliki cache.
6. GET, HEAD, dan Range tidak mengalami regresi.
7. API akun, save, metadata, cover, redirect, serta error tetap `no-store`.
8. Tidak ada migrasi database, perubahan identitas save, ataupun perubahan bundle engine.

## Risiko dan Batasan

- Browser dapat membuang cache, khususnya file besar seperti ROM PS1. Fitur ini mengurangi unduhan ulang, bukan menjamin penyimpanan permanen.
- Cache bisa saja hanya tersimpan di memori untuk ukuran atau kondisi tertentu; pengujian restart memastikan perilaku untuk browser/fixture yang diuji, bukan jaminan semua perangkat.
- Tetap membutuhkan koneksi untuk validasi; ini bukan mode offline.
- Mode privat, pembersihan data browser, penggantian profil, atau penggantian origin dapat menghilangkan reuse cache.
- `private` tidak mengenkripsi file dan tidak berarti cache dipisahkan per akun aplikasi. Pengguna lain pada profil browser yang sama dapat memiliki akses ke data lokal tersebut.
- Penghapusan game di server tidak menghapus paksa byte yang sudah diterima perangkat dan tidak menghentikan sesi yang sedang berjalan; sesi baru tetap diperiksa server.
- Strong ETag berbasis hash mengasumsikan file storage tidak dimodifikasi di luar alur aplikasi. Pemeriksaan ukuran yang ada tidak mendeteksi perubahan konten berukuran sama; jangan mengklaim verifikasi hash runtime.
- Deployment harus mempertahankan header origin dan validator. Jika proxy mengubah representasi, pastikan penanganan ETag tetap benar.

## Rollback

Kembalikan respons sukses ROM/BIOS menjadi `Cache-Control: no-store` dan hentikan jalur 304. Tidak diperlukan migrasi data atau perubahan save. Salinan yang sudah tersimpan tidak otomatis dihapus dari perangkat, tetapi kebijakan `no-cache` sebelumnya tetap mewajibkan validasi sebelum digunakan ulang.
