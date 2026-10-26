# M8 — Backup, Restore, dan Operasi

Status: **M8 selesai untuk cakupan penggunaan lokal:** implementasi/verifikasi otomatis lulus, dan pengguna mengonfirmasi progres PS1 terbaca setelah restore backup instalasi. Bukti PS1 ini merupakan konfirmasi manual M8, bukan pengangkatan hasil M6/M7 atau klaim seluruh game/card/varian. **HTTPS belum diimplementasikan atau diuji** pada instalasi pengguna; penerapannya ditunda dan akses akun dari perangkat lain belum dinyatakan siap.

**Pembaruan 0.3.1:** tersedia opsi HTTP akun untuk LAN tepercaya melalui `MAIN_DULU_ALLOW_INSECURE_HTTP=true` dan origin HTTP eksplisit. Ini tidak mengenkripsi koneksi dan bukan bukti deployment HTTPS/LAN pengguna telah diuji. Panduan Docker terkini: [deploy backend](../deploy/README.backend.md).

**Pembaruan pengembangan Admin/Library/BIOS:** startup kini memakai skema **8**. Backup baru hanya diizinkan bila tabel game/BIOS dan direktori aset katalog kosong; termasuk tombstone/aset yatim akan memblokir backup. Verify/restore backup skema **7** tetap didukung secara eksplisit. Backup koleksi lengkap belum tersedia sampai Milestone 7 pada rencana katalog; lihat [fondasi katalog/storage](milestone-2-katalog-storage.md). Penomoran M8 dalam dokumen ini berasal dari rencana akun/save, bukan Milestone 7 katalog.

## Keputusan dan cakupan

- Administrasi lokal melalui CLI, bukan endpoint/web admin.
- Backup **offline**: sinkronkan progres, tutup player semua perangkat, lalu hentikan seluruh proses server/admin yang memakai data tersebut.
- Format folder + `manifest.json`; tanpa ZIP, enkripsi bawaan, penjadwalan, atau penghapusan otomatis.
- Restore ke **nama folder baru yang belum ada**, bukan merge/overwrite. Bahkan folder kosong yang sudah ada ditolak agar tidak mengganti tujuan yang salah.
- Sesi login dicabut pada **hasil restore**, tanpa mengubah backup asal atau akun/save.
- Skema tetap **6**; M8 tidak mengubah fingerprint engine, identitas game, format save, atau kebijakan kompatibilitas M5–M7.
- Backup seluruh instalasi ini berbeda dari cadangan konflik/impor M7 di disk server yang sama.

## Instalasi tanpa Docker

Gunakan Node.js **24+** dengan patch LTS terbaru; Windows adalah lingkungan yang diuji. Linux ditargetkan tetapi belum diuji langsung. Dari folder proyek:

```sh
npm ci
npm run build
npm start
```

Setelah dependensi/build tersedia, satu perintah `npm start` menjalankan frontend + API di **http://localhost:7777**. Tidak perlu database server terpisah atau unduhan engine dari CDN. Build tidak otomatis dijalankan saat start. Hentikan dengan Ctrl+C dan tunggu proses selesai.

Contoh konfigurasi PowerShell sebelum start atau menjalankan CLI admin:

```powershell
$env:MAIN_DULU_DATA_DIR = 'C:\maindulu-data'
$env:MAIN_DULU_PORT = '7777'
npm start
```

| Variabel | Default / kegunaan |
| --- | --- |
| `MAIN_DULU_DATA_DIR` | `data`; SQLite + blob privat, di luar `public/` dan `dist/` |
| `MAIN_DULU_DIST_DIR` | `dist`; hasil build frontend |
| `MAIN_DULU_HOST` | `127.0.0.1`; hanya komputer sendiri |
| `MAIN_DULU_PORT` | `7777`; web dan API satu port |
| `MAIN_DULU_PUBLIC_ORIGIN` | Tidak disetel; default origin HTTPS untuk akun jaringan; harus cocok dengan URL browser |
| `MAIN_DULU_ALLOW_INSECURE_HTTP` | `false`; opt-in HTTP LAN tepercaya, mewajibkan origin eksplisit |
| `MAIN_DULU_REGISTRATION_OPEN` | `true`; set `false` untuk menutup pendaftaran baru |
| `MAIN_DULU_STATE_MAX_BYTES` | 33.554.432 (32 MiB); maksimum state, maksimal konfigurasi 64 MiB |
| `MAIN_DULU_GAME_SAVE_MAX_BYTES` | 8.388.608 (8 MiB); maksimum paket progres |
| `MAIN_DULU_SAVE_QUOTA_BYTES` | 268.435.456 (256 MiB); gabungan aktif + cadangan per akun |

Path relatif konfigurasi backend dihitung dari akar proyek. Aplikasi tidak membaca `.env` backend secara otomatis; gunakan environment shell/process manager. Argumen path CLI backup/restore dihitung dari **direktori kerja terminal**; gunakan path absolut untuk operasi penting. Parent folder tujuan harus sudah ada dan dapat ditulis.

Parent folder sumber backup juga harus dapat ditulis untuk lock di sebelahnya saat verify/restore; isi backup sendiri tidak ditulis ulang. Untuk media read-only, salin seluruh backup ke lokasi privat lokal yang sesuai dahulu, lalu verifikasi salinan.

Frontend statis tetap memakai `npm run dev`, `npm run preview`, atau hosting `dist/` tanpa backend. `VITE_BACKEND_ENABLED=true` hanya opt-in untuk proxy same-origin yang sudah menyediakan API; bukan pengaktif server. Compose Nginx lama tetap **statis**, bukan deployment backend akun.

## Membuat dan memeriksa backup

1. Di semua perangkat, tunggu status penyimpanan dikonfirmasi. Unduh kandidat yang gagal/konflik. Perubahan yang hanya ada di memori player **tidak** masuk backup server.
2. Tutup seluruh player/tab aktif, hentikan server dan CLI reset admin. Jangan biarkan versi lama server yang tidak mengenal lock M8 tetap berjalan.
3. Pastikan `MAIN_DULU_DATA_DIR` menunjuk data yang benar. Jangan menggunakan data pengguna untuk percobaan.
4. Buat backup dengan **nama tujuan baru**, lalu verifikasi:

```powershell
$env:MAIN_DULU_DATA_DIR = 'C:\maindulu-data'
npm run data:backup -- 'D:\maindulu-backups\2026-10-25-sebelum-update'
npm run data:verify -- 'D:\maindulu-backups\2026-10-25-sebelum-update'
```

5. Salin **seluruh folder hasil backup** ke perangkat/lokasi lain, lalu jalankan `data:verify` pada salinan tersebut. Setelah CLI selesai, server boleh dinyalakan kembali dengan data asal.

Struktur hasil:

```text
backup/
├─ manifest.json
├─ maindulu.sqlite
├─ saves/          # state aktif dan blob cadangan state M7 yang direferensikan
└─ game-saves/     # progres aktif dan blob cadangan progres M7 yang direferensikan
```

Database mencakup seluruh akun/hash kredensial, sesi pada waktu backup, metadata save, slot Autosave 99, tombstone penghapusan, cadangan M7, receipt keputusan, dan identitas instalasi. Blob yang dipakai bersama aktif/cadangan disalin satu kali; file orphan/temp tidak ikut dan tidak dihapus dari sumber.

Manifest mencatat versi format, skema, versi aplikasi/Node, checksum `dist/player/builds.json` bila tersedia, jumlah record, checksum/ukuran setiap berkas, waktu, dan konfigurasi allowlist (host/port/origin/opsi HTTP/pendaftaran/batas/kuota). Tidak menyalin seluruh environment atau path data lokal. Metadata save tetap membawa fingerprint core/runtime aktual masing-masing. Opsi HTTP dicatat sejak 0.3.1; ketiadaan field konfigurasi ini pada backup dengan skema yang sesuai tetap didukung dan konfigurasi tidak diterapkan otomatis. Snapshot skema 7 juga mempertahankan role akun.

**Tidak termasuk:** ROM, BIOS, katalog/cover, kode aplikasi/build/engine, sertifikat HTTPS, konfigurasi process manager, rahasia environment lain, serta pengaturan/favorit/riwayat/progres browser tamu. Simpan distribusi aplikasi yang tepat dan konfigurasi deployment secara terpisah. `appVersion` saja bukan identitas semua perubahan pengembangan yang belum dirilis. Jangan mengganti ROM katalog atau ID game setelah restore lalu menganggap save pasti kompatibel.

### Konsistensi dan kegagalan

- Server/reset admin memakai lease shared; backup/verify/restore memakai lease eksklusif per folder. Restore juga mengecualikan instalasi `MAIN_DULU_DATA_DIR` yang saat itu dikonfigurasi, meskipun tujuan restore adalah folder baru lain. Beberapa koneksi server tetap dapat bekerja seperti M5–M7, tetapi maintenance ditolak selama ada koneksi terkait. Verifikasi backup terpisah boleh dilakukan saat server tidak memakai folder backup tersebut.
- SQLite memakai API backup resmi `node:sqlite`, termasuk halaman committed di WAL; snapshot diubah menjadi journal DELETE yang mandiri. Ini **bukan** salinan sembarang file SQLite aktif atau keharusan menghapus WAL/SHM sumber.
- Integritas SQLite dan foreign key dicek; seluruh referensi aktif/cadangan harus mempunyai blob dengan ukuran/SHA-256 yang cocok. Verifikasi bukan hanya checksum manifest.
- Staging privat `.nama.partial-*` dibuat di parent tujuan, file di-flush, direktori di-fsync pada platform yang mendukungnya, lalu dipublikasikan lewat rename. Fsync direktori tidak dilakukan pada Windows. Uji kegagalan bukan simulasi pemadaman listrik atau jaminan hardware/filesystem.
- Jika sumber rusak, tujuan terisi, atau I/O gagal, operasi gagal dengan exit code nonzero. Data lama tidak ditimpa. Kegagalan normal membersihkan staging milik operasi; crash/kill dapat meninggalkan staging yang **bukan backup selesai**.
- Jika rename berhasil tetapi flush parent gagal, folder tujuan bisa sudah ada meskipun CLI gagal. Jangan menimpanya atau langsung menghapusnya; jalankan verifikasi/inspeksi dan pilih nama baru untuk retry. Ini bukan jaminan durabilitas setelah listrik padam.
- Sumber backup harus tepercaya dan tidak diubah selama CLI bekerja. Isi symlink/junction, hard link, file khusus, path traversal, file ekstra, WAL/SHM, dan manifest/versi yang tidak dikenal ditolak. Pemeriksaan canonical path juga mencegah tujuan melewati alias folder publik.
- Lock hanya mengoordinasikan aplikasi/CLI M8 pada **satu komputer dan filesystem lokal**. Bukan distributed lock untuk folder jaringan, bukan penghalang administrator OS yang mengedit file langsung, dan tidak mengenali proses versi lama/tool SQLite eksternal. Hentikan semuanya sendiri sebelum maintenance.

## Restore ke data bersih

1. Tutup semua player/browser yang memakai instalasi lama dan hentikan server/admin. Jika data lama masih dapat dibaca, buat backup terpisah dahulu. Jangan hapus data lama.
2. Siapkan versi aplikasi/engine yang sesuai dengan backup. Verify/restore CLI pengembangan terbaru menerima format backup 1 dengan skema **7**, atau skema **8** dengan katalog kosong; rilis 0.3.1 menerima skema **6**. Pembuatan backup baru mensyaratkan skema 8 dengan katalog/aset kosong. CLI tidak memigrasikan sumber atau memaksa downgrade. Untuk backup skema 6, verifikasi/restore dengan aplikasi lama terlebih dahulu, kemudian buka hasil restore memakai server baru untuk migrasi. Simpan distribusi yang sesuai; jangan ubah nomor skema/manifest manual.
3. Verifikasi lalu restore ke **folder yang belum ada**:

```powershell
npm run data:verify -- 'D:\maindulu-backups\2026-10-25-sebelum-update'
npm run data:restore -- 'D:\maindulu-backups\2026-10-25-sebelum-update' --to 'C:\maindulu-data-pulih'
```

4. Hasil restore telah diverifikasi kembali, dengan tabel sesi dikosongkan. Backup asal tidak diubah. Tidak ada merge akun/save dari dua instalasi.
5. Tinjau `manifest.json` untuk konfigurasi lama. CLI **tidak menerapkannya otomatis**: pilih port/origin/pendaftaran/kuota yang benar. Jangan memublikasikan manifest atau SQLite.
6. Arahkan server ke hasil restore:

```powershell
$env:MAIN_DULU_DATA_DIR = 'C:\maindulu-data-pulih'
npm start
```

7. Buka sesi/browser baru, login ulang, pilih ROM/BIOS yang sama, lalu periksa akun, slot, cadangan M7, dan kuota. Untuk progres gunakan Continue/Load dalam game tanpa memuat state. Uji Muat state secara terpisah; jangan hanya mengandalkan pesan RPC.
8. Setelah hasil benar, lanjutkan dengan data baru. Data lama tetap disimpan terpisah sampai pemulihan diterima. Jangan menjalankan dua salinan instalasi sebagai server aktif yang saling bergantian untuk browser yang sama.

**Efek rollback:** password dan hash kode pemulihan kembali ke waktu backup. Password baru sesudah backup mungkin tidak berlaku; kode sekali pakai yang pernah dipakai sesudah backup dapat kembali berlaku. Penghapusan/save setelah backup juga kembali ke kondisi snapshot. Reset password/terbitkan kode baru bila ada risiko, dan serahkan kode secara privat. Sesi backup dicabut, tetapi browser harus menutup player/antrean lama dan login ulang; jangan mencoba melanjutkan antrean lama terhadap revisi server yang sudah mundur.

### Lock tertinggal dan staging

Lock ada di **sebelah** folder terkait: misalnya `C:\.maindulu-data.maindulu-lock\`. Folder lock kosong boleh tetap ada dan tidak termasuk backup. Lease mempunyai PID lokal dan mode shared/exclusive; lease dari PID yang terbukti sudah tidak ada dibersihkan saat percobaan berikutnya. PID yang masih hidup/terpakai ulang, izin pemeriksaan yang ditolak, lease rusak, atau gate tertinggal ditangani konservatif: tidak dianggap aman untuk dilewati.

Pada Linux/Docker, lease juga mencatat namespace PID/hostname. Pemeriksaan PID untuk pembersihan otomatis hanya berlaku pada namespace yang sama; lease namespace lain atau format Linux lama ditolak karena tidak dapat dibuktikan mati dari container sekarang. Crash container lama dapat meninggalkan lease di named volume yang tetap terbawa saat recreate. Setelah semua pemilik dipastikan berhenti, karantina folder lock yang tepat tanpa menyentuh database/blob. Contoh perintah Docker tersedia di [panduan pemulihan lock backend](../deploy/README.backend.md#lock-tertinggal-dari-container-lama).

Jika muncul pesan lock sibuk/rusak:

1. Pastikan semua server/admin/backup/verify/restore pada folder itu sudah berhenti; cocokkan PID di lease/gate lewat pengelola proses OS. Jangan mencetak kredensial/database.
2. Hanya setelah tidak ada operasi aktif, pindahkan folder lock yang tepat ke nama karantina untuk pemeriksaan, lalu retry. **Jangan hapus lock hidup**, jangan menghapus WAL/SHM, dan jangan memakai reset database sebagai jalan keluar.
3. Setelah memastikan proses staging sudah berhenti, inspeksi/pindahkan hanya `.partial-*` milik operasi gagal yang tepat. Jangan menyamakannya dengan hasil backup yang telah diverifikasi.

## Pembaruan aplikasi dan reset admin

1. Sinkronkan/tutup player; hentikan proses dan buat backup offline terverifikasi.
2. Simpan versi/distribusi aplikasi/engine lama dan konfigurasi deployment di luar backup data. Ambil versi baru, jalankan `npm ci`, lalu `npm run build`.
3. Jalankan `npm start` dengan folder data yang sama. Migrasi startup bersifat transaksional; jangan menghapus SQLite atau memaksa aplikasi lama membuka skema lebih baru.
4. Uji login dan pemulihan save pada sesi baru. Jika perlu rollback, hentikan aplikasi baru dan restore backup ke folder baru memakai versi yang sesuai—bukan downgrade database aktif.

Reset admin tetap:

```sh
npm run account:reset -- <username>
```

Set folder data yang benar, verifikasi pemilik akun di luar aplikasi, dan isi password melalui terminal tersembunyi (bukan argumen/redirect). ID/kepemilikan save tetap, sesi serta kode lama dibatalkan. Serahkan kode baru secara privat. Reset admin boleh memakai data server berjalan seperti sebelumnya, tetapi tidak boleh bersamaan dengan maintenance eksklusif. Lihat [prosedur M4](milestone-4-pemulihan-akun.md#bantuan-admin-lokal-jika-kode-hilang).

## Akses perangkat lain dan HTTPS

`localhost` pada HP berarti HP itu sendiri, bukan PC server. PC harus tetap menyala, tidak sleep, dan dapat dijangkau firewall/jaringan. Backend Node default hanya bind loopback. Akun dari HTTP IP LAN **ditolak secara default**, walaupun gameplay tamu pada origin HTTP dapat bekerja.

Untuk akun jaringan, gunakan reverse proxy HTTPS **same-origin** ke Node loopback; set `MAIN_DULU_PUBLIC_ORIGIN` ke origin HTTPS yang tepat (tanpa path). Proxy harus mempertahankan header `Host` publik dan meneruskan semua path/API/body biner, bukan menulis ulang kegagalan API menjadi HTML. Cookie menjadi Secure. Jangan hanya mengganti bind ke `0.0.0.0` lalu mengirim password lewat HTTP.

Pengecualian LAN tanpa TLS sejak 0.3.1 memerlukan persetujuan risiko eksplisit: `MAIN_DULU_ALLOW_INSECURE_HTTP=true` dan misalnya `MAIN_DULU_PUBLIC_ORIGIN=http://192.168.2.251:7777`. Flag saja tidak mengizinkan Host sembarang. Password, kode pemulihan, cookie dan save tidak terenkripsi; gunakan password khusus, batasi firewall ke LAN tepercaya dan jangan membuka port ke internet. Tidak ada pembatasan subnet otomatis. HTTPS tetap rekomendasi; untuk Compose dan perpindahan ke HTTPS lihat [panduan backend](../deploy/README.backend.md).

Contoh konseptual Caddy lokal (bukan hasil uji deployment M8):

```text
maindulu.home.arpa {
  tls internal
  reverse_proxy 127.0.0.1:7777
}
```

```powershell
$env:MAIN_DULU_HOST = '127.0.0.1'
$env:MAIN_DULU_PUBLIC_ORIGIN = 'https://maindulu.home.arpa'
npm start
```

Nama tersebut harus diarahkan ke IP server lewat DNS/hosts, dan CA lokal harus dipercaya pada **setiap perangkat**. Jangan mematikan validasi sertifikat/pengamanan browser. Untuk domain publik, gunakan sertifikat valid dan konfigurasi firewall/proxy yang sesuai; panduan ini tidak menyiapkan layanan publik/otomatisasi sertifikat. Perubahan HTTP/HTTPS, hostname/IP, atau port memisahkan storage tamu; gunakan ekspor/impor eksplisit M7, bukan menganggap save browser berpindah otomatis.

## Privasi dan retensi

Backup berisi data semua akun dan hash kredensial: **sensitif**, meskipun password/kode mentah tidak disimpan. SHA-256 mendeteksi kerusakan, **bukan autentikasi atau enkripsi**. Hanya gunakan backup tepercaya; orang yang menguasai backup dapat mencoba membobol hash secara offline. Batasi ACL folder pada Windows (mode POSIX tidak menggantikan ACL), gunakan media/enkripsi OS yang sesuai, dan jangan menaruhnya di Git, `public/`, `dist/`, atau share terbuka.

Tidak ada pruning otomatis. Operator bertanggung jawab memeriksa ruang disk, menyimpan beberapa generasi terverifikasi, menyalin ke perangkat/lokasi lain, serta menjalankan latihan restore berkala. File/volume di komputer yang sama tidak melindungi dari kerusakan komputer atau kehilangan perangkat.

## Matriks bukti dan batas dukungan

| Core/varian | Bukti sebelumnya | Bukti M8 |
| --- | --- | --- |
| NES fceumm legacy | State M5, SRAM M6, konflik/impor M7 otomatis | Backup instalasi → folder bersih → login baru → SRAM sebelum boot dan load state melalui engine nyata |
| NES normal | Aset/fingerprint dibundel; bukan bukti gameplay server | Belum diverifikasi gameplay M8 |
| PS1 pcsx_rearmed | M1/M6/M7 dikonfirmasi manual pengguna dengan batas cakupan masing-masing | Pengguna mengonfirmasi progres terbaca setelah restore instalasi pada M8; manual, rincian konfigurasi belum dicatat |
| SNES, GB/GBC, GBA, Mega Drive | Core dibundel, belum ada adapter sinkronisasi M6 terverifikasi | Tidak dinyatakan mendukung sinkronisasi progres akun; ekspor/cadangkan sebelum keluar |

### Hasil manual PS1 M8 — pengguna

- [x] Pengguna menyatakan tes PS1 normal dan mengonfirmasi progres terbaca setelah restore backup instalasi, lalu meminta pembaruan dokumen serta commit/push penutupan M8.

Konfirmasi ini diterima untuk penutupan M8 lokal. Ini bukan tes otomatis PS1 dan tidak membuktikan semua card/slot/varian, state PS1, atau seluruh aksi cadangan M7 satu per satu. Game/region/hash, sumber ROM, BIOS/HLE, browser/perangkat, core/varian/fingerprint, serta card/slot belum dirinci. Jangan mengirim ROM/BIOS/kredensial.

Checklist berikut untuk pencatatan/pengujian tambahan. Item belum dicentang bukan pembatalan hasil manual berhasil di atas dan tidak dianggap sudah dikonfirmasi satu per satu:

- [ ] Catat game/region/hash, sumber ROM, BIOS/HLE, browser/perangkat, core/varian/fingerprint, card/slot.
- [ ] Simpan progres dalam game, tunggu konfirmasi server, tutup semua player, backup/verifikasi.
- [ ] Restore ke folder baru, jalankan server pada data hasil restore, login ulang pada browser baru.
- [ ] Pilih ROM/BIOS sesuai dan periksa Continue/Load **tanpa** memuat state M5.
- [ ] Uji state dan cadangan M7 secara terpisah jika tersedia; pertahankan sumber/backup.
- [ ] Catat hasil aktual. Jangan menggeneralisasi ke semua card/slot/varian atau multi-disk.

### HTTPS ditunda, bukan dinyatakan lulus

Pengguna belum mengimplementasikan HTTPS sehingga belum mengujinya. Ini tidak menghalangi penutupan M8 untuk penggunaan lokal melalui localhost. Untuk akses jaringan aman/default, HTTPS tetap harus diterapkan dan diuji: sertifikat dipercaya pada perangkat lain, login/Secure cookie, upload/download state/progres, pemulihan sesi, dan batas proxy. Pengecualian HTTP LAN 0.3.1 tidak membuktikan HTTPS atau menghilangkan risiko penyadapan. Pengujian Origin/cookie otomatis bukan bukti pemasangan reverse proxy nyata; contoh Caddy di atas bukan implementasi aktif atau penerimaan jaringan.

## Verifikasi otomatis

Perintah: `npm test`, `npm run build`, `node --check public/player/player.js`, `npm run test:e2e:backend`, `npm run test:e2e`, `npm run test:e2e:production`. Build mendahului browser backend/production. Suite memakai data temporer, bukan folder pengguna.

`tests/data-backup.test.mjs` membuktikan restore akun/state/progres/Autosave/tombstone/cadangan/receipt, kuota, cookie lama ditolak, committed WAL, restart, lease lintas proses, lease proses mati/rusak, konflik maintenance, kegagalan publikasi, sumber rusak/hilang, manifest/path/link tidak aman, serta CLI nyata. `tests/browser/server-game-saves.spec.ts` menambah skenario M8 NES engine nyata dengan folder restore bersih dan browser baru; klik toolbar di tes M8 menggunakan DOM event asli untuk menghindari bar auto-hide, tanpa mock bridge/save/API.

Lingkungan: Windows, Node.js **26.12.1**, Microsoft Edge headless; jalur CLI/database/admin juga diuji pada Node.js **24.22.1**.

| Pemeriksaan | Hasil |
| --- | --- |
| `npm test` pada revisi akhir | **109 lulus**, termasuk 9 tes M8 |
| `npm run build` | Lulus |
| Sintaks bridge `public/player/player.js` dan modul backup | Lulus |
| TypeScript ketat suite `server-game-saves.spec.ts` | Lulus |
| Browser backend penuh | **46 lulus**; sebelum tambahan guard restore untuk instalasi yang sedang dikonfigurasi |
| M8 browser terarah setelah guard terakhir | **1 lulus**, termasuk restore SRAM/state engine nyata, folder bersih dan browser baru |
| Browser statis development | **22 lulus**, 29 skenario akun/server sengaja dilewati |
| Browser statis production, setelah build selesai | **22 lulus**, 29 skenario akun/server sengaja dilewati |
| `data-backup` + `server` + `admin` pada Node.js 24.22.1 | **23 lulus** pada revisi akhir |
| PS1 setelah restore instalasi | Pengguna mengonfirmasi progres terbaca; lulus manual dalam cakupan pengguna, rincian konfigurasi belum dicatat |
| HTTPS reverse proxy nyata | Belum diimplementasikan/diuji oleh pengguna; ditunda, bukan hasil lulus |

Suite penuh backend memeriksa kembali akun, pemulihan, tamu, state, SRAM, konflik/impor, kuota, dan kegagalan backend. Guard terakhir menolak restore ke folder lain ketika instalasi yang dikonfigurasi masih aktif; sesudah penambahan itu unit/integrasi penuh, jalur Node 24, dan tes M8 engine nyata diulang. Suite statis sengaja melewati akun/server, bukan bukti backend berfungsi di hosting statis. Angka tabel berasal dari eksekusi selesai yang lulus; percobaan awal helper toolbar yang tidak membuka overlay tidak dihitung sebagai kelulusan. Pengujian otomatis menggunakan data temporer, bukan data pengguna nyata; verifikasi manual PS1 dilakukan sendiri oleh pengguna setelah implementasi.

Saat penutupan setelah konfirmasi manual pengguna, `npm test` diperiksa ulang (**109 lulus**) dan `npm run build` lulus. Pembaruan penerimaan ini hanya mengubah dokumentasi dan pengecualian backup privat dari Git, bukan kode runtime. Suite browser pada tabel berasal dari verifikasi implementasi M8 sebelumnya dan tidak diulang untuk pembaruan dokumentasi saja.

### Pemetaan kriteria selesai

- Web+API tanpa Docker, tamu/statis, akun lokal/pemulihan/admin: regresi otomatis lulus.
- Penyimpanan setelah restart dan pemulihan backup: API lintas akun/jenis save, byte/checksum, revisi, cadangan, receipt, serta gameplay NES dibuktikan.
- Gangguan sinkronisasi tidak menimpa diam-diam dan ROM/BIOS lokal tidak menjadi payload sinkronisasi: regresi M5–M7 serta tamu lulus; bukan pemindai semua byte opaque.
- Pembatasan core/kompatibilitas tetap berlaku. PS1 M8 diterima berdasarkan konfirmasi manual pengguna di atas; rincian tambahan tidak digeneralisasi. HTTPS belum diimplementasikan/diuji dan ditunda di luar penutupan lokal ini. Tidak ada klaim pemadaman listrik, Linux, semua core/card/slot, atau kesiapan akun jaringan/publik dari hasil tersebut.

M8 ditutup untuk cakupan lokal berdasarkan bukti otomatis dan konfirmasi manual PS1 tersebut. Ini bukan pernyataan bahwa seluruh konfigurasi/core atau akun dari perangkat lain sudah siap digunakan tanpa penerapan HTTPS dan pengujian tambahan.
