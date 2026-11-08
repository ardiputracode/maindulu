# Rencana Implementasi Metadata Otomatis ScreenScraper

Status: **M0–M7 selesai untuk cakupan pribadi/nonkomersial LAN; M7 ditutup pada cakupan ZIP satu ROM raw bounded**. M7 tidak mencakup auto-identifikasi 7z/RAR/disc PS1; format tersebut tetap review. Verifikasi akhir M7: **507 tes unit/integrasi**, build, **168 browser backend** (tanpa gagal/skip/retry), serta **66 statis dev + 66 produksi** lulus (107 skip khusus backend per mode statis). Smoke provider asli dan save/cache/backup M6 diterima sebagai hasil manual operator, bukan smoke ZIP live. Fitur tetap **default off**, aktivasi dipilih operator. [Bukti dan batas M7](milestone-7-screenscraper-identifikasi.md); [runbook M6](milestone-6-screenscraper-operasi.md); [bukti M5](milestone-5-screenscraper-ui.md). Riwayat milestone di bawah mempertahankan konteks saat penulisannya, bukan membatalkan status terbaru ini. Disusun pada 2026-11-05, diperbarui 2026-11-08.

**Penutupan M0:** cover PNG region `us` berukuran 875.141 byte dan 705×700 piksel berhasil didecode melalui endpoint tetap, tanpa disimpan; `preferredNameListed`/`preferredSynopsisListed` true. Anomali dua ID ROM valid berbeda tetap dicatat sebagai peringatan, bukan dianggap sudah hilang. **66 tes M0, seluruh suite 383 tes, dan build lulus.** [Bukti akhir dan batas penutupan §13](milestone-0-screenscraper-contract.md#13-penutupan-m0-untuk-pribadilan--2026-11-07). Bagian berikut mempertahankan riwayat putaran sebelumnya; keterangan “masih menunggu” di riwayat itu bukan status akhir.

**Tambahan M0 2026-11-06:** operator melaporkan akun developer sudah diperoleh untuk penggunaan pribadi/LAN. Tersedia template secret lokal dan `npm run metadata:m0` untuk pemeriksaan manual opt-in; bukan aktivasi scan. Panduan pengisian secret, command, batas output/kuota, dan lock: [laporan M0 §8](milestone-0-screenscraper-contract.md#8-secret-lokal-dan-cli-probe-manual--2026-11-06). Uji API asli dan konfirmasi ketentuan media tetap terbuka.

**Verifikasi awal CLI M0:** 22 tes CLI baru dan seluruh suite **354 tes lulus** tanpa gagal/skip; build **lulus**. Template `.env.screenscraper.local` kosong dibuat secara exclusive dan diabaikan Git. Operator kemudian mengisi secret dan menjalankan probe sendiri: akun/kuota sukses, error respons pada daftar sistem. Agent tidak membaca secret atau menjalankan API asli.

**Perbaikan diagnostik M0 2026-11-06:** kode error respons dipisah, diagnostik aman tanpa secret ditambahkan, dan cap daftar sistem dipisah 16 MiB sementara akun/ROM tetap 2 MiB. **43 tes M0 dan seluruh suite 360 tes lulus**, build **lulus**. Penyebab error operator belum terbukti; perlu uji ulang. Rincian: [laporan M0 §9](milestone-0-screenscraper-contract.md#9-perbaikan-error-respons-dan-batas-per-endpoint--2026-11-06). Tidak ada perubahan startup backend, skema, upload, player, atau scan otomatis.

**Tambahan diagnostik bukti ROM:** uji ulang operator membuktikan akun/kuota dan tujuh sistem lolos; lookup GBA terhenti pada `EVIDENCE` sebelum probe negatif. Skrip kini menampilkan alasan, boolean per-field, dan kategori bentuk field tanpa nilai hash/ID/nama/secret, **tanpa melonggarkan policy atau menambah request**. **48 tes M0 dan seluruh suite 365 tes lulus**, build **lulus**. Rincian dan cara membaca output: [laporan M0 §10](milestone-0-screenscraper-contract.md#10-diagnostik-bukti-rom-per-field--2026-11-06). Penyebab penolakan ROM aktual masih menunggu hasil diagnostik operator.

**Perbaikan referensi ROM 2026-11-07:** diagnostik operator berikutnya menunjukkan seluruh bukti primer cocok; hanya referensi atas `jeu.romid` yang tidak konsisten. Setelah pemeriksaan dokumentasi publik, CLI memisahkan referensi tambahan sebagai `rom_reference_invalid`/`rom_reference_mismatch` pada `rom.warnings`, bukan gerbang penolakan primer. Tidak menebak makna/nilai referensi aktual; sistem, status game, satu matched ROM/support, ukuran, MD5 dan SHA-1 tetap wajib. **51 tes M0 dan seluruh suite 368 tes lulus**, build **lulus**. [Temuan, batas interpretasi, dan urutan uji ulang di §11](milestone-0-screenscraper-contract.md#11-referensi-rom-tambahan-bukan-gerbang-bukti-primer--2026-11-07). Probe negatif asli masih menunggu operator, scan otomatis tetap nonaktif.

**Persiapan penutupan M0 2026-11-07:** operator kemudian mengirim hasil lengkap empat request yang berhasil termasuk negatif 404; anomali referensi dikonfirmasi sebagai dua ID valid berbeda. Operator mengonfirmasi persetujuan konteks LAN termasuk cache/penyajian. Ketentuan/atribusi didokumentasikan dan CLI ditambah `--cover` untuk satu gambar sementara di memori (endpoint tetap, tanpa URL provider/redirect, maksimum 8 MiB/4096×4096, decode penuh). Dua boolean konvensi judul/sinopsis ditambahkan tanpa mencetak teks. **383 tes lulus**, build **lulus**. [Laporan M0 §12](milestone-0-screenscraper-contract.md#12-bukti-akhir-operator-ketentuan-dan-probe-cover-manual--2026-11-07) mencatat bukti, batas izin, command terakhir dan checklist. **Belum menutup M0 sebelum uji cover aktual; tidak mengaktifkan scan atau mulai M1.**

## Alur yang Dituju

```text
Admin memilih ROM dan console
  -> upload, validasi, dan publikasi katalog seperti sekarang
  -> judul sementara dari nama file, kecuali admin mengisinya sendiri
  -> game langsung tersedia di Library dan dapat dimainkan
  -> tugas scan tersimpan di database, diproses backend di background
  -> ScreenScraper dicari menggunakan identifikasi berkas dan sistem
      -> cocok terverifikasi: terapkan metadata pada field yang tidak dikunci
      -> ambigu: simpan kandidat untuk diperiksa admin
      -> tidak ditemukan/gagal: pertahankan game dan metadata sementara
  -> Library menampilkan metadata terbaru tanpa reload halaman manual
```

Scan tidak memperpanjang request upload sampai menunggu ScreenScraper. Browser boleh ditutup setelah publikasi berhasil; worker tidak bergantung pada halaman admin yang tetap terbuka.

### Batas dan kondisi awal

- Cakupan utama adalah **ROM upload katalog backend**, bukan ROM lokal dari Buka ROM, BIOS, atau demo statis. File lokal tidak otomatis diunggah atau dicari ke layanan luar.
- Backend Fastify, SQLite, staging streaming, katalog admin/publik, cover raster, Library, dan backup metadata sudah tersedia. Rencana ini memperluas fondasi tersebut, bukan menggantinya.
- SHA-256 byte upload tetap menjadi identitas konten yang sekarang digunakan. Hash pencarian tambahan tidak mengubah ID game, console, nama berkas, URL ROM, `saveIdentity`, save state, progres, atau key cache ROM/BIOS IndexedDB.
- ScreenScraper hanya menerima informasi pencarian seperti hash, ukuran, nama berkas, dan sistem; **byte ROM/BIOS tidak dikirim**. Nama berkas juga merupakan data yang dibagikan dan harus disebut dalam pemberitahuan privasi.
- Lisensi/hak distribusi ROM tetap diisi admin. Developer, publisher, atau data ScreenScraper bukan bukti hak distribusi ROM maupun cover.
- Backup tetap menyimpan akun/save/metadata, **tanpa byte ROM, BIOS, atau cover**. Kredensial tidak masuk database backup atau frontend.
- Seluruh pengujian otomatis memakai fixture dan transport provider tiruan. Pengujian layanan asli dilakukan terpisah, dengan izin dan kredensial operator.

## Milestone 0 — Validasi Akses API, Pencocokan, dan Batas MVP

**Target:** memastikan akses ScreenScraper dan aturan pencocokan layak sebelum membangun integrasi produksi.

Keputusan, sumber, batas operasional, fixture, dan hasil aktual: [laporan M0 ScreenScraper](milestone-0-screenscraper-contract.md). Policy M0 belum terhubung startup/upload; request provider hanya dari CLI manual opt-in, tanpa perubahan database/UI.

- [x] Periksa ketentuan publik dan tetapkan atribusi/cache. Operator mengonfirmasi persetujuan pribadi/nonkomersial LAN termasuk penyimpanan dan penyajian metadata/cover pada 2026-11-07, bukan sekadar keberhasilan login. Dicatat sebagai pernyataan operator tanpa membaca bukti privat; bukan izin layanan internet publik atau pengalihan hak pihak ketiga. Rincian §12 laporan M0.
- [x] Operator menyiapkan kredensial developer/pengguna sendiri dan softname, lalu tahap akun/kuota berhasil menurut output CLI yang dibagikan pada 2026-11-06. Nilai secret tidak dibaca agent atau dimasukkan dokumen/repository.
- [x] Dokumentasikan kontrak `jeuInfos.php`, `jeuRecherche.php`, daftar sistem, media, respons JSON, dan informasi kuota berdasarkan sumber publik, dengan fixture **sintetis** tanpa rahasia untuk pengembangan offline.
- [x] Akun/kuota, tujuh sistem, bentuk metadata, matched ROM GBA dan lookup negatif 404 dikonfirmasi lewat output CLI operator yang disanitasi. Fixture tetap sintetis, bukan capture akun; tidak mengklaim semua platform/endpoint terverifikasi.
- [x] Uji cover asli dan konvensi region/bahasa metadata lolos menurut output operator: PNG `box-2D` region `us`, 875.141 byte, 705×700 piksel, decode penuh melalui endpoint tetap; judul/sinopsis preferensi tersedia. Tidak menyimpan cover atau mengaktifkan aplikasi. Bukti penutupan dan keterbatasan §13 laporan M0.
- [x] Dokumentasikan bahwa API identifikasi memakai CRC/MD5/SHA-1 beserta ukuran; SHA-256 proyek tidak dapat langsung dipakai sebagai penggantinya. Pilihan awal: hitung MD5 dan SHA-1 secara streaming pada worker, pertahankan SHA-256 yang sudah ada.
- [x] Tetapkan syarat auto-apply: hasil tunggal, sistem sesuai, dan bukti kecocokan hash/ukuran yang dapat diverifikasi dari respons. Jika provider tidak menyediakan bukti yang cukup, hasil harus masuk review, bukan dianggap pasti hanya karena HTTP 200.
- [x] Petakan sistem NES, SNES, GB, GBC, GBA, Mega Drive, dan PS1 berdasarkan halaman platform resmi. Resolver membedakan `.gb`/`.gbc` tanpa mengganti console/identitas game; ketujuh ID juga lolos pembandingan API menurut output probe operator 2026-11-06.
- [x] Tetapkan preferensi regional judul/cover dan bahasa deskripsi dengan fallback deterministik. Tidak menjanjikan metadata bahasa Indonesia jika provider tidak menyediakannya.
- [x] Tetapkan batas MVP format: raw eligible harus cocok persis ukuran/MD5/SHA-1 sebelum auto-apply. ZIP/7z/RAR, CHD/PBP, CUE/multi-track, dan dump dengan header/transformasi tidak diasumsikan cocok dari hash byte luar; gunakan review/pencarian nama jika belum didukung. Cakupan provider asli belum terbukti dan perluasan identifikasi tetap Milestone 7.
- [x] Tetapkan batas lokal panjang/jumlah kandidat, TTL cache positif/negatif, retensi riwayat tugas, ukuran respons, timeout, retry, dan laju awal konservatif. Batas efektif wajib mengikuti izin dan quota aktual yang sudah lolos probe operator; nilai M0 bukan hak akun atau izin cache universal, dan tidak menaikkan batas provider.

**Kriteria selesai:** tersedia keputusan tertulis tentang akses/izin, format yang didukung, mapping sistem, bukti kecocokan, dan batas operasional. Fixture provider yang disanitasi cukup untuk melanjutkan pengembangan offline; uji layanan asli yang belum dilakukan dicatat sebagai gerbang aktivasi produksi yang masih terbuka.

**Area utama:** dokumentasi fitur, `public/catalog/consoles.json`, `server/catalog/validation.mjs`, rencana konfigurasi backend.

**Hasil akhir M0 (2026-11-07): selesai untuk konteks pribadi/nonkomersial LAN.** Seluruh checklist M0 di atas memiliki keputusan/bukti yang dicatat; izin berdasarkan pernyataan operator, smoke nyata berdasarkan output operator, kasus pertahanan berdasarkan tes offline. Tidak mengklaim semua platform/format/endpoint sudah diuji atau integrasi produksi sudah tersedia. Pekerjaan berikut M1, belum dimulai; aktivasi tetap menunggu implementasi/proteksi M1–M6.

**Implementasi/verifikasi M0 (2026-11-05):** policy murni di `server/metadata/screenscraper-policy.mjs`, empat fixture JSON sintetis beserta provenance, dan 15 tes policy offline. Seluruh `npm test`: **332 lulus, tanpa gagal/skip**; `npm run build`: **lulus**, dengan peringatan ukuran chunk frontend >500 kB. Tidak ada perubahan skema, upload, frontend, engine, save, atau cache ROM. **Fondasi teknis M0 siap untuk M1 offline, tetapi M0 akses operasional belum ditutup:** persetujuan konteks distribusi/penyajian media, kredensial sendiri, quota, mapping API, serta smoke data nyata masih terbuka. Rincian dan checklist operator ada pada [laporan M0](milestone-0-screenscraper-contract.md).

**Referensi:** [dokumentasi resmi ScreenScraper API v2](https://www.screenscraper.fr/webapi2.php). Verifikasi kembali kontrak dan ketentuannya saat implementasi.

## Milestone 1 — Model Metadata, Provenance, dan Kompatibilitas Backup

**Target:** database mampu menyimpan metadata hasil scan, status, dan perlindungan edit admin tanpa merusak data lama.

- [ ] Tambahkan migrasi setelah versi skema terbaru saat pengerjaan; saat rencana ditulis, `server/database.mjs` berada pada skema 9. Jangan mengubah migrasi historis.
- [ ] Rancang tabel/kolom terstruktur untuk metadata tambahan: tanggal rilis beserta presisinya jika hanya tahun/bulan tersedia, genre, developer, publisher, jumlah pemain, region/bahasa, provider game ID, metode pencocokan, serta waktu pengambilan/penerapan. Nilai yang tidak tersedia tetap kosong, bukan ditebak.
- [ ] Simpan provenance dan kunci override **per field**, termasuk judul, deskripsi, metadata tambahan, dan cover. Bedakan sumber `filename`, `manual`, dan `screenscraper`; metadata terapan dan kandidat belum disetujui tidak boleh tercampur.
- [ ] Perlakukan nilai lama sebagai milik admin secara konservatif. Jangan menimpa judul/deskripsi/cover katalog lama hanya karena belum ada provenance. Scan koleksi lama bersifat eksplisit dan awalnya menawarkan hasil untuk review.
- [ ] Simpan tugas persisten dengan game ID, fingerprint aset, generation, fase, status, attempts, jadwal berikutnya, lease/token, dan kode error aman. Batasi satu tugas aktif per game/generation; jangan simpan cookie sesi atau password pada tugas.
- [ ] Siapkan cache hasil provider dengan key identifikasi + sistem + preferensi bahasa/region + versi normalisasi. Terapkan TTL, negative cache, batas ukuran/jumlah, dan invalidasi hasil sesuai ketentuan provider.
- [ ] Tambahkan revision monoton metadata/katalog untuk pembaruan UI dan perlindungan konflik; jangan hanya mengandalkan `updatedAt` milidetik sebagai token konkurensi.
- [ ] Sesuaikan parser/DTO backend/frontend secara aditif. Hanya informasi publik yang diperlukan masuk katalog publik; error internal, kuota akun, lease, dan kandidat review hanya untuk admin.
- [ ] Perbarui `data:backup`, `data:verify`, `data:restore`, hitungan tabel, validasi referensi, dan kebijakan skema **bersamaan dengan migrasi**, bukan ditunda sampai akhir.
- [ ] Pertahankan dukungan backup lama yang saat ini diterima, termasuk format 2 skema 9; verifikasi terhadap skema sumber sebelum migrasi restore. Tidak ada pemaksaan downgrade atau pengabaian tabel baru.
- [ ] Backup mempertahankan metadata terapan/provenance/kunci manual. Cache provider, lease, dan tugas operasional dinormalisasi pada snapshot saja; restore tidak boleh melanjutkan tugas lama atau menghubungi provider otomatis. Aset hilang ditangani melalui pemulihan ID lama seperti sekarang, lalu scan dilanjutkan eksplisit bila diperlukan.

**Kriteria selesai:** migrasi dan round-trip backup/restore menjaga akun, save, identitas katalog, metadata, serta override. Database hasil restore tidak membawa lease aktif atau tugas yang langsung memakai kuota provider. Fitur masih nonaktif dan upload lama tetap berfungsi.

**Area utama:** `server/database.mjs`, `server/data-backup.mjs`, `server/catalog/queries.mjs`, `src/lib/catalog.ts`, `src/lib/domain.ts`, `tests/catalog-backup.test.mjs`, `tests/data-backup.test.mjs`.

## Milestone 2 — Client ScreenScraper dan Identifikasi ROM

**Target:** pencarian metadata dapat diuji secara mandiri, aman, dan tidak mengunggah konten ROM.

- [ ] Buat modul provider terpisah, misalnya `server/metadata/screenscraper.mjs`, beserta normalisasi respons dan resolver sistem. Transport, waktu, dan respons provider dapat diinjeksi untuk tes tanpa jaringan eksternal.
- [ ] Tambahkan konfigurasi backend saja untuk enable/disable, kredensial, softname, region/bahasa, timeout, dan batas worker. Nama env awal dapat memakai prefix `MAIN_DULU_SCREENSCRAPER_`; dokumentasikan nama final saat implementasi. Jangan menggunakan prefix `VITE_` untuk rahasia.
- [ ] Default fitur nonaktif. Saat nonaktif tidak ada request provider; jika diaktifkan dengan konfigurasi lokal tidak lengkap, berikan pesan konfigurasi yang jelas. Gangguan provider tidak menjatuhkan health backend akun/katalog atau menghalangi upload/main.
- [ ] Baca ROM dari storage terkontrol dengan handle berkas aman. Hitung MD5/SHA-1 secara streaming dalam chunk terbatas; cocokkan SHA-256/ukuran dengan descriptor aset dan periksa pembatalan agar scan berkas besar tidak menahan event loop atau memuat seluruh ROM ke RAM.
- [ ] Implementasikan pencarian hash terlebih dahulu. Pencarian nama memakai basename yang dibersihkan dan filter sistem, bersifat fallback/kandidat; jangan auto-apply hanya berdasarkan kemiripan nama atau hasil pertama.
- [ ] Normalisasi respons melalui allowlist field, batas panjang/nilai/jumlah, dan perlakuan teks biasa. Jangan merender HTML provider atau menyimpan seluruh respons mentah tanpa batas.
- [ ] Bedakan tidak ditemukan, format belum didukung, autentikasi ditolak, provider ditutup, quota exhausted, rate limit, timeout, JSON rusak, dan kegagalan sementara. Perhatikan kode nonstandar seperti HTTP 430 sesuai kontrak provider yang terverifikasi.
- [ ] Rahasiakan seluruh query berkredensial pada log, exception/cause, telemetry, pesan UI, dan cache. Error HTTP library tidak boleh secara tidak sengaja memasukkan URL lengkap ke logger global.
- [ ] API client hanya mengakses endpoint HTTPS provider yang ditetapkan; pengguna tidak dapat memasok base URL atau URL unduhan arbitrer.

**Kriteria selesai:** fixture membuktikan pencocokan raw yang didukung, GB/GBC, metadata parsial, respons ambigu/rusak, serta klasifikasi error. Tidak ada pengiriman byte ROM, request provider dari browser, atau kredensial pada hasil/log pengujian.

**Area utama:** modul baru `server/metadata/`, `server/config.mjs`, `server/catalog/storage.mjs`, tes provider dan identifikasi baru di `tests/`.

## Milestone 3 — Antrean Persisten dan Scan Setelah Upload

**Target:** upload sukses otomatis menjadwalkan scan, tanpa menunggu jaringan provider dan tanpa kehilangan tugas setelah crash.

- [ ] Tambahkan enqueue dalam **transaksi publikasi katalog yang sama** setelah berkas siap dipublikasikan. Crash setelah commit sebelum worker dibangunkan tidak boleh menghasilkan game yang kehilangan tugas; jangan hanya membuat Promise fire-and-forget setelah respons.
- [ ] Jangan enqueue untuk upload batal/gagal, duplikat aktif, BIOS, demo, atau ROM lokal. Pemulihan ID/aset lama mempertahankan override/provenance dan hanya membuat generation scan baru jika memang diminta atau diperlukan sesuai kebijakan yang terdokumentasi.
- [ ] Worker berjalan di proses backend yang sama untuk MVP; tidak perlu Redis atau layanan baru. Daftarkan lifecycle start/stop di Fastify, hentikan pengambilan tugas saat shutdown, abort I/O, dan tunggu penyelesaian terbatas sebelum database ditutup.
- [ ] Claim tugas memakai transaksi singkat serta lease/token/generation. Dukung pemulihan lease kedaluwarsa dan koordinasi lintas proses yang mengakses database yang sama; transaksi SQLite tidak boleh ditahan selama hashing/jaringan/unduh cover.
- [ ] Terapkan default satu request provider aktif per akun konfigurasi, tetap tunduk pada batas aktual. Koordinasikan concurrency, cooldown, dan kuota lintas worker/proses; HTTP 429/430 tidak boleh menyebabkan semua tugas mencoba ulang bersamaan.
- [ ] Gunakan retry terbatas dengan exponential backoff/jitter dan `Retry-After` bila tersedia. Kesalahan autentikasi/config dipause sampai diperbaiki, kuota mengikuti jadwal provider, dan `not_found` tidak diulang terus-menerus tanpa tindakan atau kedaluwarsa cache.
- [ ] Periksa game aktif, fingerprint aset, generation, dan token sebelum tiap tahap penting dan commit. Delete membatalkan tugas; hasil tugas lama tidak boleh menerapkan metadata ke game yang dihapus/dipulihkan kemudian.
- [ ] Catat worker sebagai operasi sistem yang berasal dari upload/rescan berotorisasi, bukan memalsukan actor admin agar lolos repository. Tugas upload yang sudah disetujui berjalan tanpa cookie sesi uploader; perintah baru tetap memerlukan admin aktif. Sediakan pembatalan/nonaktif global untuk menghentikan pemrosesan.
- [ ] Bedakan fase `identifying`, `lookup`, `cover`, dan `apply` dari status tugas. Usulan status: `disabled`, `queued`, `running`, `retry_wait`, `paused`, `needs_review`, `succeeded`, `not_found`, `unsupported`, `failed`, dan `cancelled`, dengan kode alasan terpisah.
- [ ] Dalam milestone ini worker boleh menyimpan hasil normalisasi sebagai kandidat saja; auto-apply tetap dimatikan sampai Milestone 4 selesai. Kandidat dan tugas memiliki batas retensi.

**Kriteria selesai:** upload selesai ketika provider sengaja ditahan/offline; game tetap playable. Restart dan dua worker konkuren tidak kehilangan tugas atau mengizinkan hasil worker kedaluwarsa menulis. Pemrosesan bersifat at-least-once dengan commit idempoten, bukan janji request provider exactly-once.

**Area utama:** `server/catalog/repository.mjs`, `server/catalog/routes.mjs`, `server/app.mjs`, modul antrean/worker baru, tes crash/konkurensi baru.

## Milestone 4 — Auto-Apply Aman dan Penyimpanan Cover Lokal

**Target:** hasil terverifikasi memperbarui metadata tanpa menimpa pilihan admin atau membuat berkas yatim berbahaya.

- [ ] Terapkan otomatis hanya field yang belum dikunci dan hasil yang memenuhi syarat Milestone 0. Judul sementara bersumber `filename` boleh diganti; judul yang diisi admin tetap manual.
- [ ] Saat admin mengedit/mengosongkan field, mengganti cover, atau sengaja menghapus cover, simpan override per field. Penghapusan cover manual juga harus mencegah worker menambahkannya kembali.
- [ ] Terapkan compare-and-swap berdasarkan revision/override/generation terbaru di transaksi akhir. Edit admin selama lookup/unduh harus menang; kandidat yang tertunda tetap dapat ditinjau tanpa menimpa edit baru.
- [ ] Jangan pernah mengganti `license`, ID, console, SHA-256, ukuran/nama byte ROM, URL ROM, atau identitas save melalui metadata provider. Kecocokan sistem lain diarahkan ke review, bukan migrasi console otomatis.
- [ ] Unduh cover dari server, lalu layani melalui endpoint cover same-origin yang sudah ada. Jangan mengirim URL media berkredensial ke browser atau melonggarkan `isSafeLocalUrl`/CSP demi hotlink provider.
- [ ] Lindungi fetch media dari SSRF: allowlist host/path HTTPS yang diverifikasi, tanpa userinfo/port arbitrer, blok tujuan lokal/private/link-local termasuk IPv6, validasi resolusi dan koneksi, serta tolak redirect atau validasi ulang setiap hop. Allowlist tidak boleh berupa pemeriksaan substring domain.
- [ ] Batasi waktu, body stream terdekompresi, jumlah redirect, tipe konten, ukuran maksimum 8 MiB dan dimensi 4096 × 4096 sesuai kebijakan cover sekarang. Validasi decode raster PNG/JPEG/WebP lengkap dengan `sharp`; tolak SVG/HTML/animasi.
- [ ] Gunakan staging, quota/reservasi storage, promosi key baru yang immutable, transaksi referensi cover, kompensasi, cleanup, dan recovery yang setara upload manual. Scan bersamaan dengan upload tidak boleh melewati batas ruang disk.
- [ ] Metadata teks boleh berhasil walau cover tidak tersedia/gagal diunduh; simpan warning/status cover terpisah dan pertahankan cover lama. Jangan mengulang lookup teks sukses hanya karena retry cover.
- [ ] Simpan asal data, metode pencocokan, waktu penerapan, serta ringkasan perubahan yang dibatasi. Sediakan cara melepas kunci field atau menerapkan kandidat per field secara eksplisit dengan preview.

**Kriteria selesai:** hasil pasti memperbarui field yang eligible, hasil ambigu tidak diterapkan, dan edit/hapus cover manual selalu dihormati. Uji delete/edit/rescan saat cover diunduh, quota penuh, promosi gagal, crash, serta payload/URL berbahaya; tidak ada perubahan pada save atau byte ROM.

**Area utama:** modul penerapan metadata baru, `server/catalog/repository.mjs`, `server/catalog/storage.mjs`, `server/catalog/maintenance.mjs`, `server/catalog/validation.mjs`, `server/catalog/recovery.mjs`.

## Milestone 5 — UI Upload, Review Admin, dan Pembaruan Library

**Target:** pengguna melihat alur upload dulu lalu scan otomatis, beserta kontrol untuk kegagalan dan hasil yang perlu ditinjau.

- [x] Form upload game cukup mewajibkan ROM dan console; judul sementara dihasilkan dari basename aman dengan batas 200 karakter dan fallback nonkosong. Judul opsional yang benar-benar diisi admin diberi sumber manual, berbeda dari hasil autofill UI. Form BIOS tetap seperti sekarang.
- [x] Server juga membentuk fallback judul, bukan hanya frontend. Sesuaikan allowlist/jumlah field multipart, validator/repository, DTO, dan client bila menambah pilihan scan; jangan mengendurkan body limit API akun/save.
- [x] Tampilkan pilihan scan otomatis yang mengikuti kesiapan backend. Jika fitur nonaktif, upload tetap berhasil tanpa scan dan tanpa pesan seolah-olah scan sudah dijadwalkan.
- [x] Pisahkan progress pengiriman/publikasi dari scan. Setelah publikasi: “Game berhasil diunggah dan sudah bisa dimainkan. Metadata sedang menunggu scan.” Halaman admin tidak perlu menunggu worker selesai.
- [x] Tampilkan label status berbahasa Indonesia pada Manage Game, detail hasil, warning cover, dan waktu percobaan berikutnya bila relevan. Library cukup menampilkan status publik ringkas tanpa error/config/kuota internal.
- [x] Sediakan “Scan ulang”, retry sesuai kondisi, pencarian nama manual, pilihan kandidat, preview perubahan, dan penerapan field terpilih. Retry admin tidak boleh melewati cooldown/kuota atau membuat tugas aktif ganda. Rescan tidak diam-diam melepas override.
- [x] Sesuaikan form edit agar mengirim field yang benar-benar berubah/keputusan eksplisit, bukan otomatis mengunci semua field hanya karena form sekarang mengirim judul/deskripsi/lisensi sekaligus.
- [x] Gunakan polling metadata ringan saat halaman terlihat, dengan backoff, abort cleanup, jeda saat hidden/offline, dan refresh saat fokus kembali. Hindari WebSocket/SSE untuk MVP dan jangan polling byte ROM/BIOS.
- [x] Refresh katalog berdasarkan revision secara terkoordinasi. Library sekarang memuat beberapa halaman lalu merge/sort di browser; perubahan judul saat pagination dapat menyebabkan duplikasi/skip. Deteksi revision berubah dan ulangi snapshot secara terbatas, bukan menampilkan hasil setengah lama/setengah baru.
- [x] Jangan mengosongkan grid setiap polling. Pertahankan query/filter/halaman, tangani perpindahan hasil setelah judul berubah, dan beri pemberitahuan pembaruan yang tidak mencuri fokus. URL cover yang sama harus menampilkan cover baru tanpa mengubah kebijakan cache ROM.
- [x] Metadata favorit/riwayat server diperbarui berdasarkan ID stabil pada titik refresh yang sesuai; jangan menghapus record lokal, menaikkan batas daftar tersimpan, mengganti judul sesi yang sedang berjalan secara paksa, atau menulis ulang metadata save lama.
- [x] Mode statis tidak melakukan request scan/provider; backend lama tanpa capability baru tetap bisa menampilkan katalog. Preserve 401/403, aksesibilitas dialog, navigasi mobile, dan fallback saat backend tidak tersedia.

Usulan kontrak API; nama final mengikuti pola proyek saat implementasi:

| Endpoint | Akses | Tujuan |
| --- | --- | --- |
| `GET /api/admin/metadata/status` | Admin | Kesiapan fitur, status worker, kuota/cooldown yang disanitasi |
| `GET /api/admin/games/:id/metadata` | Admin | Status tugas, provenance, kandidat, warning, dan revision |
| `POST /api/admin/games/:id/metadata/scan` | Admin + CSRF | Menjadwalkan scan/rescan idempoten untuk game aktif |
| `POST /api/admin/games/:id/metadata/search` | Admin + CSRF | Mencari kandidat terbatas melalui antrean/rate limit yang sama |
| `POST /api/admin/games/:id/metadata/apply` | Admin + CSRF | Menerapkan kandidat tersimpan/override terpilih dengan expected revision |
| `GET /api/catalog/revision` | Publik | Revision katalog/status publik untuk refresh metadata ringan |

Endpoint apply hanya menerima referensi kandidat yang tersimpan dan terikat pada game/generation/sistem serta field allowlist; bukan URL cover atau respons provider arbitrer dari client. Detail status privat memakai `no-store`; endpoint publik tidak membocorkan keberadaan game terhapus atau antrean privat.

**Kriteria selesai:** browser membuktikan upload → langsung terlihat/playable → status scan → judul/cover berubah otomatis tanpa reload manual. Kegagalan, review kandidat, edit manual saat scan, beberapa tab, pagination/filter, mode statis, dan sesi non-admin ditangani dengan benar.

**Penutupan M5 (2026-11-08):** kriteria di atas dibuktikan lewat backend nyata, provider tiruan, dan engine NES lokal. Skema 13 menambahkan request antrean dan gate provider bersama; backup/restore ikut diperbarui, termasuk penerimaan backup skema 12. Penerapan manual adalah persetujuan eksplisit per field atas kandidat tersimpan, bukan pelonggaran bukti auto-apply. [Matriks bukti, command, percobaan gagal dan batas](milestone-5-screenscraper-ui.md). Bukan aktivasi produksi atau penutupan M6.

**Area utama:** `src/components/AdminCatalog.tsx`, `src/components/Library.tsx`, `src/components/GameCard.tsx`, `src/App.tsx`, `src/lib/admin-catalog.ts`, `src/lib/catalog.ts`, `src/lib/backend.ts`, `src/styles.css`, route metadata backend baru.

## Milestone 6 — Regresi, Operasional, dan Aktivasi Bertahap

**Target:** fitur siap diaktifkan pada lingkungan yang dinyatakan, dengan kegagalan provider terisolasi dari gameplay/upload/save.

- [x] Tambahkan unit/integration test pada tiap milestone, lalu lengkapi matriks migrasi/backup lama-baru, hash independen, sistem GB/GBC, cache TTL, quota/cooldown, crash/lease, idempotensi, dan race edit/delete/restore/rescan.
- [x] Uji otorisasi/CSRF semua endpoint baru, role dicabut, payload field/generation palsu, kandidat milik game lain, replay hasil lama, XSS/teks provider, SSRF/redirect/DNS, response berlebih, serta redaksi rahasia pada semua jalur error.
- [x] Tambahkan browser test dengan provider tiruan terkontrol: upload → main saat scan ditahan → metadata berubah → override manual menang → restart → metadata/progres tetap → delete → hasil worker terlambat ditolak.
- [x] Verifikasi state/progres engine nyata NES sebelum/sesudah perubahan metadata, favorit/riwayat, serta cache ROM IndexedDB tetap hit tanpa download ulang akibat judul/cover berubah. Jangan menyamakan bukti NES dengan dukungan gameplay semua core.
- [x] Jalankan `npm test`, `npm run build`, `npm run test:e2e`, `npm run test:e2e:production`, dan `npm run test:e2e:backend` sesuai lingkungan. Hasil aktual/skip serta percobaan gagal/ulang tercatat dalam laporan M6.
- [x] Smoke provider asli opt-in diterima dari laporan manual operator, dilengkapi bukti raw GBA/negatif 404/cover/kuota M0 dan tes redaksi offline. Rincian pengulangan M6 tidak dilampirkan; tidak mengklaim agent menginspeksi trafik, secret, atau semua platform. Tidak memakai layanan asli untuk stress/failure test.
- [x] Dokumentasikan konfigurasi di deployment backend, kredensial melalui env/secret operator tanpa masuk image/repository, egress HTTPS ke host provider/media tervalidasi, volume data persisten, restart/shutdown worker, quota penuh, retry, dan disable fitur.
- [x] Tambahkan observabilitas aman: jumlah antrean, usia tugas tertua, status worker, durasi fase, hasil/error code, cache hit, dan cooldown. Tanpa ROM, URL berkredensial, atau dump respons provider lengkap pada log.
- [x] Runbook mencakup password/izin salah, provider tertutup, kuota habis, tugas macet, metadata salah, cover hilang, dan backup restore tanpa aset. Disable menghentikan claim/request serta mencegah auto-apply yang belum commit setelah efektif; metadata terapan dan game tetap tersedia. Env tidak hot-reload: hentikan/recreate lalu verifikasi status disabled.
- [x] Alur/gerbang rollout terdokumentasi: default off → fixture/offline → satu upload legal → beberapa upload terbatas → aktivasi operator. Hasil manual pribadi/LAN diterima; jumlah upload/lingkungan staging terpisah tidak diasumsikan. Tidak mengaktifkan konfigurasi operator, scan massal startup, atau scan otomatis setelah restore.
- [x] Rollback operasional cukup nonaktifkan fitur dan gunakan versi yang kompatibel dengan skema baru. Jangan menjalankan binary lama pada database bermigrasi atau menghapus tabel/save untuk memaksa rollback; prosedur restore backup harus eksplisit.
- [x] Perbarui README/changelog/panduan privasi dan atribusi setelah implementasi. Catat Docker/volume, HTTP LAN, HTTPS/proxy, serta format/core yang benar-benar diuji secara terpisah.

**Kriteria selesai:** regresi yang relevan lulus dengan hasil tercatat, smoke layanan asli dan izin aktivasi terpenuhi, serta operator dapat mematikan scan tanpa mengganggu game/save. Batas format identifikasi terlihat jelas di UI/dokumentasi, bukan tersembunyi sebagai kegagalan acak.

**Area utama:** `tests/`, `tests/browser/`, `deploy/docker-compose.backend.yml`, `deploy/README.backend.md`, `README.md`, `CHANGELOG.md`, dokumentasi fitur.

**Penutupan M6 (2026-11-08): selesai untuk pribadi/nonkomersial LAN.** Regresi akhir 445 unit/integrasi, build, 167 browser backend dan 66 statis pada masing-masing dev/produksi lulus. Smoke asli serta save/cache/backup diterima dari operator; izin LAN merujuk penutupan M0. Default tetap off, tanpa migrasi baru (skema 13), tanpa aktivasi atau scan massal. Docker/HTTPS/proxy nyata dan seluruh core/format tidak diklaim. [Laporan, matriks, kegagalan awal dan runbook M6](milestone-6-screenscraper-operasi.md). M7 tetap tahap lanjutan berdasarkan kebutuhan/bukti format.

## Milestone 7 — Perluasan Identifikasi Arsip dan Disc (Lanjutan)

**Target:** meningkatkan kecocokan ZIP/7z/RAR dan format PS1 yang belum tercakup tanpa mengubah byte upload atau identitas save. Milestone ini bukan syarat rilis MVP format raw yang sudah diverifikasi.

- [x] Audit baseline nyata: seluruh arsip/disc ditolak sebelum lookup; ukur demo CC0 24.592 byte menjadi deflate 759 byte (32,40:1). Tidak ada data kegagalan koleksi operator, sehingga tidak mengklaim angka kecocokan produksi atau dukungan provider baru; pilih ZIP→tuple raw yang kontraknya sudah ada. Pencarian nama tetap konfirmasi; rincian/batas [laporan M7 §1](milestone-7-screenscraper-identifikasi.md#1-baseline-pengukuran-dan-keputusan-format).
- [x] Identifikasi ZIP32 stored/deflate dengan satu anggota raw melalui streaming worker; GB/GBC dipilih dari anggota. Fingerprint pencarian dan descriptor anggota terpisah dari fingerprint/identitas aset upload pada kandidat tugas; bukan hash kontainer.
- [x] Batas kontainer 128 MiB, output 64 MiB, rasio 100:1, 64 entri, path 240 karakter/8 komponen, nested 0, deadline 30 detik, heap worker terbatas, temporary extraction 0. Traversal/link/encrypted/multi-game/header ambiguity ditolak. Worker bukan sandbox OS atau limit RSS/kernel; [batas lengkap §2](milestone-7-screenscraper-identifikasi.md#2-implementasi-dan-batas-resource).
- [x] Strategi disc tetap **review**, bukan mencoba hash CHD/PBP/CUE/satu track/serial tanpa bukti provider. PS1 termasuk ZIP tidak di-auto-identifikasi; tidak menebak `romtype` atau sistem dari serial tidak unik.
- [x] Tidak memakai executable tambahan. Dependensi parser **yauzl 3.4.0, MIT** terpin/integrity lockfile; Node 24+ worker/zlib pada Windows/Linux/Docker tanpa binary proprietary/shell. Packaging didokumentasikan, eksekusi Linux/Docker nyata tidak diklaim.
- [x] Tidak ada normalisasi header/byte-swap: anggota raw dihash persis. ROM tersimpan, URL, SHA-256, ID/console, license, filename engine/save dan key cache tidak diganti.
- [x] Tes otomatis memakai demo CC0 + fixture sintetis legal/korup/berbahaya, output aktual tepat 64 MiB dan penolakan lebih besar. Descriptor PS1 sintetis 768 MiB ditolak tanpa membaca byte, bukan klaim decode/boot disc besar. Browser membuktikan ZIP NES boot/cache/identitas saat metadata berubah; provider asli ZIP dan gameplay non-NES tidak diklaim. [Matriks dan hasil §5](milestone-7-screenscraper-identifikasi.md#5-bukti-otomatis-dan-percobaan-ulang).

**Kriteria selesai:** setiap format baru mempunyai aturan pencocokan, batas resource, bukti otomatis/manual, dan fallback yang jelas. Format yang belum aman tetap ditandai belum didukung, bukan dicoba dengan ekstraksi tanpa batas.

**Penutupan M7 (2026-11-08): selesai pada cakupan ZIP satu ROM raw bounded.** 7z/RAR/disc/header normalization ditunda secara eksplisit berdasarkan batas bukti, sesuai keputusan bahwa tidak semua format wajib sekaligus. Regresi akhir 507 unit/integrasi, build, 168 browser backend dan 66 statis dev + 66 produksi lulus; skip statis 107 per mode adalah skenario backend. Tidak ada migrasi (tetap skema 13), aktivasi secret atau scan massal. Smoke ZIP live dan Linux/Docker/HTTPS nyata tidak diklaim. [Laporan, hasil akhir dan batas M7](milestone-7-screenscraper-identifikasi.md).

## Urutan Rilis

- **M0–M1:** keputusan akses/kontrak, model data, override, dan backup kompatibel.
- **M2–M4:** provider, worker persisten, serta auto-apply/cover aman; fitur tetap nonaktif untuk penggunaan umum.
- **M5–M6:** pengalaman admin/Library lengkap, regresi, runbook, dan aktivasi bertahap. Ini gerbang rilis MVP.
- **M7:** perluasan format berdasarkan kebutuhan dan bukti setelah MVP; bukan janji semua arsip/CHD sudah dikenali sejak awal.
- Checklist dan kriteria selesai tiap milestone menjadi batas implementasi. Subdokumen hasil milestone boleh ditambahkan saat pengerjaan; dokumen rencana ini tidak menyatakan fitur sudah tersedia atau pengujian sudah lulus.
