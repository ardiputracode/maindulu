# M3 — Integrasi Player, Bridge, dan Regresi Save

Lanjutan [rencana cache IndexedDB ROM/BIOS](rencana-cache-indexeddb-rom-bios.md), [adapter M0](milestone-0-cache-indexeddb-spike.md), dan [resolver M2](milestone-2-cache-indexeddb-resolver.md).

Status: **selesai pada 2026-11-05 dalam cakupan integrasi aset kecil/NES**, termasuk suite regresi penuh. **Default cache tetap nonaktif**, bukan rollout pengguna. PS1 nyata, file besar dan restart proses browser tetap di luar bukti M3 sebagaimana dirinci di bawah.

## Implementasi

- `src/lib/player-assets.ts`: satu resolver bersama per tab, aktivasi mengikuti settings DB (default tetap **off**), persiapan ROM kemudian BIOS, AbortSignal subscriber, serta hasil metadata tanpa menyimpan Blob di state React.
- `src/components/Player.tsx`: persiapan setelah Main sekarang dan sebelum configure iframe; fencing effect/sesi/akun; fase timeout terpisah; status transfer dan persistence dasar yang terpisah dari sinkronisasi save.
- `src/lib/player-bridge-assets.ts`: kontrak prepared descriptor/File yang dipakai host dan iframe; pemeriksaan namespace, sumber sesi, ID, URL, console, hash, ukuran, nama File dan konflik dengan input lokal.
- `public/player/player.js`: File native ROM melalui adapter per sesi M0; BIOS raw ZIP STORED / arsip pass-through melalui URL Blob; tidak ada HEAD/GET origin kedua oleh engine untuk aset prepared. Input lokal dan statis tetap jalur semula.
- `scripts/build-player-assets.mjs` → `public/player/asset-helpers.js`: bundle helper **aplikasi**, reproducible melalui `npm run build:player`, dijalankan sebelum Vite menyalin public pada build/dev. Kedua Dockerfile menyalin generator yang diizinkan secara spesifik oleh `.dockerignore`.
- `src/lib/asset-cache.ts`: pembacaan settings metadata-only; schema DB tetap v1.

Integrasi menemukan race cancellation M1 yang tidak terlihat pada tes resolver dengan writer injeksi: listener AbortSignal memulai `abort()` lalu `finally` resolver memanggil `abort()` lagi. Sebelumnya panggilan kedua selesai terlalu dini sehingga `close()` membatalkan transaksi cancel pertama. Writer sekarang menyimpan Promise cancellation bersama; seluruh pemanggil menunggu commit yang sama. Tes browser baru menutup koneksi segera sesudah dua panggilan abort dan memastikan staging/reservation/chunk bersih setelah reopen.

Regresi fullscreen menemukan race intent/acknowledgment ketika Escape ditekan segera sesudah Enter Fullscreen. Bridge kini melacak intent sementara sebelum acknowledgment host, tanpa mengubah engine. Skenario produksi tersebut lulus tiga run terfokus berurutan.

Tidak ada perubahan generator/vendor engine, core, `builds.json`, fingerprint runtime, SQLite backend, identitas save, format state/progres, atau allowlist kompatibilitas. `EJS_disableDatabases = true` dan `EJS_CacheLimit = 0` tetap berlaku.

## Lifecycle dan Timeout

1. Iframe siap: batas 90 detik khusus handshake, dibersihkan sebelum persiapan aset.
2. Transfer memakai timeout resolver M2: metadata 15 detik, header/koneksi 30 detik, stream idle 60 detik; tidak ada batas total transfer 90 detik.
3. Persiapan progres akun tetap melalui client akun yang memiliki timeout sendiri, tanpa menyamarkannya sebagai status cache.
4. Sesudah configure, loading engine memiliki timer sendiri (90 detik), dibersihkan saat `loaded`.
5. Menunggu klik Mulai bermain tidak diberi timeout. Sesudah klik, timer start core 90 detik baru dimulai.
6. Keluar, retry, dan penghentian akun membatalkan subscriber dan melepas listener/timer; hasil terlambat tidak boleh configure. Resolver bersama tidak ditutup oleh cleanup StrictMode subscriber lain.
7. Koneksi pemeriksaan settings selalu ditutup. Koneksi resolver ditutup oleh lifecycle M2. Adapter melepas Promise buffer, referensi payload/global, serta URL Blob setelah start, failure atau teardown.

Settings `enabled: false` mempertahankan jalur URL/HTTP cache lama dan tidak menghapus entry lama. Bila pembacaan settings tidak tersedia, aktivasi tidak diasumsikan: aplikasi kembali ke jalur lama dengan pemeriksaan ketersediaan yang sudah ada. Bila settings berhasil aktif tetapi storage gagal pada resolver, fallback tetap memakai satu download terverifikasi M2 dengan hasil `not-stored`.

Pengelola cache/toggle UI, diagnostik storage lengkap dan permintaan persistence tetap M4. Aktivasi default untuk pengguna tetap menunggu M6.

## Pengujian

Suite baru: `tests/player-assets.test.mjs`, `tests/browser/catalog-indexeddb-cache.spec.ts`; controls storage dan harness React development StrictMode ada hanya di `tests/fixtures/`, dibundel di memori dan tidak dikirim dalam aplikasi.

Perintah reproduksi:

```text
npm test
npm run build
npm run test:e2e:backend -- tests/browser/catalog-indexeddb-cache.spec.ts
npm run test:e2e:backend
npm run test:e2e:production
```

Build harus selesai sebelum suite browser; jangan membangun ulang `dist/` saat backend/preview sedang diuji. Suite IndexedDB baru sengaja menonaktifkan HTTP cache melalui CDP. Suite HTTP cache historis tidak diubah menjadi cache-disabled.

### Hasil verifikasi akhir

Lingkungan: Windows x64, Node.js **v26.12.1**, Microsoft Edge headless (versi executable **156.0.4314.58**), backend Node lokal dan browser context terisolasi. Tidak memakai profil pribadi.

Fixture: ROM NES battery orisinal **24.592 byte**, ROM dengan nama/ukuran sama dan satu byte padding berbeda, BIOS raw sintetis **512 byte** dengan nama legal backend `firmware-test.bin`. ROM memakai nama URL `battery%20test.nes` untuk membuktikan preservasi basename ter-encode. Fixture BIOS sintetis tidak membuktikan boot firmware proprietary.

- `npm test`: **301/301 lulus**, tanpa fail/skip/cancel, sekitar **41,7 detik** pada run akhir unit; termasuk lima kontrak payload/bundle M3 dan tes fingerprint engine lama.
- `npm run build`: **lulus**. Vite memberi warning chunk frontend >500 kB (sekitar 523 kB sebelum gzip); bukan build failure, belum dioptimalkan pada M3.
- TypeScript spec/harness M3 dan storage M1: **lulus**.
- Gabungan suite storage dan Player: **38/38 lulus**, tanpa retry/skip, sekitar **1,8 menit**: 28 storage (termasuk regresi abort baru) dan sepuluh integrasi Player.
- Regresi fullscreen produksi terfokus: **3/3 lulus** dengan `--repeat-each=3`, tanpa retry, sekitar **24,6 detik**.
- Regresi engine spike M0 kecil: **2/2 lulus**, tanpa retry/skip, sekitar **17,8 detik** (SRAM/state URL → prepared, NES/raw/ZIP ROM dan BIOS). Hanya harness M0, bukan pengganti sepuluh tes Player produksi; spike 500 MiB tidak dijalankan ulang.
- Suite production statis penuh: **55 lulus/70 skip**, tanpa fail/retry, sekitar **1,6 menit**. Skip mencakup sepuluh integrasi cache Player dan skenario backend lain yang tidak tersedia pada hosting statis; tidak dihitung sebagai kelulusan implisit.
- Suite backend penuh: **120/120 lulus**, tanpa fail/retry/skip, sekitar **10,5 menit**. Termasuk sepuluh integrasi cache Player, 28 storage, tujuh resolver M2 (termasuk HTTP LAN), HTTP cache historis/restart, akun/password, katalog, SRAM/state/autosave, import/export, isolasi tamu/akun dan pergantian akun. Regresi lama yang memakai default cache off tidak dianggap bukti prepared-cache untuk semua jalur.
- `node --check public/player/player.js` dan `git diff --check`: **lulus**.
- Hash helper/bridge di `dist/player/` cocok dengan sumber hasil build di `public/player/`; tidak ada perubahan file vendor/core, generator engine, atau `builds.json` pada diff.

Output production dipisahkan ke `C:\Users\Ardi Putra\AppData\Local\Temp\opencode\maindulu-m3-production-results` agar tidak membersihkan data/artefak backend yang berjalan bersamaan. Tidak ada build yang berjalan bersamaan dengan suite browser.

Sepuluh skenario integrasi Player:

1. Miss ROM/BIOS masing-masing satu HEAD + satu GET dengan body persis ukuran; canvas NES nyata aktif, state bisa diekspor, manifest committed dan staging/reservation kosong. Hit dan reload dokumen tetap HEAD segar dengan **GET/body origin nol**. Off sesudah hit memakai jalur URL lagi tanpa menghapus cache lama.
2. State hasil boot URL lama dipulihkan ke boot prepared pada engine yang sama. Nama filesystem, `EJS_gameName`, key state, dan path SRAM tetap identik. ROM bernama/berukuran sama dengan hash berbeda tidak tertukar.
3. ROM lokal + BIOS server, ROM server + BIOS lokal, kedua aset server, dan tanpa BIOS; hanya aset backend eligible muncul dalam cache.
4. Default off tetap jalur URL. Budget satu byte memberi satu download terverifikasi, status tidak disimpan, tanpa manifest palsu.
5. Akun membuat fixture SRAM CPU/state melalui boot URL lama; boot prepared memulihkan SRAM sebelum mulai, memuat state lama melalui UI, mengekspor state, dan menulis slot Autosave 99. Metadata runtime tidak kompatibel tetap menahan boot dan tidak menimpa checksum progres.
6. Keluar selama GET ditahan membatalkan persiapan. Pesan wrong source/origin/session tidak mencatat history. Sesi baru bisa mulai; writer lama tidak tersisa.
7. Logout dari UI tab lain saat persiapan menghapus iframe lama dan membersihkan staging; pengelolaan akun dalam Player tetap sengaja disabled, bukan dipaksa lewat test.
8. Bridge produksi menolak origin/source/session palsu, identitas descriptor berbeda, namespace salah dan ukuran berlebih sebelum loader engine dimuat.
9. Komponen Player asli dibundel dengan React development **StrictMode** hanya pada harness memori tes; mount/cleanup ulang tetap menyiapkan satu sesi hidup, satu GET, satu callback start, tanpa writer tertinggal.
10. Stream fixture kecil yang berasal dari respons backend nyata dikirim bertahap dengan **160 detik waktu virtual** (20 detik per bagian): timeout handshake/engine tidak memotong transfer aktif. Ini pengujian timer, bukan transfer besar 160 detik wall-clock.

Attachment `server-asset-transfers.json` merekam byte yang benar-benar ditulis origin, bukan hanya status respons di JavaScript. Tidak ada request interception pada skenario hit/miss pembuktian transfer. Interception hanya dipakai khusus skenario cancellation; skenario timer membungkus respons fixture kecil dengan stream tertunda.

### Run yang gagal selama pengembangan

- Unit awal: **299 lulus/1 gagal** karena assertion allowlist Docker belum memasukkan generator helper baru. Assertion diperbarui secara spesifik; tidak membuka allowlist direktori script secara luas.
- Browser awal: **1 lulus/3 gagal** karena fixture raw BIOS memakai spasi (ditolak backend). Nama fixture diperbaiki; kebijakan backend tidak dilonggarkan.
- Run delapan integrasi: **4 lulus/4 gagal**: helper tes mencari upload lain di Beranda setelah exit (diperbaiki dengan navigasi Library), dan mencoba logout dari tombol akun yang sengaja disabled saat Player aktif (dipindah ke tab lain).
- Run sepuluh integrasi: **7 lulus/3 gagal**: dua kegagalan benar-benar menunjukkan race transaksi abort yang diperbaiki di atas; satu kegagalan harness StrictMode memakai transform JSX klasik (dibetulkan menjadi JSX automatic).
- Production awal: **53 lulus/70 skip/1 gagal** pada Escape fullscreen cepat; intent/ack race diperbaiki, bukan assertion dilemahkan.

Run gagal tidak dihitung sebagai bukti kelulusan.

## Batas Bukti dan Berikutnya

- Belum membuktikan cache produksi setelah restart seluruh proses browser/profil persistent; reload dokumen/sesi bukan restart browser. Pembuktian itu tetap M5.
- Belum menjalankan pipeline produksi 329.641.708 byte, 500 MiB, transfer penuh batas 768 MiB/32 MiB, atau mengukur RAM engine untuk ROM besar.
- PS1/CHD tetap terbatas pada tes kontrak metode engine/nama/path sintetis M0 dan format envelope unit. **Tidak ada uji ulang gameplay, firmware, atau memcard PS1 nyata pada M3**; bukti manual lama tidak dianggap bukti prepared-cache baru.
- Fixture save lama dibuat melalui jalur URL pada engine/fingerprint yang memang tidak berubah; bukan menjalankan image deployment release lama atau memperluas allowlist kompatibilitas.
- Kegagalan storage fisik penuh belum direproduksi; quota fault injection M1/M2 dan fallback budget Player tidak sama dengan disk fisik penuh.
- Tidak membuktikan Docker/Linux, Firefox/Safari, perangkat mobile nyata atau HTTPS reverse proxy. Perubahan Docker di sini diuji sebagai kontrak konfigurasi/build input, bukan daemon/image runtime.
- Berikutnya **M4 — Pengelola cache dan pengalaman kegagalan**. Status persistence dasar M3 tidak menggantikan panel settings/toggle/daftar/clear/estimate/persist dan pengujian aksesibilitas M4.

**Gate M3 terpenuhi dalam cakupan otomatis aset kecil/NES:** Player memakai hasil resolver nyata tanpa GET origin kedua oleh engine; nama/save lama, manual start, cancellation dan isolasi akun lulus. Tidak ada klaim kesiapan rollout atau dukungan ROM besar dari gate ini.
