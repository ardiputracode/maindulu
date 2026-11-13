# M0 — Kontrak ScreenScraper, Pencocokan, dan Batas MVP

Status 2026-11-07: **M0 selesai dan ditutup untuk penggunaan pribadi/nonkomersial LAN yang dikonfirmasi operator**. Akun/kuota, tujuh sistem, matched ROM GBA, negatif HTTP 404, konvensi metadata, dan decode satu cover aktual lolos menurut output operator. Persetujuan konteks LAN dicatat berdasarkan konfirmasi operator; keputusan cache/atribusi terdokumentasi. Dua ID ROM valid berbeda tetap menjadi peringatan, bukan temuan yang dianggap hilang. Bukti penutupan dan batas cakupan ada pada §13. **Scan otomatis tetap nonaktif; M1–M7 belum diimplementasikan.** Agent tidak membaca secret/ROM operator atau menjalankan API asli. Lanjutan [rencana metadata otomatis](rencana-screenscraper-metadata.md).

Bagian §7–§12 mempertahankan riwayat implementasi/verifikasi; keterangan “belum” di laporan putaran sebelumnya menggambarkan keadaan saat itu. Status akhir mengikuti §13, bukan permintaan uji ulang historis.

## 1. Hasil dan Batas M0

- Meneliti dokumentasi API publik dan halaman platform resmi, menentukan batas MVP, menyediakan kebijakan murni yang dapat diuji dan fixture sintetis untuk M1/M2.
- `server/metadata/screenscraper-policy.mjs` berisi mapping sistem, kelayakan format, preferensi, batas sumber daya, dan pemeriksaan bukti pencocokan. Modul **belum diimpor startup aplikasi**; tidak membuat request, membaca berkas, menerima kredensial, atau menulis database.
- Belum ada migrasi, HTTP client produksi, worker, scan, penyimpanan/penyajian cover, perubahan upload/UI, atau aktivasi fitur. Tahap tersebut tetap M1–M6. CLI probe HTTP opt-in (§8–§12) dapat menguji satu cover di memori dengan `--cover`; bukan integrasi aplikasi.
- Seluruh fixture dibuat dari kontrak yang diteliti, **bukan capture akun asli**. Ini cukup untuk melanjutkan pekerjaan offline, tetapi tidak membuktikan JSON aktual, cakupan database provider, atau keberhasilan identifikasi ROM asli.

### Bukti sumber yang diperiksa

| Sumber | Temuan |
| --- | --- |
| [WebAPI v2](https://www.screenscraper.fr/webapi2.php) | Akses developer, GET XML/JSON, identifikasi hash/ukuran, daftar sistem, informasi quota, media, dan kode HTTP; dokumen menyatakan API v2 dapat berubah |
| Halaman sistem resmi pada tabel §4 | Nama platform dan ID pada URL publik; kemudian tujuh ID lolos perbandingan `systemesListe.php` pada probe operator 2026-11-06, tanpa menyimpan respons mentah |
| Footer WebAPI dan halaman sistem | Pernyataan CC BY-NC-SA 4.0 dan kredit komunitas/sumber media; bukan pemberian izin otomatis untuk semua penggunaan/aset |

Pada penelitian awal tidak ada request pencarian/media terautentikasi atau pemakaian kredensial contoh aplikasi lain. Operator kemudian menjalankan probe sendiri hingga akun/sistem/ROM/negatif lolos (§12), setelah perbaikan yang dicatat pada §9–§11. Agent tidak mengakses provider dengan secret operator atau mengunduh cover nyata.

## 2. Akses, Lisensi, Atribusi, dan Kredensial

### Keputusan

1. Fitur produksi default **nonaktif**. Operator mengonfirmasi pada 2026-11-07 bahwa konteks pribadi/nonkomersial LAN, cache metadata/cover, dan penyajian kepada pengguna LAN sudah disetujui (§12). Konfirmasi ini dicatat berdasarkan pernyataan operator, bukan pemeriksaan korespondensi privat oleh agent. `private: true` di `package.json`, penggunaan LAN, atau aplikasi tanpa biaya saja bukan bukti izin penggunaan API.
2. Dokumentasi mewajibkan aplikasi sepenuhnya gratis dan didistribusikan, atau izin khusus dari tim ScreenScraper. Ajukan aplikasi melalui [forum developer resmi](https://www.screenscraper.fr/forumsujets.php?frub=12&numpage=0), jelaskan backend scraper, akses Library/cover oleh tamu, model distribusi, serta penggunaan nonkomersial/komersial yang sesungguhnya.
3. Minta konfirmasi penyimpanan lokal metadata/cover, penyajian ulang cover same-origin, aturan atribusi/sumber, retensi/cache, dan kebutuhan izin untuk hosting yang dipakai. Dokumen publik yang dibaca tidak menetapkan TTL cache khusus atau menjamin seluruh hak cover pihak ketiga.
4. Siapkan atribusi terlihat pada detail metadata/kredit: ScreenScraper sebagai sumber, tautan halaman game yang dibentuk dari ID aman, [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), sumber/kredit media yang tersedia, serta keterangan bila konten diubah. Implementasi UI/penyimpanan atribusi mengikuti M1/M5 dan hasil konfirmasi hak. Jangan mengklaim lisensi tersebut sebagai lisensi ROM atau seluruh aplikasi.
5. Dokumen ini bukan penetapan legal final. Tanpa izin/kepastian hak yang diperlukan, jangan aktifkan pengambilan/penyajian ulang data nyata; pengembangan fixture tetap bisa berjalan.

### Checklist operator

- [x] Operator melaporkan `devid`/`devpassword` developer sudah diperoleh pada 2026-11-06; nilainya tidak diperiksa oleh agent. Tahap akun/sistem kemudian lolos menurut output CLI operator.
- [x] Operator mengonfirmasi persetujuan konteks pribadi/nonkomersial LAN, cache metadata/cover, dan penyajian LAN pada 2026-11-07. Keputusan atribusi/retensi terdokumentasi pada §12. Ini bukan persetujuan distribusi/layanan internet publik; simpan bukti privat sendiri, tanpa email/password di repository.
- [x] Operator sudah memiliki akun pengguna ScreenScraper yang dilaporkan bekerja di RomM. CLI manual tetap memerlukan `ssid`/`sspassword` tersebut secara lokal, tanpa anonymous fallback.
- [x] Verifikasi akun/developer maindulu melalui CLI M0: operator mengirim hasil `configuration: valid` dan tahap `account.verified: true` beserta kuota pada 2026-11-06. Ini bukti run operator, bukan eksekusi API oleh agent.
- [x] Daftar sistem memuat ketujuh ID yang diharapkan menurut output `systems.verifiedSystems: 7` dari run operator.
- [x] Matched ROM GBA dan respons negatif HTTP 404 lolos menurut output run operator empat request; bukti hash/ukuran/sistem tetap wajib.
- [x] Uji cover aktual dan konvensi region/bahasa metadata lolos menurut output operator: judul/sinopsis preferensi tersedia, cover PNG 705×700, 875.141 byte, decode penuh berhasil melalui endpoint tetap (§13), tanpa mengaktifkan aplikasi.

### Konfigurasi CLI M0 (belum dibaca runtime aplikasi/M2)

| Nama env | Tujuan |
| --- | --- |
| `MAIN_DULU_SCREENSCRAPER_ENABLED` | Wajib nonaktif pada CLI M0; bukan tombol aktivasi scan aplikasi |
| `MAIN_DULU_SCREENSCRAPER_DEV_ID` | Identitas aplikasi developer |
| `MAIN_DULU_SCREENSCRAPER_DEV_PASSWORD` | Rahasia developer |
| `MAIN_DULU_SCREENSCRAPER_USER` | Identitas akun provider operator |
| `MAIN_DULU_SCREENSCRAPER_PASSWORD` | Rahasia akun provider operator |
| `MAIN_DULU_SCREENSCRAPER_SOFTNAME` | Identitas aplikasi beserta versi untuk `softname` |

CLI memilih softname `maindulu-<versi package.json>` (menggantikan usulan awal dengan slash), memakai huruf/angka/titik/minus/garis bawah tanpa karakter khusus. Jika ScreenScraper menyetujui nama lain, isi SOFTNAME sesuai identitas maindulu, bukan menyamar sebagai scraper lain. Semua secret hanya berasal dari file/env lokal backend, tidak memakai `VITE_`, tidak disimpan pada tugas/cache/backup, dan tidak dimasukkan image. API memakai query GET sehingga URL request, header respons yang mengulang request, dan error/cause library tidak boleh ditampilkan. CLI membuang seluruh respons mentah dan hanya menampilkan summary allowlist.

## 3. Kontrak Provider untuk M2

Base URL yang dipilih: `https://api.screenscraper.fr/api2/`. Ini endpoint tetap, bukan input admin. Semua request dibuat server dengan TLS; bukan browser. Kredensial umum: `devid`, `devpassword`, `softname`, `output=json`, serta akun eksplisit `ssid`/`sspassword` untuk MVP operasional.

| Endpoint GET | Parameter bisnis | Data yang diperlukan |
| --- | --- | --- |
| `ssuserInfos.php` | Akun/kredensial umum | `response.ssuser` untuk akses, threads, dan quota; bukan mencari game untuk sekadar menguji akun |
| `systemesListe.php` | Kredensial umum | `response.systemes`: ID dan nama sistem; cocokkan kembali mapping M0 sebelum aktivasi |
| `jeuInfos.php` | `systemeid`, `romtype=rom`, `romnom` basename, `romtaille`, `md5`, `sha1` | `response.jeu`, sistem, metadata, serta **matched `rom`** untuk bukti identifikasi |
| `jeuRecherche.php` | `recherche`, `systemeid` eksplisit | `response.jeux`, maksimum 30 kandidat menurut dokumen, diurutkan probabilitas; tidak memuat bukti ROM seperti lookup hash |
| `jeuInfos.php` dengan `gameid` | ID kandidat dan sistem | Detail pilihan admin; dokumentasi menyatakan lookup ini tidak mengirim informasi ROM, jadi bukan bukti hash |
| `mediaJeu.php` | `systemeid`, **`jeuid`** (bukan `gameid`), `media=box-2D(region)` | Byte cover atau indikator seperti `NOMEDIA`; CLI hanya endpoint tetap ini, tidak mengikuti URL media hasil provider; penyimpanan/penyajian produksi tetap M4 |

Hash API resmi adalah CRC/MD5/SHA-1 dengan ukuran. M0 memilih **MD5 dan SHA-1 byte berkas asli**, dihitung bersama secara streaming pada worker M2, tanpa stripping header/konversi. SHA-256 tetap untuk identitas/validasi aset maindulu, tidak dikirim sebagai parameter hash pengganti. MD5/SHA-1 adalah lookup fingerprint, bukan jaminan keamanan/legalitas atau pengganti SHA-256.

### Respons/normalisasi yang perlu ditangani

- Field dokumen resmi berbasis tipe XML/JSON; pada fixture JSON, nilai numerik/boolean provider sering diwakili string. M2 harus memvalidasi dan menormalisasi ID ke string desimal, ukuran ke integer aman, dan boolean secara eksplisit; `Boolean('false')` salah.
- Bentuk ilustratif: `noms[] {region,text}`, `synopsis[] {langue,text}`, `dates[] {region,text}`, `medias[] {type,region,format,url}`, `editeur`/`developpeur`/`joueurs` berisi `text`. Variasi bentuk aktual belum dikonfirmasi dengan akun sendiri; bentuk tidak dikenal tidak boleh dianggap cocok.
- `rom` adalah ROM hasil pencarian, `roms` daftar ROM lain yang terkait game. Jangan memakai hash dari dua record berbeda, mencari hash cocok di `roms` lalu mengaku itulah hasil lookup, atau memakai `romid` tanpa bukti ROM.
- CLI manual memperlakukan `jeu.romid` sebagai referensi tambahan, bukan pengganti matched `jeu.rom.id`. Bila bukti utama persis cocok, referensi tambahan tidak valid/berbeda dilaporkan sebagai peringatan tersanitasi; bila bukti utama gagal, tetap `EVIDENCE`. Ini keputusan lokal M0, bukan klaim bahwa perbedaan kedua ID dijamin/normal menurut API; lihat penelitian dan batasnya di §11.
- Metadata opsional dapat hilang, nama bisa regional, tanggal hanya tahun/bulan, pemain berupa rentang. Jangan menebak tanggal lengkap, penerjemahan Indonesia, atau angka pemain tunggal.
- Kuota: `maxthreads`, `maxdownloadspeed`, `requeststoday`, `requestskotoday`, `maxrequestsperday`, `maxrequestskoperday`, dan `maxrequestspermin`. Dokumen sebagian endpoint mengeja `maxrequestsperdmin`; perlakukan sebagai alias defensif setelah validasi. Jika keduanya muncul, gunakan batas paling ketat, jangan memberi hak tambahan karena alias.
- Batas/usage hilang, tidak valid, atau kontradiktif: pause lookup normal sampai pemeriksaan quota terkontrol berhasil. Tidak menganggap nilai kosong sebagai tidak terbatas.
- Header/body provider dapat mengulang URL berkredensial dan identitas akun. Normalisasi hanya field allowlist yang dibutuhkan; jangan cache/dump respons mentah secara utuh.

## 4. Mapping Sistem dan Format MVP

| Console maindulu | Format pencarian awal | Sistem provider | Sumber publik resmi |
| --- | --- | --- | --- |
| `nes` | `.nes` utuh, termasuk header yang memang ada | `3` NES | [NES](https://www.screenscraper.fr/systemeinfos.php?plateforme=3) |
| `snes` | `.sfc` utuh | `4` Super Nintendo | [Super Nintendo](https://www.screenscraper.fr/systemeinfos.php?plateforme=4) |
| `gb` | `.gb` | `9` Game Boy | [Game Boy](https://www.screenscraper.fr/systemeinfos.php?plateforme=9) |
| `gb` | `.gbc` | `10` Game Boy Color | [Game Boy Color](https://www.screenscraper.fr/systemeinfos.php?plateforme=10) |
| `gba` | `.gba` | `12` Game Boy Advance | [GBA](https://www.screenscraper.fr/systemeinfos.php?plateforme=12) |
| `megadrive` | `.md`, `.gen`, `.bin` raw | `1` Megadrive | [Megadrive](https://www.screenscraper.fr/systemeinfos.php?plateforme=1) |
| `psx` | Review/pencarian nama, belum auto hash | `57` Playstation | [Playstation](https://www.screenscraper.fr/systemeinfos.php?plateforme=57) |

Kelayakan ekstensi di tabel **bukan bukti file valid atau pasti ada di provider**. Auto-apply tetap memerlukan bukti §5; jika hash byte lengkap tidak cocok, jangan mencoba membuang header secara diam-diam. ID publik ini masih harus dibandingkan dengan daftar sistem API akun saat smoke.

- `.smc` polos (header copier 512 byte) kini didukung untuk lookup hash setelah normalisasi header, baik upload langsung maupun satu anggota ZIP SNES; `.fig`, `.swc`, `.smd`, `.unf`, `.unif`, serta interleaving/container lain tetap review/pencarian nama.
- `.fds`: provider memiliki platform FDS terpisah; resolver M0 sengaja tidak memilih ID NES. Tidak melakukan fallback ke NES otomatis. Mapping/identifikasi FDS lanjutan memerlukan verifikasi tersendiri.
- `.zip`, `.7z`, `.rar`: tidak di-hash sebagai pengganti anggota ROM, tidak diekstrak M0/MVP. Untuk console `gb`, sistem pencarian tidak ditebak dari nama arsip; admin memilih GB/GBC bila ingin pencarian nama. ID console game tetap `gb`.
- `.chd`, `.pbp`, `.cue`, PS1 `.bin`/`.iso`: belum auto-apply hash, karena kontainer/track/disc/serial perlu kontrak khusus. Nama/kandidat dapat diperiksa admin pada M5; identifikasi format ini tetap M7.
- Tidak mengganti ID game, console, storage key ROM, basename URL, SHA-256, `saveIdentity`, namespace engine, atau cache ROM. Tidak mengubah manifest console untuk menambahkan ID scraping yang bukan bagian runtime emulator.

## 5. Gerbang Bukti dan Pemilihan Metadata

`assessScreenScraperEvidence()` menerima fingerprint dari server dan kandidat **yang sudah dinormalisasi M2**, bukan input browser atau payload API mentah. Nilai `verified` berarti memenuhi syarat bukti saja; M4 masih harus memeriksa provenance/override, revision, generation, status game, serta izin sebelum menerapkan field.

Hasil baru layak auto-apply bila semuanya benar:

1. Lookup bermetode `hash`, format raw eligible, ukuran integer positif, serta MD5 dan SHA-1 lokal valid.
2. Tepat satu kandidat dengan ID valid, sistem sama dengan resolver, dan `notGame` terkonfirmasi false. Hasil non-game/flag tidak diketahui masuk review.
3. Matched `rom` tersedia dengan ID valid, satu support, ukuran persis sama, serta **kedua** hash MD5/SHA-1 valid dan cocok pada ROM tersebut (case-insensitive).
4. Tidak ada konflik hash, ukuran, sistem, jumlah support, atau kandidat. Satu hash cocok dan satu berbeda tidak boleh diterima.

Hasil nama/game ID/serial, HTTP 200 saja, ukuran tanpa hash, CRC saja, hash parsial, SHA-256 saja, `roms` tanpa matched `rom`, dua kandidat, atau field bukti hilang → **review/tidak terverifikasi**. Kebijakan sengaja lebih ketat daripada API yang menerima minimal satu hash; recall lebih rendah diterima demi mencegah metadata salah otomatis.

### Preferensi deterministik

- Judul dan cover: `wor` → `us` → `eu` → `jp` → `ss`, pilih teks nonkosong dalam urutan ini; provider internal `ss` adalah fallback terakhir. Jika tidak ada judul yang dapat dipakai, pertahankan judul sementara.
- Deskripsi/genre: `en` → `fr` → `ja`; jika tidak ada, biarkan kosong/pertahankan nilai lama. Tidak menerjemahkan atau menjanjikan bahasa Indonesia. Preferensi baru boleh dikonfigurasi setelah kode bahasa/region diverifikasi pada daftar resmi.
- Cover awal hanya tipe front-box `box-2D`, bukan box belakang, logo, video, atau manual. Jika tidak ada, tetap placeholder/cover lama, bukan memilih gambar arbitrer. Seri pilihan dengan rank sama harus diurutkan berdasarkan ID/URL kanonis secara stabil pada normalizer M2.
- Tanggal rilis mengikuti region terpilih dengan presisi asli. Nilai publisher/developer dan jumlah pemain hanya informasi, tidak pernah mengisi `license`/hak distribusi ROM.
- Metadata dari matched ROM yang terverifikasi dapat memiliki override khusus edisi; normalizer M2 harus mencatat sumber/regionnya, bukan mencampur edisi lain dari `roms`.

## 6. Batas Lokal, Cache, Retry, dan Kuota

Nilai `screenScraperLimits` adalah keputusan konservatif maindulu untuk implementasi berikutnya, **bukan hasil pengukuran atau hak akun ScreenScraper**. Nilai efektif selalu tunduk pada izin operator, quota provider terbaru, limit download, dan cooldown bersama seluruh proses.

| Area | Batas rancangan M0 |
| --- | --- |
| Request aktif | 1 untuk akun konfigurasi, termasuk lookup, pemeriksaan quota, dan media |
| Jarak awal request | Minimal 1 detik; laju efektif lebih lambat jika quota/`Retry-After` meminta demikian |
| Timeout | 20 detik total per request termasuk body; pembatalan saat shutdown/disable |
| Respons JSON/teks | Maksimum 2 MiB setelah dekompresi untuk akun/game; CLI manual memberi katalog sistem penuh batas terpisah 16 MiB (§9). Tidak memakai `Content-Length` sebagai satu-satunya batas |
| Kandidat / media / genre | Maksimum 30 / 1.000 / 20; respons melampaui batas dianggap tidak valid, bukan dipotong lalu dinyatakan hasil tunggal |
| Teks tersimpan | Judul 200, deskripsi 10.000, developer/publisher 200, pemain 32, URL media 4.096 karakter |
| Cache positif/negatif | TTL awal 7 hari / 24 jam; hanya 404 lookup sungguhan atau hasil kosong tervalidasi sebagai negatif |
| Kapasitas cache | Maksimum 1.000 entri dan 32 MiB hasil normalisasi; evict expired lalu least-recently-used; cache miss tidak menghapus metadata terapan |
| Antrean / retensi | Maksimum 1.000 tugas menunggu; terminal/review 30 hari; metadata terapan tidak dihapus mengikuti TTL job/cache |
| Retry sementara | Maksimum 4 percobaan total; backoff 30 detik × 2, jitter, cap backoff lokal 15 menit. `Retry-After` lebih panjang selalu dihormati |
| Cover | Maksimum 8 MiB, raster nonanimasi PNG/JPEG/WebP, dimensi maksimum 4096 × 4096, validasi decode seperti upload manual |

TTL/cache/penyajian cover masih bersyarat pada konfirmasi hak §2; TTL tidak memberikan hak penyimpanan dengan sendirinya. Key cache menyertakan sistem, metode/fingerprint, preferensi, dan versi normalisasi, tanpa password/URL auth. Cache tidak boleh mencampur akun dengan ketentuan berbeda. Data kuota terbaru harus diperiksa sebelum request meskipun cache baru saja miss.

Jika antrean penuh, game tetap dipublikasikan dengan status scan tertunda yang dapat direkonsiliasi, bukan gagal upload atau kehilangan niat scan. M1/M3 harus menetapkan representasi durable-nya pada transaksi publikasi dan membatasi pemulihan antrean; jangan menyiasati cap dengan antrean RAM tak terbatas.

### Penanganan status

| Status | Keputusan aplikasi yang ditetapkan |
| --- | --- |
| 400 | Permintaan/parameter salah; failed, jangan retry request identik otomatis |
| 401 | Menurut dokumen dapat berarti API ditutup untuk nonanggota/anggota tidak aktif; pause akses, jangan menganggap pasti password salah |
| 403 | Pause kredensial/developer; tindakan operator, tidak loop retry |
| 404 | Lookup game tidak ditemukan; negative cache, tetap playable. **404 unduh cover** hanya missing cover, bukan game tidak ditemukan |
| 423 | Provider ditutup; pause/cooldown bersama, pemeriksaan akses terjadwal terbatas |
| 426 | Software diblokir/tidak sesuai; pause sampai operator memperbaiki izin/versi |
| 429 | Retry terjadwal, hormati `Retry-After` dan turunkan laju; jangan retry seluruh tugas bersamaan |
| 430 | Quota harian habis; pause seluruh akun konfigurasi, bukan `not_found` |
| 431 | Quota hasil tidak dikenal habis; pause seluruh lookup akun konfigurasi, bukan `not_found` atau request-header error generik |
| 5xx, timeout, transport | Retry terbatas, tidak ada negative cache |
| HTML 200 / JSON rusak / kontrak tidak dikenal | `invalid_response`, retry sementara terbatas lalu pause/gagal terlihat; tidak auto-apply/negative cache |

Tidak mengasumsikan jumlah request harian universal atau reset tengah malam WIB. Jika waktu reset/`Retry-After` belum diketahui, 430/431 dipause konservatif 24 jam atau sampai operator meminta pemeriksaan `ssuserInfos.php` terkontrol; tetap tidak bypass quota jika belum pulih. Counter penggunaan bersama diperbarui dari respons valid dan reservasi request lokal; request metadata/media/bootstrap dihitung konservatif. Kapasitas thread yang lebih besar dari satu tidak otomatis menaikkan concurrency MVP.

## 7. Fixture dan Verifikasi

| File | Cakupan |
| --- | --- |
| `server/metadata/screenscraper-policy.mjs` | Policy murni tanpa I/O; tidak terhubung ke aplikasi |
| `tests/fixtures/screenscraper/systemes.json` | Subset ilustratif tujuh sistem dari halaman publik |
| `tests/fixtures/screenscraper/jeu-infos.json` | Game/data/quota sintetis, matched ROM berbeda dari `roms`, metadata regional dan cover `.invalid` |
| `tests/fixtures/screenscraper/jeu-recherche.json` | Kandidat nama parsial tanpa bukti ROM |
| `tests/fixtures/screenscraper/http-errors.json` | Status/error dan hasil aplikasi yang diharapkan; bukan classifier produksi |
| `tests/screenscraper-policy.test.mjs` | Mapping, kelayakan format, gerbang bukti, input buruk, hash/ukuran/ID, immutability dan fixture tanpa secret |

Fingerprint fixture berasal dari teks `abc`/`abcd`, bukan ROM valid. ID game dan metadata dibuat untuk tes, URL media `.invalid`, tanpa akun/secret/konten provider. Lihat [provenance fixture](../tests/fixtures/screenscraper/README.md). Parser kecil test-only tidak membuktikan parser produksi atau akses API; normalizer/provider client tetap M2.

Hasil aktual pada 2026-11-05, Windows dengan Node.js `v26.12.1`:

| Pemeriksaan | Hasil |
| --- | --- |
| `node --test tests/screenscraper-policy.test.mjs` | 15 lulus, tanpa gagal/skip pada putaran awal; setelah penguatan penolakan newline, kelimabelasnya juga lulus dalam suite lengkap berikutnya |
| `npm test` | **332 lulus**, tanpa gagal/skip, sekitar 39,3 detik; termasuk 15 tes policy M0 dan regresi akun/katalog/backup/save/cache yang sudah ada |
| `npm run build` | **Lulus**, sekitar 5,2 detik tahap Vite; peringatan chunk frontend minified >500 kB tetap dicatat, bukan error M0 |
| Browser, Docker, provider terautentikasi | **Tidak dijalankan untuk M0 ini**; policy belum terhubung aplikasi dan tidak ada perubahan UI/runtime/deploy |

Tes tidak mencoba mencocokkan byte demo ke ScreenScraper, tidak menghubungi endpoint metadata/media, dan tidak membuktikan dukungan semua format/core. Tidak ada build ulang bundle engine; build aplikasi menjalankan generator helper yang sudah ada tanpa perubahan hasil tracked.

### Gerbang sebelum aktivasi data nyata

- [x] Konteks pribadi/nonkomersial LAN termasuk cache dan penyajian metadata/cover sudah disetujui menurut konfirmasi operator 2026-11-07; tidak memperluasnya menjadi izin layanan publik atau mengklaim seluruh hak pihak ketiga.
- [x] Tahap akun menerima kredensial maindulu menurut output operator. Redaksi/no-secret di frontend/log/backup tetap wajib pada implementasi berikutnya; agent tidak membaca nilai secret.
- [x] `ssuserInfos.php` menghasilkan quota aktual yang lolos validator menurut output operator; varian alias field diuji offline, bukan seluruhnya dibuktikan oleh run akun ini.
- [x] `systemesListe.php` memuat tujuh ID yang dibutuhkan menurut output probe operator, tanpa raw capture atau request ulang oleh agent.
- [x] Satu ROM raw pilihan operator berhasil dicocokkan dengan matched `rom`, ukuran, MD5 dan SHA-1; satu lookup sintetis negatif menghasilkan HTTP 404. Kuota lolos; atribusi dirancang pada §12, belum diimplementasikan pada UI.
- [x] Konvensi region/bahasa yang tersedia pada metadata dan satu cover aktual lolos uji manual menurut output operator: `preferredNameListed`/`preferredSynopsisListed` true, cover region `us`, endpoint tetap `mediaJeu.php`, tanpa mengikuti URL provider (§13). Ini bukan verifikasi seluruh kamus/platform; domain `.invalid` fixture tetap tidak boleh masuk allowlist M4.

**Kesimpulan akhir:** M0 ditutup untuk konteks pribadi/nonkomersial LAN berdasarkan keputusan teknis, fixture/tes offline, konfirmasi izin operator, serta hasil probe metadata/cover aktual pada §13. Penutupan tidak mengaktifkan scan, menjanjikan semua format/platform dikenali, atau menggantikan implementasi/proteksi produksi M1–M6.

## 8. Secret Lokal dan CLI Probe Manual — 2026-11-06

### Persiapan secret

1. Gunakan Node.js 24+ pada host checkout proyek. CLI ini belum dipaketkan dalam image Docker runtime; tidak perlu mengubah container/backend yang sedang berjalan.
2. Jalankan `npm run metadata:m0 -- init`. Perintah membuat **`.env.screenscraper.local`** di root proyek memakai create-exclusive, tidak menimpa file yang sudah ada. Template publik tanpa nilai rahasia ada di `deploy/screenscraper-m0.env.example`; **jangan isi secret pada file example**.
3. Edit `.env.screenscraper.local` sendiri memakai editor lokal. Isi DEV_ID/DEV_PASSWORD dari akun developer maindulu dan USER/PASSWORD dari akun pengguna ScreenScraper. Jangan tertukar antara dua pasangan tersebut dan jangan tempel nilainya di chat, screenshot, perintah shell, atau Git.
4. Pertahankan flag ENABLED nonaktif. SOFTNAME boleh kosong untuk default versi aplikasi. Nilai satu baris yang mengandung spasi atau `#` perlu dikutip sesuai format dotenv; tidak ada normalisasi/trim password diam-diam.
5. File lokal dan lock sudah diabaikan Git dan tidak masuk allowlist build Docker. File dibuat mode `0600` pada sistem POSIX; pada Windows akses mengikuti ACL NTFS folder/user. Gitignore bukan enkripsi atau pengganti ACL—jangan simpan secret di folder publik/sinkronisasi yang dibagikan.

CLI hanya membaca file khusus ini, bukan `.env`/`.env.local` umum. Environment proses dengan nama variabel yang sama mengungguli nilai file lokal. Pembacaan file dibatasi 64 KiB, menolak hard link/symlink/berkas khusus dan variabel tak dikenal pada file. Tidak mengekspor nilainya ke `process.env`, Vite, frontend, server, atau database. Hindari environment debug/tracing HTTP eksternal yang dapat mencatat URL, karena API provider membawa kredensial dalam query GET.

### Langkah pengujian

Validasi kelengkapan secret **tanpa jaringan**:

```sh
npm run metadata:m0 -- check
```

Output `configuration: valid` berarti format/kelengkapan lokal valid, **bukan** login API berhasil. Template kosong sengaja ditolak sampai operator mengisinya.

Uji akun/kuota dan tujuh sistem dengan izin eksplisit jaringan:

```sh
npm run metadata:m0 -- check --live
```

Maksimum dua request berurutan: `ssuserInfos.php` lalu `systemesListe.php`. Tidak ada request kedua jika data kuota tidak lengkap/tidak aman atau habis. Request API selalu menuju host/path tetap melalui HTTPS, tanpa redirect dan timeout total 20 detik termasuk body. Akun/ROM dibatasi 2 MiB setelah dekompresi; daftar sistem penuh dibatasi terpisah 16 MiB. **Tidak ada retry otomatis**, termasuk saat 429/430/431; tunggu cooldown sesuai provider sebelum mencoba manual lagi.

Untuk membuktikan matched ROM, pilih sendiri file **legal raw yang kamu tahu ada di database provider**, bukan demo proyek yang belum tentu terdaftar:

```sh
npm run metadata:m0 -- check --live --console nes --rom "C:/ROM-legal/game.nes"
```

Ini menambah satu lookup `jeuInfos.php`. ROM dibaca dalam chunk 1 MiB untuk MD5/SHA-1/SHA-256 lokal; yang dikirim hanya basename, sistem, ukuran, MD5, dan SHA-1. Byte ROM dan SHA-256 tidak dikirim. Hasil harus cocok persis dengan gerbang policy M0. File tidak diubah atau disimpan ke katalog. Arsip/CHD/format review ditolak sebelum request, bukan diekstrak/dikonversi. `.gbc` tetap memakai console aplikasi `gb`, lalu resolver memilih sistem Game Boy Color.

Opsional, uji respons tidak ditemukan dalam run yang sama:

```sh
npm run metadata:m0 -- check --live --console nes --rom "C:/ROM-legal/game.nes" --not-found
```

Maksimum empat request total. Probe terakhir mengirim nama dan hash buffer acak lokal 64 byte, **bukan ROM yang diunggah**, dan hanya dianggap berhasil jika provider benar-benar menjawab HTTP 404. Ini memakai satu pencarian/kuota negatif secara sengaja; jangan jalankan berulang atau saat kuota kecil. Probe negatif tidak dijalankan jika lookup positif belum terverifikasi. Kuota yang tidak tersedia untuk langkah berikutnya menghentikan probe.

### Output, lock, dan kegagalan

- Output hanya berisi tahap akun, angka kuota tervalidasi, jumlah sistem, boolean bukti/shape metadata, hasil 404 opsional, jumlah request, dan penanda scan otomatis tetap nonaktif. Saat gagal ditambahkan diagnostik aman (§9). Tidak mencetak akun/password, URL auth, hash/nama/path ROM, judul/deskripsi/URL cover, header respons mentah, body error, stack, atau `cause` dari fetch.
- Output boolean `frontCoverListed` hanya menunjukkan ada field media front-box, **bukan** bukti cover dapat diunduh atau boleh disajikan ulang. Tanpa flag baru `--cover` (§12), skrip tidak mengunduh media. CLI tidak memeriksa seluruh endpoint region/bahasa/search dan tidak menghasilkan capture respons JSON.
- Exit code `0` berarti seluruh pemeriksaan yang diminta berhasil; `1` berarti ada konfigurasi/kontrak/akses/kuota/pencocokan yang belum lolos. Jangan menutup M0 hanya dari pemeriksaan offline atau menganggap stage akun sukses berarti semua stage berhasil.
- Satu checkout memakai lock lokal `.screenscraper-m0.lock.local` untuk mencegah dua CLI berjalan bersamaan. Lock dibersihkan saat selesai/gagal normal serta pembatalan SIGINT/SIGTERM. Jangan jalankan bersamaan dengan scan RomM atau client lain yang memakai akun sama—lock ini **bukan** koordinasi kuota lintas aplikasi/host/checkout; worker produksi M3 tetap harus mempunyai koordinasi sendiri.
- Jika proses mati paksa dan lock tertinggal: pastikan seluruh proses probe pada checkout itu sudah berhenti, lalu hapus **hanya file lock tersebut** secara manual. Jangan menghapus secret, database, volume, atau memakai penghapusan direktori untuk memulihkan probe. Lock lama tidak direbut otomatis berdasarkan PID.
- Setelah berhasil, simpan ringkasan output yang sudah disanitasi jika diperlukan untuk bukti M0. Jangan membagikan file secret atau dump respons mentah. Tidak ada auto-update checklist/dokumen hanya karena CLI dijalankan.

### Hasil verifikasi penambahan CLI

Pada 2026-11-06, Windows/Node.js `v26.12.1`:

| Pemeriksaan | Hasil |
| --- | --- |
| Tes CLI baru `tests/screenscraper-m0.test.mjs` | **22 lulus** dalam suite lengkap: argumen/opt-in, secret tanpa overwrite, environment precedence, hard link/ukuran, tanpa request offline, streaming fingerprint, kuota/alias/rate, sistem, bukti ROM, HTTP error/secret redaction, respons berlebih, timeout/cancel/late body, probe negatif, lock, dan Git ignore |
| `npm test` | **354 lulus**, tanpa gagal/skip, sekitar 77,5 detik; termasuk 22 tes CLI dan 15 tes policy M0 sebelumnya |
| `npm run build` | **Lulus**, sekitar 6,8 detik tahap Vite; peringatan chunk frontend >500 kB tetap ada, output frontend/engine tracked tidak berubah |
| `npm run metadata:m0 -- --help` | Lulus; tidak membaca secret atau memakai jaringan |
| `npm run metadata:m0 -- init` | Membuat template lokal kosong; file tersebut sudah diabaikan Git. Tidak diisi secret oleh agent |
| `git check-ignore --no-index .env.screenscraper.local .screenscraper-m0.lock.local` | Kedua path diabaikan; example publik tetap dapat dilacak Git |
| Provider asli / browser / Docker runtime | **Tidak dijalankan**; perubahan ini hanya CLI host, bukan integrasi aplikasi/deploy |

**Batas verifikasi penambahan awal ini:** semua tes API otomatis memakai kredensial palsu dan transport fixture. Sesudah penambahan awal, operator mengirim bukti akun/kuota asli sukses tetapi uji sistem gagal (§9). Agent tetap tidak membaca secret, menghubungi API asli, atau memiliki bukti keberhasilan ROM/cover nyata.

## 9. Perbaikan Error Respons dan Batas per Endpoint — 2026-11-06

### Laporan operator dan diagnosis

Operator menjalankan probe lengkap GBA. Pemeriksaan lokal valid dan tahap akun mengembalikan `verified: true` beserta kuota. Error `RESPONSE` muncul sebelum tahap sistem dinyatakan berhasil, sehingga matched ROM dan probe negatif belum dijalankan.

Kode lama memakai satu pesan untuk tipe konten, body stream, ukuran, UTF-8/JSON, dan envelope. Dari output itu saja **belum dapat dibuktikan** apakah daftar sistem terlalu besar, respons bukan JSON, atau format provider berbeda. Jangan mengganti password atau mencetak body/URL untuk menebaknya.

### Perubahan

- `systemesListe.php` membawa katalog lengkap termasuk metadata/media sistem, sehingga tidak lagi memakai anggaran respons satu game. CLI memakai **hard cap 16 MiB** untuk daftar sistem; `ssuserInfos.php` dan `jeuInfos.php` tetap **2 MiB**. Ini bukan kenaikan batas global policy/cover/upload dan bukan bukti bahwa ukuran merupakan penyebab run operator tadi.
- Streaming tetap menghitung byte body setelah dekompresi, mengabaikan klaim `Content-Length` sebagai bukti ukuran, menghentikan stream saat melewati cap, dan tidak melakukan retry/lookup ROM lanjutan setelah kegagalan.
- Error respons dibedakan: `RESPONSE_TYPE`, `RESPONSE_BODY`, `RESPONSE_SIZE`, `RESPONSE_ENCODING`, `RESPONSE_JSON`, `RESPONSE_ENVELOPE`, dan `RESPONSE_REJECTED`. HTML/plaintext tidak diloloskan hanya karena statusnya 200.
- Error transport/HTTP/timeout juga dapat membawa diagnostik aman. Diagnostik disimpan sebagai snapshot immutable internal, bukan mengambil `message`, `stack`, `cause`, atau properti `diagnostic` arbitrer dari exception.

Contoh format diagnostik (angka ilustratif, **bukan hasil API operator**):

```json
{"step":"diagnostic","code":"RESPONSE_JSON","endpoint":"systemesListe.php","httpStatus":200,"contentType":"application/json","receivedBytes":1,"limitBytes":16777216}
```

`endpoint` hanya salah satu basename endpoint yang ditetapkan skrip, tanpa query/host/path lokal. `contentType` adalah kategori MIME allowlist; charset, subtype tak dikenal, `Location`, serta header lain tidak dicetak. Subtype JSON khusus dinormalkan menjadi `application/*+json` agar nama subtype tidak dapat menyisipkan secret. `receivedBytes` adalah jumlah byte **yang sudah dibaca**, bukan ukuran total body; dapat nol jika ditolak dari header sebelum pembacaan. Diagnostik tidak mencetak body atau URL berkredensial.

### Langkah berikutnya

Jalankan dahulu `npm run metadata:m0 -- check --live` untuk menguji ulang akun dan daftar sistem tanpa mengulang hashing ROM. Jika gagal, bagikan baris `step: diagnostic` beserta kode pesan statis, **bukan** file secret/URL/response mentah. Jika sistem berhasil, lanjutkan perintah ROM + `--not-found` sebelumnya. Scan otomatis tetap tidak aktif.

### Hasil verifikasi perbaikan

- `node --test tests/screenscraper-m0.test.mjs tests/screenscraper-policy.test.mjs`: **43 lulus**, tanpa gagal/skip (28 tes CLI, 15 policy).
- `npm test`: **360 lulus**, tanpa gagal/skip, sekitar 37,6 detik. Tes baru membuktikan JSON sistem >2 MiB dapat lolos, cap 16 MiB tetap membatalkan stream, cap akun/ROM tetap 2 MiB, klasifikasi error terpisah, serta redaksi MIME/charset/header dan perlindungan snapshot diagnostik.
- `npm run build`: **lulus**, sekitar 5,0 detik tahap Vite; peringatan chunk frontend >500 kB tetap ada. Tidak ada perubahan startup aplikasi, upload, skema, engine/player, atau aktivasi scan.
- Seluruh tes perubahan memakai transport tiruan dan secret palsu. Agent **tidak menjalankan API asli atau membaca/mengubah secret lokal operator**. Penutupan M0 tetap menunggu hasil uji ulang dan pemeriksaan yang belum lolos.

## 10. Diagnostik Bukti ROM per Field — 2026-11-06

Bagian ini mencatat perubahan diagnostik awal beserta hasil tes saat itu. Perlakuan `rom_reference_mismatch` sebagai alasan penolakan di versi tersebut **digantikan oleh §11**; bukti utama tetap ketat.

### Bukti operator terbaru

- `check --live` berhasil dengan dua request: akun/kuota tervalidasi dan `systems.verifiedSystems: 7`. Batas respons baru melewati gangguan sebelumnya, tetapi kode generik pada run lama tetap tidak membuktikan penyebab historisnya.
- Pada probe GBA lengkap berikutnya, akun/sistem kembali lolos lalu `EVIDENCE` menghentikan proses. Lookup telah melewati HTTP/JSON, tetapi belum ada bukti yang memenuhi gerbang matched ROM. Probe negatif **belum dijalankan**.
- Ini bukan bukti bahwa ROM rusak atau perlu diganti. Bentuk respons aktual, field yang hilang, dan nilai yang tidak cocok belum diketahui tanpa diagnostik rinci. Tidak ada capture respons mentah atau secret yang diminta.

### Output baru

Skrip tetap mengembalikan exit code `1` dan kode statis `EVIDENCE` jika bukti ditolak. Sebelum pesan statis, otomatis ada satu baris JSON `step: evidence`, tanpa perlu flag debug. Isinya hanya endpoint tetap `jeuInfos.php`, alasan allowlist, boolean pemeriksaan, dan kategori bentuk field.

| Kelompok | Pemeriksaan yang ditampilkan |
| --- | --- |
| Game/sistem | `hasGame`, `gameIdValid`, `systemIdValid`, `systemMatches` |
| Penanda non-game | `notGameFieldPresent`, `notGameConfirmedFalse`, `notGameConfirmedTrue` |
| Matched ROM | `hasMatchedRom`, `hasRomsList`, `romIdValid` |
| Referensi ROM | `hasRomReference`, `romReferenceConsistent` |
| Jumlah support | `supportCountPresent`, `singleSupport` |
| Ukuran | `sizeValid`, `sizeMatches` |
| Hash | `md5Present`, `md5Valid`, `md5Matches`, `sha1Present`, `sha1Valid`, `sha1Matches` |

`shapes` hanya menjelaskan tipe kategori untuk `game`, `matchedRom`, `system`, `notGame`, `supportCount`, `size`, `md5`, dan `sha1`: `missing`, `null`, `object`, `array`, `string`, `boolean`, `number`, atau `other`. Tidak mencetak nama field tambahan dari provider, nilai ID, hash, ukuran asli, judul/nama ROM, lokasi berkas, akun/password, URL, atau body.

Contoh **potongan ilustratif**, bukan output provider/operator yang sudah diamati:

```json
{"step":"evidence","code":"EVIDENCE","endpoint":"jeuInfos.php","reason":"unconfirmed_game","checks":{"hasMatchedRom":true,"notGameFieldPresent":false,"notGameConfirmedFalse":false,"sizeMatches":true,"md5Matches":true,"sha1Matches":true},"shapes":{"notGame":"missing"}}
```

### Membaca hasil

- `missing_game` / `missing_matched_rom`: tidak ada object game/matched `rom` yang diterima. Keberadaan `roms` tidak dipakai sebagai pengganti matched ROM; array `rom` juga tidak diam-diam diambil item pertamanya.
- `rom_reference_mismatch`: referensi `romid` yang dikembalikan tidak konsisten dengan ID matched ROM. Referensi tetap opsional seperti sebelum perubahan: jika tidak ada, `hasRomReference` false dan `romReferenceConsistent` true; ini bukan bukti referensi tersedia.
- `unconfirmed_game`: periksa ID/sistem dan penanda non-game. `notgame` hilang atau object wrapper tidak dianggap false. Kategori bentuk field membantu menilai kontrak tanpa mencetak nilainya.
- `unconfirmed_rom`: periksa ID ROM/jumlah support. Jumlah support hilang tidak diasumsikan satu.
- `size_mismatch`: ukuran tidak valid atau tidak cocok; lihat `sizeValid` dan `sizeMatches`.
- `missing_hash_evidence`: hash hilang/tidak valid/bentuk belum didukung. `*Present` membedakan field hilang dari field ada tetapi tidak valid.
- `hash_mismatch`: hash berformat valid tetapi berbeda. `md5Matches` dan `sha1Matches` membedakan hash mana yang tidak cocok; nilainya sendiri tidak pernah ditampilkan.
- Alasan policy lain seperti `invalid_input`, `manual_lookup`, dan `invalid_fingerprint` tetap berupa kode tetap. Kode tidak dikenal pada snapshot menjadi `unknown_evidence`, bukan teks input/provider.

Seluruh `checks` bertipe boolean ketat dan seluruh kategori/alasan memakai allowlist. Snapshot serta object nested-nya immutable di registry internal, bukan properti error publik yang dapat diganti. `message`, `stack`, `cause`, `error.evidence`, dan field tambahan tidak diteruskan ke terminal.

### Tidak ada pelonggaran atau request tambahan

Perubahan hanya menambah penjelasan penolakan. Policy `assessScreenScraperEvidence()` tidak diubah: tetap perlu raw eligible, sistem dan ID valid, non-game terkonfirmasi false, satu matched ROM/satu support, ukuran persis sama, dan kedua hash cocok. Tidak ada default field yang hilang, normalisasi wrapper baru, pencarian nama/fallback `roms`, ekstraksi/konversi, retry, penerapan metadata, atau scan otomatis. Sukses lama dengan referensi opsional tetap sukses; data provider/input tidak dimutasi.

Ulangi perintah probe GBA yang sama pada file pilihanmu. Jika masih ditolak, bagikan **baris `step: evidence` dan pesan error statis saja**. Tidak perlu mengganti file atau membagikan secret/raw response. Jika HTTP/JSON gagal, baris `step: diagnostic` dari §9 tetap berlaku. Probe negatif masih ditahan sampai matched ROM lolos.

### Verifikasi penambahan

- `node --test tests/screenscraper-m0.test.mjs tests/screenscraper-policy.test.mjs`: **48 lulus**, tanpa gagal/skip (33 tes CLI dan 15 policy).
- Lima tes baru mencakup matriks 23 varian bukti yang ditolak, input lokal tidak valid, kasus sukses/reference opsional tanpa mutasi, snapshot allowlist yang tidak dapat ditimpa, dan output CLI tanpa secret/hash/ID/nama game yang berhenti sebelum probe negatif.
- `npm test`: **365 lulus**, tanpa gagal/skip, sekitar 35,8 detik.
- `npm run build`: **lulus**, sekitar 4,8 detik tahap Vite; peringatan chunk frontend >500 kB tetap dicatat. Tidak ada perubahan frontend, engine, identitas save, database, atau aktivasi scan.
- Seluruh pengujian perubahan memakai fixture, transport tiruan, dan secret palsu. Agent tidak membaca/mengubah secret operator, membuka ROM pilihan operator, atau menjalankan API asli. M0 tetap terbuka sampai hasil bukti ROM dan pemeriksaan berikutnya benar-benar lolos.

## 11. Referensi ROM Tambahan, Bukan Gerbang Bukti Primer — 2026-11-07

### Bukti operator dan penelitian kontrak

Run GBA terbaru kembali meloloskan akun/kuota dan tujuh sistem. Diagnostik menunjukkan sistem sesuai, ID game/matched ROM valid, non-game terkonfirmasi false, satu support, ukuran sama, serta **MD5 dan SHA-1 valid dan cocok**. Satu-satunya kegagalan adalah pemeriksaan tambahan CLI `romReferenceConsistent: false`; policy murni tidak mensyaratkan referensi atas tersebut. Probe negatif belum dijalankan.

Sumber publik diperiksa kembali tanpa request terautentikasi:

| Sumber | Yang benar-benar dapat disimpulkan |
| --- | --- |
| [WebAPI v2, `jeuInfos.php`](https://www.screenscraper.fr/webapi2.php) | Menyebut `jeu.romid` sebagai identifiant numérique de la rom. Bagian `roms` adalah daftar ROM terkait game; bagian `rom` adalah informasi ROM yang dicari jika ditemukan dalam database, termasuk ID, support, ukuran, MD5, dan SHA-1. Dokumentasi mencampur notasi XML/JSON (`rom`/`romid`), tetapi tidak menjelaskan kasus referensi atas berbeda atau aturan sentinel/wrapper yang aman dinormalisasi. |
| [Tipe publik RomM `SSGame`/`SSGameRom`](https://github.com/rommapp/romm/blob/master/backend/adapters/services/screenscraper_types.py) | `SSGame.romid` bertipe string opsional dan ID ROM juga opsional dalam tipe tersebut. Ini bukti sekunder tentang penanganan field opsional, **bukan** spesifikasi provider atau bukti bahwa ID berbeda harus diterima. |

Tidak ditemukan penjelasan publik yang cukup untuk menyatakan kedua ID memiliki makna berbeda, menebak bahwa nilai aktual adalah nol/sentinel, atau mengubah parser wrapper/leading-zero. Diagnostik operator lama tidak merekam bentuk/validitas referensi atas sehingga tidak membuktikan apakah nilainya tidak valid atau dua ID valid benar-benar berbeda. Tidak meminta raw response atau nilai ID untuk menentukannya.

### Keputusan lokal CLI M0

- **Bukti primer tetap dari matched `jeu.rom` saja.** ID game/ROM dan sistem valid, status game eksplisit, satu support, ukuran persis, kedua hash valid dan cocok, serta format/metode eligible tetap wajib. `assessScreenScraperEvidence()` tidak diubah.
- `jeu.romid` hanya referensi tambahan. Angka integer positif aman dan string desimal kanonis dinormalisasi dengan aturan ID yang sudah ada; object/array/null/nol/leading zero tidak dibongkar atau ditebak.
- Referensi hilang atau valid dan sama: `warnings: []`. Referensi ada tetapi tidak valid: satu peringatan `rom_reference_invalid`. Dua ID valid berbeda: satu peringatan `rom_reference_mismatch`.
- Peringatan muncul dalam `step: rom` dan `report.rom.warnings` **hanya setelah bukti primer lolos**. `verified: true` tetap berarti kelayakan bukti utama, bukan konsistensi seluruh respons atau izin menerapkan metadata. Anomali referensi tetap terlihat dan tidak diklaim sudah diperbaiki di sisi provider.
- Bila bukti primer gagal, exit code tetap `1`/`EVIDENCE` dengan alasan primer, sekalipun referensi atas sama atau bermasalah. Referensi tidak boleh memasok ID ROM hilang, memilih item `roms`, atau menyembunyikan hash/ukuran/sistem yang berbeda.
- Snapshot peringatan menggunakan allowlist alasan/checks/bentuk yang sama dengan error evidence dan immutable hingga object nested. Tidak menyalin respons, field tambahan, ID, hash, nama, path ROM, URL, atau secret. Tambahan `romReferenceValid` dan `shapes.romReference` membedakan referensi tidak valid dari dua ID valid berbeda tanpa nilainya. `romReferenceConsistent: true` saat referensi hilang tetap bukan bukti referensi tersedia; gunakan `hasRomReference`.

Ini mengubah **gerbang tambahan CLI**, bukan sekadar kosmetik diagnostik, tetapi tidak melonggarkan gerbang bukti primer. Pilihan ini tidak bergantung pada klaim bahwa provider menjamin atau melarang perbedaan referensi: M0 memakai seluruh bukti matched ROM yang persis, lalu melaporkan anomali tambahan terpisah. Belum ada penerapan metadata/worker produksi; M2 harus mempertahankan pemisahan bukti primer dan anomali serta memverifikasi kembali kontrak saat integrasi.

### Urutan probe dan uji ulang

Tidak ada retry/request tambahan. Tanpa `--not-found`, sukses memerlukan tiga request akun → sistem → ROM; dengan flag tersebut empat request akun → sistem → ROM → negatif. Peringatan referensi saja tidak lagi menghentikan urutan; kegagalan bukti primer tetap menghentikannya sebelum negatif. Probe negatif tetap wajib benar-benar HTTP 404—HTTP 200 yang terlihat seperti game bukan sukses negatif. Pembatasan quota, laju, timeout, lock, redaksi, dan flag ENABLED nonaktif tidak berubah.

Operator dapat mengulang perintah GBA yang sama. Bagikan summary tersanitasi `step: rom` (termasuk `warnings`) dan `step: not_found`, atau `step: evidence`/`step: diagnostic` bila gagal. Tidak perlu mengirim ID/hash, secret, respons mentah, atau mengganti ROM/password. Agent tidak menjalankan perintah tersebut atas file/secret operator.

### Verifikasi perubahan

- Tiga tes tambahan: **14 varian referensi** tanpa mutasi; **70 kombinasi** referensi dan bukti primer salah/hilang; output CLI tersanitasi untuk referensi berbeda/tidak valid, dengan/tanpa probe negatif dan tanpa request ekstra.
- Matriks transport penolakan primer diperluas untuk SHA-1, ID matched ROM, support, dan non-game yang salah bersamaan dengan referensi berbeda; selalu berhenti setelah tiga request. Tes negatif HTTP 200 juga dijalankan dengan peringatan referensi dan tetap ditolak.
- `node --test tests/screenscraper-m0.test.mjs tests/screenscraper-policy.test.mjs`: **51 lulus**, tanpa gagal/skip (36 CLI, 15 policy).
- `npm test`: **368 lulus**, tanpa gagal/skip, sekitar 38,5 detik.
- `npm run build`: **lulus**; tahap Vite sekitar 5,5 detik, peringatan lama chunk frontend >500 kB tetap ada.
- Seluruh tes memakai fixture/transport tiruan dan secret palsu. Tidak ada secret/ROM operator dibaca, API asli dijalankan, scan otomatis diaktifkan, atau metadata/database/frontend/save/engine diubah. M0 operasional **belum ditutup** sebelum hasil uji ulang dan pemeriksaan media/izin yang masih terbuka.

## 12. Bukti Akhir Operator, Ketentuan, dan Probe Cover Manual — 2026-11-07

### Probe yang sudah lolos

Operator mengirim hasil lengkap setelah perbaikan referensi: akun/kuota terverifikasi, tujuh sistem cocok, `rom.verified: true`, dan `not_found.verified: true` dengan HTTP 404. Run memakai **empat request**, `automaticScan: false`. Matched ROM, status game, satu support, sistem, ukuran, MD5 dan SHA-1 semuanya lolos. Bentuk nama, sinopsis, tanggal, genre dan media berupa array; entri front cover tersedia. Ini bukti operator, bukan eksekusi agent atau fixture sintetis yang diklaim sebagai capture nyata.

Peringatan `rom_reference_mismatch` disertai `romReferenceValid: true` dan bentuk `string`, jadi **dua ID valid berbeda**, bukan field invalid/sentinel/wrapper. Penyebab ketidaksamaan di sisi provider masih tidak diketahui. Perbedaan tetap dilaporkan; tidak dianggap sudah diperbaiki atau dijamin normal oleh API. Tidak menyimpan ID, hash, judul, nama/path ROM, nilai secret, atau respons mentah dalam laporan ini.

### Ketentuan dan batas izin yang ditetapkan

Sumber publik diperiksa 2026-11-07:

| Sumber | Temuan dan keputusan maindulu |
| --- | --- |
| [WebAPI v2, bagian siapa yang boleh memakai API](https://www.screenscraper.fr/webapi2.php) | Aplikasi harus sepenuhnya gratis dan didistribusikan, atau memperoleh persetujuan sebelumnya dengan ketentuan tim ScreenScraper. Developer diminta memperkenalkan integrasinya melalui forum. Akses kredensial/HTTP sukses sendiri tidak membuktikan cakupan persetujuan. |
| Footer halaman WebAPI v2 | Menampilkan CC BY-NC-SA 4.0 dan daftar sumber/kredit komunitas untuk informasi serta media. Tidak menjamin semua hak cover pihak ketiga atau memberikan lisensi ROM. |
| [Deed resmi CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.en) | Untuk materi yang memang dicakup lisensi: kredit yang layak, tautan lisensi, indikasi perubahan, penggunaan nonkomersial, ShareAlike bila mendistribusikan adaptasi, dan tanpa pembatasan tambahan yang bertentangan. Deed adalah ringkasan; [legal code](https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.en) tetap rujukan lisensi. CC mengingatkan hak lain mungkin tetap diperlukan. |
| Bagian `mediaJeu.php` pada WebAPI v2 | Endpoint gambar resmi memakai `systemeid`, `jeuid`, dan selector `media` dengan region. `mediaformat` hanya informasi; `outputformat` dapat mengubah format. Respons dapat berupa gambar atau marker `NOMEDIA`/hash-update, bukan selalu gambar meskipun HTTP 200. |

Operator memilih **“Konteks LAN sudah disetujui”** pada pertanyaan yang secara eksplisit menyebut maindulu pribadi/nonkomersial, penyimpanan metadata/cover, serta penyajian kepada pengguna LAN. Gerbang izin **untuk konteks ini** dicatat selesai berdasarkan pernyataan tersebut. Agent tidak membaca persetujuan privat atau menganggapnya pendapat hukum. Operator menyimpan bukti sendiri; tidak ada kewajiban mengirim email, akun, ID, atau dokumen privat ke chat/repository. Pindah ke layanan internet publik, distribusi berbayar/komersial, atau konteks lain memerlukan peninjauan kembali; konfirmasi ini tidak diperluas otomatis.

Keputusan cache/atribusi M0:

- CLI tidak menyimpan metadata/cover sama sekali; byte uji cover hanya sementara di memori. Cache produksi adalah pekerjaan M2/M4, dengan TTL/batas lokal §6 dan tunduk pada ketentuan yang berlaku. Sumber publik yang diperiksa tidak menetapkan TTL cache spesifik; angka 7 hari/24 jam bukan hak provider atau hasil persetujuan TTL khusus.
- M1/M4/M5 wajib mempertahankan sumber/tautan game aman, pemberitahuan lisensi yang berlaku, kredit pencipta/sumber media yang diberikan, serta catatan perubahan. Tidak menyebut seluruh cover pasti CC hanya karena footer situs, dan tidak mengubah lisensi aplikasi/ROM.
- Atribusi minimal yang akan terlihat pada detail/kredit: **“Metadata/cover: ScreenScraper — sumber dan kredit media jika tersedia. CC BY-NC-SA 4.0 untuk materi yang dicakup lisensi tersebut. Perubahan: [tidak diubah / rincian perubahan].”** Sertakan tautan halaman game tanpa kredensial dan tautan lisensi; jangan menyiratkan endorsement. Rincian hak/sumber yang lebih spesifik harus dipertahankan, bukan diganti template umum ini.
- Uji decode bukan bukti hak; `cover.rightsVerified: false` memang tetap false. Itu batas kemampuan validator otomatis, **bukan pembatalan konfirmasi izin operator** yang dicatat terpisah di atas.

### Implementasi probe cover

`npm run metadata:m0` menerima **`--cover`** hanya jika `check --live`, ROM, dan console diberikan. Tanpa flag itu perilaku/request lama tetap. Tidak ada migrasi, registrasi startup/upload, cache, worker, penerapan metadata, atau UI baru.

Urutan: akun → sistem → matched ROM → negatif bila diminta → **satu cover** bila diminta. Tanpa `--not-found` empat request; dengan kedua flag maksimal lima. Tidak mencoba region/URL/gambar lain atau retry bila satu unduh gagal. Pemeriksaan kuota/reservasi konservatif, interval minimum, timeout total 20 detik termasuk stream/decode, pembatalan, dan lock tetap berlaku.

Pemilihan cover:

- Hanya daftar `jeu.medias` milik game dengan bukti ROM lolos; maksimum 1.000 entri object. Tipe tetap `box-2D`, region pertama yang tersedia menurut `wor` → `us` → `eu` → `jp` → `ss`. Lebih dari satu entri di region pilihan dianggap ambigu dan ditolak, bukan dipilih arbitrer.
- Request dibangun ke **`https://api.screenscraper.fr/api2/mediaJeu.php`** dengan `jeuid` dari ID game tervalidasi dan `systemeid` dari sistem yang cocok. Tidak memakai top-level `romid` atau matched ROM ID sebagai game ID. Type/region berasal dari allowlist tetap.
- **Seluruh URL/query/ID/format hint media dari respons diabaikan**: tidak di-fetch, tidak di-log, tidak dijadikan fallback. Tidak meneruskan kredensial ke host lain. Tidak menambahkan `outputformat`, resize, hash conditional, atau parameter arbitrer. `.invalid`, localhost, URL bermuatan secret, dan host CDN tak dikenal tidak pernah diikuti.
- Redirect ditolak dan URL respons yang berubah juga ditolak. Kebijakan probe ini tidak menyatakan seluruh URL media provider sudah diteliti/aman; allowlist produksi M4 harus mempertahankan endpoint tetap atau menilai ulang bila perlu host lain.

Validasi byte:

- HTTP harus 200; MIME harus PNG/JPEG/WebP dan cocok dengan format yang didecode. SVG/GIF/HTML/JSON/octet-stream tidak diterima. `text/plain` hanya dibaca untuk mengenali marker `NOMEDIA`; teks lain ditolak. HTTP 404/`NOMEDIA` adalah **cover tidak tersedia**, bukan game tidak ditemukan.
- Batas **8 MiB setelah dekompresi**, dihitung saat streaming tanpa mempercayai `Content-Length`; stream dibatalkan jika berlebih. Akun/game tetap 2 MiB, daftar sistem 16 MiB.
- `sharp` membatasi input 4096×4096 piksel; kedua dimensi maksimum 4096, satu frame, bukan animasi. Chunk `acTL` PNG ditolak walau decoder melihat hanya frame pertama. Setelah metadata/signature, decoder membaca **gambar penuh** ke raster berbatas, bukan menganggap header cukup. Decode juga memiliki batas waktu native dan dibersihkan saat selesai/batal.
- Tidak menulis gambar/raster/JSON ke disk, katalog, backup, browser, atau laporan otomatis. Ringkasan sukses hanya endpoint/boolean kebijakan host, type/region allowlist, MIME, byte/dimensi, `decoded`, `stored: false`, `rightsVerified: false`. Decoder exception, body, header mentah, kredensial, URL, hash, nama dan ID tidak diteruskan ke output.

Selain boolean shape lama, `rom.metadataShape.preferredNameListed`/`preferredSynopsisListed` menunjukkan apakah ada teks tidak kosong dalam batas panjang, dengan kode region/bahasa yang didukung. Ini membantu memeriksa konvensi respons aktual tanpa mencetak teks atau kode arbitrer. Metadata opsional yang hilang tidak membuat hash gagal; boolean tersebut bukan validasi semantik/akurasi teks atau pengganti parser produksi M2. Probe ini tidak memeriksa seluruh kamus region/bahasa atau seluruh platform/edisi.

### Langkah operator terakhir (sudah selesai, hasil pada §13)

Probe negatif sudah lolos, jadi tidak perlu diulang untuk pemeriksaan terakhir. Setelah persetujuan konteks LAN yang sudah dikonfirmasi, jalankan satu kali:

```powershell
npm run metadata:m0 -- check --live --console gba --rom "C:\path\ROM-pilihan.gba" --cover
```

Bagikan **baris `step: rom` dan `step: cover`** (atau `step: diagnostic`/`step: evidence` serta error statis bila gagal). Tidak perlu mengirim gambar, URL, raw response, secret, nama game, atau hash. `rom_reference_mismatch` tetap peringatan; tidak perlu mengganti ROM hanya untuk menghilangkannya.

Gerbang akhir M0:

- [x] Bukti akun/kuota, sistem, matched ROM dan lookup negatif HTTP 404 menurut output operator.
- [x] Konteks pribadi/nonkomersial LAN termasuk cache/penyajian dikonfirmasi operator; ketentuan, keputusan cache, dan persyaratan atribusi didokumentasikan.
- [x] Uji offline CLI cover/keamanan dan regresi lulus; runtime aplikasi tetap nonaktif.
- [x] Output operator menunjukkan `preferredNameListed: true` dan `preferredSynopsisListed: true`; satu cover PNG region `us` berhasil didecode melalui endpoint tetap, 875.141 byte, 705×700 piksel (§13).

**Hasil terakhir sudah diterima dan M0 ditutup pada §13** untuk ruang lingkup pribadi/nonkomersial LAN yang dikonfirmasi. Ini tetap bukan aktivasi produksi: penyimpanan provenance/atribusi, worker, cache, publikasi metadata/cover dan UI mengikuti M1–M6; tidak memulai M1 pada pekerjaan ini.

### Verifikasi perubahan

- `tests/screenscraper-m0-cover.test.mjs`: **15 tes baru**, seluruhnya fixture/transport tiruan dan gambar raster buatan `sharp`, tanpa aset provider. Mencakup flags, host/parameter tetap, region/ambiguitas/cap daftar, gate primer/negatif, konvensi metadata aman, decode PNG/JPEG/WebP, MIME/format rusak, dimensi batas, PNG animation-control dan WebP animasi, byte cap/cancel/timeout, redirect, HTTP/quota, sanitasi CLI dan tanpa persistensi.
- `node --test tests/screenscraper-m0*.test.mjs tests/screenscraper-policy.test.mjs`: **66 lulus**, tanpa gagal/skip (15 cover + 36 CLI + 15 policy), sekitar 0,9 detik pada pengulangan akhir.
- `npm test`: **383 lulus**, tanpa gagal/skip; sekitar 39,6 detik.
- `npm run build`: **lulus**; tahap Vite sekitar 5,3 detik, peringatan chunk frontend >500 kB tetap ada.
- `node scripts/screenscraper-m0.mjs --help`: lulus tanpa membaca secret atau memakai jaringan. Agent hanya membaca dokumentasi publik; tidak membuka secret/ROM operator, memanggil API terautentikasi, atau mengunduh cover provider asli.

## 13. Penutupan M0 untuk Pribadi/LAN — 2026-11-07

**Keputusan: M0 selesai dan ditutup** setelah operator mengirim hasil `--cover` dan meminta penutupan, commit, serta push. Penutupan dibatasi pada penggunaan maindulu pribadi/nonkomersial di LAN yang sebelumnya dikonfirmasi operator. Pernyataan cakupan persetujuan berasal dari operator, bukan kesimpulan hukum atau pembacaan korespondensi privat oleh agent.

### Matriks bukti akhir

| Pemeriksaan | Bukti dan hasil |
| --- | --- |
| Akun/developer dan kuota | `account.verified: true` pada run operator; kuota melewati validator konservatif. Nilai secret tidak dibaca/disalin agent. |
| Mapping sistem | `systems.verifiedSystems: 7`; bukan bukti pencocokan ROM di seluruh platform. |
| Matched ROM GBA | `rom.verified: true`; ID game/ROM valid, sistem sesuai, status game eksplisit, satu support, ukuran sama, serta MD5 dan SHA-1 valid/cocok. Nilai ID/hash/nama/path tidak dicatat. |
| Lookup negatif | Run `--not-found` sebelumnya menghasilkan `not_found.verified: true`, HTTP 404, empat request. Tidak diulang pada uji cover. |
| Konvensi metadata | `names`, `synopsis`, `dates`, `genres`, `media`, `preferredNameListed`, `preferredSynopsisListed`, dan `frontCoverListed` true. Menunjukkan shape/kode preferensi yang dipakai tersedia, bukan validasi semantik teks atau seluruh kamus region/bahasa. |
| Cover aktual | `cover.verified: true`, `image/png`, **875.141 byte**, **705×700 piksel**, `decoded: true`; di bawah cap 8 MiB dan 4096×4096. Tipe `box-2D`, region `us`. |
| Tujuan request cover | `endpoint: mediaJeu.php`, `fixedOrigin: true`, `providerUrlFollowed: false`; hanya endpoint HTTPS tetap, tanpa mengikuti URL media dari respons. |
| Tanpa penyimpanan/aktivasi | `stored: false`, `automaticScan: false`; run cover memakai empat request. Tidak menerapkan metadata atau menyimpan gambar/katalog/database. |
| Izin/cache/atribusi | Konteks pribadi/nonkomersial LAN termasuk penyimpanan/penyajian metadata/cover dikonfirmasi operator; keputusan serta kewajiban atribusi ada pada §2/§12. Implementasi provenance/atribusi tetap M1/M4/M5 sebelum aktivasi aplikasi. |

`cover.rightsVerified: false` tetap benar: validator hanya menguji byte, MIME, ukuran/dimensi dan decode, tidak membuktikan hak penggunaan. Konfirmasi izin operator dicatat terpisah; tidak ada klaim seluruh aset pihak ketiga otomatis berlisensi sama atau hak ROM ikut diberikan.

### Temuan yang dipertahankan dan batas serah-terima

- `rom_reference_mismatch` tetap terlihat pada run terakhir: referensi atas berbentuk string ber-ID valid tetapi berbeda dengan ID matched ROM. Penyebab provider belum diketahui. Ini **temuan non-blocking yang terdokumentasi**, bukan inkonsistensi yang dihapus dari laporan; semua bukti primer tetap wajib. M2 harus mempertahankan pemisahan bukti primer dan peringatan tersebut.
- Bukti nyata terbatas pada satu ROM GBA dan satu cover PNG region `us`, satu negatif sintetis, akun/kuota, dan daftar tujuh ID sistem. Tidak mengklaim setiap core/format/edisi, media/host alternatif, `jeuRecherche.php`, atau seluruh kamus region/bahasa sudah diuji terautentikasi. Kasus pertahanan lain diuji offline memakai fixture sintetis.
- Agent tidak membaca `.env.screenscraper.local`, ROM operator, persetujuan privat, atau body/gambar provider. Agent tidak menjalankan request terautentikasi ulang. Bukti nyata berasal dari summary CLI yang dibagikan operator; tidak disimpan sebagai capture mentah.
- Secret dan lock tetap diabaikan Git; template publik tetap kosong. Tidak ada secret/raw response/ROM/cover operator yang menjadi artefak commit.
- **Tidak mengaktifkan scan dan tidak mengimplementasikan M1.** Tahap selanjutnya M1: model metadata, provenance/kunci per-field, dan kompatibilitas backup. Integrasi produksi, worker, cache, unduh/penyajian cover dan UI tetap M2–M6 dengan proteksi/atribusi yang direncanakan.
- Perubahan konteks menjadi layanan internet publik, komersial, distribusi lain, atau penggunaan media/host baru memerlukan peninjauan ulang ketentuan dan keamanan. Penutupan M0 bukan persetujuan universal atau aktivasi produksi.

Verifikasi kode terakhir: **66 tes M0 dan 383 tes keseluruhan lulus**, build produksi lulus dengan peringatan lama chunk frontend >500 kB (§12). Pengujian otomatis tidak menggunakan secret/provider nyata; penutupan menggabungkan bukti offline ini dengan hasil operator di atas.

Sebelum commit penutupan, `npm test` dijalankan ulang: **383 lulus, tanpa gagal/skip**, sekitar 39,0 detik; `npm run build` kembali lulus, tahap Vite sekitar 5,2 detik dengan peringatan chunk yang sama. `git check-ignore --no-index` mengonfirmasi secret/lock tetap diabaikan tanpa membaca isi file lokal.
