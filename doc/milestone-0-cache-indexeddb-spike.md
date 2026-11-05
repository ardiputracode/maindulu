# M0 — Spike Cache IndexedDB ROM/BIOS

> Catatan historis: hasil dan batas di bawah merekam penutupan M0, bukan status rollout terbaru. [M6](milestone-6-cache-indexeddb-rollout.md) kini selesai untuk cakupan lokal/HTTP LAN; default aktif hanya untuk DB baru, Docker/CHD dikonfirmasi manual pengguna, dan HTTPS ditunda (bukan lulus). Preferensi DB lama tetap dihormati.

Status: **selesai pada 2026-11-04 dalam cakupan spike yang dijelaskan di bawah**. Lanjutan [rencana IndexedDB ROM/BIOS](rencana-cache-indexeddb-rom-bios.md). Ini **belum mengaktifkan cache IndexedDB pada aplikasi pengguna**; storage produksi, resolver backend, integrasi bridge, dan UI masih M1–M6.

## 1. Keputusan Utama

**Gunakan input native File/Blob EmulatorJS 4.2.3, tanpa patch engine.** Hipotesis hook `downloadFile()` pada rencana awal tidak dibutuhkan untuk cakupan yang diuji.

Alur yang dipilih untuk integrasi M3:

1. Sesudah pengguna memilih **Main sekarang**, host memvalidasi descriptor katalog dan melakukan HEAD segar ke backend.
2. Resolver M2 menyiapkan Blob terverifikasi dari IndexedDB atau satu download jaringan.
3. `preparedRomFile(blob, url)` membuat File dengan **basename URL yang masih ter-encode**, kemudian host mengirim descriptor/File ke iframe same-origin.
4. Di dalam iframe, `engineRomInput(file)` membentuk adapter File per sesi; File ini diberikan **langsung** ke `EJS_gameUrl`, bukan melalui blob URL.
5. BIOS raw dibungkus ZIP STORED dengan nama anggota yang cocok dengan jalur URL lama; arsip BIOS tidak dikemas ulang. BIOS diberikan melalui blob URL milik sesi.
6. Tombol **Mulai bermain** engine tetap manual. Input prepared tidak mengambil ROM/BIOS lagi dari origin.
7. Setelah byte dikonsumsi/start, saat gagal, dan pada teardown, lepaskan buffer adapter dan referensi yang tidak diperlukan; revoke blob URL BIOS pada teardown.

`EJS_disableDatabases = true` dan `EJS_CacheLimit = 0` tetap berlaku. Penyimpanan IndexedDB produksi akan dikelola aplikasi sendiri, bukan cache bawaan engine berbasis basename/ukuran.

## 2. Kenapa Bukan Blob URL ROM atau Patch Engine?

### Nama file dan progres

Pada jalur URL, engine mengambil bagian terakhir URL tanpa decode. Untuk `/.../battery%20test.nes`, nama file engine adalah `battery%20test.nes`, bukan `battery test.nes`.

Memberi nama File dari label yang telah di-decode atau mengubah ROM menjadi blob URL dapat mengubah nama filesystem dan path progres. Jalur native File menetapkan `config.gameUrl = file.name` sebelum pemilihan nama ROM, sehingga basename lama dapat dipertahankan tanpa mengubah engine.

`EJS_gameName` tetap identitas save berbasis hash. Cache key/UUID blob tidak menjadi game ID, state key, nama ROM, atau path SRAM/memcard. Full URL sumber tetap disimpan pada descriptor host untuk validasi, bukan dipaksakan tetap menjadi `config.gameUrl` setelah native engine mengonsumsi File.

### Fingerprint build

`scripts/vendor-engine.mjs` menghitung `runtimeBuild` dari hasil bundle engine. Bridge progres akun membandingkan metadata build secara ketat. Patch engine untuk cache akan mengubah fingerprint dan membutuhkan evaluasi pemulihan state/progres lama.

Pada M0 **tidak ada perubahan** pada:

- `scripts/vendor-engine.mjs`;
- loader, source atau bundle di `public/vendor/emulatorjs/4.2.3/`;
- core atau `public/player/builds.json`;
- provenance engine atau format/identitas save.

Tes menghitung ulang SHA-256 kode bundle yang benar-benar dikirim dan mencocokkannya dengan `runtimeBuild`; fingerprint tidak dipalsukan atau dipertahankan setelah perubahan engine. Karena native input memakai bundle yang sama, tidak diperlukan migrasi atau allowlist build. Tes browser memulihkan SRAM sebelum boot dan state sesudah boot dari baseline URL ke input prepared dengan metadata yang sama.

### BIOS native File tidak dipilih

`downloadGameFile()` versi ini memanggil `assetUrl.split()` pada jalur cache/preflight, sebelum mengonversi File menjadi nama. Karena itu BIOS tidak diberikan langsung sebagai File. Raw BIOS dibungkus ZIP tanpa kompresi dengan basename yang sama; ZIP/7z/RAR yang sudah ada diteruskan apa adanya melalui blob URL. Bukti browser pada M0 mencakup raw sintetis dan ZIP, bukan arsip 7z/RAR atau boot firmware proprietary.

## 3. Adapter Memori per File

Native `downloadFile()` memanggil `toData()` sebelum membedakan HEAD dan GET. Untuk File, ini membaca seluruh `arrayBuffer()` juga pada **HEAD lokal**. Tanpa adapter, HEAD dan GET dapat menghasilkan dua buffer penuh yang hidup bersamaan.

`engineRomInput()` menggunakan subclass File yang hanya berlaku untuk input sesi tersebut:

- panggilan `arrayBuffer()` pertama menyimpan satu Promise;
- HEAD dan GET native memakai Promise/buffer yang sama;
- tidak mengubah `File.prototype`, XHR, fetch, atau method engine;
- `release()` menghapus referensi memoized dan menolak pembacaan baru; aman dipanggil ulang;
- dibentuk **di dalam iframe sesudah postMessage**. Structured clone mempertahankan File/nama/byte, tetapi tidak membawa subclass dan method adapter.

Ini mengurangi pembacaan duplikat input, bukan mengubah emulator menjadi streaming. `downloadRom()`, ekstraksi, FS/WASM, dan core masih bisa membuat alokasi lain. File 500 MiB tetap memerlukan setidaknya buffer input besar sebelum mempertimbangkan memori emulasi.

## 4. File yang Ditambahkan/Diubah

| File | Peran M0 |
| --- | --- |
| `src/lib/engine-assets.ts` | Helper nama URL, File ROM, adapter buffer sesi, dan ZIP STORED BIOS; belum diimpor Player/bridge produksi |
| `tests/engine-assets.test.mjs` | Delapan tes helper, metode source engine sebenarnya, kontrak CHD sintetis, dan fingerprint |
| `tests/fixtures/asset-cache-engine.ts` | Harness iframe test-only yang memakai loader/core nyata dan menerima File lewat postMessage |
| `tests/fixtures/asset-cache-chunks.ts` | Prototipe chunk IndexedDB test-only; **bukan schema/storage produksi M1** |
| `tests/browser/helpers/asset-cache-spike.ts` | HTTP server uji terisolasi, fixture legal/sintetis, bundle helper in-memory, dan pencatat transfer |
| `tests/browser/asset-cache-spike.spec.ts` | Emulator nyata, pemulihan save, chunk/restart HTTP LAN, serta perbandingan buffer 500 MiB |
| `playwright.asset-cache-spike.config.ts` | Suite opt-in, satu worker, tanpa retry, timeout 5 menit per tes |
| `playwright.config.ts` | Mengecualikan suite spike besar dari suite browser default |
| `package.json` | Menambah `test:e2e:asset-cache:spike` |

Test server hanya hidup saat suite M0 berjalan. Harness/chunk prototype tidak disalin ke `public/` atau deployment. Helper browser dibundel in-memory oleh esbuild pada fixture. Untuk M3 diperlukan bundle helper aplikasi yang reproducible sebelum aset player disalin ke build, **bukan regenerasi engine**. Sampai ada integrasi tersebut, output frontend produksi tetap tidak memakai helper baru ini.

## 5. Bukti Emulator dan Kompatibilitas

### Engine nyata

- Baseline URL dan input prepared sama-sama menjalankan NES battery fixture asli berlisensi CC0, demo `jalan-pulang.nes`, serta ZIP ROM.
- Canvas dan state export nyata terbukti, bukan hanya start screen.
- Basename raw ber-spasi tetap `battery%20test.nes`, path SRAM tetap `/data/saves/FCEUmm/battery%20test.srm`, dan state key/gameName tidak berubah.
- BIOS sintetis 512 byte tetap muncul sebagai `firmware%20test.bin` pada filesystem; raw dan ZIP sama-sama diuji.
- Counter SRAM baseline dinaikkan ke 1. Pada boot prepared, SRAM dimasukkan sebelum `callMain`, counter kembali 1 dan dapat dinaikkan ke 2: data benar-benar dibaca program NES.
- State baseline dimuat pada engine prepared setelah counter menjadi 2; counter kembali 1 dan bisa dinaikkan ke 2 lagi.
- GET ROM/BIOS prepared hanya satu per aset untuk persiapan host. Tidak ada HEAD/GET origin kedua dari engine sesudah File/Blob diterima.

### CHD dan batas bukti

Tes Node mengeksekusi metode source engine yang sebenarnya dengan FS/dekompresi stub serta byte sintetis untuk nama `Suikoden%20(Asia).chd`. Ini membuktikan basename dan rumus path yang sama dengan input URL, **bukan boot PS1 atau pemulihan memcard nyata**. Suite 500 MiB juga memakai data sintetis, bukan game CHD yang bisa dimainkan.

Harness M0 memakai protokol test-only, bukan payload configure bridge produksi. Validasi descriptor/sessionId pada protokol aplikasi, fresh HEAD katalog backend, logout/cancel, dan exit orchestration tetap harus diintegrasikan serta diuji pada M2/M3.

Setiap boot fixture memiliki page tersendiri dan ditutup tanpa menjalankan beforeunload. Saat percobaan harness menavigasi ulang page dengan mode MEMFS akun, handler exit engine yang tidak diubah menghasilkan `ErrnoError` ketika melakukan unmount. M0 tidak memperbaiki atau menyembunyikan error gameplay itu; tes akhirnya mengisolasi lifetime boot agar mengukur kompatibilitas data. Exit/unmount dan cancellation harus diperiksa pada integrasi M3, bukan diklaim terverifikasi dari harness ini.

## 6. Bukti IndexedDB Besar dan Restart

Lingkungan pengukuran yang berhasil: **Windows, Microsoft Edge headless 156, origin HTTP IPv4 non-loopback**. `isSecureContext === false`, `crypto.subtle`, Web Locks, persistence API, dan storage estimate tidak tersedia. SHA-256 inkremental memakai dependency noble yang sudah dimiliki aplikasi.

- HTTP cache dinonaktifkan melalui CDP pada setiap peluncuran browser; service worker diblokir.
- Profil persistent terisolasi dan origin/port yang sama dipakai sebelum/sesudah seluruh context/proses browser ditutup.
- Payload dibuat deterministik per chunk oleh server; tidak ada file proprietary atau ROM besar yang dikomit.
- Chunk ditulis sebagai Blob melalui transaksi pendek dan manifest diterbitkan sesudah ukuran/hash cocok serta transaksi selesai.
- Setelah restart, setiap chunk dibaca, ukuran/hash diverifikasi, dan digabung menjadi Blob/File; tidak ada GET payload ke server.
- File 500 MiB dikirim lewat postMessage ke iframe, lalu dibaca oleh metode `downloadFile()` dari bundle native yang sama. Hash hasil GET lokal sama dengan hash server.
- Profil/data uji dibersihkan setelah browser ditutup.

Hasil satu run sukses adapter:

| Payload | Chunk 4 MiB | Tulis + hash + transfer | Baca + hash setelah restart |
| --- | --- | --- | --- |
| 4.194.303 byte | 1 | sekitar 0,16 detik | sekitar 0,10 detik |
| 4.194.304 byte | 1 | sekitar 0,14 detik | sekitar 0,10 detik |
| 4.194.305 byte | 2 | sekitar 0,16 detik | sekitar 0,10 detik |
| 524.288.000 byte (**500 MiB**) | **125** | **13,38 detik** | **11,82 detik** |

Pada transfer/write 500 MiB, heartbeat UI 50 ms berjalan **155 kali**, gap terbesar sekitar **121 ms**. Ini telemetry run, bukan batas respons yang dijamin pada semua mesin. Biaya hash/baca masih terasa untuk file besar dan harus ditampilkan sebagai fase tersendiri pada UI M3/M4.

GET origin untuk setiap ukuran hanya satu pada cold write, dengan byte body tepat dan respons selesai. Pada baca ulang sesudah restart dan konsumsi File oleh iframe, **GET origin tambahan = 0**. Ini bukti prototipe IndexedDB tanpa bantuan HTTP cache, bukan bukti pipeline katalog produksi yang belum dibuat.

## 7. Pengukuran Buffer 500 MiB

Angka berikut adalah `Runtime.getHeapUsage().backingStorageSize` Chromium pada satu run, **bukan total RSS/working set browser, disk Blob, WASM, atau memori gameplay PS1**.

| Fase | Backing buffer yang teramati |
| --- | --- |
| Setelah baca/hash dari chunk | sekitar 80 MiB |
| Native File biasa, sesudah HEAD lokal | sekitar 500,43 MiB |
| Native File biasa, sesudah GET lokal | sekitar **1.000,43 MiB** |
| Adapter sesi, sesudah HEAD lokal | sekitar **500,43 MiB** |
| Adapter sesi, sesudah GET lokal | tetap sekitar **500,43 MiB** |
| Adapter dilepas + garbage collection pengukuran | sekitar 0,43 MiB |

Sebelum perbandingan adapter, buffer hasil baseline dibuang dan GC dipaksa melalui CDP agar kedua kandidat diukur terpisah. Produksi tidak bergantung pada forced GC. Tes membatasi buffer kandidat adapter pada ukuran payload + 64 MiB untuk fase ini, bukan mengklaim seluruh proses/browser berada di bawah batas tersebut. Tidak ada klaim pengukuran peak menyeluruh sepanjang pipeline.

Keputusan: **pertahankan chunk 4 MiB dan adapter read-once sebagai dasar M1/M3**. Dukungan gameplay 500 MiB di HP, PS1 nyata, Safari/Firefox, Docker/Linux, dan HTTPS proxy masih belum dibuktikan oleh angka ini.

## 8. Kontrak Persiapan dan Timeout untuk M3

Ini keputusan desain M0, **belum perubahan perilaku Player saat ini**:

- Persiapan dimulai sesudah Main sekarang. Library/pemilihan game tidak mendownload body.
- Fase dibedakan: ready iframe, HEAD/metadata, read/download, hash, commit, configure engine, menunggu klik start, dan boot.
- Ready/configure engine memakai deadline tersendiri seperti batas 90 detik saat ini; download tidak dimasukkan ke timer ready tersebut.
- HEAD/metadata memakai batas 15 detik. Transfer memakai idle timeout awal 45 detik dan deadline keseluruhan awal 30 menit; nilai akhir diuji pada M3 dan ditampilkan melalui pesan yang dapat ditindaklanjuti.
- Hash/read/write menggunakan checkpoint cancellation dan yield per chunk. Timeout transfer tidak boleh menyala karena fase sudah berpindah ke hashing atau pengguna belum menekan tombol start.
- Waktu menunggu klik Mulai bermain tidak dianggap hang. Setelah klik, gunakan fase boot 90 detik terpisah; perubahan berikutnya perlu pengujian core/perangkat besar.
- Unmount, sesi/akun berubah, atau cancel membatalkan operasi yang belum diserahkan. Completion lama tidak boleh mengonfigurasi iframe baru.
- Single-flight dan fencing transaksi/reservation adalah pekerjaan M1–M3. Buffer adapter dibentuk ulang per boot dan dilepas pada start, error, cancel, dan teardown; object URL BIOS milik boot yang sama.

## 9. Verifikasi dan Reproduksi

```text
node --test tests/engine-assets.test.mjs
npm run test:e2e:asset-cache:spike
npm run build
```

Suite M0 merupakan opt-in karena melakukan transfer/storage 500 MiB dan pembacaan buffer besar. Persiapkan disk kosong dan RAM desktop yang memadai. Tes LAN hanya boleh dinyatakan lulus jika interface non-loopback tersedia; skip tidak menjadi bukti LAN.

Hasil terverifikasi saat dokumen ini ditulis:

- Tes helper/kontrak M0: **8/8 lulus**.
- Browser spike: **3/3 lulus**, sekitar 1,2 menit pada run adapter, tanpa retry/skip.
- `npm test`: **242/242 lulus**, tanpa fail/skip/cancel; termasuk delapan tes helper M0.
- `npm run build`: **lulus**; frontend masih tidak mengimpor helper baru.
- Pemeriksaan TypeScript ketat untuk spec/helper/fixture baru: **lulus**, dijalankan terpisah dari build aplikasi.
- Browser backend terfokus: **26/26 lulus**, tanpa retry/skip, sekitar 3 menit. Perintah: `npm run test:e2e:backend -- tests/browser/app.spec.ts tests/browser/server-game-saves.spec.ts tests/browser/catalog-cache.spec.ts`. Ini mencakup UI/player, state/SRAM akun/tamu, pemulihan build, serta HTTP cache/restart/delete sebelumnya; **bukan eksekusi ulang seluruh suite backend**.

Perintah pemeriksaan TypeScript yang dipakai:

```text
npx tsc --noEmit --strict --skipLibCheck --moduleResolution bundler --module esnext --target es2022 --allowJs --allowImportingTsExtensions tests/browser/asset-cache-spike.spec.ts tests/fixtures/asset-cache-engine.ts
```

Suite statis production penuh, seluruh suite backend, Docker, dan HTTPS proxy tidak dijalankan ulang pada M0. Jangan memakai jumlah tes historis rencana HTTP cache sebagai bukti verifikasi tersebut.

Artefak suite berada di `test-results/asset-cache-m0/`, diabaikan Git:

- `m0-chunk-memory-spike.json` dan attachment dengan nama yang sama: ukuran, hash, timing, heartbeat, environment, buffer fase, serta transfer origin.
- Attachment `url-to-native-file-compatibility`: metadata baseline/prepared, nama/path/state key, dan transfer.
- Attachment `native-input-names`: hasil demo serta ROM/BIOS ZIP.

Run berikutnya dapat berbeda waktunya. Pencatat menyimpan jumlah body dari `ServerResponse.write/end`, bukan menebak dari status fetch atau kecepatan loading. Nama database prototipe adalah `maindulu-asset-cache-m0-spike`; ini tidak dipakai aplikasi pengguna dan tidak dimigrasikan menjadi DB produksi.

Percobaan awal harness belum lulus: CSS ukuran iframe belum menyamai player produksi sehingga tombol start berada di luar viewport, lalu pengujian ulang page memicu error exit MEMFS yang dijelaskan di atas. Dua masalah harness tersebut dipisahkan sebelum run sukses; hasil awal tidak dihitung sebagai kelulusan. Pengukuran raw File yang boros buffer dipertahankan sebagai baseline, bukan disamarkan oleh adapter.

## 10. Batas Selesai M0 dan Pekerjaan Berikutnya

**Gate spike M0 terpenuhi:** input native yang mempertahankan nama/save dipilih, risiko fingerprint dihindari tanpa pelemahan validasi, chunk 4 MiB dan restart 500 MiB terbukti pada lingkungan uji, serta pembacaan input ganda diatasi pada adapter per sesi.

Belum selesai dan tidak boleh dianggap ada pada deployment:

- M1: skema produksi, budget/kuota, atomisitas lintas store, abort/recovery, lease, clear epoch, fencing antartab, dan LRU.
- M2: descriptor katalog dan HEAD/GET backend asli, hashing/integritas, serta fallback cache gagal tanpa download kedua.
- M3: bundle helper bridge, protokol/session validation, integrasi Player, fase timeout/cancel, exit orchestration, dan regresi save aplikasi lengkap.
- M4: status penyimpanan dan pengelola cache.
- M5: suite end-to-end produksi untuk 329.641.708 byte/500 MiB, race/kegagalan/eviction, dan gameplay CHD legal pada perangkat sasaran.
- M6: rollout dan bukti Docker/LAN/proxy nyata.

Langkah berikutnya adalah **M1 — Storage IndexedDB dan kebijakan cache**, bukan mengaktifkan dua flag cache EmulatorJS.
