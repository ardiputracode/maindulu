# M2 — Resolver Aset, Validasi Origin, dan Hashing

> Catatan historis: hasil dan batas di bawah merekam penutupan M2, bukan status rollout terbaru. [M6](milestone-6-cache-indexeddb-rollout.md) kini selesai untuk cakupan lokal/HTTP LAN; default aktif hanya untuk DB baru, Docker/CHD dikonfirmasi manual pengguna, dan HTTPS ditunda (bukan lulus). Preferensi DB lama tetap dihormati.

Status: **selesai pada 2026-11-05 dalam cakupan resolver mandiri**. Lanjutan [rencana IndexedDB ROM/BIOS](rencana-cache-indexeddb-rom-bios.md) dan [storage M1](milestone-1-cache-indexeddb-storage.md).

**Cache belum diaktifkan pada aplikasi pengguna.** Setup menyiapkan descriptor sesi, tetapi Player belum memanggil resolver dan bridge tetap memakai alur URL lama. Integrasi engine adalah M3; UI/pengelola cache M4; pembuktian restart browser/file besar M5; rollout M6.

## 1. Implementasi

| File | Perubahan |
| --- | --- |
| `src/lib/server-assets.ts` | Resolver descriptor terbaru → HEAD origin → read terverifikasi / satu GET streaming → verifikasi → commit atau fallback sesi |
| `src/lib/asset-cache-policy.ts` | `catalogAssetDescriptor()` mengubah metadata backend menjadi descriptor ketat M1 |
| `src/lib/catalog.ts` | Error HTTP katalog mempertahankan status; request tetap `no-store`, same-origin, dan menolak redirect |
| `src/lib/domain.ts` | `Bios.size` opsional agar manifest statis tetap kompatibel |
| `src/components/SetupDialog.tsx` | Menyertakan descriptor ROM/BIOS upload terbaru dalam sesi; static/local tidak diberi descriptor backend |
| `src/components/Player.tsx` | Hanya perluasan tipe `LaunchSession.serverRom` / `serverBios`, belum integrasi resolver |
| `src/lib/identity.ts`, `src/lib/asset-cache.ts` | Satu helper SHA-256 inkremental noble untuk identitas lokal, network, dan verifikasi storage; algoritma/digest tidak berubah |
| `tests/server-assets.test.mjs` | Validator sumber, streaming, fallback, single-flight, cancellation, timeout, dan parity hash |
| `tests/fixtures/server-assets.ts`, `tests/browser/server-assets.spec.ts` | Harness test-only dengan backend dan IndexedDB browser nyata, termasuk HTTP LAN |
| `playwright.backend.config.ts` | Registrasi eksplisit suite resolver |

Tidak ada dependency baru, endpoint backend baru, perubahan SQLite, schema cache v1, database save, format progres, saveIdentity, generator/vendor engine, `builds.json`, atau fingerprint runtime. `EJS_disableDatabases = true` dan `EJS_CacheLimit = 0` tetap dipertahankan.

## 2. Kontrak Resolver

```ts
const resolver = createServerAssetResolver()
try {
  const prepared = await resolver.resolve(serverRomDescriptor, {
    signal,
    onProgress: progress => { /* host M3/M4 */ },
  })
  // prepared.blob: bytes asli yang sudah diverifikasi, belum adapter engine.
  // prepared.descriptor: tetap menyimpan URL/nama asli serta ID/hash sesi.
} finally {
  await resolver.close()
}
```

Hasil:

- `descriptor`: metadata sumber terbaru; perubahan label boleh diterima, perubahan identitas byte/console/URL/nama/ukuran/hash ditolak dengan `changed` dan harus membuka ulang entri.
- `blob`: byte ROM/BIOS asli, bukan ZIP firmware adapter atau object URL. Konversi File bernama basename URL ter-encode dan adapter BIOS M0 tetap pekerjaan integrasi M3.
- `source`: `indexeddb` atau `network`.
- `persistence`: `reused`, `stored`, atau `not-stored`. `stored` hanya setelah Promise commit M1 selesai, yang menunggu `transaction.oncomplete`.
- `transferredBytes`: nol untuk hit, ukuran body terverifikasi untuk hasil network yang berhasil.
- `warnings`: kode/message storage terstruktur, terpisah dari error fatal sumber.

Fase progres: `metadata`, `checking`, `reading-cache`, `downloading`, `verifying`, `saving`, dan `ready`, dengan jenis aset serta received/total bytes. Progres adalah metadata kecil, bukan acknowledgment byte bolak-balik.

`cacheEnabled: false` melarang pemakaian/pengisian cache oleh resolver, tetapi download tetap memakai validasi sumber dan hash. Pengaturan DB default **tetap nonaktif**; resolver tidak memanggil `setSettings()` untuk mengaktifkannya. Harness tes sengaja mengaktifkan DB terisolasi. Invalidation karena penghapusan server tetap dicoba meskipun penggunaan cache dimatikan.

## 3. Validasi dan Fallback

1. Descriptor input wajib endpoint upload kanonis M1; local File, static demo, hash/ukuran invalid, dan URL eksternal ditolak sebelum request.
2. Ambil ulang `latestCatalogEntry()` dengan `no-store`. Jangan mengganti hash/ID sesi diam-diam jika sumber berubah.
3. HEAD origin selalu lebih dahulu daripada membaca cache, dengan `cache: 'no-store'`, `mode`/credentials same-origin, `redirect: 'error'`, tanpa conditional/Range header.
4. HEAD maupun GET wajib status penuh 200, strong ETag persis `"<sha256>"`, Content-Length positif dan persis descriptor, bukan HTML/XHTML, bukan content-range, dan tidak berpindah URL.
5. Hit memakai pembacaan chunk/hash/pin M1. Cache korup diinvalidasi secara kondisional oleh M1, lalu resolver melakukan maksimal satu GET normal. Tidak ada loop retry network.
6. Miss melakukan satu GET `no-store`. Byte dibatasi terhadap descriptor, di-hash inkremental sambil diterima, dan dirakit menjadi Blob chunk maksimal **4 MiB**. Tidak memakai full-file `response.arrayBuffer()` atau buffer transfer ArrayBuffer penuh.
7. Verifikasi EOF/ukuran/SHA-256 dilakukan sebelum commit. Stream kosong, terpotong, berlebih, terputus, atau hash salah tidak menghasilkan aset siap ataupun manifest committed.
8. Admission budget gagal atau IDB tidak tersedia: tetap download sekali, hasil `not-stored` dengan warning. Write gagal di tengah stream: hentikan write berikutnya dan abort staging, tetapi teruskan stream yang sama menjadi Blob sesi. Quota retry chunk yang aman tetap kewenangan M1, maksimal satu, tanpa GET ulang.

404/410 dari metadata/HEAD/GET menghentikan persiapan dan mencoba menghapus salinan cache untuk jenis/ID terkait, termasuk fencing writer. Network error, timeout, dan 5xx juga menghentikan persiapan, **tanpa menganggap cache lama rusak atau menghapusnya**. Kegagalan invalidasi storage tidak mengubah error sumber menjadi keberhasilan.

Error fatal resolver dibedakan: `invalid`, `changed`, `unavailable` (sumber dihapus/tidak tersedia), `http`, `validator`, `integrity`, `network`, `timeout`, `aborted`, dan `unsupported-stream`. Warning IDB memakai kode `AssetCacheError` M1; kode bernama sama pada domain berbeda tidak dipakai untuk mem-bypass sumber.

## 4. Timeout, Memori, dan Lifecycle

- Metadata mempertahankan timeout katalog 15 detik. HEAD/header GET mempunyai timeout respons **30 detik**; setiap pembacaan stream mempunyai idle timeout **60 detik**. Nilai transport dapat diinjeksi untuk tes. Tidak ada total download timeout 90 detik; ini belum mengubah timer Player produksi.
- Idle timer jaringan tidak berjalan ketika sedang menunggu transaksi chunk/hash lokal. Waktu total transfer aktif boleh lebih lama daripada satu idle window.
- Jika streaming tidak tersedia, resolver menolak secara eksplisit (`unsupported-stream`), bukan diam-diam menggandakan buffer file besar.
- Blob chunk hasil jaringan dipakai bersama untuk hasil sesi dan write; setelah write gagal, hasil yang sudah diterima tidak diunduh ulang. Hash jaringan tetap independen dari writer agar fallback storage tidak melewati pemeriksaan integritas.
- M1 juga memverifikasi digest write/read. Ada biaya CPU hash tambahan, tetapi tidak menambah buffer hash utuh sebesar ROM.
- Single-flight berlaku pada **satu instance resolver**, yang ditujukan dipakai bersama pada satu tab. Label tampilan tidak memecah task aset sama; descriptor sumber berbeda tidak digabung.
- Subscriber memiliki AbortSignal masing-masing. Membatalkan satu subscriber tidak membatalkan subscriber lain. Subscriber terakhir pergi: hapus flight dan abort network segera; pemanggilan berikutnya membentuk task/controller baru, bukan mewarisi signal mati.
- Task selesai tidak dimemoisasi: sesi berikutnya wajib metadata/HEAD segar lagi. Tidak ada klaim dedup transfer lintas tab.
- Resolver memiliki koneksi dari factory `openCache`, menunggu cleanup writer, lalu menutup koneksi pada hit/sukses/gagal. Jangan menginjeksi koneksi bersama yang masih dipakai pemilik lain.
- `close()` menghentikan task aktif dan menunggu settlement/cleanup. Pembukaan DB terlambat ditutup ketika akhirnya tersedia; metadata terlambat tidak dapat menghidupkan kembali task. Listener/timer jaringan dibersihkan pada settlement/cancel.
- Blob hasil terverifikasi dapat dipegang pemanggil setelah resolver selesai/ditutup. Pelepasan referensi host/iframe dan perakitan ROM/BIOS berurutan masih harus dipasang dalam lifecycle Player pada M3.

## 5. Bukti Pengujian

Lingkungan: Windows x64, **Node.js v26.12.1**, Microsoft Edge headless (trace mencatat Edge **156.0.0.0**), backend lokal, context browser terisolasi; bukan profil pribadi. ROM transport sintetis **4.194.341 byte (4 MiB + 37)** dan BIOS sintetis **512 byte**; tes unit juga merakit **8 MiB + 17** dengan fragment network yang tidak sejajar chunk storage.

### Suite resolver browser

Run terfokus: **7/7 lulus**, tanpa retry/skip, sekitar **14,8 detik**:

1. Miss ROM dan BIOS: masing-masing satu HEAD dan satu GET penuh, ukuran/hash benar, manifest committed dan staging kosong. Peluncuran resolver berikutnya membuka koneksi baru, melakukan HEAD origin, source `indexeddb`, GET/body aset **nol**.
2. Chunk IndexedDB diubah byte dengan ukuran sama: read mendeteksi hash korup, invalidasi, satu HEAD + GET, kemudian replacement valid.
3. Quota fault injection pada transaksi chunk kedua di IndexedDB nyata: hasil sesi lengkap/hash benar, satu GET, warning `quota`, tanpa manifest/staging/reservation tertinggal. Ini bukan bukti disk browser fisik penuh.
4. Body network diubah byte dengan ukuran/header/ETag sama: hash ditolak, chunk yang sudah staged dibersihkan, tidak ada hasil siap/manifest palsu.
5. Default DB off, budget tidak cukup, storage ditolak, dan toggle resolver off: network-only terverifikasi, tidak ada committed entry.
6. HEAD 503 terkontrol tidak memakai hit atau menghapusnya; pemulihan server memakai hit lama. Penghapusan metadata BIOS melalui repository backend nyata menolak persiapan baru dan menginvalidasi salinan lokal.
7. Origin **HTTP LAN non-loopback nyata**: `isSecureContext === false`, tidak ada `crypto.subtle`, Web Locks, atau storage estimate API; miss tersimpan dan hit tetap HEAD origin tanpa GET, hash cocok.

HTTP cache sengaja dimatikan dengan Chromium CDP **hanya pada suite resolver baru**. Dokumen awal dan endpoint metadata/aset berasal dari backend nyata, tanpa interception request aset. Attachment `server-asset-transfers.json` menghitung method/status/body byte yang benar-benar ditulis server; `lan-origin.json` mencatat origin fixture.

Percobaan awal: 32/33 pada gabungan storage/resolver (termasuk 27 storage M1) lulus; tes LAN gagal karena dokumen harness sintetis hasil `route.fulfill()` kehilangan klasifikasi address space dan memicu Private Network Access browser. Harness diperbaiki dengan navigasi dokumen backend asli. Tidak memakai flag penonaktif proteksi browser, HTTPS palsu, atau mock Web Crypto. Run gagal tersebut tidak dihitung sebagai kelulusan.

### Perintah reproduksi

```text
node --test tests/server-assets.test.mjs
npm test
npm run build
npm run test:e2e:backend -- tests/browser/server-assets.spec.ts tests/browser/asset-cache-storage.spec.ts
npm run test:e2e:backend
npm run test:e2e:production
npx tsc --noEmit --strict --skipLibCheck --moduleResolution bundler --module esnext --target es2022 --allowJs --allowImportingTsExtensions tests/browser/server-assets.spec.ts tests/fixtures/server-assets.ts
```

Hasil verifikasi akhir:

- `npm test`: **295/295 lulus**, tanpa fail/skip/cancel, sekitar **40,6 detik**; termasuk **45 tes resolver**.
- `npm run build` dan pemeriksaan TypeScript spec/harness: **lulus**.
- Suite production statis penuh: **54 lulus, 60 skip**, tanpa kegagalan, sekitar **1,7 menit**. Skip mencakup tujuh tes resolver dan skenario khusus backend lain yang tidak tersedia pada hosting statis; bukan kelulusan implisit.
- Suite resolver terfokus: **7/7 lulus** seperti dijelaskan di atas. Regresi storage M1 juga lulus **27/27** pada run gabungan awal dan suite production.
- Suite backend penuh: **109/109 lulus**, tanpa fail/retry/skip, sekitar **8,9 menit**. Mencakup tujuh resolver, 27 storage, HTTP cache lama, akun/password, katalog, engine NES, state/SRAM/progres, isolasi tamu/akun dan kompatibilitas build melalui alur Player lama.
- `git diff --check`: **lulus**.

Catatan percobaan backend sebelum run akhir yang lulus:

- Percobaan pertama terhenti oleh timeout harness shell **120 detik**, setelah 49 tes yang sudah selesai lulus; run tidak lengkap tersebut tidak dihitung sebagai kelulusan suite.
- Run berikutnya: **108 lulus, 1 gagal**, sekitar **10,5 menit**. Seluruh tujuh resolver dan 27 storage lulus, tetapi tes pergantian password menunggu tombol login sampai timeout. Trace menunjukkan request JS/CSS mendapat **404** ketika `npm run build` berjalan bersamaan dan mengosongkan/menulis ulang `dist/`; halaman kedua tidak memuat aplikasi. Ini kesalahan urutan verifikasi, bukan alasan mengubah kode akun atau melemahkan tes.
- Run akhir diulang tanpa timeout shell dan **tanpa build bersamaan**: **109/109 lulus**, termasuk tes password yang sebelumnya gagal. Tidak ada perubahan kode akun, penambahan retry, atau pelemahan assertion untuk memperoleh hasil ini.

Output suite production dipisahkan ke `C:\Users\Ardi Putra\AppData\Local\Temp\opencode\maindulu-m2-production-results` agar tidak membersihkan data/artefak suite backend yang berjalan.

## 6. Batas Bukti dan Langkah Berikutnya

- **Belum ada pemakaian resolver dalam Player/bridge produksi**, tombol/progres UI cache, atau pengelola cache. Descriptor sesi bukan aktivasi cache.
- Browser miss/hit resolver dan close/reopen koneksi bukan restart proses browser/profil. Pembuktian restart dengan HTTP cache terisolasi tetap M5.
- Belum menguji pipeline produksi 329.641.708 byte, 500 MiB, transfer penuh batas 768 MiB ROM / 32 MiB BIOS, memori engine, atau gameplay PS1/CHD proprietary. Fixture transport tidak dihitung playable ROM.
- Single-flight/cancellation resolver diuji dengan dependency injection; interaksi StrictMode, akun/logout, lifecycle iframe, clear saat persiapan Player dan engine manual start masih perlu integrasi M3/M5. Race storage M1 tetap punya tes tersendiri.
- Uji regresi engine/save aplikasi lama bukan bukti engine sudah memakai hasil resolver. Fingerprint, format save, nama filesystem dan path progres belum diubah.
- Bukan bukti Firefox/Safari, Docker/Linux, perangkat seluler nyata, atau HTTPS reverse proxy. HTTP LAN membuktikan API baseline resolver/storage tanpa secure context, bukan kemampuan semua perangkat menjalankan ROM besar.
- Berikutnya **M3 — Integrasi Player, bridge, dan regresi save**, termasuk bundle helper aplikasi M0 yang reproducible, adapter nama asli dan fase timeout Player. Jangan mengaktifkan database bawaan EmulatorJS atau memperluas allowlist kompatibilitas build.
