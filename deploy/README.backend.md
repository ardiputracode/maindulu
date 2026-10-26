# Docker backend maindulu 0.3.1

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
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml config
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d --build
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml ps
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml logs --tail=50 backend
```

Buka **http://192.168.2.251:7777** dari PC/HP lain. Tidak perlu Nginx, sertifikat, atau pengaturan keamanan browser. Pilih **Masuk → Daftar**, simpan kode pemulihan, lalu login sebelum membuka game agar sesi memakai save server. Game tamu tetap memakai browser.

`PORTS` harus menampilkan `0.0.0.0:7777->7777/tcp` (atau IP bind yang dipilih). Izinkan TCP 7777 hanya dari LAN tepercaya pada firewall LXC/host/Proxmox; jangan mengaktifkan port forwarding router. Bind `0.0.0.0` mencakup semua interface IPv4, bukan hanya LAN.

**Penting tentang environment:**

- Gunakan `--env-file .env.backend` pada **semua** perintah contoh berikut jika memilih mode ini. Contoh operasi di bawah memakai opsi tersebut; pengguna localhost dapat menghilangkannya.
- `.env.backend` bukan otomatis dibaca Node maupun Compose tanpa opsi itu. Shell environment yang sudah diekspor mengalahkan nilai env-file; periksa hasil `config` jika nilainya tidak sesuai.
- `MAIN_DULU_PUBLIC_ORIGIN` harus sama dengan URL browser: skema, hostname/IP, dan port. Tanpa path/query/kredensial. Dengan origin LAN, API akun lewat `localhost` yang berbeda akan ditolak; healthcheck `/api/health` tetap bekerja.
- Mengganti IP/port berarti memperbarui origin dan URL browser sekaligus. Data akun/save server tetap pada volume, tetapi storage tamu terpisah per origin.
- Mengaktifkan flag HTTP **tanpa origin eksplisit** membuat startup gagal. Flag default tetap `false`; HTTPS tetap memakai cookie `Secure` walaupun flag keliru dibiarkan `true`.
- Setelah mengubah env, gunakan `up -d --force-recreate`, bukan hanya `restart`. Tidak perlu build ulang untuk perubahan environment.

### C. Beralih ke HTTPS nanti

Pasang reverse proxy dan sertifikat yang dipercaya perangkat lebih dahulu. Contoh env untuk proxy pada host Docker:

```dotenv
MAIN_DULU_BIND_ADDRESS=127.0.0.1
MAIN_DULU_PORT=7777
MAIN_DULU_PUBLIC_ORIGIN=https://main.example.com
MAIN_DULU_ALLOW_INSECURE_HTTP=false
```

Proxy meneruskan seluruh path ke `http://127.0.0.1:7777`, mempertahankan **Host publik beserta port bila nonstandar** (Nginx: `proxy_set_header Host $http_host;`), dan menerima body biner sampai batas state yang dikonfigurasi. Jangan mengubah error API menjadi HTML. Jika proxy di container lain, gunakan jaringan Docker bersama, bukan `127.0.0.1` container proxy.

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d --force-recreate
```

Variabel `https://...` saja **tidak** mengaktifkan TLS pada server Node. Compose ini tidak memasang proxy/sertifikat. HTTP LAN bukan pengganti HTTPS untuk deployment publik.

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
| `MAIN_DULU_CONTAINER_DATA_DIR` | `/var/lib/maindulu/data` | Folder data **di dalam volume**, dapat diarahkan ke hasil restore |

Nilai boolean hanya `true`/`false`. `MAIN_DULU_HOST=0.0.0.0`, port internal 7777, dan dist `/app/dist` sudah ditetapkan Compose; bukan alamat yang perlu diketik di browser. Data dir harus tetap di bawah `/var/lib/maindulu` agar persisten, bukan di `public/`, `dist/`, atau filesystem image read-only.

Image `maindulu-backend:0.3.1` memakai production dependencies, user `node`, root filesystem read-only, `/tmp` tmpfs, dan healthcheck API. Modul bersama `src/lib/game-save-format.ts` ikut disalin ke runtime karena diimpor langsung oleh server.

## 5. Data persisten dan backup offline

Compose project bernama **`maindulu-backend`**, service **`backend`**, volume **`storage`** (biasanya `maindulu-backend_storage`). Parent `/var/lib/maindulu` dimount agar data dan lock di sebelahnya berada pada volume sama. Mengganti nama project/volume akan terlihat seperti instalasi kosong.

### Database lokal tidak otomatis diimpor ke Docker

| Cara menjalankan | Lokasi data default |
| --- | --- |
| `npm start` di host | `data/maindulu.sqlite`, `data/saves/`, dan `data/game-saves/` di folder proyek |
| Docker backend | `/var/lib/maindulu/data/maindulu.sqlite`, `saves/`, dan `game-saves/` pada named volume |

Database bukan isi bawaan repo/image: `data/` diabaikan Git, dan allowlist `.dockerignore` mengecualikan data privat serta SQLite dari build context. Saat volume masih kosong, backend membuat database baru; rebuild/recreate memakai data lama selama volume dan folder data tetap sama. Error lock berasal dari penyimpanan volume, bukan database yang disalin saat build.

Untuk memindahkan instalasi `npm start` ke Docker: hentikan server lokal, buat/verifikasi backup M8 dari folder data yang benar, salin **seluruh folder backup** ke volume secara privat, lalu restore ke folder baru dan set `MAIN_DULU_CONTAINER_DATA_DIR` seperti di bawah. Akun/save tidak digabung otomatis. Jangan hanya menyalin SQLite karena blob save/progres berada di file terpisah. Konfigurasi environment dan progres tamu browser tidak ikut backup.

**Jangan gunakan `down -v`, hapus volume, atau `docker volume prune` sebagai solusi error.** Rebuild/recreate container tidak menghapus data volume. Volume di disk server yang sama bukan backup terhadap kerusakan disk.

Sebelum update: sinkronkan progres, unduh kandidat yang gagal/konflik, tutup semua player, lalu hentikan server dan CLI admin lain. Gunakan nama tujuan backup baru setiap kali. Contoh Linux, backup pra-update 0.3.1:

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml stop backend
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml run --rm --no-deps backend node scripts/data-backup.mjs backup /var/lib/maindulu/backup-before-0.3.1
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml run --rm --no-deps backend node scripts/data-backup.mjs verify /var/lib/maindulu/backup-before-0.3.1
```

`run --rm --no-deps` memakai volume/environment yang sama tanpa memulai server atau mempublish port. Folder tujuan belum boleh ada; parent `/var/lib/maindulu` sudah tersedia dan dapat ditulis user `node`. Jangan memakai `exec` untuk backup saat server aktif.

Salin keluar dari volume melalui container backend yang masih ada dalam keadaan stopped (`stop`, bukan `down`):

```sh
mkdir -p /opt/maindulu-backups
chmod 700 /opt/maindulu-backups
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml cp backend:/var/lib/maindulu/backup-before-0.3.1 /opt/maindulu-backups/backup-before-0.3.1
```

Tujuan host tersebut juga harus belum ada. Simpan seluruh folder di perangkat lain secara privat. Backup tidak terenkripsi dan tidak mencakup ROM/BIOS, aplikasi/engine, env, atau progres tamu. Jangan hanya menyalin SQLite aktif tanpa blob/WAL. Simpan kode aplikasi/engine dan konfigurasi yang sesuai secara terpisah.

### Restore tanpa menimpa data lama

Dengan server tetap berhenti, restore backup di volume ke folder baru:

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml run --rm --no-deps backend node scripts/data-backup.mjs restore /var/lib/maindulu/backup-before-0.3.1 --to /var/lib/maindulu/data-restored-0.3.1
```

Jika backup hanya ada di host, salin seluruh folder ke path baru dalam volume melalui container stopped menggunakan `docker compose ... cp`, lalu verifikasi sebelum restore. Periksa pemilik/izin salinan: `cp` ke container dapat menghasilkan file milik root, sedangkan CLI berjalan sebagai `node`. Folder/file backup harus dapat diakses user `node` dan parent harus dapat ditulis untuk sibling lock; jangan mengatasi masalah izin dengan membuka data privat ke semua pengguna. Restore menolak tujuan yang sudah ada, mencabut semua sesi pada hasil restore, dan tidak menimpa data lama. Tambahkan ke `.env.backend`:

```dotenv
MAIN_DULU_CONTAINER_DATA_DIR=/var/lib/maindulu/data-restored-0.3.1
```

Lalu `up -d --force-recreate`, login ulang, dan uji save dengan ROM/core yang sama. Password/kode pemulihan kembali ke waktu backup; konfigurasi dari manifest tidak diterapkan otomatis. Panduan lengkap/lock tertinggal: [operasi M8](../doc/milestone-8-backup-operasi.md).

## 6. Update ke versi baru

1. Backup offline terverifikasi seperti di atas, simpan distribusi lama dan env; jangan menimpa perubahan lokal saat mengambil kode baru.
2. Ambil revisi baru, misalnya `git pull --ff-only` jika working tree bersih, atau salin distribusi baru.
3. Build/jalankan kembali dengan **env, project, dan volume yang sama**:

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d --build
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml ps
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml logs --tail=50 backend
```

4. Periksa versi **0.3.1** di Pengaturan, login, save/progres dan pemulihannya. Rilis 0.3.1 tidak mengubah skema SQLite (**6**), engine (**4.2.3**), atau format save. Jangan paksa downgrade database aktif; rollback memakai backup ke folder baru.

**Pengembangan setelah 0.3.1:** fondasi role admin menaikkan skema menjadi **7**, tanpa mengubah format save/engine. Buat backup pra-update memakai aplikasi lama. CLI baru hanya menerima backup skema 7; verifikasi/restore backup skema 6 dengan aplikasi lama, lalu migrasikan hasil restore memakai server baru. Jangan paksa downgrade atau ubah nomor skema manual.

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

Gunakan container/data dir yang sama dengan server; jangan pakai container `run` terpisah saat server aktif karena namespace lock berbeda. Role berlaku pada request sesi aktif berikutnya, tanpa menghapus progres/kredensial. CLI ditolak selama maintenance eksklusif. `GET /api/admin/status` hanya menerima admin (tamu 401, akun biasa 403). Health mengiklankan `admin: true`, sedangkan `gameCatalog`/`biosCatalog` masih `false`; halaman admin/upload belum tersedia. Panduan lengkap: [role akun](../doc/admin-role-akun.md).

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
- `npm run build`: lulus; versi UI diambil dari `package.json` (**0.3.1**).
- `npm run test:e2e:backend -- tests/browser/account.spec.ts`: **8 tes lulus**, termasuk daftar/login/logout/reload sesi di browser pada IP jaringan HTTP (`isSecureContext === false`) tanpa sertifikat.
- Pemeriksaan TypeScript ketat `tests/browser/account.spec.ts`: lulus.
- Docker CLI tidak tersedia pada lingkungan ini: build/runtime Compose, recreate volume di Linux/LXC, dan reverse proxy HTTPS **belum diuji lokal**. Tes browser di atas memakai server Node nyata pada Windows, bukan container Docker atau bukti konektivitas LAN instalasi pengguna.
