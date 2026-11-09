# Docker backend maindulu 0.5.0

Frontend + API akun/save disajikan oleh **satu server Node.js 24**, bukan Nginx. SQLite, state, progres game, dan cadangan konflik disimpan pada named volume privat. Tidak perlu Node/npm atau database terpisah di host.

> **HTTP LAN adalah pilihan berisiko, bukan HTTPS.** Password, kode pemulihan, cookie sesi, dan save dapat disadap/diubah di perjalanan. Gunakan hanya pada jaringan tepercaya, jangan gunakan password layanan lain, dan jangan membuka port HTTP ini ke internet. Pemeriksaan origin/CSRF tidak mengenkripsi koneksi dan tidak mencegah penyadapan. Mode ini tidak membatasi subnet otomatis; operator harus mengatur firewall.

## 1. Prasyarat

- Docker Engine + plugin Compose v2 di Linux/LXC, atau Docker Desktop dengan Linux containers (Windows: WSL2).
- `docker info` dan `docker compose version` berhasil. Untuk LXC, Docker harus sudah diizinkan oleh konfigurasi host virtualisasi.
- Salinan repo lengkap, termasuk `public/vendor/`. Jalankan perintah dari **akar repo**, misalnya `/opt/maindulu`.
- Pilih satu deployment pada port 7777: statis **atau** backend. Jangan jalankan keduanya pada port host yang sama.

## 2. Pilih cara akses

| Mode | Bind host | Origin akun | Opsi HTTP |
| --- | --- | --- | --- |
| Localhost (default) | `127.0.0.1` | Tidak disetel | `false` |
| LAN HTTP (opt-in) | `0.0.0.0` atau IP LAN server | `http://IP-SERVER:7777` | **`true`** |
| HTTPS reverse proxy | `127.0.0.1` untuk proxy di host | `https://main.example.com` | `false` |

### A. Localhost, tanpa konfigurasi

```sh
docker compose -f deploy/docker-compose.backend.yml up -d --build
```

Buka **http://localhost:7777 pada server sendiri**. `localhost` pada PC/HP lain menunjuk perangkat tersebut, bukan server. Default sengaja tidak membuka akun ke jaringan.

### B. LAN HTTP, tanpa domain/sertifikat

Contoh server: **192.168.2.251**, port **7777**. Gunakan IP tetap/reservasi DHCP.

Salin contoh (hanya jika file tujuan belum ada; jangan timpa konfigurasi sendiri):

```sh
cp deploy/backend.env.example .env.backend
```

Edit `.env.backend` di akar repo:

```dotenv
MAIN_DULU_BIND_ADDRESS=0.0.0.0
MAIN_DULU_PORT=7777
MAIN_DULU_PUBLIC_ORIGIN=http://192.168.2.251:7777
MAIN_DULU_ALLOW_INSECURE_HTTP=true
MAIN_DULU_REGISTRATION_OPEN=true
```

Kemudian:

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml config --quiet
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d --build
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml ps
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml logs --tail=50 backend
```

Buka **http://192.168.2.251:7777** dari PC/HP lain. Tidak perlu Nginx, sertifikat, atau pengaturan keamanan browser. Pilih **Masuk → Daftar**, simpan kode pemulihan, lalu login sebelum membuka game agar sesi memakai save server. Game tamu tetap memakai browser.

`PORTS` harus menampilkan `0.0.0.0:7777->7777/tcp` (atau IP bind yang dipilih). Izinkan TCP 7777 hanya dari LAN tepercaya pada firewall LXC/host/Proxmox; jangan mengaktifkan port forwarding router. Bind `0.0.0.0` mencakup semua interface IPv4, bukan hanya LAN.

**Penting tentang environment:**

- Gunakan `--env-file .env.backend` pada **semua** perintah contoh berikut jika memilih mode ini. Contoh operasi di bawah memakai opsi tersebut; pengguna localhost dapat menghilangkannya.
- `.env.backend` bukan otomatis dibaca Node maupun Compose tanpa opsi itu. Shell environment yang sudah diekspor mengalahkan nilai env-file. Gunakan `config --quiet` untuk validasi; `config` tanpa opsi, `inspect`, dan dump environment dapat menampilkan secret ScreenScraper. Jangan bagikan hasilnya.
- `MAIN_DULU_PUBLIC_ORIGIN` harus sama dengan URL browser: skema, hostname/IP, dan port. Tanpa path/query/kredensial. Dengan origin LAN, API akun lewat `localhost` yang berbeda akan ditolak; healthcheck `/api/health` tetap bekerja.
- Mengganti IP/port berarti memperbarui origin dan URL browser sekaligus. Data akun/save server tetap pada volume, tetapi storage tamu terpisah per origin.
- Mengaktifkan flag HTTP **tanpa origin eksplisit** membuat startup gagal. Flag default tetap `false`; HTTPS tetap memakai cookie `Secure` walaupun flag keliru dibiarkan `true`.
- Setelah mengubah env runtime backend, gunakan `up -d --force-recreate`, bukan hanya `restart`. Tidak perlu build ulang untuk perubahan runtime ini; opsi frontend **build-time** pada bagian cache di bawah berbeda dan memerlukan rebuild.

### C. Beralih ke HTTPS nanti

Pasang reverse proxy dan sertifikat yang dipercaya perangkat lebih dahulu. Contoh env untuk proxy pada host Docker:

```dotenv
MAIN_DULU_BIND_ADDRESS=127.0.0.1
MAIN_DULU_PORT=7777
MAIN_DULU_PUBLIC_ORIGIN=https://main.example.com
MAIN_DULU_ALLOW_INSECURE_HTTP=false
```

Proxy meneruskan seluruh path ke `http://127.0.0.1:7777`, mempertahankan **Host publik beserta port bila nonstandar** (Nginx: `proxy_set_header Host $http_host;`), dan menerima body biner sampai batas state yang dikonfigurasi. Jangan mengubah error API menjadi HTML. Jika proxy di container lain, gunakan jaringan Docker bersama, bukan `127.0.0.1` container proxy.

Untuk API upload katalog pengembangan, lihat [batas multipart, buffering, timeout, dan contoh location proxy](../doc/milestone-3-api-katalog.md#reverse-proxy). API akun/save tetap memakai limit sendiri; jangan mengekspos volume data melalui Nginx.

Pertahankan kebijakan cache backend: respons ROM/BIOS upload yang valid (`/games/:id/rom/:filename`, `/bios/:id/:filename`) memakai `Cache-Control: private, no-cache` dan ETag SHA-256; browser boleh menyimpan lalu memvalidasi ulang, termasuk setelah restart jika disk cache tersedia. Jangan menimpa respons ini dengan `no-store`, membuang ETag/`If-None-Match`, mengabaikan `private`, atau melayani shared cache tanpa validasi origin. API akun/save/metadata, cover, redirect ROM, serta error tetap `no-store`. Jika proxy mengubah representasi, pastikan validator tetap benar. Kebijakan ini tidak mengubah aset statis/bawaan; bukan mode offline atau penyimpanan ROM permanen. Lihat [hasil pengujian dan batas cache](../doc/rencana-cache-rom-bios.md#hasil-implementasi-dan-verifikasi); tes browser loopback tersebut tidak membuktikan konfigurasi proxy/HTTPS nyata.

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d --force-recreate
```

Variabel `https://...` saja **tidak** mengaktifkan TLS pada server Node. Compose ini tidak memasang proxy/sertifikat. HTTP LAN bukan pengganti HTTPS untuk deployment publik.

### Metadata ScreenScraper (M6, opt-in pribadi/LAN)

Fitur default nonaktif. Isi `MAIN_DULU_SCREENSCRAPER_ENABLED`, `DEV_ID`, `DEV_PASSWORD`, `USER`, `PASSWORD`, dan `SOFTNAME` dengan prefix `MAIN_DULU_SCREENSCRAPER_` melalui environment runtime/secret operator. Contoh nama tersedia di `backend.env.example`; jangan menaruh nilai secret di Dockerfile, build arg, variabel `VITE_`, repository, atau backup. Node `npm start` membaca `.env`; Compose memakai `--env-file .env.backend`. File probe `.env.screenscraper.local` tidak otomatis mengonfigurasi backend.

Compose meneruskan secret saat runtime, bukan saat build. Sesudah mengubah enable/secret, jalankan `up -d --force-recreate` dengan env-file yang sama, **tanpa** menghapus volume. Volume `storage` tetap menyimpan database, antrean, ROM/BIOS/cover dan save. Worker satu proses backend; tidak perlu Redis/layanan worker tambahan. Izinkan DNS dan egress TCP 443 ke `api.screenscraper.fr`; media memakai endpoint tetap pada host yang sama, alamat IPv4 publik tervalidasi/pinned, tanpa redirect. Jangan menonaktifkan verifikasi TLS atau mengizinkan URL media arbitrer.

Periksa `GET /api/admin/metadata/status` memakai sesi admin, lalu coba satu upload legal sebelum beberapa upload terbatas. Health backend tidak bergantung pada provider. Untuk berhenti: ubah enable menjadi `false`, recreate, lalu pastikan worker disabled; metadata/game/save yang sudah ada tetap tersedia. Jangan gunakan `docker compose down -v` sebagai rollback.

Runbook lengkap (kuota, retry, shutdown/lease, backup/restore, rollback skema 13, batas format, privasi/atribusi) dan bukti penutupan: [M6 ScreenScraper](../doc/milestone-6-screenscraper-operasi.md). Verifikasi Docker/HTTPS nyata tidak diasumsikan dari tes Node/konfigurasi.

### CHD PS1 Serial Auto-apply (M7 lanjutan, opt-in)

Dengan ScreenScraper aktif, upload CHD `.chd` polos pada console `psx` membaca **serial disc** lewat `rom-converto v0.24.0` (pinned, SHA-256 terverifikasi) dan mengirimnya ke ScreenScraper sebagai `serialnum` + `systemeid=57` tanpa hash/ukuran ROM. Auto-apply hanya jika provider mengembalikan **tepat satu kandidat** yang terkonfirmasi game PS1 (`notGame=false`, system match, multi-support `totalSupports=1` bila ada). Jika tidak, hasil `needs_review` tanpa mengubah metadata. Kill switch `MAIN_DULU_CHD_SERIAL_AUTOAPPLY=false` menonaktifkan auto-apply sambil mempertahankan lookup. Field yang dikunci admin selalu dihormati; provenance `match_method = 'serial'` dicatat di `game_metadata`. Binary vendor Alpine musl otomatis dipasang saat build image; operator dapat override dengan `MAIN_DULU_ROM_CONVERTO_PATH`. Dokumentasi privasi: **serial disc dikirim ke ScreenScraper, bukan byte ROM**. [Rancangan lengkap](../doc/rencana-chd-serial-screenscraper.md).

M7 menambah identifikasi ZIP32 satu ROM raw (stored/deflate) melalui worker thread Node.js 24+, **yauzl 3.4.0 terpin**, dan zlib bawaan; tanpa `7z`/`unrar`, executable atau temporary extraction. Jalankan `npm ci`/rebuild image agar dependency dan file worker ikut terpasang; `COPY server ./server` dan dependency produksi yang ada sudah mencakupnya. Batas scan ZIP: arsip 128 MiB, output 64 MiB, rasio 100:1, 64 entri, deadline 30 detik. Upload tetap 768 MiB dan byte aset/save tidak diubah. 7z/RAR/PS1 tetap review; nama/ukuran/hash **anggota ZIP** dapat dibagikan ke provider. Tidak ada env tuning tambahan atau aktivasi otomatis pada secret operator. [Policy resource, error dan batas verifikasi M7](../doc/milestone-7-screenscraper-identifikasi.md).

### Cache perangkat ROM/BIOS (IndexedDB)

Fitur ini berjalan **di frontend/profil browser**, bukan cache pada server. Tidak perlu Redis, volume cache Docker, atau `.env` baru untuk pemakaian normal. **Default aktif** untuk database/profil baru (M6 rollout); database lama mempertahankan preferensinya, termasuk yang nonaktif. Pengguna dapat mengaktifkan/menonaktifkan melalui **Pengaturan → Cache ROM/BIOS perangkat**. Hanya upload backend dengan descriptor lengkap yang eligible; file lokal/demo/engine tidak ikut disimpan.

Server tetap diperiksa pada setiap peluncuran. Hit IndexedDB terverifikasi tidak membuat GET aset; miss melakukan satu download/verifikasi dan baru menyatakan **Tersimpan di perangkat** setelah commit. Fetch pipeline IndexedDB memakai `no-store`; ini **bukan** instruksi mengubah header backend/proxy `private, no-cache` di atas. Gagal kuota/storage dapat dimainkan tanpa disimpan, tetapi error sumber/hash tidak dibypass.

IndexedDB bekerja pada HTTP LAN tepercaya tanpa persistence API; budget awal 2 GiB bukan jaminan kuota/RAM. Penyimpanan dibagi semua akun dalam origin/profil, tidak terenkripsi/permanen/offline, dan logout tidak menghapusnya. Rebuild/restart/recreate backend tidak memindahkan DB browser. Domain/IP, port, skema, atau profil baru memakai storage lain; volume Docker tetap menyimpan aset sumber/save server seperti biasa.

Gunakan daftar/hapus satu/semua di Pengaturan untuk menghapus **hanya** cache, bukan save/progres. DevTools: **Application → IndexedDB → `maindulu-asset-cache`**; hanya `entries` committed yang siap, bukan `chunks`/`staging` tersendiri. Jangan membersihkan seluruh data origin sebagai prosedur rutin.

Proxy wajib mempertahankan strong ETag SHA-256 dan Content-Length untuk respons file penuh, HEAD segar, serta 404/410/5xx asli. Jangan mengganti error dengan HTML, memakai static alias ke volume data, atau menyajikan cache tanpa pemeriksaan origin. Untuk jalur ini sebaiknya tidak mengompresi/mengubah representasi ROM/BIOS; perubahan harus diuji terhadap validator dan bytes aktual. Akun/save tetap mengikuti kebijakan privat/no-store masing-masing.

Rem darurat opsional **build-time**: `VITE_ASSET_CACHE_DISABLED=true`. Compose meneruskannya hanya sebagai build argument, bukan runtime environment backend. Contoh dengan env-file yang sama seperti deployment:

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml build --build-arg VITE_ASSET_CACHE_DISABLED=true backend
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d --no-build backend
```

Build ini mengabaikan penggunaan/pengisian cache walaupun preferensi lama aktif, menampilkan alasannya, dan tetap menyediakan daftar/hapus. Tidak menghapus DB atau mengubah preferensi. Untuk memulihkan, build dengan `--build-arg VITE_ASSET_CACHE_DISABLED=false`, lalu `up -d --no-build`; pilihan pengguna sebelumnya kembali berlaku. Mengubah env runtime atau `restart` saja **tidak** mengganti frontend yang telah dibundel. Tidak perlu menambah variabel ini ke `.env.backend` normal. Tutup sesi player, lalu reload halaman setelah deployment.

**M6 cache selesai untuk penggunaan lokal/HTTP LAN.** [Runbook dan matriks verifikasi M6](../doc/milestone-6-cache-indexeddb-rollout.md) memisahkan bukti otomatis Node/LAN dari konfirmasi pengguna bahwa Docker backend sudah diuji di mesin lain dan skenario manual CHD besar legal beserta progres lama lulus. Rincian lingkungan/log manual belum dilampirkan; tidak ada klaim seluruh distro Linux, game, firmware, atau perangkat. Uji sintetis 500 MiB tetap bukti transport, bukan gameplay CHD.

HTTPS reverse proxy **dilewati/ditunda atas keputusan pengguna** karena belum diperlukan, bukan dinyatakan lulus. Uji TLS/proxy dan kontrak header/error di atas tetap diperlukan sebelum cakupan HTTPS/deployment publik digunakan. Kebijakan keamanan akun tidak berubah; HTTP hanya untuk LAN tepercaya, bukan internet.

## 3. Build image untuk Portainer (opsional)

Jika ingin upload image ke Portainer sebagai file, build dari **root project** dengan Dockerfile backend:

```sh
cd "D:\side project\maindulu"
docker build -f deploy/Dockerfile.backend -t maindulu-backend .
docker save -o maindulu-backend.tar maindulu-backend
```

File `maindulu-backend.tar` siap diupload ke Portainer (Images → Import). Pastikan Docker Desktop berjalan sebelum build.

Bersihkan cache/temp setelah berhasil:

```sh
docker builder prune -f
```

Opsional, hapus image lokal yang sudah disimpan (karena sudah ada di `.tar`):

```sh
docker rmi maindulu-backend
```

Jangan hapus volume data (`/var/lib/maindulu`) agar akun/save tetap.

## 3. Build, mulai, berhenti, dan log

```sh
# Build/rebuild lalu jalankan
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d --build

# Mulai lagi tanpa build
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d

# Terapkan perubahan env saja
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d --force-recreate

# Status, log, berhenti sementara
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml ps
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml logs -f backend
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml stop backend

# Hapus container/network; named volume tetap disimpan
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml down
```

Build pertama mengunduh image/dependensi. Layer `CACHED` pada build berikutnya normal. Jika memang perlu build bersih:

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml build --no-cache
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d
```

`--no-cache` milik **build**, bukan `up`. Build tidak mengambil kode baru dari Git; salin/pull revisi yang diinginkan lebih dahulu.

## 4. Konfigurasi

| Variabel | Default | Fungsi |
| --- | --- | --- |
| `MAIN_DULU_BIND_ADDRESS` | `127.0.0.1` | Interface host tempat port Docker dipublish; `0.0.0.0` untuk LAN |
| `MAIN_DULU_PORT` | `7777` | Port **host**; server di dalam container tetap 7777 |
| `MAIN_DULU_PUBLIC_ORIGIN` | Tidak disetel | Satu origin akun yang diizinkan; harus cocok dengan browser |
| `MAIN_DULU_ALLOW_INSECURE_HTTP` | `false` | `true` untuk mengizinkan origin HTTP jaringan secara eksplisit; hanya LAN tepercaya |
| `MAIN_DULU_REGISTRATION_OPEN` | `true` | `false` menutup pendaftaran, bukan login akun lama |
| `MAIN_DULU_STATE_MAX_BYTES` | `33554432` | Batas state 32 MiB; konfigurasi maksimum 64 MiB |
| `MAIN_DULU_GAME_SAVE_MAX_BYTES` | `8388608` | Batas paket progres 8 MiB |
| `MAIN_DULU_SAVE_QUOTA_BYTES` | `268435456` | Kuota akun 256 MiB untuk state + progres + cadangan konflik |
| `MAIN_DULU_CATALOG_QUOTA_BYTES` | `21474836480` | Kuota katalog pengembangan 20 GiB termasuk staging/orphan |
| `MAIN_DULU_CATALOG_MIN_FREE_BYTES` | `268435456` | Reserve ruang disk minimum saat admission upload |
| `MAIN_DULU_CATALOG_UPLOAD_LIMIT` | `2` | Reservasi upload bersamaan lintas proses |
| `MAIN_DULU_CATALOG_UPLOAD_TIMEOUT_MS` | `1800000` | Deadline upload/publikasi katalog 30 menit |
| `MAIN_DULU_CONTAINER_DATA_DIR` | `/var/lib/maindulu/data` | Folder data **di dalam volume**, dapat diarahkan ke hasil restore |
| `MAIN_DULU_ROM_CONVERTO_PATH` | *(kosong)* | Path absolut ke binary `rom-converto` (override vendor/PATH) |
| `MAIN_DULU_ROM_CONVERTO_TIMEOUT_MS` | `30000` | Timeout panggil `rom-converto info --json` (5000–120000) |
| `MAIN_DULU_CHD_SERIAL_AUTOAPPLY` | `true` | `false` menonaktifkan auto-apply CHD serial (tetap lookup + review) |

Nilai boolean hanya `true`/`false`. `MAIN_DULU_HOST=0.0.0.0`, port internal 7777, dan dist `/app/dist` sudah ditetapkan Compose; bukan alamat yang perlu diketik di browser. Data dir harus tetap di bawah `/var/lib/maindulu` agar persisten, bukan di `public/`, `dist/`, atau filesystem image read-only.

**Katalog pengembangan:** API dan UI admin upload/edit/delete serta unduh publik tersedia. Setelah promosi role dan login admin, buka `/admin/games` atau `/admin/bios`; game aktif dapat ditemukan/dimainkan melalui `/library`, dan BIOS dinamis dipilih sesuai console. Refresh/deep link dilayani backend. ROM/BIOS aktif dapat diunduh tamu. **Backup format 2 hanya menyimpan akun/save/metadata**, bukan berkas ROM/BIOS/cover; katalog berisi data tidak lagi memblokir backup. Setelah restore bersih, upload ulang aset identik dan konfirmasi ID lama. Ini bukan backup koleksi lengkap dan bukan bukti verifikasi produksi/container/proxy. Panduan: [backup metadata](../doc/backup-metadata-katalog.md), [Library/player](../doc/milestone-5-library-player.md), [UI admin](../doc/milestone-4-ui-admin.md), dan [API katalog](../doc/milestone-3-api-katalog.md).

Image `maindulu-backend:0.5.0` memakai production dependencies, user `node`, root filesystem read-only, `/tmp` tmpfs, dan healthcheck API. Modul bersama `src/lib/game-save-format.ts` ikut disalin ke runtime karena diimpor langsung oleh server.

## 5. Data persisten dan backup offline

Compose project bernama **`maindulu-backend`**, service **`backend`**, volume **`storage`** (biasanya `maindulu-backend_storage`). Parent `/var/lib/maindulu` dimount agar data dan lock di sebelahnya berada pada volume sama. Mengganti nama project/volume akan terlihat seperti instalasi kosong.

### Database lokal tidak otomatis diimpor ke Docker

| Cara menjalankan | Lokasi data default |
| --- | --- |
| `npm start` di host | `data/maindulu.sqlite`, `data/saves/`, dan `data/game-saves/` di folder proyek |
| Docker backend | `/var/lib/maindulu/data/maindulu.sqlite`, `saves/`, dan `game-saves/` pada named volume |

Database bukan isi bawaan repo/image: `data/` diabaikan Git, dan allowlist `.dockerignore` mengecualikan data privat serta SQLite dari build context. Saat volume masih kosong, backend membuat database baru; rebuild/recreate memakai data lama selama volume dan folder data tetap sama. Error lock berasal dari penyimpanan volume, bukan database yang disalin saat build.

Untuk memindahkan instalasi `npm start` ke Docker: hentikan server lokal, buat/verifikasi backup dari folder data yang benar, salin **seluruh folder backup** ke volume secara privat, lalu restore ke folder baru dan set `MAIN_DULU_CONTAINER_DATA_DIR` seperti di bawah. Akun/save tidak digabung otomatis. Jangan hanya menyalin SQLite karena blob save/progres berada di file terpisah. Format 2 sengaja tidak menyalin berkas ROM/BIOS/cover; setelah restore, upload ulang byte identik dan konfirmasi ID lama melalui admin. Konfigurasi environment dan progres tamu browser tidak ikut backup.

**Jangan gunakan `down -v`, hapus volume, atau `docker volume prune` sebagai solusi error.** Rebuild/recreate container tidak menghapus data volume. Volume di disk server yang sama bukan backup terhadap kerusakan disk.

Sebelum update: sinkronkan progres, unduh kandidat yang gagal/konflik, tutup semua player, lalu hentikan server dan CLI admin lain. Gunakan nama tujuan backup baru setiap kali. Contoh Linux, backup pra-update 0.5.0:

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml stop backend
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml run --rm --no-deps backend node scripts/data-backup.mjs backup /var/lib/maindulu/backup-before-0.5.0
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml run --rm --no-deps backend node scripts/data-backup.mjs verify /var/lib/maindulu/backup-before-0.3.1
```

`run --rm --no-deps` memakai volume/environment yang sama tanpa memulai server atau mempublish port. Folder tujuan belum boleh ada; parent `/var/lib/maindulu` sudah tersedia dan dapat ditulis user `node`. Jangan memakai `exec` untuk backup saat server aktif.

Salin keluar dari volume melalui container backend yang masih ada dalam keadaan stopped (`stop`, bukan `down`):

```sh
mkdir -p /opt/maindulu-backups
chmod 700 /opt/maindulu-backups
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml cp backend:/var/lib/maindulu/backup-before-0.5.0 /opt/maindulu-backups/backup-before-0.5.0
```

Tujuan host tersebut juga harus belum ada. Simpan seluruh folder di perangkat lain secara privat. Backup tidak terenkripsi dan tidak mencakup berkas ROM/BIOS/cover, aplikasi/engine, env, atau progres tamu. Metadata katalog dan hubungan ID save tetap disimpan pada format 2. Jangan hanya menyalin SQLite aktif tanpa blob/WAL. Simpan kode aplikasi/engine dan konfigurasi yang sesuai secara terpisah.

### Restore tanpa menimpa data lama

Dengan server tetap berhenti, restore backup di volume ke folder baru:

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml run --rm --no-deps backend node scripts/data-backup.mjs restore /var/lib/maindulu/backup-before-0.5.0 --to /var/lib/maindulu/data-restored-0.5.0
```

Jika backup hanya ada di host, salin seluruh folder ke path baru dalam volume melalui container stopped menggunakan `docker compose ... cp`, lalu verifikasi sebelum restore. Periksa pemilik/izin salinan: `cp` ke container dapat menghasilkan file milik root, sedangkan CLI berjalan sebagai `node`. Folder/file backup harus dapat diakses user `node` dan parent harus dapat ditulis untuk sibling lock; jangan mengatasi masalah izin dengan membuka data privat ke semua pengguna. Restore menolak tujuan yang sudah ada, mencabut semua sesi pada hasil restore, dan tidak menimpa data lama. Tambahkan ke `.env.backend`:

```dotenv
MAIN_DULU_CONTAINER_DATA_DIR=/var/lib/maindulu/data-restored-0.5.0
```

Lalu `up -d --force-recreate`, login ulang, dan uji save dengan ROM/core yang sama. Pada restore format 2 ke folder bersih, entri aktif ditampilkan admin sebagai **Berkas hilang** sampai upload ulang byte identik pada console yang sama dikonfirmasi memakai ID lama; cover dapat diunggah ulang lewat edit metadata. Password/kode pemulihan kembali ke waktu backup; konfigurasi manifest tidak diterapkan otomatis. Panduan: [pemulihan metadata tanpa ROM/BIOS](../doc/backup-metadata-katalog.md) dan [operasi M8](../doc/milestone-8-backup-operasi.md).

## 6. Update ke versi baru

1. Backup offline terverifikasi seperti di atas, simpan distribusi lama dan env; jangan menimpa perubahan lokal saat mengambil kode baru.
2. Ambil revisi baru, misalnya `git pull --ff-only` jika working tree bersih, atau salin distribusi baru.
3. Build/jalankan kembali dengan **env, project, dan volume yang sama**:

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d --build
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml ps
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml logs --tail=50 backend
```

4. Periksa versi **0.5.0** di Pengaturan, login, save/progres dan pemulihannya. Rilis 0.3.1 tidak mengubah skema SQLite (**6**), engine (**4.2.3**), atau format save. Jangan paksa downgrade database aktif; rollback memakai backup ke folder baru.

**Pengembangan terkini:** skema **14** menyimpan ROM/BIOS dengan nama asli pada folder platform (`roms/<platform>/`, `bios/<platform>/`) dan menolak benturan nama tanpa menimpa; skema 13 mencakup metadata ScreenScraper/provenance/override/gate worker. Format save/engine tidak berubah. CLI membuat backup **format 2** akun/save/metadata, tanpa berkas ROM/BIOS/cover dan tanpa syarat katalog kosong. Tugas/cache/lease/cooldown provider dinormalisasi pada snapshot saja; restore tidak menjalankan scan otomatis. Verify/restore format 2 skema 9-14 dan format 1 skema 7/8/9 dengan katalog kosong tetap didukung. Sumber diverifikasi sebelum migrasi hasil restore; aplikasi lama tidak boleh dipakai pada database skema baru. Untuk skema 6 gunakan aplikasi lama terlebih dahulu. Jangan paksa downgrade atau ubah nomor skema/manifest manual.

## 7. Reset akun admin

Saat backend berjalan, gunakan terminal interaktif (tanpa password dalam argumen):

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml exec backend npm run account:reset -- username
```

Jika server sedang berhenti dan tidak ada maintenance lain, gunakan `run --rm --no-deps backend npm run account:reset -- username`. Password diminta tersembunyi. Reset mempertahankan akun/save, mencabut sesi serta kode lama, dan menampilkan kode baru untuk diserahkan secara privat. Jangan berjalan bersamaan dengan backup/restore.

### Role admin (fondasi belum dirilis)

Reset password di atas berbeda dari penetapan role. Akun lama/baru selalu `user`; pendaftar pertama tidak otomatis admin. Promosi/demosi akun yang sudah ada:

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml exec backend npm run account:role -- username admin
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml exec backend npm run account:role -- username user
```

Gunakan container/data dir yang sama dengan server; jangan pakai container `run` terpisah saat server aktif karena namespace lock berbeda. Role berlaku pada request sesi aktif berikutnya, tanpa menghapus progres/kredensial. CLI ditolak selama maintenance eksklusif. `GET /api/admin/status` hanya menerima admin (tamu 401, akun biasa 403). Health mengiklankan `admin`, `gameCatalog`, dan `biosCatalog` sebagai `true`. Milestone 4 menambahkan menu/halaman admin dan Milestone 5 menghubungkannya ke Library/pilihan BIOS. Backup menyimpan metadata katalog tetapi tidak menyertakan byte aset. Bila menu belum muncul setelah promosi, muat ulang halaman atau fokuskan kembali tab untuk memperbarui sesi. Panduan: [role akun](../doc/admin-role-akun.md), [UI admin](../doc/milestone-4-ui-admin.md), [Library](../doc/milestone-5-library-player.md), dan [backup metadata](../doc/backup-metadata-katalog.md).

## 8. Verifikasi dan troubleshooting

Untuk contoh LAN, jalankan dari server/PC lain:

```sh
curl http://192.168.2.251:7777/api/health
curl http://192.168.2.251:7777/api/auth/session
```

Health harus mengembalikan JSON `service: maindulu`, `status: ok`, capability akun/save/progres `true`. Session tanpa login harus `200` JSON dengan `user: null`. Healthcheck Docker **tidak** membuktikan firewall/LAN/origin akun sudah benar.

| Gejala | Pemeriksaan / solusi |
| --- | --- |
| `ERR_CONNECTION_REFUSED` | Sertakan `:7777`; cek `ps`, bind host, IP server dan firewall. Default `127.0.0.1` tidak bisa diakses PC lain. |
| `Akses akun memerlukan HTTPS` | Untuk HTTP LAN, isi **kedua** flag `true` dan origin HTTP eksplisit; periksa `config`, gunakan env-file yang sama lalu recreate. |
| `Alamat akun tidak sesuai` / origin ditolak | URL browser berbeda hostname/IP, skema atau port. Pakai origin yang dikonfigurasi persis; jangan menonaktifkan CSRF. |
| Server gagal validasi origin | Tidak boleh ada path/query/kredensial; `true` tanpa origin ditolak, HTTP LAN tanpa flag ditolak. |
| `unknown flag: --no-cache` | Gunakan `build --no-cache`, kemudian `up -d`, bukan `up --no-cache`. |
| `Cannot find module ...game-save-format.ts` | Gunakan Dockerfile backend 0.3.1 dan rebuild. Pastikan kode terbaru benar-benar sudah disalin; no-cache tidak mengunduh kode baru. |
| Log server menunjukkan `127.0.0.1` di dalam container | Fastify dapat menampilkan alamat loopback pertama walaupun bind `0.0.0.0`; log ini saja bukan bukti server hanya lokal. Cek environment `MAIN_DULU_HOST`, hasil `ps`/publish port dan firewall. Gunakan IP host Docker + port host sebagai URL LAN. |
| Akun/save terlihat kosong setelah update | Cek nama project/volume dan `MAIN_DULU_CONTAINER_DATA_DIR`; jangan buat akun baru/hapus data sebelum menemukan volume lama. |
| Lock data/maintenance sibuk atau `Lock data berasal dari host/namespace lain atau versi Linux lama` | Hentikan semua server/admin yang memakai volume. Lease dari container/namespace lain tidak dihapus otomatis; ikuti prosedur karantina di bawah, jangan menghapus lock hidup/WAL. |
| Container `unhealthy` / restart | Lihat log; cek build frontend, env, izin/ruang disk dan data. Tidak perlu reset/hapus volume. |

Checklist browser: daftar/login → reload tetap login → simpan state/progres → tutup game → buka ulang dan pulihkan → recreate container → data tetap tersedia. Pastikan aset hilang (`/catalog/tidak-ada.json`) menghasilkan **404**, bukan HTML SPA; API juga tidak boleh difallback ke HTML.

Tes konfigurasi/unit bukan bukti build Docker atau HTTPS nyata. Jalankan checklist container/LAN di server tujuan; dukungan PS1 tetap terbatas pada skenario yang didokumentasikan, bukan seluruh game/card/varian.

### Lock tertinggal dari container lama

Lock mencatat PID **dan namespace Linux/hostname**. PID yang sama bisa menunjuk proses berbeda pada dua container. Karena itu aplikasi sengaja menolak lease dari namespace lain, bukan menghapusnya otomatis. Crash/penghentian paksa dapat meninggalkan lock di volume; recreate mengganti namespace tetapi tidak menghapus isi volume. Ini bukan bukti database rusak atau masalah konfigurasi HTTP.

**Jangan melewati lock sebelum memastikan pemiliknya sudah berhenti.** Contoh berikut hanya untuk folder data default `/var/lib/maindulu/data`, dengan sibling lock `/var/lib/maindulu/.data.maindulu-lock`. Jika memakai folder restore/custom, sesuaikan path berdasarkan nama folder data—jangan memindahkan folder data itu sendiri.

1. Tutup player dan hentikan backend:

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml stop backend
```

2. Periksa seluruh container, container yang memakai volume (sesuaikan nama volume bila project berbeda), serta proses `npm start`/Node, reset admin, backup/verify/restore di host. Pastikan tidak ada proses/container lain yang masih mengakses data tersebut:

```sh
docker ps -a
docker ps --filter volume=maindulu-backend_storage
```

3. Baca lease tanpa menjalankan server atau CLI yang mengambil lock:

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml run --rm --no-deps backend sh -c 'cat /var/lib/maindulu/.data.maindulu-lock/*.json'
```

Field `pid`, `namespace`, dan `exclusive` membantu mengidentifikasi pemilik. **PID tidak ditemukan di container baru bukan bukti pemilik lama sudah mati.** Cocokkan dengan container/proses asal; bila tidak yakin, hentikan dan periksa dahulu. Jika tidak ada lease tetapi ada `gate` tertinggal, itu juga memerlukan pemeriksaan operator, bukan bypass otomatis.

4. **Hanya setelah semua pemilik dipastikan berhenti**, pindahkan folder lock yang tepat ke nama karantina unik. Perintah ini tidak menghapus SQLite/save dan mempertahankan lock lama untuk pemeriksaan:

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml run --rm --no-deps backend node -e "const fs = require('node:fs'); const folder = '/var/lib/maindulu/.data.maindulu-lock'; const target = folder + '.quarantine-' + require('node:crypto').randomUUID(); fs.renameSync(folder, target); console.log('Lock lama dikarantina:', target)"
```

5. Jalankan backend, periksa log/status, dan uji akun/save:

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml logs --tail=50 backend
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml ps
```

Tidak perlu rebuild atau membuat database baru. Jangan menghapus volume, WAL/SHM, atau menambahkan penghapusan lock ke startup. Jika berulang setelah shutdown normal, simpan log dan lease karantina untuk menelusuri pelepasan lock; prosedur manual ini bukan perbaikan otomatis mekanisme lock. Rincian maintenance: [operasi M8](../doc/milestone-8-backup-operasi.md#lock-tertinggal-dan-staging).

### Verifikasi pengembangan 0.3.1

- `npm test`: **120 tes lulus**, termasuk opt-in HTTP, origin/CSRF/sesi, upload/download state/progres, contoh env, dan kontrak Docker runtime.
- `npm run build`: lulus; versi UI diambil dari `package.json` (**0.5.0**).
- `npm run test:e2e:backend -- tests/browser/account.spec.ts`: **8 tes lulus**, termasuk daftar/login/logout/reload sesi di browser pada IP jaringan HTTP (`isSecureContext === false`) tanpa sertifikat.
- Pemeriksaan TypeScript ketat `tests/browser/account.spec.ts`: lulus.
- Docker CLI tidak tersedia pada lingkungan ini: build/runtime Compose, recreate volume di Linux/LXC, dan reverse proxy HTTPS **belum diuji lokal**. Tes browser di atas memakai server Node nyata pada Windows, bukan container Docker atau bukti konektivitas LAN instalasi pengguna.

Catatan lanjutan 2026-11-05: batas pada hasil pengembangan 0.3.1 di atas bersifat historis. Untuk rollout cache IndexedDB M6, pengguna mengonfirmasi Docker backend sudah diuji di mesin lain; HTTPS ditunda di luar cakupan lokal. Ini tidak mengubah angka tes lama atau membuktikan setiap skenario Linux/LXC/recreate volume. Lihat [hasil dan batas M6 cache](../doc/milestone-6-cache-indexeddb-rollout.md).
