# M5 — Restart Browser, File Besar, LAN, dan Race

Lanjutan [rencana cache IndexedDB ROM/BIOS](rencana-cache-indexeddb-rom-bios.md) dan [pengelola cache M4](milestone-4-cache-indexeddb-settings.md).

Status: **selesai pada 2026-11-05 dalam cakupan Edge/Windows, engine NES dan transport sintetis besar**, termasuk regresi backend penuh. Default cache tetap nonaktif; rollout/deployment M6 tidak termasuk perubahan ini.

## Implementasi

- `tests/browser/helpers/asset-transfers.ts` mengekstrak pencatat transfer origin dari tes HTTP cache historis. Mengamati `write`/`end`/header tanpa mengubah body, validator, backpressure, atau kebijakan cache. Mencatat fase, HEAD/GET, status, ETag, Cache-Control, byte body yang ditulis Node, serta finish/close. Byte write pada request terputus bukan bukti seluruh byte diterima klien. Unit test menguji streamed GET, HEAD, conditional 304, dan putus koneksi.
- `tests/browser/catalog-indexeddb-restart.spec.ts` masuk suite backend default: aplikasi/engine NES dan BIOS sintetis, proses Edge persistent, origin/port sama, cold/warm/restart, serta penghapusan hanya database cache. HTTP cache dimatikan melalui CDP pada setiap proses; service worker diblokir. Opt-in dilakukan sekali sebelum restart, bukan ditulis ulang ketika profil dibuka.
- Suite cepat juga menguji batas chunk 4 MiB -1/tepat/+1 dan 8 MiB +37, dua resolver/tab, reservation `busy`, clear/delete sebelum late commit, tab ditutup di dalam transaksi chunk IndexedDB yang benar-benar aktif, cleanup dengan clock tes melewati lease, serta download baru. Tidak mengklaim dedup download lintas tab.
- Cache terisi tidak boleh mem-bypass server: ROM **dan** BIOS dihapus, file hilang, ukuran berubah atau hardlink unsafe; offline dan listener server dihentikan lalu dibuka kembali pada port sama. Proxy test-only meneruskan respons normal tanpa perubahan dan memberikan HEAD 503 nyata untuk membuktikan penolakan dan pemulihan cache tanpa mengganti generation.
- `tests/fixtures/asset-cache-production.ts` membungkus modul resolver/storage/adapter **produksi**, bukan implementasi cache alternatif. Bundle fixture hanya di memori tes, tidak disalin ke `public/` atau `dist/`. Hash hasil Blob dihitung ulang secara inkremental dan dibandingkan dengan SHA Node fixture server.
- `tests/browser/catalog-indexeddb-large.spec.ts` dan `playwright.asset-cache-large.config.ts`: opt-in satu worker, tanpa retry, timeout 10 menit per ukuran, trace body besar nonaktif. Fixture deterministik **329.641.708 byte (314,3708305358887 MiB)** dan **524.288.000 byte (500 MiB)** dibuat lewat stream maksimal 1 MiB di direktori sementara. Melalui staging/publish backend nyata, bukan route aset palsu atau buffer upload utuh di Node.
- Preflight menolak suite besar jika disk bebas <6 GiB atau RAM tersedia <2 GiB. Setiap ukuran memakai profil sementara sendiri. Browser ditutup sebelum fixture/profile dihapus. Artefak disimpan lebih dahulu, termasuk ketika assertion gagal.
- Resource: durasi fase resolver, hash ulang, heartbeat UI, CDP JS heap/TaskDuration, memori proses Node dan RAM sistem tersedia. Pada Windows, sampling working set/private bytes pohon proses Edge yang memakai profil tes. Working set dapat menghitung shared pages berulang; sampling bukan peak fisik eksak dan JS heap bukan seluruh memori Blob/ArrayBuffer/WASM. Transport sintetis tidak menjalankan alokasi FS/WASM core PS1.
- Helper/header menguji batas ROM **805.306.368 byte (768 MiB)** dan BIOS **33.554.432 byte (32 MiB)** tanpa mengalokasikan transfer ROM penuh pada batas maksimum. Tidak mengklaim transfer ROM 768 MiB dari pengujian header.
- Pengujian besar menemukan `NotReadableError` sesudah commit ketika hasil Blob jaringan dibaca ulang. `src/lib/server-assets.ts` sekarang menggabungkan packet jaringan dalam **satu buffer Uint8Array maksimal 4 MiB yang dipakai ulang**, kemudian membuat satu snapshot Blob per chunk. Sebelumnya setiap potongan packet dibuat menjadi Blob tersendiri, lalu disusun menjadi Blob bertingkat. Coalescing membatasi dependency Blob, tetapi **sendiri tidak menyelesaikan** kegagalan 500 MiB.
- Diagnosis lanjutan membuktikan hash ulang handle jaringan gagal pada **offset 0**, sedangkan pembacaan ulang generation yang sudah committed melalui IndexedDB berhasil dengan SHA persis sama. Resolver kini membaca snapshot committed melalui `AssetCache.read()` yang sudah memiliki pin/epoch/hash/cardinality sebelum menyerahkannya ke engine, lalu melepas daftar Blob jaringan. Ini menambah satu pembacaan/hash disk pada cache miss yang tersimpan, bukan download/HEAD kedua atau buffer file utuh. `source` tetap `network` dan byte transfer tetap satu file penuh. Jika snapshot sudah dihapus/abort sebelum handoff, hasil menjadi `not-stored` dengan warning dan byte sesi, tanpa retry GET.
- Unit regresi memeriksa jumlah/ukuran snapshot, byte lintas batas, snapshot awal tidak berubah saat buffer dipakai ulang, handoff snapshot committed, serta clear/abort saat pembacaan pascacommit tidak membuat klaim tersimpan palsu.

Tidak ada perubahan schema cache v1, engine/vendor/core, fingerprint, saveIdentity, format save/progres, SQLite produksi, atau default settings.

## Perintah Reproduksi

```text
npm test
npm run build
npm run test:e2e:backend -- tests/browser/catalog-indexeddb-restart.spec.ts tests/browser/catalog-cache.spec.ts
npm run test:e2e:asset-cache:large
npm run test:e2e:backend
npm run test:e2e:production
```

Build harus selesai sebelum browser suite. Suite besar membutuhkan Edge terpasang dan IPv4 LAN non-loopback nyata; tidak mengganti LAN dengan localhost. Jangan memakai profil pribadi atau menjalankan beberapa suite besar bersamaan. Untuk mempertahankan artefak, gunakan `--output <direktori-terpisah>` saat menjalankan suite backend/production setelah suite besar: output default Playwright dapat membersihkan `test-results/`, termasuk subdirektori suite lain.

Artefak per tes: `server-asset-transfers.json`, `indexeddb-cache-events.json`, `cache-summary.json`; suite besar juga `preflight.json`/`environment.json`. Tes kuota menulis `actual-quota-probe.json`. File disimpan fisik melalui `info.outputPath()` lalu dilampirkan; tidak hanya mengandalkan attachment body reporter list.

## Hasil Aktual

Lingkungan: Windows x64 **10.0.26300**, Node.js **v26.12.1**, Microsoft Edge headless **156**; profil terisolasi. Loopback serta HTTP LAN non-loopback diuji terpisah. Pengukuran resource adalah pengamatan pada mesin pengembangan dengan workload lain, bukan benchmark perangkat khusus.

- Unit akhir: **313/313 lulus**, tanpa fail/skip/cancel, sekitar **49,0 detik**.
- Build snapshot committed **lulus**, dengan warning ukuran bundle frontend >500 kB (**534,49 kB sebelum gzip**), bukan build failure.
- TypeScript aplikasi dan strict spec/fixture M5 serta spec M4 yang diubah **lulus**.
- Production statis penuh pada build snapshot: **66 lulus/90 skip**, tanpa fail/retry, sekitar **2,1 menit**. Tambahan 13 skip merupakan skenario backend M5, bukan kelulusan cache katalog upload di hosting statis.
- `node --check public/player/player.js` **lulus**; tidak ada fixture/injeksi M5 dalam JS `dist/`.
- Suite besar pada snapshot committed: **2/2 lulus**, tanpa retry/skip, sekitar **4,9 menit** (329.641.708 byte sekitar 1,9 menit; 500 MiB sekitar 3,0 menit).
- Tambahan suite besar fallback kuota 500 MiB: **1/1 lulus**, tanpa retry/skip, sekitar **38,9 detik**. Tiga kasus suite besar telah dijalankan sebagai run 2 kasus persistence/restart dan run terfokus 1 kasus fallback (bukan satu run gabungan 3 kasus).
- Backend penuh terakhir pada build snapshot yang sama: **151/151 lulus**, tanpa fail/retry/skip, sekitar **12,0 menit**. Termasuk 13 skenario M5, regresi HTTP cache historis, M1–M4, akun/admin/katalog, state/SRAM/autosave/import/export dan perubahan akun. Run ini dilakukan terpisah dari suite besar/unit; hasil kegagalan sebelumnya dicatat di bawah.

### Bukti File Besar pada HTTP LAN

Kedua profil memakai `http://192.168.2.123` dengan port sementara masing-masing; **origin/port dipertahankan sepanjang cold, warm, restart, dan delete DB pada profil yang sama**. HTTP cache dimatikan lagi sesudah membuka proses browser baru; service worker diblokir. `isSecureContext=false`, `crypto.subtle`/Web Locks/estimate/persist tidak tersedia.

| Ukuran | Chunk committed | Cold HEAD/GET/body | Warm HEAD/GET/body | Restart proses HEAD/GET/body | DB dihapus HEAD/GET/body |
| --- | --- | --- | --- | --- | --- |
| 329.641.708 byte | 79 | 1 / 1 / 329.641.708 byte | 1 / 0 / 0 byte | 1 / 0 / 0 byte | 1 / 1 / 329.641.708 byte |
| 524.288.000 byte (500 MiB) | 125 | 1 / 1 / 524.288.000 byte | 1 / 0 / 0 byte | 1 / 0 / 0 byte | 1 / 1 / 524.288.000 byte |

Seluruh respons origin 200 dengan strong ETag SHA sesuai file dan `private, no-cache`; tidak ada GET 304 sebagai pengganti bukti hit. Cold/delete menghasilkan `network/stored`, warm/restart `indexeddb/reused`. Statistik setiap fase: satu entry, logical bytes tepat, staging/reservation nol. Sesudah restart, adapter native File dapat membaca ukuran utuh dengan nama `synthetic-<ukuran>.nes`; ini **bukan** boot emulator terhadap byte sintetis tersebut.

SHA-256 fixture deterministik yang diverifikasi kembali pada empat fase:

- 329.641.708 byte: `5d1d45702df88ade0ce8ae5a74ae177a1e62c6ac3f6430650c1100f47f3c292e`.
- 524.288.000 byte: `4f8e7ba8dada3f28212f092fa1fdf9f4d2aed021e4385d17fc8f74cb01e2c1b3`.

| Pengamatan resource | 329.641.708 byte | 500 MiB |
| --- | --- | --- |
| Resolver cold (termasuk commit + read/hash snapshot) | 24,37 detik | 40,69 detik |
| Resolver warm / restart | 7,70 / 8,40 detik | 16,51 / 12,68 detik |
| Hash ulang tambahan test-only pada cold | 7,97 detik | 13,50 detik |
| Total transaksi append pada cold | 8,36 detik, 79 complete | 13,44 detik, 125 complete |
| Gap heartbeat UI terbesar yang teramati | 226,2 ms | 226,1 ms |
| Sampling pohon Edge | 38 sampel | 61 sampel |
| Working set gabungan terbesar yang tersampel | 1.010.417.664 byte | 1.330.675.712 byte |
| Private bytes gabungan terbesar yang tersampel | 813.862.912 byte | 1.109.086.208 byte |

Angka gabungan proses/heartbeat bukan batas jaminan RAM/latensi, bukan peak fisik eksak, dan bukan kebutuhan memori gameplay PS1. Durasi hash tambahan fixture bukan seluruhnya overhead produksi. Artefak lengkap ada di `C:\Users\Ardi Putra\AppData\Local\Temp\opencode\maindulu-m5-large-snapshot`; output production final di `maindulu-m5-production-snapshot` dan backend bersih di `maindulu-m5-backend-verified` pada parent yang sama. Hash helper/bridge `public/player/` cocok dengan salinan `dist/player/`; `git diff --check` lulus.

### Kegagalan Storage dan Fallback

- Percobaan aman `Storage.overrideQuotaForOrigin` membatasi origin tes menjadi 1 MiB, tetapi Edge tetap berhasil menyimpan fixture 4 MiB +1. Artefak probe mencatat `reproduced=false`; ini **bukan** bukti actual quota exhaustion. Tidak mencoba memenuhi disk fisik atau mengubah profil pengguna.
- Injeksi quota pada transaksi append kedua produksi untuk **500 MiB** menghasilkan satu chunk complete, satu transaksi append abort, cleanup reservation/staging, lalu menyelesaikan **satu GET 524.288.000 byte**. Hash hasil sesi tetap cocok dan adapter native File membaca ukuran utuh. Hasil `network/not-stored` dengan warning `quota`, statistik entry/staging/reservation nol; tidak ada false stored atau retry GET penuh. Ini fault deterministik pada transaksi IndexedDB browser, bukan kuota disk fisik yang benar-benar habis.
- Tes browser kecil menutup tab saat transaksi chunk aktif dan menguji rollback/cleanup yang benar-benar dijalankan browser. M2/M4 tetap memverifikasi quota deterministik serta engine NES playable ketika storage gagal; transport sintetis 500 MiB tidak dijadikan bukti gameplay.
- Artefak fallback akhir berada di `C:\Users\Ardi Putra\AppData\Local\Temp\opencode\maindulu-m5-large-quota-final`.

### Kegagalan dan Perbaikan Selama Pengembangan

Run awal suite besar: **1 lulus/1 gagal** (329.641.708 byte lulus; 500 MiB gagal ketika hash ulang hasil Blob). Reproduksi 500 MiB berikutnya gagal dengan `NotReadableError` yang sama; run diagnostik sesudahnya lulus satu kali sebelum perubahan coalescing, jadi kegagalan awal tidak dinyatakan sepenuhnya deterministik atau akar internal Chromium sudah terbukti. Run penuh berikutnya dengan coalescing saja kembali **1 lulus/1 gagal**; diagnosis menunjukkan cache committed utuh meskipun handle jaringan tidak dapat dibaca. Regresi akhir diulang sesudah handoff snapshot committed dipasang; kegagalan historis tidak dihitung sebagai kelulusan.

Run production pertama pada build coalescing: **65 lulus/90 skip/1 gagal**. Tes staging M4 mencoba commit writer segera setelah klik konfirmasi, sebelum clear async sempat dikomit; hasil `committed` pada urutan tersebut memang sah. Tes diperbaiki dengan menunggu Dialog sukses ditutup (sesudah transaction complete) sebelum menguji **late** commit. Tidak menambahkan sleep, melemahkan assertion fencing, atau mengubah implementasi clear/Player. Production diulang penuh dengan sinkronisasi tes ini.

Run backend penuh pertama juga menjumpai race assertion staging M4 tersebut dan dihentikan ketika build/source diperbarui selama diagnosis; run parsial itu bukan bukti kelulusan regresi akhir. Pengujian backend penuh dimulai ulang pada build snapshot final, tanpa rebuild di tengah run. Unit awal untuk handoff snapshot juga membuka asumsi adapter in-memory: adapter tes kini menyediakan satu snapshot pascacommit, tetapi tetap memerlukan `state.hit` eksplisit untuk tes single-flight sesi berikutnya; assertion cancellation/download tidak dikurangi.

Run backend snapshot berikutnya **150 lulus/1 gagal**: restore tombstone BIOS pada `admin-catalog.spec.ts` menerima pesan storage tidak aman/tidak dapat dibaca, sehingga Dialog dengan benar tidak ditutup. Tes yang sama lulus **3/3 pengulangan terfokus tanpa perubahan backend/tes admin**, sekitar 17,1 detik. Penyebab internal filesystem/cleanup belum dibuktikan; kegagalan tidak dihapus dari laporan atau disamarkan dengan retry otomatis. Seluruh backend diulang lagi secara terpisah dari workload suite besar/unit dan **151/151 lulus**, sekitar 12,0 menit; tidak ada perubahan perilaku storage server untuk memaksa tes hijau.

## Batas Dukungan

- Fixture besar merupakan byte sintetis, bukan CHD playable atau firmware proprietary. Gameplay PS1, memcard nyata dan restore progres pengguna lama pada CHD legal tetap verifikasi manual M6.
- Restart yang diuji menutup seluruh proses context persistent milik tes dan membuka profil disk sama; bukan hanya reload dokumen atau Playwright storage state.
- HTTP LAN dilakukan melalui interface host Windows, bukan perangkat mobile fisik. Docker/Linux, HTTPS reverse proxy, Firefox/Safari dan restart/recreate deployment bukan hasil M5 ini.
- Kuota dicoba secara aman melalui `Storage.overrideQuotaForOrigin`; jika Chromium mengabaikan override/menerapkan floor, bukti dicatat sebagai **tidak tereproduksi**, bukan klaim disk penuh. Kegagalan quota deterministik M2/M4 serta abort transaksi browser nyata tetap bukti terpisah.
- Cache bukan offline, terenkripsi, permanen, atau per akun. Batas RAM emulator tetap terpisah dari kapasitas disk cache; tidak menjanjikan semua perangkat bisa menjalankan 500 MiB.

**Gate M5 terpenuhi:** cache produksi 329.641.708 byte dan 500 MiB terkomit, hash tepat, reuse sesi berikutnya/restart proses tanpa GET/body origin dengan HTTP cache mati; fallback kuota 500 MiB tetap menghasilkan aset sesi terbaca dari satu download tanpa entry palsu. Engine NES nyata, validasi sumber, race dan regresi penuh lulus. Berikutnya **M6 — dokumentasi rilis, rollout dan verifikasi deployment/CHD legal**; default belum diaktifkan.
