# Rencana Cache IndexedDB ROM/BIOS Backend

Status: **M0 (spike) selesai pada 2026-11-04; M1 (storage/kebijakan), M2 (resolver aset), M3 (integrasi aset kecil/NES), M4 (pengelola cache/UX kegagalan), dan M5 (restart/LAN/file besar/race) selesai pada 2026-11-05; M6 belum diimplementasikan**. Default cache tetap nonaktif: pengguna dapat opt-in melalui Pengaturan M4, tetapi belum aktivasi default/rollout deployment. Hasil aktual dan batas bukti ada di [laporan spike M0](milestone-0-cache-indexeddb-spike.md), [laporan storage M1](milestone-1-cache-indexeddb-storage.md), [laporan resolver M2](milestone-2-cache-indexeddb-resolver.md), [laporan Player M3](milestone-3-cache-indexeddb-player.md), [laporan Pengaturan M4](milestone-4-cache-indexeddb-settings.md), dan [laporan verifikasi M5](milestone-5-cache-indexeddb-verification.md). Checklist yang belum dicentang tetap rencana, bukan hasil tes.

Rencana ini melengkapi, bukan menghapus riwayat [implementasi HTTP cache](rencana-cache-rom-bios.md). HTTP cache tetap berguna, tetapi tidak dijadikan jaminan penyimpanan ROM besar. Perubahan runtime, bundle engine, dan pengujian dalam dokumen ini memerlukan implementasi terpisah.

## 1. Masalah dan Target

### Temuan saat ini

- Backend sudah mengirim `Cache-Control: private, no-cache` dan ETag SHA-256 untuk ROM/BIOS upload yang valid; conditional GET/HEAD dan pemeriksaan ketersediaan tetap diperlukan.
- Pada laporan pengguna, ROM `Suikoden (Asia).chd` berukuran **329.641.708 byte, sekitar 314,37 MiB**, tetap diunduh ulang. Screenshot menunjukkan HEAD dan GET; HEAD bukan unduhan body kedua. Bukti tersebut belum memastikan alasan browser tidak memakai HTTP cache.
- `public/player/player.js` menetapkan `EJS_disableDatabases = true` dan `EJS_CacheLimit = 0`. Dengan demikian **tidak ada penyimpanan ROM/BIOS IndexedDB oleh fitur saat ini**.
- Pengujian HTTP cache yang ada memakai ROM NES 24.592 byte dan BIOS sintetis 512 byte. Keberhasilannya tidak membuktikan reuse ROM 300–500 MB.
- Pengguna membandingkan perilaku dengan situs lain yang terlihat menyimpan di IndexedDB. Implementasi internal situs tersebut belum diaudit; rencana ini berdasarkan kebutuhan aplikasi sendiri, bukan menyalin kode/aset situs tersebut.

### Target pengguna

Setelah download selesai dan penyimpanan lokal **berhasil dikomit**, ROM/BIOS backend dapat digunakan kembali dari IndexedDB pada sesi berikutnya dan setelah restart browser, selama data belum dihapus/di-evict dan aset masih tersedia di server.

Untuk ROM besar, UI harus membedakan **selesai download**, **tersimpan di perangkat**, dan **dimainkan tanpa tersimpan**. Jangan menjanjikan reuse jika transaksi penyimpanan gagal.

### Bukan jaminan permanen

IndexedDB juga tunduk pada kuota, eviction, mode privat, penghapusan data situs, pergantian profil/origin, dan kebijakan browser. Permintaan persistent storage tidak selalu didukung atau dikabulkan. Memori yang dibutuhkan emulator untuk memuat ROM tetap menjadi batas terpisah dari kapasitas disk.

## 2. Cakupan dan Non-Tujuan

### Dalam cakupan

- ROM dan BIOS **hasil upload katalog backend** dengan descriptor tervalidasi: jenis, ID katalog, URL, nama file, SHA-256, dan ukuran.
- Penyimpanan byte di IndexedDB milik aplikasi, bukan database cache bawaan EmulatorJS.
- Fresh validation ke backend pada setiap peluncuran, termasuk cache hit.
- Download, verifikasi hash, penyimpanan atomik, baca ulang, invalidasi, pengelolaan kuota, dan pembersihan data sementara.
- UI status cache serta pengelola cache di Pengaturan.
- Browser desktop Chromium/Edge, HTTP LAN, dan uji ROM ratusan MB; cakupan tambahan dicatat secara eksplisit.

### Di luar cakupan

- Mode offline/PWA/service worker, Cache API, OPFS, serta resume download parsial.
- Penyimpanan otomatis ROM/BIOS lokal yang dipilih pengguna.
- Cache engine, cover, frontend, manifest, atau demo statis `public/games/` dan `public/bios/`.
- Migrasi HTTP cache ke IndexedDB: HTTP cache tidak mempunyai API untuk enumerasi dan migrasi seperti database aplikasi.
- Perubahan identitas save, format progres, SQLite backend, autentikasi, backup server, atau hak distribusi aset.
- Jaminan semua browser/core/HP dapat memainkan ROM 500 MiB. Transport/cache dan kompatibilitas gameplay diuji terpisah.

## 3. Keputusan Arsitektur

### 3.1 Cache dikelola frontend, bukan toggle cache engine

**Jangan hanya mengubah dua flag EmulatorJS menjadi aktif.** Pada sumber engine 4.2.3 saat ini:

- `data/src/emulator.js` membuat database bawaan saat `disableDatabases` tidak aktif.
- `downloadRom()` mengambil key dari bagian terakhir URL dan menerima cache jika `content-length` sama.
- Nama file/ukuran yang sama tidak membuktikan konten sama; ROM dan BIOS perlu namespace terpisah.
- Penanganan kegagalan storage bawaan tidak cukup untuk kontrak commit, kuota, dan pembatalan yang dibutuhkan fitur ini.

Pertahankan `EJS_disableDatabases = true` dan `EJS_CacheLimit = 0`. Modul cache baru menangani ROM/BIOS backend secara eksplisit. Database save-state/progres yang sudah ada tetap mengikuti kebijakan tamu/akun saat ini.

### 3.2 Alur utama

```text
Pengguna memilih "Main sekarang"
  -> descriptor katalog terbaru dan validasi sumber
  -> HEAD segar ke endpoint aset backend
  -> cache enabled? cari entri siap dengan jenis + ID + SHA-256
      -> hit: baca chunk, periksa ukuran/hash
      -> miss/rusak: GET penuh, verifikasi ukuran/hash, coba simpan
  -> hasil: File/Blob terverifikasi + descriptor + status penyimpanan
  -> configure iframe melalui postMessage same-origin
  -> adapter engine membaca aset yang sudah disiapkan, tanpa GET ROM kedua
  -> tombol "Mulai bermain" engine tetap membutuhkan tindakan pengguna
```

Persiapan aset dimulai sesudah **Main sekarang**, bukan ketika membuka Library atau sekadar memilih game. Ini menggeser tahap transfer sebelum configure engine; tampilkan progres persiapan pada host dan jangan memulai emulator otomatis. Semua jalur lokal/statis yang tidak eligible mempertahankan alur lama.

### 3.3 Menjaga nama ROM dan identitas save

Mengganti URL CHD menjadi `blob:` begitu saja tidak cukup. `getBaseFileName(true)` pada engine memakai URL asli bila tersedia, sedangkan blob dapat membuatnya memakai `gameName`. Bridge progres PS1 membangun path memcard dari nama file final. Perubahan nama ini dapat membuat progres lama tidak ditemukan atau layout ditolak.

**Keputusan M0: gunakan input native File/Blob, tanpa patch engine.** Hipotesis awal hook `downloadFile()` tidak dipilih karena native File sudah cukup menjaga nama dan kompatibilitas build; hasilnya dibuktikan pada harness engine nyata dan tes kontrak CHD sintetis.

- Host mempertahankan descriptor URL asli untuk validasi server; `preparedRomFile()` memberi File nama berupa **basename URL yang masih ter-encode**, bukan nama display yang sudah di-decode.
- Kirim descriptor/File melalui postMessage; di dalam iframe bentuk `engineRomInput()`, lalu pasang File hasil adapter **langsung** sebagai `EJS_gameUrl`. Jangan memakai blob URL untuk ROM backend prepared.
- Adapter berupa subclass File per sesi yang memakai ulang Promise ArrayBuffer untuk HEAD/GET lokal engine. Bukan patch engine, network global, atau `File.prototype`. Bentuk ulang sesudah structured clone karena subclass/method tidak ikut terkirim.
- Engine secara native mengganti `config.gameUrl` dengan `File.name` sebelum memilih basename. Full URL tetap disimpan pada descriptor host; nama filesystem/progres tetap cocok dengan jalur URL lama.
- BIOS raw dibungkus ZIP STORED dengan nama anggota sesuai basename URL lama; BIOS ZIP/7z/RAR tidak dikemas ulang. Berikan BIOS melalui blob URL milik sesi, bukan native File langsung: path BIOS 4.2.3 memanggil `assetUrl.split()` sebelum ekstraksi.
- HEAD engine untuk input prepared hanya pemeriksaan lokal, **bukan fresh origin validation**. Fresh HEAD backend wajib tetap dilakukan host pada M2/M3 sebelum konfigurasi player.
- `EJS_gameName`, `saveIdentity`, ID game, nama filesystem, dan path progres tidak diganti dengan key cache atau UUID blob.
- `config.rom`/`config.bios` lokal dan aset backend prepared harus dibedakan secara eksplisit. File backend yang dikirim lewat message tidak boleh membuat game dianggap lokal atau mengganti identitas game menjadi nama File.
- Lepaskan buffer memoized pada akhir konsumsi/start, kegagalan, dan teardown; revoke URL BIOS pada teardown. Engine tetap membutuhkan memori ArrayBuffer/FS, sehingga penghematan ini bukan jaminan perangkat kecil mampu menjalankan ROM besar.
- Helper `src/lib/engine-assets.ts` kini dipasang pada bridge produksi melalui `src/lib/player-bridge-assets.ts` dan bundle `public/player/asset-helpers.js`. Generator M3 berjalan sebelum build frontend menyalin aset player; bundle engine tidak diubah untuk memuat helper aplikasi.

**Kompatibilitas build:** tidak ada perubahan `scripts/vendor-engine.mjs`, loader/vendor runtime, core, provenance engine, atau `public/player/builds.json` pada M0. Fingerprint aktual diverifikasi dengan hash bundle; SRAM dan state dari boot URL lama dipulihkan lewat boot input prepared pada engine yang sama. Tidak ada migrasi/allowlist kompatibilitas atau pelemahan pemeriksaan metadata. Jika milestone berikutnya memerlukan patch engine, keputusan ini harus dibuka ulang karena `runtimeBuild` dapat berubah dan memblokir pemulihan lama.

### 3.4 Modul dan file yang direncanakan

Modul storage/kebijakan M1, resolver M2, integrasi Player/bridge M3, serta pengelola cache M4 di bawah sudah tersedia. Suite restart dan file besar M5 kini tersedia; hasil verifikasi dicatat di [laporan M5](milestone-5-cache-indexeddb-verification.md). Default rollout belum aktif.

| File | Tanggung jawab |
| --- | --- |
| `src/lib/asset-cache.ts` | **M1 tersedia:** skema IndexedDB, transaksi, baca/tulis chunk, manifest, clear epoch, statistik metadata |
| `src/lib/asset-cache-policy.ts` | **M1 tersedia:** validasi descriptor, key, budget, LRU, hasil/error terstruktur; mudah diuji sebagai fungsi murni |
| `src/lib/server-assets.ts` | **M2 tersedia:** HEAD segar, download tunggal, hashing, koordinasi cache, AbortSignal dan single-flight |
| `src/lib/identity.ts` | **M2 tersedia:** helper hashing inkremental bersama untuk local/network/storage tanpa buffer hash file utuh |
| `src/lib/catalog.ts`, `src/lib/domain.ts` | **M2 tersedia:** status error HTTP katalog, validasi same-origin/no-redirect dan `Bios.size` opsional |
| `src/components/SetupDialog.tsx` | **M2 tersedia:** descriptor ROM/BIOS backend lengkap dari metadata terbaru dalam sesi; dipakai resolver Player pada M3 |
| `src/lib/player-assets.ts` | **M3 tersedia:** penghubung settings DB, satu resolver bersama per tab, persiapan aset berurutan dan cancellation subscriber |
| `src/components/Player.tsx` | **M3 tersedia:** persiapan aset, status dasar, pembatalan, fencing sesi, configure, fase timeout dan lifecycle |
| `src/lib/player-bridge-assets.ts`, `public/player/player.js` | **M3 tersedia:** validasi payload bersama, adapter aset sesi, preservasi nama dan pelepasan referensi |
| `scripts/vendor-engine.mjs` | Tidak diubah untuk arsitektur native M0; perubahan berikutnya memerlukan evaluasi kompatibilitas ulang |
| `public/vendor/emulatorjs/4.2.3/`, `public/player/builds.json`, `third_party/emulatorjs/README.md` | Runtime/provenance engine tetap; `scripts/build-player-assets.mjs` menghasilkan helper aplikasi terpisah pada M3 |
| `src/components/AssetCacheSettings.tsx`, `src/App.tsx`, `src/styles.css` | **M4 tersedia:** pengelola cache, status storage, pengaturan dan aksesibilitas |
| `src/lib/asset-cache-ui.ts`, `src/lib/asset-cache-events.ts` | **M4 tersedia:** label/progres/persistence, feature detection storage, notifikasi metadata antar-tab best-effort setelah commit |
| `tests/asset-cache-policy.test.mjs`, `tests/browser/asset-cache-storage.spec.ts` | **M1 tersedia:** kebijakan serta transaksi/kegagalan/race storage browser nyata dengan dependency injection |
| `tests/server-assets.test.mjs`, `tests/browser/server-assets.spec.ts` | **M2 tersedia:** validator origin, orkestrasi resolver, backend/IndexedDB nyata, fallback serta HTTP LAN |
| `tests/player-assets.test.mjs`, `tests/browser/catalog-indexeddb-cache.spec.ts` | **M3/M4 tersedia:** kontrak payload/bundle, engine/backend/IDB nyata, miss/hit/reload dokumen, save lama, akun/logout, StrictMode, timer, kegagalan storage, clear saat game aktif dan UI HTTP LAN; restart proses/invalidasi lanjutan dilengkapi pada M5 |
| `tests/asset-cache-ui.test.mjs`, `tests/browser/asset-cache-settings.spec.ts` | **M4 tersedia:** status persistence/API opsional, pengaturan dan metadata, delete/clear, staging, eviction/antar-tab, kegagalan transaksi, versi lebih baru dan fokus/mobile |
| `tests/browser/asset-cache-spike.spec.ts`, `playwright.asset-cache-spike.config.ts` | Harness/prototipe test-only M0, termasuk 500 MiB; bukan storage produksi |
| `tests/browser/catalog-indexeddb-restart.spec.ts`, `tests/fixtures/asset-cache-production.ts`, `tests/browser/helpers/asset-cache-production.ts` | **M5 tersedia:** restart proses persistent, engine NES, HTTP cache nonaktif, HTTP LAN, batas chunk, race, invalidasi sumber, offline/5xx dan percobaan kuota aman |
| `tests/browser/helpers/asset-transfers.ts`, `tests/asset-transfers.test.mjs` | **M5 tersedia:** pencatat transfer origin bersama, termasuk regresi HTTP cache historis dan koneksi terputus |
| `tests/browser/catalog-indexeddb-large.spec.ts` | **M5 tersedia:** suite besar resolver/storage produksi opt-in, terpisah dari spike dan emulator playable |
| `playwright.backend.config.ts`, `playwright.asset-cache-large.config.ts`, `package.json` | **M5 tersedia:** registrasi testMatch eksplisit, script suite besar satu worker/tanpa retry dan preflight resource |

Tidak diperlukan endpoint backend baru pada rancangan awal. Metadata dan endpoint HEAD/GET sudah menyediakan hash serta ukuran; perubahan server hanya bila spike menemukan kebutuhan kontrak yang tidak dapat dipenuhi saat ini.

## 4. Kontrak Data IndexedDB

### 4.1 Database dan identitas

Database usulan: **`maindulu-asset-cache`**, versi awal **1**. Jangan memakai atau menghapus database `EmulatorJS-states` maupun penyimpanan progres tamu/akun.

Key manifest: `[kind, catalogId, sha256]`, dengan `kind` bernilai `rom` atau `bios`. Database sudah terisolasi per origin browser; jangan memakai basename sebagai identitas atau memakai key lintas origin. URL/nama adalah metadata, bukan satu-satunya key.

Dedup byte lintas ID katalog tidak termasuk versi pertama. Hal ini menyederhanakan otorisasi/ketersediaan, penghapusan, dan pembukuan. ROM/BIOS dengan hash sama tetap mempunyai namespace dan descriptor masing-masing.

### 4.2 Object stores

| Store | Isi dan aturan |
| --- | --- |
| `entries` | Manifest **siap pakai saja**: key, kind, catalogId, sha256, size, fileName, url, consoleId, label, generationId, chunkCount, createdAt, lastUsedAt |
| `chunks` | Key `[generationId, index]`, Blob maksimal **4 MiB** per chunk; chunk terakhir boleh lebih kecil |
| `staging` | generationId, descriptor, ownerId, epoch, expectedSize, receivedSize, chunkCount, heartbeatAt, reservation; tidak dianggap cache hit |
| `control` | Clear epoch/generation administratif, budget/settings cache, reservation/admission serta lease pemeliharaan bila dibutuhkan |

Tambahkan index untuk LRU, pencarian ID katalog, dan cleanup generation. Tampilan daftar/statistik membaca metadata `entries`, **bukan memuat semua Blob untuk menghitung ukuran**.

Ukuran chunk 4 MiB lolos spike M0 dan pipeline produksi M5 sampai 500 MiB pada Edge/HTTP LAN yang dicatat. M5 menggabungkan packet dalam buffer maksimal 4 MiB dan menyerahkan snapshot IndexedDB terverifikasi sesudah commit untuk menghindari handle Blob jaringan besar yang tidak terbaca. Jangan menunggu satu transaksi berisi 500 MiB. Chunk bukan fitur resume: putus download tetap memerlukan GET baru pada percobaan berikutnya.

### 4.3 Atomisitas dan commit

1. Reservasi admission dengan ID sesi dan epoch aktif; buat staging generation baru.
2. Baca stream jaringan di luar transaksi IndexedDB; hash dan hitung ukuran sambil berjalan.
3. Tulis tiap chunk dalam transaksi pendek. Jangan `await fetch()`/hashing async di tengah transaksi aktif karena transaksi bisa auto-close.
4. Setelah EOF, ukuran total dan SHA-256 harus cocok; respons GET juga harus sesuai validator.
5. Publikasikan manifest di `entries` dan hapus staging dalam transaksi yang memeriksa epoch/reservation/generation yang masih berlaku.
6. Nyatakan **tersimpan** hanya setelah `transaction.oncomplete`, bukan hanya setelah `request.onsuccess`.
7. Saat gagal/abort, jangan pernah mempublikasikan manifest parsial. Chunk orphan dibersihkan dengan mekanisme yang dibatasi dan bisa dijalankan ulang.

Cache read wajib memastikan seluruh chunk ada, urutan dan ukuran valid, serta hash byte cocok sebelum diserahkan ke engine. Cache korup dihapus/diinvalidasi lalu boleh melakukan **satu** download normal; hindari loop retry.

Pada cache hit, lakukan verifikasi hash secara inkremental agar tidak memerlukan buffer utuh tambahan. Ini menambah baca/CPU tetapi mencegah klaim integritas hanya dari metadata lokal. Optimasi melewati rehash memerlukan desain dan bukti terpisah.

### 4.4 Versi dan lifecycle database

- Tangani `onupgradeneeded`, `blocked`, `versionchange`, error pembukaan, abort transaksi, dan database dihapus dari tab lain.
- Tutup connection saat versionchange dan saat pemilik lifecycle selesai; UI menampilkan jika tab lain menghalangi upgrade.
- Versi aplikasi lama yang menemukan versi DB lebih baru harus fallback tanpa cache dengan pesan, **bukan menghapus database otomatis**.
- Jangan jalankan `indexedDB.deleteDatabase()` generik pada logout/reset Pengaturan. Penghapusan cache dilakukan terarah pada database fitur ini.

## 5. Validasi Server dan Konsistensi

### 5.1 HEAD harus benar-benar memeriksa origin

- Ambil metadata katalog terbaru menggunakan jalur `latestCatalogEntry` yang sudah memakai `cache: 'no-store'`.
- HEAD aset menggunakan `cache: 'no-store'`, same-origin, AbortSignal, dan kebijakan redirect yang menolak perpindahan sumber. Jangan memakai header bersyarat dari cache aplikasi pada pemeriksaan ini.
- Wajib sukses 200, body metadata masuk akal, bukan HTML, `Content-Length` positif dan cocok descriptor, serta strong ETag sesuai `"<sha256>"`.
- Jika katalog terbaru berbeda dari sesi yang dipilih, batalkan persiapan lama dan minta buka ulang dengan descriptor baru. Jangan mencampur bytes baru dengan saveIdentity yang dibentuk dari hash lama.
- 404/410: tolak peluncuran dan invalidasi salinan lokal terkait. Network error, timeout, atau 5xx: tolak peluncuran baru tetapi jangan menyimpulkan cache lokal rusak atau menghapus seluruh cache.
- Ketika cache dinonaktifkan atau storage tidak tersedia, pemeriksaan aset untuk jalur baru tetap berlaku; kegagalan IDB tidak boleh mem-bypass kegagalan server.

HEAD memeriksa ketersediaan pada titik waktu request tersebut. Delete sesudah HEAD tidak dapat menarik kembali byte yang sudah diterima atau menjamin pembatalan sesi yang sedang berjalan. Jangan mengklaim proteksi terhadap semua race sepanjang sesi.

### 5.2 Download cache miss

- GET memakai URL descriptor yang persis sama; untuk pipeline cache baru gunakan `cache: 'no-store'` sehingga tidak menggantungkan sumber pada HTTP cache dan tidak membuat dua lapis persistensi yang sulit dibuktikan.
- Tidak mengirim Range/If-Range. Terima hanya respons file penuh 200 dengan panjang/ETag konsisten; 206/304 tak terduga ditolak oleh pipeline ini, bukan dianggap file lengkap.
- Tolak redirect, HTML, file kosong, stream terpotong, body berlebih, Content-Length tak valid, atau hash tidak cocok. Jangan menyimpan atau menjalankan bytes yang gagal verifikasi.
- Jika HEAD dan GET tidak konsisten karena aset berubah, hentikan dengan pesan untuk memuat ulang entri. Jangan mengganti descriptor/saveId diam-diam atau retry tanpa batas.
- Strong ETag origin masih bergantung pada asumsi berkas server immutable. Hash download/cache di browser memverifikasi byte yang diterima, bukan menambah runtime rehash file pada server.
- Aset statis/tidak eligible tetap menggunakan jalur lama dan HTTP cache yang sudah ada. Kebijakan backend `private, no-cache` tidak dihapus hanya karena fetch pipeline baru memilih `no-store`.

## 6. Memori, Kuota, Pembatalan, dan Banyak Tab

### 6.1 Batas awal

| Parameter | Nilai awal rencana |
| --- | --- |
| ROM maksimal | Ikuti batas domain/backend saat ini: 768 MiB |
| BIOS maksimal | Ikuti batas domain/backend saat ini: 32 MiB |
| Chunk storage | 4 MiB, dikonfirmasi lewat spike |
| Budget cache aplikasi | 2 GiB per origin; dapat diubah pengguna, tidak berarti kuota browser tersedia |
| Reserve ruang origin | 128 MiB sebagai margin best-effort terhadap `navigator.storage.estimate()` |
| Paralel persiapan aset | ROM/BIOS berurutan pada satu sesi untuk mengurangi puncak RAM |
| Cleanup staging basi | Kandidat setelah heartbeat tidak aktif 1 jam; harus memakai fencing/lease, bukan timestamp saja |

Budget mencakup entry committed, staging, dan reservation yang masih aktif agar dua tab tidak lolos admission dengan hitungan sama. Statistik memperlihatkan committed bytes dan aktivitas sementara secara terpisah. Kuota aktual dapat jauh lebih rendah; `estimate()` hanya estimasi dan bukan admission guarantee.

### 6.2 Memory budget dan fallback

- Hindari rangkaian `arrayBuffer -> Uint8Array copy -> Blob copy -> postMessage ArrayBuffer copy` untuk file utuh.
- Stream/hash secara inkremental dan simpan Blob chunk. Hasil siap pakai berupa File/Blob yang mempertahankan nama; structured clone File/Blob tidak menggunakan transfer list ArrayBuffer penuh.
- Engine tetap membutuhkan representasi ArrayBuffer/FS. Ukur puncak memori, waktu hash/baca, dan respons UI; chunked IndexedDB tidak otomatis membuat keseluruhan emulator streaming atau hemat RAM.
- Bila penulisan IDB gagal, hentikan write berikutnya dan bersihkan staging. Download yang sudah berlangsung tetap diteruskan sebagai data sesi bila memungkinkan; kumpulkan Blob chunk tanpa menggandakan unduhan.
- Bila budget jelas tidak cukup sebelum download, lewati write sejak awal dan mainkan dari download satu kali, dengan status **tidak disimpan**.
- Kegagalan cache boleh fallback ke gameplay; kegagalan integritas/network file tidak boleh.
- Jika browser tidak menyediakan stream API yang diperlukan, gunakan fallback terukur dengan batas ukuran yang terdokumentasi atau tolak cache file besar secara jelas. Jangan diam-diam menggandakan buffer 500 MiB.

### 6.3 Kuota dan eviction

- LRU hanya menghapus ROM/BIOS dari DB cache ini; tidak menghapus state, SRAM, LocalStorage riwayat, atau data akun.
- Jangan evict entry yang sedang dipakai untuk assembly; gunakan pin/lease atau aturan kepemilikan generation. Setelah File/Blob siap, penghapusan cache tidak boleh menghentikan sesi berjalan.
- Pada quota error, maksimal satu upaya cleanup + retry penulisan jika aman. Tidak boleh retry tanpa batas atau mengunduh ulang file penuh hanya untuk mengulang write.
- `navigator.storage.estimate()`/`persisted()` bersifat opsional. `persist()` diminta melalui tindakan pengguna jika tersedia; pada HTTP LAN bisa tidak tersedia. IndexedDB adalah baseline dan tidak boleh mensyaratkan secure context.
- Jika API estimasi tidak tersedia, gunakan budget aplikasi dan hasil transaksi nyata; tampilkan bahwa estimasi ruang browser tidak tersedia.
- Mematikan cache berarti tidak memakai/mengisi cache pada peluncuran berikutnya; penghapusan data lama membutuhkan aksi terpisah. Aktifkan opsi tersebut secara eksplisit setelah rollout lulus, bukan tersembunyi di `.env`.

### 6.4 Abort, clear, dan race

- Seluruh persiapan menerima AbortSignal dari lifecycle Player; keluar, sesi berubah, atau akun sesi dihentikan membatalkan network/persiapan yang belum diserahkan.
- Hasil async terlambat tidak boleh configure iframe sesi baru. Integrasi harus aman terhadap StrictMode dan effect cleanup, bukan memakai ref yang mengunci state abort lama.
- Gunakan single-flight di tab yang sama; jangan mempertahankan task dengan AbortSignal pemilik yang sudah mati. Subscriber/cancellation harus jelas.
- Koordinasi lintas tab memakai transaksi IDB/CAS, reservation, dan fencing epoch/generation. Web Locks/BroadcastChannel hanya optimasi, bukan ketergantungan wajib karena HTTP LAN perlu didukung.
- Dua download yang terlanjur berjalan boleh menghasilkan transfer ganda lintas tab pada versi awal, tetapi tidak boleh merusak data atau melewati batas reservation. Klaim dedup lintas tab tidak boleh dibuat tanpa tes khusus.
- Clear cache menaikkan epoch secara atomik. Writer epoch lama tidak boleh mempublikasikan entry atau menulis chunk baru setelah clear; semua transaksi write memeriksa fencing.
- Penghapusan per entry mempunyai fencing generation agar late commit tidak menghidupkan kembali entry yang dihapus. Cleaner orphan tidak boleh menghapus generation yang masih dimiliki writer/read lease valid.
- Lease kedaluwarsa bukan bukti task sudah mati; fencing harus membuat pemilik lama tidak bisa melanjutkan write setelah kepemilikan diambil alih.

## 7. UX dan Batas Keamanan

### Status persiapan

Status host tidak hanya bergantung pada pesan `started` engine:

1. `Memeriksa ROM/BIOS server…`
2. `Membaca cache perangkat…` atau `Mengunduh ROM: X / Y MiB…`
3. `Memverifikasi ROM…`
4. `Menyimpan cache perangkat…` bila belum dikomit
5. `Cache perangkat dipakai` / `Tersimpan di perangkat` / `Dimainkan tanpa disimpan: ruang tidak cukup`
6. Dilanjutkan status engine/core dan tombol start yang sudah ada.

Notifikasi cache bukan error fatal player. Error validasi aset tetap fatal. Sediakan pembatalan dan retry yang membentuk task/sesi baru, tanpa menutupi error integritas atau progres akun.

### Pengelola cache di Pengaturan

- Toggle penggunaan cache ROM/BIOS backend; default rollout akhir **aktif** dengan penjelasan penyimpanan perangkat bersama.
- Budget cache dapat dipilih; tampilkan penggunaan committed, jumlah aset, serta status penyimpanan persisten jika API tersedia.
- Daftar ROM/BIOS: label, nama file, ukuran, waktu terakhir dipakai, status; baca metadata saja.
- Hapus satu aset atau semua cache dengan konfirmasi yang tegas: **tidak menghapus save/progres**.
- Penghapusan menampilkan hasil transaksi, menangani tab lain, dan tidak bergantung pada reload halaman.
- Gunakan Dialog/pola fokus, Escape, keyboard, label aksesibel, dan tampilan seluler yang sudah dipakai aplikasi.
- Jangan menampilkan label "offline siap" atau "permanen".

### Privasi dan protokol iframe

- Cache per origin/profil, **bukan per akun aplikasi**. Aset aktif saat ini bersifat publik; logout tidak menghapus cache atau save tamu otomatis. Perubahan akses aset menjadi privat memerlukan desain baru.
- IndexedDB tidak mengenkripsi ROM. Penghapusan server menolak peluncuran baru setelah pemeriksaan server, bukan menghapus paksa semua byte dari perangkat.
- Tetap validasi origin, source window, channel, sessionId, tipe, ukuran, dan allowlist descriptor pada message. Bridge hanya menerima aset untuk descriptor sesi yang dikonfigurasi.
- ROM/BIOS lokal tidak ditulis ke DB cache. Token/cookie/identitas akun tidak menjadi key atau isi manifest.
- File/Blob tidak perlu dikirim bolak-balik ke host sebagai acknowledgment; status cukup metadata kecil. Batasi referensi agar host/iframe melepas aset saat selesai/keluar.

## 8. Milestone Implementasi dan Pengujian

Urutan: **M0 -> M1 -> M2 -> M3 -> M4 -> M5 -> M6**. Kebijakan/integritas dan prototipe filename harus selesai sebelum optimasi atau klaim dukungan file besar. Setiap milestone dapat menjadi commit terpisah dengan bukti tesnya sendiri.

| Milestone | Hasil utama | Bukti sebelum lanjut |
| --- | --- | --- |
| M0 | Keputusan adapter dan strategi memori/kompatibilitas | Nama file, save lama, dan spike file besar aman |
| M1 | Penyimpanan IndexedDB atomik | Tidak ada hit parsial, race clear aman |
| M2 | Resolver server + cache | Validator/hash benar, download tunggal |
| M3 | Player/bridge/engine terintegrasi | Emulator nyata dan regresi save lulus |
| M4 | Status dan pengelola cache | Kegagalan terlihat, hapus tidak menghapus save |
| M5 | Pembuktian restart/LAN/file besar | Reuse IndexedDB tanpa bantuan HTTP cache |
| M6 | Rollout dan dokumentasi | Hasil deployment nyata dan batas dukungan tercatat |

### M0 — Spike integrasi engine, nama file, dan memori

**Selesai dalam cakupan spike.** [Keputusan, pengukuran aktual, dan batas verifikasi](milestone-0-cache-indexeddb-spike.md). M0 bukan aktivasi cache produksi; hasil storage M1, resolver M2, integrasi M3, pengelola M4 dan pembuktian M5 dicatat terpisah di bawah. M6 tetap diperlukan sebelum rollout.

**Implementasi/spike**

- [x] Buktikan kontrak input native `downloadFile()` tanpa hook engine; descriptor URL tetap di host, basename CHD/BIOS tetap cocok dengan URL lama.
- [x] Adapter per input sesi, tanpa perubahan network global, core, save, atau metadata.
- [x] Buktikan prototipe Blob/chunk 4 MiB pada HTTP LAN dan profil persistent; ukur buffer untuk file sintetis 500 MiB.
- [x] Tetapkan alur setelah Main sekarang, cancellation, dan fase timeout sebagai keputusan M3; belum mengubah timeout player produksi pada M0.
- [x] Catat bahwa generator/loader/bundle/provenance engine tidak perlu berubah; helper bridge akan dibundel reproducible pada M3.
- [x] Pilih input native sehingga `runtimeBuild` tetap aktual, tanpa migrasi/allowlist kompatibilitas.

**Tes dan exit gate**

- [x] NES demo playable melalui native input dan jalur URL lama.
- [x] Basename raw CHD terbukti pada tes metode engine dengan byte sintetis (bukan gameplay PS1); raw NES/ZIP playable dan nama ekstraksi tetap sama.
- [x] BIOS raw/ZIP mempertahankan nama firmware pada engine nyata; fixture sintetis, bukan boot proprietary.
- [x] SaveIdentity, `EJS_gameName`, nama file dan SRAM nyata tetap sama; rumus path PS1 diuji pada kontrak nama sintetis, bukan memcard proprietary nyata.
- [x] SRAM/state dari boot URL dipulihkan ke boot prepared; fingerprint bundle tetap sama dan benar, bukan disamarkan.
- [x] Input prepared tidak memicu HEAD/GET ROM origin kedua oleh engine; HEAD/GET lokal native bukan request origin.
- [x] Tidak ada modifikasi minified atau patch generator; gate kegagalan titik patch tidak berlaku karena patch engine tidak ditambahkan.

**Gate:** pilih/finalkan adapter dan skema chunk berdasarkan bukti. Jika nama/path progres atau memori file besar belum aman, jangan lanjut mengiklankan fitur sebagai dukungan ROM besar.

### M1 — Storage IndexedDB dan kebijakan cache

**Selesai dalam cakupan storage mandiri.** [API, keputusan transaksi, hasil tes dan batas bukti](milestone-1-cache-indexeddb-storage.md). Kini dipakai resolver M2 dan Player M3; default storage tetap nonaktif sampai rollout. M3 menambahkan regresi/fix concurrent abort sebelum close tanpa mengubah schema.

**Implementasi**

- [x] Buat schema, validator, key, metadata index, API storage terstruktur, serta dependency injection clock/IDB untuk tes.
- [x] Implementasikan staging chunk, reservation, transaction-complete commit, read/hash validation, dan orphan cleanup.
- [x] Implementasikan budget/LRU/pin, clear epoch, generation fencing, blocked/versionchange, serta fallback saat IDB tak tersedia (error terstruktur untuk pemanggil; fallback download adalah M2).
- [x] Pisahkan error `unavailable`, `quota`, `corrupt`, `aborted`, `blocked`, dan `incompatible-version` dari error network/integritas.

**Tes**

- [x] Key berbeda untuk ROM/BIOS, ID berbeda, dan hash berbeda; metadata label saja tidak mengubah identitas bytes.
- [x] Ukuran 0, negatif, noninteger, di atas batas, SHA tidak valid, URL unsafe, dan chunk count tidak konsisten ditolak.
- [x] Entry tidak terlihat sebelum commit; request success diikuti transaction abort tidak dilaporkan tersimpan.
- [x] Chunk hilang, berubah byte tetapi ukuran sama, duplikat index, dan Blob salah ukuran terdeteksi.
- [x] Abort/close/reopen mengabaikan staging; cleaner dapat berjalan ulang tanpa menghapus entry valid.
- [x] Clear saat write, delete saat publish, dua writer (termasuk dua tab nyata), lease takeover, dan late completion tidak menghidupkan kembali entry.
- [x] LRU hanya menghapus cache, menghormati pin/reservation, dan statistik tidak membaca payload.
- [x] Buktikan transaksi riil di browser; fake IDB/in-memory adapter hanya pelengkap unit test dan tidak menjadi satu-satunya bukti.

**Gate terpenuhi dalam cakupan M1:** invariants data dan kegagalan transaksi lulus pada storage browser nyata. Integrasi resolver/backend dicatat pada M2; Player tetap belum dihubungkan.

### M2 — Resolver aset, validasi origin, dan hashing

**Selesai dalam cakupan resolver mandiri.** [API, hasil aktual, dan batas bukti](milestone-2-cache-indexeddb-resolver.md). Verifikasi historis M2: 295 tes unit dan 109 tes backend lulus; production statis 54 lulus/60 skip. Pada penyelesaian M2 belum dipanggil Player; kini integrasinya tersedia pada M3 dengan default cache tetap nonaktif.

**Implementasi**

- [x] Bentuk descriptor ROM/BIOS backend lengkap; tambahkan `Bios.size`/descriptor sesi tanpa mengubah kontrak manifest statis menjadi wajib hash.
- [x] Implementasikan fresh HEAD, pemilihan hit/miss, GET stream tunggal, hash inkremental, dan fallback write gagal.
- [x] Reuse/refactor hashing noble yang sudah tersedia untuk HTTP LAN; jangan menambahkan ketergantungan Web Crypto wajib.
- [x] Definisikan hasil resolver: descriptor, File/Blob, source `indexeddb`/`network`, persistence result, bytes transfer, dan warning terstruktur.
- [x] Terapkan AbortSignal, batas body, timeout koneksi/idle yang cocok file besar, serta single-flight tab (satu instance resolver bersama; wiring Player M3).

**Tes**

- [x] Cache hit tetap membuat HEAD origin segar lalu tidak membuat GET penuh.
- [x] Cache miss melakukan satu GET; hasil hash/body tepat dan entry siap setelah commit.
- [x] HEAD 404/410/503/timeout/HTML/ETag hilang/ukuran berubah tidak memakai cache sebagai bypass.
- [x] GET 206/304/redirect/HTML/ETag mismatch/truncated/oversized/hash mismatch tidak disimpan atau dijalankan.
- [x] Cache korup: invalidasi lalu satu download; server error sesudah invalidasi tidak menyebabkan loop.
- [x] Quota write gagal di tengah stream tetap menyelesaikan satu download untuk sesi tanpa mengklaim tersimpan.
- [x] Storage tidak didukung/budget tidak cukup tetap bisa menyiapkan aset valid, dengan warning; kegagalan server tetap fatal.
- [x] Refactor hash menghasilkan digest yang sama dengan `hashRom` dan Node crypto, termasuk pada HTTP non-secure context.

**Gate resolver M2 terpenuhi:** bytes dan validator cocok end-to-end pada backend/IndexedDB nyata; fallback storage tidak menyamarkan error sumber. Hasil regresi penuh dicatat terpisah pada laporan M2; reuse setelah restart proses browser/file besar tetap M5.

### M3 — Integrasi Player, bridge, dan regresi save

**Selesai dalam cakupan integrasi aset kecil/NES.** [Kontrak integrasi, hasil aktual, race abort/fullscreen dan batas bukti](milestone-3-cache-indexeddb-player.md). Verifikasi: **301 unit dan 120 backend lulus; production 55 lulus/70 skip**. Bukti otomatis engine menggunakan NES; PS1 nyata/file besar/restart proses browser belum diuji ulang pada pipeline produksi.

**Implementasi**

- [x] Hubungkan resolver ke lifecycle Player dan descriptor terbaru SetupDialog; pertahankan ID/hash sesi untuk save.
- [x] Tambahkan payload descriptor/File/Blob yang dibatasi dan adapter terpilih dari M0; validasi pada kedua sisi message.
- [x] Bundel helper bridge aplikasi secara reproducible; pertahankan engine/fingerprint M0. Tidak diperlukan patch/regenerasi engine atau perluasan kompatibilitas.
- [x] Ganti timeout tunggal 90 detik dengan fase terpisah: ready/configure, transfer dengan idle timeout + cancel, dan engine start. Progres download tidak dianggap engine hang; timer dibersihkan saat ganti fase/keluar.
- [x] Pertahankan tombol start manual, state overlay, autosave, import/export, fullscreen, dan pengisolasian sesi akun.
- [x] Release reference File/Blob, listeners, request, connection milik sesi, dan object URL jika ada pada cleanup.

**Tes**

- [x] Engine nyata NES menghasilkan canvas aktif dan state dapat diekspor pada miss/hit/restart sesi/dokumen; restart seluruh proses browser tetap M5.
- [x] Nama ROM/BIOS filesystem dan save/progress key tidak berubah; fixture nama sama/ukuran sama/hash berbeda tidak tertukar.
- [x] ROM lokal + BIOS server, ROM server + BIOS lokal, keduanya server, dan tanpa BIOS tetap benar; file lokal tidak masuk DB cache.
- [x] Akun/tamu, logout saat persiapan, regresi pergantian akun, autosave, state restore dan SRAM NES lulus. Jalur PS1 hanya kontrak metode/nama/path sintetis dan envelope unit; gameplay/memcard PS1 nyata belum diuji ulang dan tetap memerlukan verifikasi M5/M6.
- [x] Fixture SRAM/state dari boot URL pada build engine lama yang tidak berubah dipulihkan ke prepared; runtime/core tidak kompatibel tetap ditahan. Bukan menjalankan image release lama; allowlist kompatibilitas tidak diperluas.
- [x] Unmount/StrictMode/retry lambat tidak configure sesi yang sudah mati dan tidak meninggalkan writer aktif.
- [x] Wrong origin/source/session/descriptor atau Blob terlalu besar ditolak; adapter terbatas pada input aset sesi, tidak mengubah network engine/core/save secara global.
- [x] Cache dimatikan memberi perilaku lama, termasuk game bawaan dan manifest tanpa hash.

**Gate M3 terpenuhi dalam cakupan aset kecil/NES:** integrasi memakai hasil resolver tanpa mengubah save dan tanpa download ROM kedua oleh engine. Default masih nonaktif; gate ini bukan bukti rollout, restart proses browser, ROM besar atau gameplay PS1 nyata.

### M4 — Pengelola cache dan pengalaman kegagalan

**Selesai dalam cakupan pengelola cache dan UX kegagalan.** [Kontrak UI, hasil aktual dan batas bukti](milestone-4-cache-indexeddb-settings.md). Verifikasi akhir: **305 unit dan 138 backend lulus; production 66 lulus/77 skip**, termasuk 18 skenario khusus M4 dan HTTP LAN/engine NES nyata. Default tetap nonaktif; toggle Pengaturan memungkinkan opt-in eksplisit, bukan rollout default M6.

**Implementasi**

- [x] Tambahkan status persiapan/progres dan pesan persistence yang tidak bercampur dengan status sinkronisasi save.
- [x] Tambahkan panel Pengaturan, toggle, budget, daftar metadata, hapus satu/semua, dan informasi origin/profil.
- [x] Tambahkan storage estimate/persistence request dengan feature detection dan penanganan penolakan/ketiadaan API.
- [x] Sinkronkan tampilan antar tab secara best-effort; transaksi database tetap sumber kebenaran.

**Tes**

- [x] Setelah write abort UI tidak menampilkan tersimpan; cache hit menampilkan dipakai; storage penuh menampilkan tidak disimpan (quota/abort deterministik, bukan disk fisik penuh).
- [x] Daftar/statistik benar setelah reload dokumen/buka ulang panel, eviction, delete, clear, dan perubahan tab lain. Restart seluruh proses browser tetap M5.
- [x] Menghapus cache tidak menghapus state/SRAM/progres/akun/riwayat; sesi yang sudah memegang Blob tetap berjalan.
- [x] Toggle off tidak menghapus data diam-diam dan tidak mengisi/memakai cache pada peluncuran selanjutnya.
- [x] Keyboard, fokus dialog, pembatalan, screen-reader label, dan viewport ponsel benar pada tes otomatis; bukan audit manual screen reader/perangkat fisik.
- [x] `estimate`/`persist` tidak ada, ditolak, atau throw tidak memblokir game; HTTP LAN non-loopback diuji pada UI/engine NES nyata.

**Gate M4 terpenuhi:** pengguna bisa mengetahui cache berhasil atau gagal dan dapat menghapus hanya data cache; save/progres dan sesi yang sudah memegang aset tetap utuh. Restart proses browser, file besar dan gameplay PS1 nyata bukan bukti M4 dan tetap M5/M6.

### M5 — Pembuktian restart, ROM besar, LAN, dan race

**Selesai dalam cakupan Edge/Windows, engine NES dan transport sintetis besar.** [Implementasi, hasil aktual, diagnosis Blob Chromium dan batas bukti](milestone-5-cache-indexeddb-verification.md). Verifikasi akhir: **313 unit dan 151 backend lulus; production 66 lulus/90 skip; dua kasus simpan/restart besar dan satu kasus fallback kuota 500 MiB lulus dalam run terpisah**. Default tetap nonaktif; verifikasi deployment dan gameplay CHD legal adalah M6.

**Implementasi fixture/instrumentasi**

- [x] Ekstrak/reuse pencatat transfer origin dari `tests/browser/catalog-cache.spec.ts` tanpa mengubah perilaku respons.
- [x] Buat fixture sintetis deterministik berukuran besar di direktori sementara, dengan hash yang diketahui; jangan commit ROM ratusan MB atau aset proprietary.
- [x] Pisahkan suite storage/transport sintetis dari suite emulator playable dan dari uji manual CHD legal.
- [x] Tambahkan suite besar opt-in satu worker dengan time/resource budget yang eksplisit; suite cepat tetap berjalan di default backend.
- [x] Buat origin HTTP LAN nyata (non-loopback), profil persistent terisolasi, dan pengumpulan hasil per fase.

**Tes wajib**

- [x] Browser/profile baru: download penuh, manifest/chunk terkomit, hash tepat, serta byte origin sesuai file.
- [x] Sesi kedua: HEAD origin sukses, cache IndexedDB hit, **GET ROM/BIOS origin = 0**, body aset origin = 0.
- [x] Tutup seluruh context/proses browser, buka profil sama pada origin/port sama: hasil reuse tetap berlaku.
- [x] Ulangi dengan HTTP cache dinonaktifkan/diisolasi pada skenario IndexedDB khusus; IndexedDB tetap ada. Hal ini membuktikan fitur baru, bukan bantuan HTTP cache.
- [x] Hapus hanya database cache aplikasi sementara HTTP cache dinonaktifkan: peluncuran berikutnya melakukan download penuh lagi.
- [x] Uji 24.592 byte, batas chunk -1/tepat/+1, beberapa chunk, **329.641.708 byte**, dan **500 MiB (524.288.000 byte)**. Tulis unit ukuran secara eksplisit; jangan menyamakan MB dan MiB.
- [x] Uji batas ROM 768 MiB dan BIOS 32 MiB pada helper/header; transfer penuh cache ROM 768 MiB/BIOS 32 MiB tidak dijalankan pada M5 dan tidak dihitung lulus implisit.
- [x] HTTP LAN tanpa `crypto.subtle`/Web Locks/persistence API tetap menyimpan dan membaca IndexedDB melalui fallback yang didukung.
- [x] Delete game/BIOS setelah cache terisi menolak sesi baru; file hilang/ukuran rusak/unsafe di origin juga tidak dibypass.
- [x] Offline, server down, dan 5xx tidak memulai game memakai cache; pemulihan server dapat memakai cache lama yang masih valid.
- [x] Dua tab download/clear/delete bersamaan, tab ditutup saat chunk write, dan late commit tidak menghasilkan entry parsial atau resurrection.
- [x] Simulasi quota deterministik melalui adapter (termasuk 500 MiB) dan transaksi browser nyata yang diabort; percobaan kuota origin Chromium dilakukan secara aman. Actual quota exhaustion tidak tereproduksi dan tidak diklaim sebagai disk fisik penuh.

**Gate M5 terpenuhi pada cakupan yang dicatat:** fixture 329.641.708 byte dan 500 MiB tersimpan dan reused setelah restart proses profil sama dengan HTTP cache mati, HEAD origin segar dan GET/body origin nol. Fallback kuota 500 MiB selesai dengan satu download tanpa manifest palsu. Fixture sintetis tidak dihitung sebagai bukti gameplay PS1, actual quota exhaustion tidak tereproduksi, dan rollout tetap M6.

### M6 — Dokumentasi, rollout, dan verifikasi deployment

**Implementasi dokumentasi/rollout**

- [ ] Perbarui README dan `deploy/README.backend.md`: otomatis di frontend, tidak perlu Redis/volume cache Docker/.env cache baru, dukungan HTTP LAN, dan batas kuota/RAM.
- [ ] Tambahkan tautan lanjutan dari dokumen HTTP cache lama tanpa mengganti hasil tes historis atau mengklaim hasil baru sudah lulus.
- [ ] Dokumentasikan lokasi `Application -> IndexedDB -> maindulu-asset-cache`, status UI, cara hapus, perbedaan save, serta bahwa chunk/staging bukan koleksi siap pakai.
- [ ] Catat regenerasi engine, fingerprint baru, kompatibilitas progres/state, keputusan skema, dan rollback.
- [ ] Aktifkan default setelah M0–M5 lulus pada cakupan rilis; sediakan toggle pengguna dan kill switch build-time bila diperlukan. Kill switch bukan perubahan kebijakan cache backend global.
- [ ] Catat hasil aktual per browser/OS/origin/ukuran, jumlah tes, waktu, serta skenario yang tidak dijalankan.

**Verifikasi deployment**

- [ ] Build frontend dan bundle adapter terbaru benar-benar ada dalam image/backend yang dijalankan.
- [ ] Node langsung, Docker backend, HTTP LAN, serta HTTPS reverse proxy diuji terpisah. Lulus loopback Windows tidak dianggap bukti Docker/Linux/HTTPS.
- [ ] Proxy mempertahankan ETag/Content-Length dan tidak mengubah error menjadi HTML atau melayani aset melalui static alias. Jika representasi dikompresi/diubah, verifikasi validator dan jumlah byte.
- [ ] Restart/recreate backend dengan origin sama tidak menghapus IndexedDB browser; origin/domain/port baru memakai storage terpisah.
- [ ] Uji manual CHD besar yang sah: pertama download, sesi kedua, restart browser, canvas/gameplay aktif, dan save/progres sebelumnya tetap bisa dipakai.

**Gate:** dokumentasi memisahkan target, hasil nyata, dan keterbatasan; tidak ada klaim "500 MB pasti tersimpan di semua perangkat".

## 9. Strategi Pengujian dan Bukti

### 9.1 Jangan mencampur dua jenis cache

- Tes HTTP cache lama tetap memerlukan cache HTTP aktif dan tidak memakai interception/CDP toggle yang mematikannya.
- Tes IndexedDB baru harus mempunyai skenario yang **secara sengaja menonaktifkan HTTP cache** melalui mekanisme browser Chromium/CDP yang terisolasi. Ini tidak boleh dipakai pada tes HTTP cache historis.
- Untuk restart, terapkan kembali pengaturan isolasi HTTP cache pada setiap peluncuran browser yang baru. Service worker diblokir pada fixture pengukuran.
- Jangan hanya mengandalkan status respons JavaScript, loading cepat, atau adanya nama database. Buktikan entry committed, byte/hash, source resolver, dan jumlah request/body origin.
- Storage state Playwright bukan backup seluruh profil/disk cache. Gunakan `launchPersistentContext` dengan direktori profil dan origin/port yang sama.
- Jika HTTP cache tidak dapat dinonaktifkan pada browser non-Chromium, gunakan metode isolasi lain yang terdokumentasi dan jangan menyebut buktinya setara tanpa pemeriksaan.

### 9.2 Matriks hasil yang harus direkam

| Fase | HEAD origin | GET origin | Body origin | IndexedDB | Hasil |
| --- | --- | --- | --- | --- | --- |
| Cold miss | Sukses dan segar | 1 per aset | Ukuran file penuh | Commit sesudah hash valid | Bisa dipakai, status tersimpan |
| Warm hit | Sukses dan segar | 0 | 0 | Baca entry/chunk valid | Bisa dipakai dari perangkat |
| Restart profil sama | Sukses dan segar | 0 | 0 | Data masih tersedia | Bisa dipakai dari perangkat |
| IDB dihapus, HTTP cache mati | Sukses dan segar | 1 | Ukuran file penuh | Dibuat ulang jika cukup ruang | Tidak ada reuse palsu |
| Quota gagal | Sukses dan segar | 1, tanpa retry penuh | Ukuran file penuh | Tidak ada entry siap palsu | Bisa dipakai, tidak tersimpan |
| Server delete/file unavailable | Gagal | 0 untuk pipeline yang berhenti pada HEAD | 0 | Tidak dipakai | Peluncuran ditolak |
| Cache korup, server sehat | Sukses dan segar | 1 | Ukuran file penuh | Entry baru valid | Pulih sekali, tidak loop |

Jumlah HEAD dapat lebih dari satu bila guard metadata/engine lama masih terlibat; catat sumbernya dan kurangi duplikasi yang tidak diperlukan. Jangan menghitung HEAD adapter in-memory sebagai request origin. Pada hit pipeline baru, bukan GET 304 yang ditargetkan, melainkan **tidak ada GET aset ke origin**.

### 9.3 Artefak

Simpan di output tes yang diabaikan Git, misalnya:

- `server-asset-transfers.json`: fase, URL, method, status, ETag, header cache, byte body yang benar-benar ditulis server, termasuk kegagalan/abort bila dapat diamati.
- `indexeddb-cache-events.json`: source, key/hash, ukuran, generation/epoch, hasil commit/read/cleanup, warning/error; tanpa cookie/token.
- `cache-summary.json`: jumlah chunk, ukuran logical committed/staging, browser/OS, secure context, storage estimate/persistence availability, durasi download/hash/read/write.
- Trace/screenshot kegagalan dan catatan resource. Metrik JS heap saja tidak cukup mewakili Blob backing storage, ArrayBuffer eksternal, WASM, dan seluruh RAM browser.

Tidak perlu melampirkan byte ROM atau dump IndexedDB proprietary. Pengukuran file besar menggunakan fixture sintetis atau file legal di mesin operator.

### 9.4 Perintah verifikasi

Perintah yang **sudah ada** dan harus dijalankan setelah implementasi:

```text
npm test
npm run build
npm run test:e2e:backend
npm run test:e2e:production
```

Build harus dilakukan sebelum suite backend/production agar frontend/bridge terbaru dipakai. Suite production statis dipakai untuk regresi lokal/demo, bukan bukti fitur katalog upload tersedia pada hosting statis.

Perintah terfokus M3 yang **sudah didaftarkan** pada `playwright.backend.config.ts`:

```text
npm run test:e2e:backend -- tests/browser/catalog-indexeddb-cache.spec.ts
```

Script opt-in M5 yang **sudah ada di package.json**:

```text
npm run test:e2e:asset-cache:large
```

Script besar memakai backend/fixture eksplisit, satu worker, tanpa retry, timeout 10 menit per ukuran, dan preflight disk bebas >=6 GiB/RAM tersedia >=2 GiB. Profil pribadi tidak digunakan; fixture/profile dibersihkan setelah browser ditutup dan artefak disimpan ke output tes. Gunakan `--output` terpisah untuk suite lain agar output default tidak membersihkan artefak besar.

## 10. Kriteria Penerimaan Rilis

- [ ] ROM/BIOS eligible yang berhasil dikomit terlihat melalui UI dan IndexedDB; ukuran/hash tepat, bukan sekadar nama database.
- [ ] Reuse sesi kedua dan restart profil sama terbukti tanpa GET/body aset origin, meskipun HTTP cache tidak membantu.
- [ ] File sintetis 329.641.708 byte dan 500 MiB melewati alur simpan/baca/restart pada browser yang dicatat.
- [ ] Engine nyata playable untuk fixture legal; uji transport sintetis tidak diklaim sebagai gameplay CHD/firmware.
- [ ] Server tetap diperiksa; delete, file hilang, offline, dan error tidak dibypass oleh salinan lokal.
- [ ] Nama sama/ukuran sama/konten berbeda tidak tertukar; namespace ROM dan BIOS tidak bertabrakan.
- [ ] Quota/IDB unavailable tidak memblokir gameplay aset sehat dan tidak menyebabkan download ganda atau status tersimpan palsu.
- [ ] Abort, banyak tab, clear, dan cleanup tidak menghasilkan manifest parsial, budget race tak terkendali, atau resurrection.
- [ ] SaveIdentity, nama filesystem, state/SRAM/memcard, tamu/akun, dan save server tidak berubah/regresi.
- [ ] File lokal/statis di luar cakupan tidak dipersistenkan otomatis.
- [ ] Pengguna dapat menonaktifkan/menghapus cache tanpa menghapus save; persistence tidak dijanjikan permanen.
- [ ] Dokumentasi dan hasil aktual menyebut batas browser/perangkat/origin/ukuran, serta hasil deployment yang benar-benar diuji.

## 11. Rollback dan Operasi

1. Nonaktifkan penggunaan/pengisian cache melalui toggle/kill switch aplikasi; kembalikan jalur aset URL langsung yang sudah ada.
2. Adapter engine harus tetap kompatibel ketika tidak ada aset prepared: semua request melewati jalur aslinya. Jangan membuat keberadaan IndexedDB menjadi prasyarat boot.
3. Jangan mengubah cache global backend menjadi public/immutable untuk mengompensasi kegagalan frontend. HTTP cache lama tetap `private, no-cache` dengan validator.
4. Tidak ada migrasi SQLite/save. Cache IndexedDB boleh dibiarkan untuk penghapusan eksplisit pengguna; rollback tidak boleh menghapus save atau semua storage origin.
5. Jika rollback ke bundle/build sebelumnya, uji metadata fingerprint dan restore state/progres sesuai kontrak build yang berlaku. Perubahan bundle dapat mengubah runtimeBuild meskipun identitas game tetap; jangan mengklaim semua state lama otomatis kompatibel.
6. Jika skema IDB sudah naik, aplikasi lama fallback tanpa cache; jangan downgrade schema atau menghapus DB baru secara diam-diam.

## 12. Referensi Kode dan Dokumen

- [HTTP cache ROM/BIOS yang sudah diimplementasikan](rencana-cache-rom-bios.md).
- [Kontrak API katalog dan reverse proxy](milestone-3-api-katalog.md).
- [Library/player katalog backend](milestone-5-library-player.md).
- [Progres game dan batas PS1](milestone-6-progres-game.md).
- [Identitas save berbasis hash](rencana-save-identity-hash.md).
- `src/components/Player.tsx`: payload configure, timeout, lifecycle akun, state/progres.
- `src/components/SetupDialog.tsx`: refresh metadata dan pemilihan BIOS sebelum launch.
- `src/lib/catalog.ts`: `CatalogEntry`, `latestCatalogEntry`, URL dan hash/ukuran.
- `src/lib/identity.ts`: SHA-256 inkremental dan fallback HTTP LAN.
- `public/player/player.js`: HEAD, URL blob lokal, flag database, dan path progres.
- `public/vendor/emulatorjs/4.2.3/data/src/emulator.js`: `downloadFile`, `getBaseFileName`, `downloadRom`, dan `downloadGameFile`.
- `public/vendor/emulatorjs/4.2.3/data/src/storage.js`: perilaku cache IndexedDB bawaan yang tidak dipakai rancangan ini.
- `scripts/vendor-engine.mjs`: sumber perubahan engine dan provenance yang reproducible.
- `tests/browser/catalog-cache.spec.ts`: profil persistent dan pencatat byte origin untuk HTTP cache sebelumnya.
