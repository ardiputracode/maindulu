# M6 ScreenScraper — Regresi dan Operasi Pribadi/LAN

Tanggal: **2026-11-08**. Status: **M6 selesai untuk pribadi/nonkomersial LAN**, berdasarkan regresi otomatis di bawah dan hasil manual operator. Scope sesuai persetujuan operator pada M0, bukan izin layanan publik atau jaminan semua format/core. Default fitur tetap **off**; penutupan milestone tidak mengubah konfigurasi operator.

## 1. Bukti manual operator

Pada sesi penutupan M6, operator menyatakan **smoke provider asli serta save, cache, dan backup sudah dicoba manual dan lulus**. Pernyataan tersebut diterima sebagai bukti manual operator, bukan hasil tes otomatis agent. Rincian ROM/console, jumlah upload, hasil negatif, kuota, mesin/Node/Docker/origin dan log per langkah tidak dilampirkan; jangan mengarang cakupannya atau mengklaim inspeksi trafik/secret dari pernyataan itu.

Bukti provider terperinci sebelumnya (akun/kuota, tujuh sistem, raw GBA, negatif 404, decode cover PNG) tetap pada [penutupan M0](milestone-0-screenscraper-contract.md#13-penutupan-m0-untuk-pribadilan--2026-11-07). Agent tidak menjalankan provider asli, membaca secret operator, atau memindai koleksi pengguna untuk verifikasi M6. Kegagalan/beban/keamanan diuji dengan fixture dan transport tiruan saja.

## 2. Audit dan perubahan M6

- Fondasi commit `531c303`: preflight kuota akun untuk lookup uncached/media yang perlu, batas paling ketat dari allowance per menit, fail-closed jika kuota tidak dapat diverifikasi, timeout termasuk transport/body yang mengabaikan abort, gate SQLite lintas proses, serta metrik worker aman. Parameter lookup memakai `md5`, `sha1`, `romtype=rom`, `romtaille`, bukan nama field respons `rommd5`/`romsha1`.
- Audit tambahan: periksa enabled/game/generation/lease lagi **setelah menunggu reservasi cover**, sebelum preflight kuota/media. Disable/delete di sela reservasi tidak boleh mengirim request atau menerapkan hasil; kapasitas tetap dilepas. Hapus cabang klasifikasi `client_rejected` yang tidak terjangkau (tetap pause, bukan retry otomatis).
- Audit backup menemukan format 2 skema 9 ditolak oleh gerbang versi yang terlanjur minimum 10. Dukungan 9 dipulihkan, validasi referensi/cleanup skema 9 dipertahankan, dan tabel/kolom metadata dari versi yang lebih baru ditolak sebelum restore. Matriks format 2 skema 9–12 diverifikasi tanpa memigrasi sumber lalu dimigrasikan hanya pada hasil restore. Katalog pra-metadata mendapatkan row/provenance manual terkunci secara lazy saat admin membuka detail/meminta scan, bukan scan massal atau perubahan startup/migrasi historis.
- Matriks tes menambah pause autentikasi/identitas aplikasi, provider closed, rate limit, kuota harian/pencarian, timeout/JSON rusak, `Retry-After`, batas attempts, dan exception berkredensial yang tidak boleh masuk log/DTO.
- Browser menambah restart metadata + override manual + cover + boot NES tanpa lookup ulang, delete saat lookup ditahan, serta markup provider yang tetap teks literal di Library/review (bukan HTML/hotlink). Setelah judul/cover provider berubah, peluncuran NES kedua juga memeriksa identity engine tetap sama, cache ROM hit, dan jumlah GET ROM tidak bertambah.
- Regresi backend menjalankan `node server/index.mjs` tanpa memuat `.env`, dengan enable provider eksplisit `false`. Fixture metadata memakai konfigurasi `dummy` dan dependency provider/media tiruan, terpisah dari data operator.
- Tes pengaturan/deployment/LAN/cache lama masih mengharapkan default off. Diselaraskan dengan rollout cache yang **sudah** menetapkan default on untuk profil baru; tes tetap membuktikan pilihan off tersimpan setelah reload, metadata cache bertahan, budget dan isolasi origin bekerja. Skenario legacy engine/HTTP cache secara eksplisit mematikan IndexedDB pada profil fixture supaya tetap menguji HEAD/304 pada lapis yang dimaksud, bukan tersalip resolver cache baru. Tidak mengubah default aplikasi/cache/identitas ROM.
- Tidak ada migrasi baru: tetap **skema 13**. Tidak mengubah engine, byte ROM, ID/console, URL ROM, SHA-256, `saveIdentity`, key cache, atau format state/progres.

## 3. Konfigurasi dan aktivasi bertahap

| Variabel runtime backend | Fungsi |
| --- | --- |
| `MAIN_DULU_SCREENSCRAPER_ENABLED` | Hanya `true` mengaktifkan worker; default `false` |
| `MAIN_DULU_SCREENSCRAPER_DEV_ID` | Identitas developer sendiri |
| `MAIN_DULU_SCREENSCRAPER_DEV_PASSWORD` | Password developer, secret |
| `MAIN_DULU_SCREENSCRAPER_USER` | Akun pengguna provider sendiri |
| `MAIN_DULU_SCREENSCRAPER_PASSWORD` | Password pengguna, secret |
| `MAIN_DULU_SCREENSCRAPER_SOFTNAME` | Identitas aplikasi sesuai izin; fallback `maindulu` |

Node: environment proses atau `.env` yang dibaca `npm start`; restart untuk menerapkan perubahan. Compose: `--env-file .env.backend` dan `up -d --force-recreate`, bukan hanya `restart`. File `.env.screenscraper.local` milik CLI M0 **tidak** dimuat backend otomatis. Jangan mengisi template tracked dengan secret, menggunakan `VITE_`/build args, atau membagikan dump env/URL/Compose `config`/`inspect`. Batasi izin baca file/akses host dan API Docker. `config --quiet` memvalidasi tanpa mencetak hasil interpolasi. Secret tetap environment runtime, bukan vault terenkripsi atau bagian backup.

Preferensi MVP **tetap**, bukan tuning env operasional: judul/cover `wor → us → eu → jp → ss`, sinopsis `en → fr → ja`; cover `box-2D`. Field region/language yang dibaca config belum menyediakan override end-to-end normalisasi/cache; jangan mengandalkannya sebagai pengaturan efektif. Timeout provider 20 detik, body JSON 2 MiB, media 8 MiB/4096×4096 PNG/JPEG/WebP tanpa animasi, tanpa redirect. Concurrency lokal satu; laju minimal 1 detik atau lebih lambat sesuai kuota provider. Jangan menaikkan batas untuk mengatasi penolakan akun.

1. Sebelum update, sinkronkan/ekspor save penting, hentikan server dan buat/verify backup memakai aplikasi yang mendukung skema sumber. Pertahankan volume data serta salinan aset secara terpisah jika diperlukan; backup aplikasi bukan backup koleksi ROM/BIOS/cover.
2. Default off → tes fixture/offline → aktifkan hanya pada lingkungan berizin, lalu **satu upload raw legal**, review hasil dan pastikan playable → beberapa upload terbatas bila sehat. Hindari scan massal. Persetujuan M0 hanya pribadi/nonkomersial LAN.
3. Enabled dengan secret tidak lengkap tidak memproses antrean; endpoint admin menyebut nama variabel yang hilang, tidak nilainya. Health/upload/main/save tetap berjalan.
4. Izinkan DNS, TLS HTTPS egress `api.screenscraper.fr:443`. Media memakai `/api2/mediaJeu.php` di host yang sama, DNS IPv4 publik dipin ke socket TLS; private/link-local/IPv6 atau redirect ditolak. Tidak ada URL provider/browser arbitrer yang diterima.
5. Simpan data di volume `storage:/var/lib/maindulu` dengan folder data default `/var/lib/maindulu/data`. Rebuild/recreate tidak boleh menghapus volume. Ikuti [deployment backend](../deploy/README.backend.md) untuk Node/Docker, origin, HTTP LAN tepercaya, dan HTTPS/proxy. HTTP LAN tetap tidak terenkripsi; mengganti env origin bukan memasang TLS.

## 4. Observabilitas aman

Admin terautentikasi dapat membaca `GET /api/admin/metadata/status` (`no-store`, tamu 401/non-admin 403). Ini tidak melakukan request provider. Pantau:

- `ready`, `screenscraper.enabled/configured/missing`: kesiapan konfigurasi lokal, **bukan** bukti autentikasi/kuota provider masih valid.
- `worker.enabled/running/processing`: worker proses ini, bukan daftar semua proses.
- `queue.pending/running/needsReview/problem/oldestPendingMs`: jumlah antrean SQLite dan usia tugas pending tertua. Pending mencakup retry yang memang belum jatuh tempo; cocokkan dengan cooldown.
- `pausedReason`, `cooldownUntil`: gate provider bersama antarproses yang memakai **database sama**. Ini bukan koordinasi akun lintas instalasi/database; jangan gunakan akun konfigurasi yang sama pada instalasi independen secara paralel tanpa koordinasi operator.
- `worker.quota`: snapshot `remaining`, `negativeRemaining`, `intervalMs`, `checkedAt` dari preflight terakhir proses ini, dapat `null`/stale dan bukan saldo live. Sukses cache teks tidak perlu request akun/lookup; media baru tetap bisa memerlukan preflight.
- `worker.metrics`: `completed`, `cacheHits/cacheMisses`, `outcomes` per status, `phases` dengan `count/totalMs/maxMs`. Counter memori reset saat restart; jangan menjumlahkannya sebagai ledger request provider atau angka akun global.
- `GET /api/admin/games/:id/metadata`: fase/status/attempts/reason/nextAt, provenance, kandidat/preview/revision. Log worker hanya kode aman; lihat kode per tugas dan warning cover, bukan dump exception/body/URL berkredensial.

API publik hanya revision dan status ringkas. Jangan menaruh API admin di shared cache atau mempublikasikan capture sesi/CSRF. Untuk laporan gangguan, cukup status, kode, waktu, jumlah tugas dan versi aplikasi; hapus cookie/CSRF, nama ROM privat, hash serta nilai akun. Tidak mengaktifkan verbose HTTP/proxy logging untuk request provider.

## 5. Runbook

| Kondisi | Tindakan |
| --- | --- |
| Password/izin developer atau identitas aplikasi salah (`auth_rejected`, `forbidden`, `client_rejected`) | Gate dipause, tidak retry terus. Perbaiki secret/softname secara privat, restart/recreate lalu **Admin → Antrean Metadata → Lanjutkan layanan**. `ready=true` sendiri tidak membuktikan kredensial valid. Job berstatus paused dapat diantrekan ulang lewat dialog scan massal. |
| Kuota tak dapat dibuktikan (`quota_unknown`) | Fail-closed/pause. Periksa izin/status akun melalui kanal provider yang sah; jangan menghapus validasi kuota atau mencetak respons. Lanjutkan layanan setelah kondisi diperbaiki dan cooldown berakhir. |
| Provider tutup, HTTP 429, timeout/transport/JSON rusak | Retry terbatas memakai backoff 30 detik eksponensial + jitter, maksimum base 15 menit; `Retry-After` yang lebih lambat dihormati. Gate bersama menahan tugas lain, tidak hanya game pertama. |
| Kuota habis HTTP 430/431 | Tunggu cooldown konservatif 24 jam atau `Retry-After` yang lebih lama (cap parsing 7 hari). Bukan janji jam reset provider tertentu. Retry/search/admin tidak boleh mempersingkat cooldown. |
| `not_found` | Tidak auto-retry terus; negative cache 24 jam. Tunggu jadwal untuk hash baru atau gunakan pencarian nama setelah cooldown bersama, selalu review manual. |
| `unsupported` | Pakai fallback nama jika sistem dapat dipastikan, lalu review per field. GB arsip/FDS tidak dipaksa menjadi sistem NES/GB yang ditebak. Jangan hash kontainer sebagai ROM raw. |
| Tugas tampak macet | Bandingkan fase, `updatedAt`, attempts, pending age/cooldown. Hentikan/restart proses secara tertib; lease 60 detik dengan heartbeat 15 detik dapat diambil kembali setelah kedaluwarsa bila proses crash. Tidak perlu menghapus baris/tabel atau membuka kuota paksa. Batas empat attempts; tugas failed perlu tindakan admin setelah cooldown. |
| Metadata salah | Edit field yang salah atau kosongkan/hapus cover secara eksplisit agar terkunci manual; rescan tidak membuka kunci. Kandidat manual memakai preview + field terpilih + revision terbaru. Buka kunci hanya bila memang mengizinkan penggantian berikutnya; unlock tidak langsung mengubah nilai. |
| Cover gagal/kapasitas penuh | Teks dapat sukses, cover lama dipertahankan, warning terpisah. Periksa quota/free disk/egress dan validitas raster; jangan melonggarkan SSRF/MIME/decode. Setelah sehat, pilih hanya Cover dari kandidat tersimpan agar tidak lookup teks ulang. Kandidat review berumur maksimum 30 hari. |
| Aset hilang setelah restore | Tugas/cache/lease/gate tidak dibawa snapshot restore; tidak ada scan otomatis. Upload ulang byte identik pada console sama, konfirmasi **Pulihkan ID lama**, pulihkan cover manual jika perlu, lalu rescan eksplisit. Metadata/provenance/override/save tetap. |

**Disable darurat:** ubah `MAIN_DULU_SCREENSCRAPER_ENABLED=false`, hentikan proses lama secara tertib, lalu start/recreate dengan konfigurasi baru. Perubahan file env tidak hot-reload. Setelah shutdown/recreate selesai, verifikasi `worker.enabled=false`; tidak ada claim/request/auto-apply baru. Shutdown membatalkan I/O provider dan menunggu cleanup sebelum DB ditutup; lease kedaluwarsa mengamankan crash/force-kill. Hasil yang sudah commit **sebelum disable efektif** tetap berlaku; disable bukan undo. Game, metadata terapan, cover dan save tetap tersedia; upload saat off tidak diam-diam dijadwalkan untuk aktivasi berikutnya. Saat re-enable, tugas queued/retry_wait dapat dilanjutkan sesuai gate, sedangkan paused/failed perlu tindakan admin; tidak ada rescan massal koleksi lama/startup/restore.

**Kontrol operasional (skema 19, 2026-11-10):** gunakan **Hentikan semua scan** di Antrean Metadata untuk membatalkan antrean saat ini tanpa mematikan fitur, mengubah cooldown, atau menghapus metadata. Ini bukan disable permanen; upload/scan baru tetap dapat membuat tugas baru. Shutdown tertib kini mengembalikan tugas berjalan ke `retry_wait` segera tanpa menghabiskan attempts atau menyetel jeda provider. Migrasi membersihkan jeda legacy `disabled` sekali, bukan alasan autentikasi nyata. Backfill tetap harus diminta admin, maksimal 1000 job aktif dan default mempertahankan metadata terkunci. Lihat [panduan Antrean Metadata](antrean-metadata.md) untuk status, konfirmasi, dan kode penolakan API.

**Rollback:** utamakan disable pada binary yang kompatibel skema 13. Jangan menjalankan binary skema lama pada database baru, mengubah `user_version`, menghapus tabel metadata/save, atau memakai `down -v`. Jika benar-benar perlu versi lama, hentikan server, simpan backup versi kini, restore backup **sebelum migrasi** memakai tool/versi yang sesuai ke folder baru, dan pulihkan aset terpisah secara eksplisit. Pergantian target data/versi harus keputusan operator; perubahan setelah backup lama tidak otomatis ikut pulih.

Cache provider: positif 7 hari, negatif 24 jam, maksimum 1000 entri/32 MiB; tidak menyimpan secret/URL/response mentah. Riwayat terminal/candidate dibatasi 30 hari dengan generation terbaru tetap sebagai fence. Cache/antrean tidak masuk backup. Default dan TTL lokal tetap tunduk pada izin akun; bila ketentuan berubah, disable dan evaluasi ulang, bukan mengasumsikan izin universal.

## 6. Matriks bukti otomatis

| Area | Bukti |
| --- | --- |
| Migrasi/backup lama-baru, normalisasi snapshot, restore tanpa scan | `tests/catalog-backup.test.mjs`, `tests/data-backup.test.mjs`, `tests/catalog.test.mjs` |
| Hash independen dan fingerprint immutable, GB/GBC, bukti raw, arsip/disc tetap unsupported | `tests/screenscraper-policy.test.mjs`, `tests/screenscraper-m2.test.mjs`, `tests/screenscraper-m0.test.mjs`, `tests/screenscraper-m4.test.mjs` |
| Cache TTL/cap/prune, quota/cooldown/attempts/redaksi, lease proses terpisah, crash recovery idempoten | `tests/screenscraper-m6.test.mjs`, `tests/screenscraper-m5-backend.test.mjs` |
| Disable/stop/delete/restore/lease saat lookup, disable/delete saat reservasi, edit/hapus cover saat download | `tests/screenscraper-m6.test.mjs`, `tests/screenscraper-m4.test.mjs` |
| Auth/CSRF semua route, role dicabut, ID kandidat/field/generation/revision palsu, replay/expired candidate, DTO privat/publik | `tests/screenscraper-m6.test.mjs`, `tests/screenscraper-m5-backend.test.mjs` |
| SSRF/redirect/DNS/IPv6/timeout, respons berlebih, decode raster/animasi/HTML | `tests/screenscraper-m4.test.mjs`, `tests/screenscraper-m6.test.mjs`, `tests/catalog-api.test.mjs`, `tests/screenscraper-m0-cover.test.mjs` |
| Upload playable saat provider ditahan, refresh/tab/pagination, override, restart/delete, XSS literal, static/old capability | `tests/browser/metadata.spec.ts` dan matriks [M5](milestone-5-screenscraper-ui.md) |
| NES state/SRAM/restart/restore, cache IndexedDB hit, identitas tetap setelah edit metadata | `tests/browser/metadata.spec.ts`, `library.spec.ts`, `server-game-saves.spec.ts`, `server-saves.spec.ts`, `catalog-indexeddb-cache.spec.ts`, ditambah bukti manual operator |
| Packaging secret runtime/default off, volume, origin/proxy, static tanpa backend | `tests/screenscraper-m6.test.mjs`, `tests/deploy.test.mjs`; ini tes konfigurasi, bukan eksekusi Docker/proxy nyata |

| Command | Hasil aktual terbaru |
| --- | --- |
| `npm test` | **445 lulus, 0 gagal/skip**, 44,7 detik |
| `npm run build` | **Lulus**, peringatan chunk frontend >500 kB tetap ada |
| `npm run test:e2e -- --output=test-results/m6-final-static-dev` | **66 lulus, 106 skip, 0 gagal**, 2,5 menit |
| `npm run test:e2e:production -- --output=test-results/m6-final-static-production` | **66 lulus, 106 skip, 0 gagal**, 2,2 menit |
| `npm run test:e2e:backend -- catalog-api.spec.ts catalog-cache.spec.ts catalog-indexeddb-cache.spec.ts catalog-indexeddb-deployment.spec.ts server-assets.spec.ts metadata.spec.ts --output=test-results/m6-corrected-backend` | **44 lulus, 0 gagal/skip/retry**, 4,2 menit |
| `npm run test:e2e:backend -- server-saves.spec.ts --grep 'account players never read/write guest state store' --repeat-each=3 --output=test-results/m6-save-isolation-recheck` | **3 lulus, 0 gagal/skip/retry**, 48,2 detik |
| `npm run test:e2e:backend -- --output=test-results/m6-closure-final-backend` | **167 lulus, 0 gagal/skip/retry**, 13,2 menit |

Skip statis adalah skenario yang membutuhkan backend, bukan kegagalan atau bukti skenario tersebut lulus. Perintah otomatis memakai transport provider/media tiruan dan tidak menjalankan smoke live.

### Percobaan awal dan koreksi

- Sebelum pelengkapan: **421 unit/integrasi lulus**, build lulus, browser metadata terfokus **12 lulus**. Tambahan tes unit M6 terfokus **27 lulus**.
- Statis dev dan produksi awal masing-masing **65 lulus/1 gagal/103 skip** akibat ekspektasi cache default off lama. Tes diperbaiki sesuai kontrak rollout, bukan dengan melewati assertion atau mengubah aplikasi. Penambahan tiga skenario metadata membuat skip statis akhir menjadi 106.
- Putaran unit tambahan **442 lulus/1 gagal** karena fixture cleanup baru memakai kolom `created_at` yang tidak ada; diperbaiki ke bentuk tabel skema 9 yang benar. Dua putaran selanjutnya **445/445 lulus**.
- Browser backend lengkap awal **160 lulus/7 gagal/0 skip**, 15,3 menit. Tujuh kasus berasal dari asumsi cache default off/isolasi lapis lama: legacy BIOS HEAD, HTTP cache, legacy opt-out, LAN toggle, dua deployment origin, dan stored opt-out resolver. Fixture dibuat eksplisit untuk lapis cache yang diuji; tidak ada perubahan perilaku aplikasi, kenaikan timeout, atau pemaksaan skip.
- Pengulangan enam file terdampak **44/44 lulus** termasuk semua tujuh kegagalan awal, tambahan metadata/cache hit dan XSS. Pengulangan ini bukan pengganti putaran backend lengkap terakhir; keduanya dicatat terpisah.
- Putaran lengkap berikutnya (`m6-closure-backend`) mendapat **166 lulus/1 gagal/0 skip**, durasi total sekitar satu jam. Tes isolasi save tamu/akun gagal pada boot tamu terakhir dengan `Network Error` dan timeout canvas; trace mencatat jeda antarevent sekitar **2.787.019 ms (46,5 menit)**. Penyebab jeda tidak terbukti, sehingga tidak dinyatakan sebagai bug aplikasi yang sudah diperbaiki atau pasti akibat sleep mesin. Tanpa perubahan kode, timeout, atau skip, skenario tersebut kemudian lulus **3 kali berturut-turut**, lalu seluruh suite diulang bersih dengan hasil **167/167 lulus**.

## 7. Privasi, atribusi, dan batas format

Metadata disediakan oleh **[ScreenScraper](https://www.screenscraper.fr/)**. Nama berkas, ukuran, hash MD5/SHA-1 dan sistem dapat dikirim ke provider; **byte ROM/BIOS tidak dikirim**. Yang discan hanya upload katalog backend berotorisasi, bukan ROM lokal dari Buka ROM/BIOS/demo. Teks/cover disimpan dan disajikan same-origin, bukan hotlink. Data provider bukan bukti hak distribusi ROM/cover; lisensi diisi admin dan tidak diganti otomatis. Ketentuan/izin M0 berdasarkan pernyataan operator untuk pribadi/LAN, bukan pengalihan hak pihak ketiga atau izin internet publik.

Eligible hash raw: NES `.nes`, SNES `.sfc`, GB `.gb`/`.gbc` (mapping dibedakan), GBA `.gba`, Mega Drive `.md/.gen/.bin`. Semua masih memerlukan **satu hasil, satu matched ROM/support, sistem benar, ukuran + MD5 + SHA-1 persis sama**, tanpa transformasi/header stripping. Ekstensi bukan bukti ROM valid atau provider pasti punya hasil. ZIP/7z/RAR, dump berheader/format review dan seluruh PS1 `.bin/.cue/.chd/.pbp/.iso` belum eligible auto-apply hash; nama hanya kandidat untuk konfirmasi. M7 adalah perluasan identifikasi, **bukan** perubahan byte/identitas game atau janji boot core.

Batas verifikasi: otomatis pada Windows, Node.js 26.12.1, Edge headless, SQLite/backend nyata dan engine NES lokal; provider/media tiruan. Docker CLI tidak tersedia pada mesin agent; tidak mengklaim build/restart/recreate image, Linux, reverse proxy HTTPS atau semua core/provider-format sudah diuji. Pengujian manual operator diterima sebagaimana dilaporkan, tidak diberi detail lingkungan yang tidak disampaikan. Kesiapan operasional dibatasi pribadi/LAN dan batas tersebut, bukan deployment publik universal.

## 8. Penutupan

M6 ditutup untuk cakupan pribadi/LAN di atas: regresi relevan lulus, hasil manual operator diterima, batas identifikasi terlihat di UI/dokumentasi, serta konfigurasi/observabilitas/runbook disable/retry/restore/rollback tersedia. Tidak mengubah secret/env operator, mengaktifkan scan, atau menyatakan rollout publik/Docker/HTTPS nyata telah diverifikasi. Tahap rollout beberapa upload terbatas tetap keputusan operator; jumlah upload manual tidak diasumsikan dari laporan singkatnya. M7 dapat direncanakan berdasarkan kebutuhan format nyata, bukan otomatis dianggap sudah diimplementasikan.
