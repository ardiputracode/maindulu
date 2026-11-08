# M7 ScreenScraper — Identifikasi ZIP Terbatas

Tanggal: **2026-11-08**. Status: **M7 ditutup untuk cakupan ZIP satu ROM raw (stored/deflate)** pada penggunaan pribadi/nonkomersial LAN. Regresi akhir: **507 unit/integrasi**, build, **168 browser backend**, serta **66 statis dev + 66 produksi** lulus (107 skip khusus backend per mode statis). 7z/RAR, disc PS1, transformasi dump dan ZIP yang tidak memenuhi kebijakan tetap ditolak untuk lookup hash, dengan fallback review jika sistem diketahui. Ini bukan janji mendukung semua format arsip/disc. Fitur ScreenScraper tetap **default off** dan tidak diaktifkan pada konfigurasi operator.

## 1. Baseline, pengukuran dan keputusan format

Audit jalur nyata sebelum perubahan: `worker.mjs` memanggil resolver ekstensi luar, lalu mengakhiri tugas `unsupported` untuk **semua ZIP/7z/RAR dan seluruh format PS1** sebelum hashing/provider. Karena itu memindai byte kontainer menggunakan MD5/SHA-1 bukan perbaikan yang benar. Tidak tersedia laporan kegagalan koleksi per format dari operator; agent **tidak membaca koleksi/secret atau mengarang persentase kecocokan produksi**.

Pengukuran reproduktif memakai berkas legal lokal: `public/games/jalan-pulang.nes` (CC0) **24.592 byte**, deflate raw **759 byte**, rasio **32,40:1**. Dibungkus sebagai satu anggota `demo.nes`, jalur lama berhenti pada ekstensi ZIP; jalur baru menghasilkan fingerprint anggota yang sama dengan raw dan dapat boot NES melalui engine lokal. Tes browser provider tiruan membuktikan metadata dan cover diperbarui, sesi aktif tidak berubah, identitas engine tetap, dan peluncuran berikut memakai cache tanpa GET ROM tambahan. Ini bukti dekompresi/identitas/gameplay fixture, **bukan** bukti bahwa database ScreenScraper memuat homebrew tersebut.

| Format | Keputusan M7 | Bukti/fallback |
| --- | --- | --- |
| ZIP32 stored (0) / deflate (8), satu anggota raw | Didukung untuk identifikasi anggota | Hash/ukuran anggota dibandingkan independen; 12 kombinasi codec/platform diuji, termasuk GB/GBC. Provider harus mengembalikan bukti exact seperti raw. |
| ZIP dengan direktori kosong + satu ROM | Didukung dengan batas path/entri | Seluruh direktori/header diperiksa, bukan hanya berkas pertama. |
| ZIP multi-game, ROM + README/cover/CUE, nested archive | Tidak didukung untuk hash | Tidak memilih satu berkas sembarang. Nama dapat dicari untuk platform yang sudah pasti, selalu review. |
| ZIP encrypted, ZIP64, multi-volume, SFX, codec/extra field di luar allowlist | Tidak didukung untuk hash | Ditolak lokal, tanpa percobaan executable/ekstraksi alternatif. |
| 7z/RAR | Tetap review | Belum ada bukti kebutuhan/provider/packaging yang membenarkan parser atau executable tambahan. Tidak menjalankan `7z`, `unrar`, `tar` atau shell. |
| PS1 BIN/ISO/CHD/PBP/CUE/multi-track, termasuk ZIP PS1 | Tetap review | Tidak mengasumsikan hash kontainer, satu track atau serial sebagai bukti satu disc/game. Tidak mengubah `romtype=rom` menjadi tebakan `iso`. |
| Headered/byte-swapped/normalized dump | Tetap policy raw M0 | Tidak strip header atau menukar byte untuk menaikkan tingkat kecocokan. |

Dokumentasi publik [API v2 ScreenScraper](https://www.screenscraper.fr/webapi2.php) diperiksa kembali tanpa kredensial: pencarian menerima hash, ukuran, nama tanpa path dan sistem. Tidak ditemukan bukti operasional baru yang membenarkan auto-apply serial/track/CHD/PBP. M7 **tidak meminta provider mengenali ZIP**: yang dikirim tetap tuple raw dari anggota yang tervalidasi. Nama anggota berbeda dari nama upload dan juga merupakan data yang dibagikan.

Pilihan ZIP dahulu sesuai checklist rencana “tidak semua format harus didukung sekaligus”. Penambahan 7z/RAR/disc berikutnya memerlukan contoh legal dan bukti provider spesifik; bukan daftar dukungan tersirat dari penutupan M7 ini.

## 2. Implementasi dan batas resource

Modul `server/metadata/identification.mjs` memilih raw atau worker thread ZIP. `zip-identification-worker.mjs` memakai **yauzl 3.4.0**, MIT, terpin beserta integrity dalam lockfile, dan zlib bawaan Node. Tidak ada binary proprietary, download runtime, executable tambahan, atau perubahan bundle engine. [Provenance dependensi](../third_party/yauzl/README.md).

| Batas | Nilai/kebijakan |
| --- | --- |
| Ukuran kontainer ZIP | Maksimum **128 MiB** untuk identifikasi (upload tetap maksimum 768 MiB) |
| Total hasil dekompresi / satu ROM | Maksimum **64 MiB** |
| Rasio | Maksimum **100:1**, dicek dari metadata dan byte aktual |
| Jumlah entri | Maksimum **64**, termasuk direktori kosong |
| Path | Maksimum **240 karakter**, kedalaman **8 komponen**, basename tetap melalui resolver raw |
| Kedalaman arsip bersarang | **0**; nested archive ditolak |
| Pembacaan/dekompresi | Stream/chunk **64 KiB**, tidak menampung ROM penuh |
| Waktu | **30 detik** wall-clock termasuk startup worker, verifikasi aset, parse dan hashing; terminate saat timeout/abort |
| Heap worker | Old generation **32 MiB**, young **8 MiB**, stack **4 MiB** |
| Temporary storage | **0 byte**; tidak mengekstrak/menulis anggota ke disk/public |
| Concurrency | Satu identifikasi/tugas di bawah gate/lease provider bersama yang sudah ada |

Worker thread menjaga parsing/hashing CPU di luar event loop Fastify. Ini **bukan sandbox keamanan OS atau batas RSS/CPU kernel**; heap V8 tidak mencakup semua buffer/native zlib. Pembatasan byte, chunk, rasio dan wall-clock tetap wajib. Operator dapat menambah limit container sesuai kapasitas. Tidak ada env untuk menaikkan batas parser atau URL provider.

Pemeriksaan keamanan:

- Baca hanya **handle aman** dari storage; tidak membuka path anggota/path upload lagi. SHA-256 dan ukuran kontainer diverifikasi terhadap descriptor upload, stat sebelum/sesudah harus konsisten. Parent tetap pemilik handle dan menunggu worker **exit** sebelum menutupnya, termasuk pada timeout/abort.
- Semua entri diperiksa sebelum dekompresi: traversal, absolute/drive/ADS/backslash, kontrol/NUL, dot/empty segments, alias trailing dot/spasi, duplikat/case aliases, symlink/special file dan extra field link/proprietary ditolak. Tidak ada ekstraksi, sehingga anggota tidak pernah menjadi path filesystem.
- Central/local name, flag, method dan ukuran/CRC diperiksa; descriptor (dengan/tanpa signature), posisi/rentang kontigu serta envelope/count/size central directory harus konsisten. Overlap, hole, hidden local record dan SFX ditolak. Extra field hanya timestamp `0x5455`, Unix UID/GID `0x7875`, NTFS `0x000a`; Unicode path override/ZIP64/Unix link extra ditolak konservatif.
- Inflate harus mengonsumsi tepat ukuran compressed stream; trailing compressed garbage, CRC salah, output kurang/lebih dan size claim palsu gagal lokal. CRC hanya integritas ZIP, **bukan pengganti** MD5/SHA-1/ukuran provider.
- Error parser tidak diteruskan mentah ke log/UI; hanya kode aman. Arsip tidak aman/berlebih/timeout menjadi `unsupported`, tanpa retry provider otomatis. `asset_mismatch` menjadi `failed`. Tidak menghabiskan kuota untuk kegagalan lokal.

## 3. Identitas, bukti provider, cache dan review

SHA-256/ukuran aset, ID, console, storage key, original name, URL, license, `saveIdentity` dan key cache ROM tetap milik **byte upload ZIP**, bukan anggota. ROM tersimpan tidak ditulis ulang. Fingerprint pencarian anggota (`size/md5/sha1`) disimpan terpisah pada payload kandidat tugas, dengan descriptor internal `{ kind: 'zip-member', version: 1, fileName }`; job tetap terikat pada fingerprint aset/generation/lease.

Request hash memakai **basename anggota**, bukan path direktori atau nama ZIP. GB/GBC dipilih dari `.gb`/`.gbc` anggota, tanpa mengubah console katalog `gb`. Evidence gate raw M0 tetap mensyaratkan satu game, satu matched ROM/support, sistem benar, bukan non-game, **ukuran + MD5 + SHA-1 sama**. Nama, serial, SHA-256 aset, CRC atau HTTP 200 saja tidak cukup. Hasil provider ambigu tetap review.

Cache provider menggunakan sistem, fingerprint anggota, basename, preferensi dan versi normalisasi yang sudah ada. Raw dan ZIP dengan anggota identik/nama sama dapat berbagi hasil normalisasi; sistem/fingerprint/nama berbeda tidak bercampur. Descriptor anggota **tidak dipercayai dari provider/cache/client**, melainkan dibuat ulang oleh identifier lokal sebelum lookup/cache. Job/candidate expired atau dari aset lain tetap tidak dapat diterapkan.

Nama manual pada NES/SNES/GBA/Mega Drive/PS1 tetap tersedia sesuai resolver, termasuk ZIP yang hash-nya ditolak. Untuk ZIP GB, worker terlebih dahulu memastikan satu anggota valid untuk menentukan GB/GBC; ZIP ambigu/rusak/7z/RAR GB tidak ditebak platformnya. Tidak menjanjikan fallback nama GB/GBC jika sistem belum dapat dipastikan. Penerapan manual ZIP GBC mempertahankan descriptor internal antar-generation sehingga kandidat tetap dapat dilihat dan diterapkan ulang secara eksplisit.

CAS, override admin, fence delete/disable/stop/generation, lease heartbeat dan cooldown tetap berlaku. Metadata candidate adalah state operasional, tidak menambah skema atau cakupan backup. **SQLite tetap 13**, backup skema lama, normalisasi antrean/cache dan restore tanpa scan otomatis tetap seperti M6.

## 4. Operasi, privasi dan packaging

- Konfigurasi enable/secret, kuota, egress tetap mengikuti [runbook M6](milestone-6-screenscraper-operasi.md). Update dependency dengan `npm ci`/rebuild image; tidak memasang `7z`/`unrar` atau binary platform tertentu.
- Windows/Linux memakai Node.js **24+**, worker threads dan zlib bawaan; backend Docker memakai `npm ci --omit=dev` dan `COPY server ./server` yang sudah mencakup identifier serta file worker. Image statis tidak menjalankan fitur. Docker/Linux aktual belum dieksekusi di lingkungan verifikasi ini.
- Admin melihat batas ZIP pada upload/review. Muncul `archive_limits`, `archive_invalid`, `archive_unsupported`, `archive_ambiguous` atau `identification_timeout`: jangan menaikkan batas parser untuk mengatasi file. Gunakan review nama jika platform pasti, atau upload raw legal sebagai **entri terpisah** jika memang diinginkan; jangan menganggap raw dan ZIP mempunyai saveIdentity sama.
- Untuk upload lama minta **Scan ulang** secara eksplisit; tidak ada scan massal startup/restore. Existing override tidak dibuka otomatis. Fitur yang sudah diaktifkan operator dapat memakai identifier baru setelah update; tidak ada flag per-codec tambahan.
- **Nama basename anggota, ukuran anggota, hash anggota dan sistem dapat dibagikan ke ScreenScraper**. Tidak mengirim byte ROM/BIOS/ZIP atau directory path anggota. Pencarian nama manual membagikan query admin. Jangan menaruh nama/hash privat pada laporan publik.
- Metadata disediakan oleh **[ScreenScraper](https://www.screenscraper.fr/)**; izin pribadi/nonkomersial LAN M0 tetap batas operasi, bukan izin distribusi ROM/cover atau layanan internet publik. Secret tidak dibaca/diubah agent, tidak masuk frontend atau backup.
- `npm audit --json` setelah pemasangan melaporkan **3 moderate** pada rantai existing `@fastify/static → glob → minimatch`, tidak pada yauzl/pend. Tidak menjalankan `npm audit fix` atau upgrade unrelated secara diam-diam. Audit bukan jaminan parser bebas kerentanan.

## 5. Bukti otomatis dan percobaan ulang

Semua request provider pada tes memakai transport tiruan. Fixture ZIP dibentuk deterministik di memori oleh `tests/helpers/metadata-zip.mjs`; payload sintetis/legal dan demo CC0, bukan dump komersial/capture akun.

| Command | Hasil aktual |
| --- | --- |
| `node --test tests/screenscraper-m7.test.mjs` | **61 lulus, 0 gagal/skip**, 7,9 detik |
| `npm test` | **507 lulus, 0 gagal/skip**, 42,1 detik (termasuk **62 tes M7**) |
| `npm run build` | **Lulus**, warning chunk frontend >500 kB yang sudah ada |
| `npm run test:e2e:backend -- metadata.spec.ts --output=test-results/m7-metadata-backend` | **14 lulus, 0 gagal/skip**, 1,4 menit |
| `npm run test:e2e -- --output=test-results/m7-static-dev` | **66 lulus, 107 skip, 0 gagal**, 2,3 menit |
| `npm run test:e2e:production -- --output=test-results/m7-static-production` | **66 lulus, 107 skip, 0 gagal**, 1,8 menit |
| `npm run test:e2e:backend -- --output=test-results/m7-full-backend` | **168 lulus, 0 gagal/skip/retry**, 13,8 menit |

Tambahan M7 mencakup 12 kombinasi stored/deflate × NES/SNES/GB/GBC/GBA/Mega Drive; interoperabilitas ZIP buatan Windows .NET `ZipArchive` yang dibuat independen dari helper tes; parser berbahaya/korup; bounded real output **64 MiB** dan penolakan 64 MiB + 1; CRC/size/stream consumption; asset hash; deadline/abort/handle ownership; cache key; zero provider pada local rejection; GB/GBC name/apply; known-platform fallback dan race edit/delete/disable/stop. PS1 besar diuji sebagai descriptor sintetis 768 MiB yang **tidak dibaca sama sekali**, bukan benchmark decoding disc atau bukti gameplay PS1.

Skip statis adalah skenario backend yang memang tidak dijalankan pada dev/preview statis, bukan bukti backend lulus. Lingkungan otomatis: Windows, **Node.js 26.12.1**, Edge headless, SQLite/backend nyata dan engine NES lokal; provider/media tiruan. Linux/Docker/HTTPS aktual, OS sandbox dan seluruh core tidak diklaim.

Percobaan awal tidak disembunyikan:

1. Putaran awal 51 tes: **31 lulus/20 gagal**, terutama `EBADF` saat ownership handle stream lintas worker, serta satu assertion memakai URL ROM redirect tanpa canonical basename. Stream worker diganti generator baca posisi eksplisit tanpa ownership/close fd; assertion memakai URL canonical dari DTO. Tidak menonaktifkan pemeriksaan atau mengabaikan close error. Putaran berikut **51/51 lulus**.
2. Setelah validasi compressed-stream ditambah, suite penuh awal **487 lulus/9 gagal** (496 total): opsi `decompress:false` yauzl juga diberikan ke stored, padahal opsi hanya sah untuk compressed entry. Cabang opsi disesuaikan per codec; tidak melonggarkan validasi CRC/ukuran. Tes tambahan menjadi 61 M7, lalu **506/506** suite penuh lulus.
3. Browser metadata pertama termasuk ZIP NES nyata **14/14 lulus**. Jangan menyamakan hasil ini dengan provider live atau gameplay seluruh platform.
4. Audit akhir mempertahankan fingerprint pencarian saat kandidat diterapkan manual (selain descriptor anggota), dan tes name ZIP GB memakai enqueue sungguhan, bukan mengubah request langsung. Recheck M5/M6/M7 **97/97 lulus**. Fixture .NET ditambahkan setelahnya untuk memeriksa interoperabilitas producer independen; putaran suite penuh final **507/507 lulus**.
5. Regresi backend penuh selesai **168/168 lulus**, tanpa skip/retry. Status sementara 159/168 dan 167/168 bukan hasil akhir atau kegagalan; tes terakhir autosave berlangsung 1,8 menit. Seluruh command pengujian M7 sudah selesai, tidak ada pengujian tambahan yang diperlukan untuk mencatat penutupan ini.

## 6. Gerbang verifikasi operator dan batas penutupan

Smoke provider ZIP asli **tidak dijalankan agent**, dan tidak dianggap tercakup oleh laporan manual M6 yang belum menyebut ZIP. Operator dapat memilih satu raw legal yang sudah diketahui provider, mengemas byte identik menjadi ZIP satu anggota tanpa transformasi, scan eksplisit setelah kuota sehat, lalu memeriksa metadata/override, boot, save dan cache. Raw dan ZIP tetap dua identitas upload berbeda; bandingkan hash pencarian, bukan mengharapkan save otomatis berpindah antara keduanya. Jangan membagikan secret, nama/hash privat atau respons provider mentah.

**M7 ditutup pada 2026-11-08** pada scope implementasi ZIP bounded + kebijakan/fallback seluruh format lain, berdasarkan bukti otomatis dan regresi akhir di atas. Ini bukan perluasan izin atau klaim keberhasilan provider per koleksi. Smoke ZIP live tetap verifikasi operator terpisah, bukan hasil manual yang diasumsikan sudah dilakukan. Pembuktian tingkat kecocokan koleksi/operator, executable disc, Linux/Docker/HTTPS nyata dan gameplay non-NES tidak diklaim. Tidak ada migrasi baru, perubahan identitas save/cache/ROM, aktivasi secret atau scan massal.
