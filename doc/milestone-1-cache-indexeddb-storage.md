# M1 — Storage IndexedDB dan Kebijakan Cache

Status: **selesai pada 2026-11-05 dalam cakupan storage mandiri**. Lanjutan [rencana IndexedDB ROM/BIOS](rencana-cache-indexeddb-rom-bios.md) dan [spike M0](milestone-0-cache-indexeddb-spike.md).

**Belum mengaktifkan cache pada aplikasi pengguna.** Player, resolver backend, protokol bridge, dan UI tidak diubah. M2–M6 tetap diperlukan; hasil storage ini bukan bukti reuse katalog backend setelah restart browser atau gameplay ROM besar.

## 1. Implementasi

| File | Isi |
| --- | --- |
| `src/lib/asset-cache-policy.ts` | Descriptor backend ketat, namespace/key, ukuran/chunk, budget/LRU, pengaturan dan error terstruktur |
| `src/lib/asset-cache.ts` | Database produksi v1, writer/reader, commit atomik, reservation, pin, fencing dan cleanup |
| `tests/asset-cache-policy.test.mjs` | Delapan tes unit kebijakan, batas domain, namespace dan unavailable fallback |
| `tests/fixtures/asset-cache-storage.ts` | Harness test-only; bundling in-memory, fixture sintetis kecil dan akses korupsi/fault injection |
| `tests/browser/asset-cache-storage.spec.ts` | 27 tes dengan transaksi IndexedDB browser nyata, termasuk dua tab |
| `playwright.backend.config.ts` | Mendaftarkan suite storage pada backend secara eksplisit |

Tidak ada dependency baru, perubahan skema SQLite, engine/vendor/provenance, `builds.json`, saveIdentity, format state/SRAM/memcard, maupun flag database EmulatorJS. Modul baru belum diimpor frontend aktif, sehingga bundle aplikasi tetap memakai alur lama.

## 2. Skema dan API

Database default **`maindulu-asset-cache` v1**, terpisah dari `EmulatorJS-states` dan database prototipe M0. Default pengaturan `{ enabled: false, budget: 2147483648 }`; aktivasi akhir adalah M6, bukan toggle engine.

- `entries`: manifest committed saja; key `[kind, catalogId, sha256]`, index LRU, katalog dan generation unik.
- `chunks`: Blob maksimal **4 MiB**, key `[generationId, index]`. Prefix composite key menjadi jalur pencarian/hapus generation; tidak memerlukan index payload.
- `staging`: owner, epoch, ukuran/count aktual, reservation ukuran penuh dan heartbeat; index katalog/heartbeat.
- `control`: epoch, pengaturan, pin reader dan posisi cursor maintenance.

Descriptor hanya menerima endpoint upload kanonis yang cocok dengan jenis/ID/basename ter-encode: `/games/:id/rom/:name` atau `/bios/:id/:name`. Static manifest, local File, URL eksternal, query/fragment, ukuran tidak valid dan SHA tidak valid ditolak. Label tidak menjadi identitas byte.

API utama:

```ts
const cache = await openAssetCache(options)
// Hanya pemanggil yang sengaja mengaktifkan pengaturan yang boleh mengisi cache.
await cache.setSettings({ enabled: true, budget: DEFAULT_ASSET_BUDGET })
const writer = await cache.begin(descriptor, signal)
await writer.append(chunkBlob) // berurutan, tepat 4 MiB kecuali chunk terakhir
await writer.heartbeat()       // opsional jika transfer idle lama
const entry = await writer.commit() // baru berhasil setelah transaction.oncomplete
const hit = await cache.read(descriptor, signal) // null jika miss/nonaktif
await cache.stats()           // metadata saja, tidak membaca Blob
await cache.delete('rom', catalogId, optionalSha256)
await cache.clear()
await cache.cleanup(256)      // scan key dibatasi dan dapat dilanjutkan
cache.close()
```

Pada kegagalan/cancel, pemanggil dapat `await writer.abort()`; AbortSignal juga menjadwalkan cleanup. Pemilik lifecycle sebaiknya menunggu abort/settlement operasi sebelum `close()` agar cleanup sempat commit. Close/crash mendadak dapat meninggalkan staging/pin sampai lease kedaluwarsa, tetapi tidak menjadi hit. Writer basi setelah satu jam dapat diambil alih secara ter-fence. `cleanup()` dipanggil pemilik lifecycle; tidak ada interval background produksi atau koneksi global permanen pada M1.

## 3. Invariants dan Keputusan Transaksi

- Setiap operasi readwrite mengunci keempat store dalam transaksi pendek. Ini sengaja mengutamakan konsistensi admission/fencing dibanding paralelisme; tidak perlu Web Locks, BroadcastChannel atau lease cleaner terpisah.
- Hanya request IDB yang di-await di dalam transaksi. Blob read/hash/yield berlangsung di luar transaksi.
- Writer meng-hash byte setiap chunk secara inkremental memakai noble, memperbarui penghitung sesudah transaksi chunk selesai, lalu mengecek ukuran/count/digest sebelum publikasi manifest dan penghapusan staging secara atomik.
- Reader memasang pin generation, membaca satu chunk per transaksi, memeriksa ukuran/count dan SHA-256 inkremental, lalu membuat Blob dari bagian terverifikasi. Tidak ada buffer hash file penuh tambahan.
- Cache korup menghasilkan `corrupt`, menginvalidasi generation yang dibaca secara kondisional, dan menyisakan cleanup orphan yang aman dijalankan ulang. M1 tidak melakukan retry jaringan.
- Clear menaikkan epoch sekaligus menghapus store aset. Delete menghapus reservation generation yang relevan. Semua append/heartbeat/commit memeriksa owner, generation, epoch, lease dan enabled; task lama tidak dapat melanjutkan setelah kepemilikan dicabut.
- Pin reader diperbarui per chunk. LRU/cleaner tidak menghapus generation yang sedang dirakit. Jika pin kedaluwarsa dan diambil alih, reader lama gagal `fenced`, bukan meneruskan atau menginvalidasi replacement.
- Admission menghitung **committed + reservation penuh**. `stagingBytes` adalah bagian yang sudah ditulis dari reservation, ditampilkan terpisah, bukan ditambahkan lagi ke total budget. Dua tab tidak dapat meloloskan reservation yang sama terhadap budget aplikasi.
- `estimate()` opsional, best-effort dan diberi reserve **128 MiB**; reservation penuh juga diperhitungkan secara konservatif. Ketiadaan/rejection API tidak membuat IndexedDB bergantung pada secure context. Estimasi bukan jaminan kuota.
- LRU hanya menghapus aset DB cache ini. Penurunan budget ditolak atomik jika pin/reservation aktif tidak memungkinkan pemenuhan budget. Toggle off mempertahankan entry committed, tetapi mencabut writer lama.
- Quota write mengizinkan paling banyak satu eviction+retry chunk yang sama per writer bila aman. Kegagalan berulang membersihkan staging dan tidak menghasilkan manifest palsu. Tidak ada fetch/download di modul ini.
- Cleanup orphan memakai cursor **key-only**, default maksimal 256 key per panggilan, dengan checkpoint lintas panggilan. Penghapusan generation basi/evicted menggunakan range delete, bukan membaca payload.

Error dibedakan: `unavailable`, `quota`, `corrupt`, `aborted`, `blocked`, `incompatible-version`, ditambah `invalid`, `budget`, `disabled`, `busy`, dan `fenced`. M2 harus menangkap kegagalan storage untuk fallback sesi tanpa cache; kegagalan sumber/backend tidak ditangani atau dibypass modul ini.

`versionchange` menutup koneksi dan membatalkan transaksi miliknya; versi DB lebih baru menghasilkan fallback error tanpa downgrade/delete. Request opening yang sudah gagal karena blocked tidak boleh membuka koneksi terlambat atau memasang schema setelah blocker dilepas.

## 4. Pengujian Aktual

Lingkungan: Windows, Microsoft Edge headless, IndexedDB asli, origin HTTP loopback, context Playwright terisolasi (bukan profil pribadi). Harness dikirim hanya pada URL test-only melalui Playwright dan bundle esbuild in-memory; tidak masuk `public/` atau deployment. Tidak memakai fake IndexedDB.

Run terfokus terakhir: **27/27 lulus**, tanpa retry/skip, sekitar **14,4 detik**:

- staging tidak terlihat sebelum commit; close/reopen mempertahankan entry committed;
- manifest `put` sukses lalu transaksi abort tetap gagal commit;
- jenis/ID/hash berbeda, label berubah, multi-chunk 4 MiB + 1;
- chunk hilang, salah byte dengan ukuran sama, salah ukuran, index ekstra/negatif, count manifest rusak, dan duplicate add;
- abort, abandoned staging, cleanup berulang, clear/delete saat append/publish, dua tab dengan admission bersamaan;
- writer/read lease takeover dan hasil terlambat tidak menghidupkan entry kembali;
- pin melindungi assembly, LRU mengikuti last successful read, statistik tidak membaca payload;
- quota fault injection membatalkan transaksi browser nyata, retry tepat satu kali, dan kegagalan ulang tidak meninggalkan entry/staging;
- toggle off tidak menghapus entry diam-diam, estimate tidak ada/gagal, reserve estimasi, serta save DB/LocalStorage sentinel tidak tersentuh oleh eviction/clear;
- upgrade/versionchange, versi lebih baru, blocked dan request opening yang ditinggalkan.

Kasus blocked memakai factory shim untuk meminta upgrade v2 yang ditahan koneksi v1; locking dan abort tetap transaksi IndexedDB asli. Versi skema produksi tetap v1.

Perintah reproduksi:

```text
node --test tests/asset-cache-policy.test.mjs
npm test
npm run build
npm run test:e2e:backend -- tests/browser/asset-cache-storage.spec.ts
npm run test:e2e:backend
npm run test:e2e:production
npx tsc --noEmit --strict --skipLibCheck --moduleResolution bundler --module esnext --target es2022 --allowJs --allowImportingTsExtensions tests/browser/asset-cache-storage.spec.ts tests/fixtures/asset-cache-storage.ts
```

Hasil verifikasi:

- `npm test`: **250/250 lulus**, tanpa fail/skip/cancel.
- `npm run build` dan pemeriksaan TypeScript spec/harness: **lulus**.
- Backend storage terfokus: **27/27 lulus**, tanpa retry/skip.
- Suite production statis penuh: **54 lulus, 53 skip**, tanpa kegagalan, sekitar **1,5 menit**. Skip adalah skenario khusus backend pada deployment statis; bukan kelulusan implisit. Termasuk 27 tes storage dan regresi engine/save serta HTTP LAN aplikasi lama, bukan integrasi cache katalog produksi.
- `npm run test:e2e:backend`: **102/102 lulus**, tanpa fail/retry/skip, sekitar **8,9 menit**. Termasuk 27 tes storage serta regresi akun, katalog, HTTP cache/restart/delete, gameplay NES, state/SRAM/progres, isolasi tamu/akun dan kompatibilitas build pada jalur lama.

Suite production memakai `--output C:\Users\Ardi Putra\AppData\Local\Temp\opencode\maindulu-m1-production-results` untuk memisahkan output dari data/artefak suite backend yang berjalan. Screenshot aplikasi lama dengan path tetap berada di `test-results/` sebagaimana sebelumnya.

Percobaan awal mendeteksi error kuota tertimpa error abort dari request sesudah transaksi dibatalkan. Wrapper transaksi diperbaiki untuk mempertahankan penyebab pertama, termasuk ketika `abort()` kedua ditolak karena transaksi sudah abort. Run awal gagal tidak dihitung sebagai kelulusan.

## 5. Batas Bukti dan Langkah Berikutnya

- **Belum ada resolver HEAD/GET, persiapan Player atau UI**; tidak ada klaim download tunggal/reuse origin dari storage-only ini. Berikutnya **M2 — resolver aset, validasi origin, dan hashing**.
- Close/reopen koneksi bukan restart proses browser. Bukti restart profil dan HTTP cache dimatikan pada pipeline produksi tetap M5; hasil prototipe M0 tidak dipindahkan menjadi hasil M1.
- Payload browser M1 hanya fixture kecil dan 4 MiB + 1; 329.641.708 byte, 500 MiB, batas transfer maksimum, dan gameplay CHD tidak dijalankan ulang.
- Quota error diinjeksikan deterministik pada transaksi riil; bukan klaim telah memenuhi disk/kuota browser fisik. Percobaan quota browser nyata yang aman tetap M5.
- Penyimpanan M1 belum diuji terpisah di HTTP LAN non-loopback, Firefox/Safari, Docker/Linux atau HTTPS reverse proxy. Suite regresi LAN aplikasi tidak otomatis menjadi bukti cache M1 pada LAN.
- Two-tab admission/fencing bukan dedup transfer antartab; single-flight/tab dan network cancellation adalah M2/M3.
- Tidak ada persist request, panel pengaturan atau janji penyimpanan permanen/offline. Engine/fingerprint tidak berubah, dan regresi save tetap diuji melalui suite aplikasi lama.
