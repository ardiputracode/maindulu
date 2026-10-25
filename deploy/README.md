# Deployment Docker (maindulu)

Tersedia dua deployment terpisah. Pilih sesuai kebutuhan:

| Kebutuhan | Compose | Panduan |
| --- | --- | --- |
| Tamu saja, save browser | `deploy/docker-compose.yml` | Panduan statis di bawah |
| Akun, save state/progres server, backup/admin | `deploy/docker-compose.backend.yml` | **[Panduan backend lengkap](README.backend.md)** |

**Backend 0.3.1 untuk LAN tanpa HTTPS:** salin `deploy/backend.env.example` ke `.env.backend` di akar repo (jangan timpa file yang sudah ada), ganti IP/origin sesuai server, lalu:

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d --build
```

Contoh membuka **http://192.168.2.251:7777**. Akun HTTP LAN memerlukan `MAIN_DULU_ALLOW_INSECURE_HTTP=true` **dan** `MAIN_DULU_PUBLIC_ORIGIN` yang cocok dengan URL browser. **Password/cookie/save tidak terenkripsi; hanya LAN tepercaya, bukan internet.** Default backend tetap localhost/HTTPS untuk jaringan. Lihat panduan backend untuk konfigurasi, update, backup/restore, dan troubleshooting.

Database lokal dari `data/` tidak otomatis masuk image; backend memakai named volume privat. Untuk error lock namespace lama, ikuti [pemeriksaan dan karantina lock](README.backend.md#lock-tertinggal-dari-container-lama), bukan menghapus volume/database.

Kedua Compose memakai port host 7777 secara default; jangan jalankan bersamaan pada port sama. Node/npm tidak diperlukan di host. Perintah contoh dijalankan dari akar repo.

## Web statis (tanpa akun/API)

Bagian berikut khusus container web statis: Vite membangun `dist/`, lalu Nginx menyajikannya tanpa backend. Mengatur environment backend pada image statis tidak mengaktifkan akun.

## Arsitektur singkat

```
┌──────────── tahap build (node:24-alpine) ────────────┐
│  npm ci → npm run build (tsc -b && vite build)       │
│  masukan: package*.json, index.html, vite.config.ts, │
│           tsconfig*.json, src/, public/              │
└──────────────────────┬───────────────────────────────┘
                       ↓ dist/
┌──────────── tahap runtime (nginx:1.29-alpine) ───────┐
│  /usr/share/nginx/html        ← salinan dist/        │
│  /etc/nginx/conf.d/default.conf ← nginx.docker.conf  │
└──────────────────────────────────────────────────────┘
```

Image khusus ini disusun dua tahap (`deploy/Dockerfile`) supaya dependensi build (TypeScript, Vite, toolchain tsc) tidak ikut ke image akhir. Versi Node mengikuti rekomendasi README (Node 24+), versi Nginx di-pin `1.29-alpine` agar build dapat direproduksi.

## Daftar file

| Path | Fungsi |
| --- | --- |
| `deploy/Dockerfile` | Build dua tahap: Node 24 untuk `npm ci` + `npm run build`, lalu Nginx 1.29 melayani `dist/`. |
| `deploy/nginx.docker.conf` | Konfigurasi `server {}` bawaan container; dicopy ke `/etc/nginx/conf.d/default.conf`. |
| `deploy/docker-compose.yml` | Service `web` tunggal: build, porta host, `restart: unless-stopped`, healthcheck. |
| `deploy/Dockerfile.backend` | Runtime Node.js non-root, web + API dan modul format save bersama. |
| `deploy/docker-compose.backend.yml` | Backend dengan named volume privat, healthcheck API, bind host localhost secara default. |
| `deploy/backend.env.example` | Contoh opt-in HTTP LAN; salin/edit lalu gunakan `--env-file`. |
| `.dockerignore` | Allowlist build kedua image; data privat dan environment tidak ikut ke daemon. |

## Prasyarat

1. Docker Engine + Compose v2 di Linux/LXC, atau Docker Desktop dengan Linux containers (Windows: WSL2). Cek `docker info` dan `docker compose version`.
2. Jika Docker Desktop Windows gagal dengan error engine/WSL2, periksa instalasi WSL2; pemasangan dapat dilakukan melalui PowerShell Administrator: `wsl --install`, lalu restart sesuai petunjuk. WSL2 bukan syarat host Linux.

## Cara pakai

### Menyalin ke mesin lain

Salin seluruh folder project ke mesin tujuan dengan cara apa pun (clone Git atau copy folder). `node_modules/` dan `dist/` ikut terbawa pun tidak masalah — `.dockerignore` otomatis mengeluarkannya dari build context. Syarat satu-satunya di mesin tersebut adalah Docker yang sudah jalan (Docker Desktop + WSL2, atau Docker Engine di Linux); Node/npm tidak diperlukan di host karena seluruh build berjalan di dalam container.

Menyalin memakai Git? `git clone` saja; semua berkas deployment di atas ikut didorong bersama repo, jadi mesin tujuan tidak butuh salinan manual.

### Jalankan

```sh
# build + jalankan (dari akar repo)
docker compose -f deploy/docker-compose.yml up --build

# atau dari folder deploy/
cd deploy && docker compose up --build
```

Build pertama berlangsung beberapa menit (unduh image Node/Nginx, `npm ci`, lalu `vite build` di dalam container) — normal, bukan hang. Rebuild berikutnya jauh lebih cepat karena lockfile yang tidak berubah tetap ter-cache sebagai layer Docker.

Aplikasi terbuka di `http://localhost:7777`. Untuk mengakses dari ponsel/LAN (aplikasi ini memang mendukung origin HTTP tidak aman), buka `http://<ip-komputer>:7777`.

Penggunaan harian berikutnya cukup:

```sh
docker compose -f deploy/docker-compose.yml up -d
```

Tanpa `--build`, compose memakai image `maindulu-web:latest` yang sudah pernah dibangun — berguna ketika mesin hanya dinyalakan ulang.

Perintah lain yang umum:

```sh
docker compose -f deploy/docker-compose.yml ps          # status + health
docker compose -f deploy/docker-compose.yml logs -f web # log Nginx
docker compose -f deploy/docker-compose.yml down        # matikan
```

## Konfigurasi

| Fitur | Nilai / cara ubah |
| --- | --- |
| Porta host | `${MAIN_DULU_PORT:-7777}`, mis. `MAIN_DULU_PORT=8888 docker compose -f deploy/docker-compose.yml up --build` |
| Porta container | 80 (tetap; `EXPOSE 80`) |
| Restart | `unless-stopped` |
| Healthcheck | `wget --spider http://127.0.0.1/` tiap 30 s (busybox wget bawaan image alpine); `start_period` 5 s |

Jika healthcheck jadi `unhealthy`, lihat log Nginx lewat `docker compose -f deploy/docker-compose.yml logs web`.

## Perilaku serving (wajib dipertahankan)

Semua kontrak hosting di README bagian Deployment dijaga identik dengan template `deploy/nginx.conf`:

1. **Folder aset = 404 nyata.** `/vendor/`, `/player/`, `/catalog/`, `/games/`, `/bios/`, `/covers/`, dan `/assets/` memakai `try_files $uri =404`. Permintaan ke berkas yang hilang tidak boleh jatuh ke HTML aplikasi — bridge player (`public/player/player.js`, `checkServerAsset`) sengaja menolak respons ber-MIME HTML, jadi fallback HTML justru mengacaukan pemulihan error di UI.
2. **Fallback SPA hanya untuk halaman.** `location /` memakai `try_files $uri $uri/ /index.html` untuk route klien seperti `/main`, `/console`, `/pengaturan`.
3. **`Cache-Control: no-cache`** untuk semua respons agar manifest dan aset selalu divalidasi ulang ke server; pola konservatif ini mengikuti template.
4. **Header keamanan** `X-Content-Type-Options: nosniff` dan `Referrer-Policy: strict-origin-when-cross-origin` dengan `always`. Catatan: kedua header diulang **di dalam setiap `location {}`** karena aturan pewarisan Nginx — `add_header` di blok `location` anak membuat server-level `add_header` tidak diwarisi; tanpa pengulangan ini `Cache-Control` sendirian justru mematikan kedua header itu.
5. **Gzip** diaktifkan untuk teks (css/js/json/svg) dengan `gzip_types`; `application/wasm` ikut daftar bila MIME sudah ada di `mime.types` image.

Perbedaan hanya dua hal dibanding `deploy/nginx.conf` (template hosting umum): root dokumen `/usr/share/nginx/html` (standar image Nginx), dan `listen ... default_server` untuk IPv4 dan IPv6. Template `deploy/nginx.conf` **tidak diubah** dan tetap jadi referensi README.

Konteks build dijaga oleh allowlist `.dockerignore`; `node_modules/`, `dist/`, `tests/`, `third_party/`, environment dan data privat dikecualikan. Dua CLI admin/backup di `scripts/` diizinkan secara eksplisit untuk image backend, bukan disalin ke runtime Nginx. Engine EmulatorJS sudah dibundel di `public/vendor/emulatorjs/4.2.3/`, sehingga build tidak perlu vendoring ulang.

## Verifikasi manual

Jalankan saat engine Docker tersedia untuk memverifikasi image build:

| Permintaan | Harapan |
| --- | --- |
| `curl -I http://localhost:7777/` | `200`, `Content-Type: text/html`, header keamanan + `Cache-Control: no-cache` |
| `curl -I http://localhost:7777/main` | `200` (SPA fallback) |
| `curl http://localhost:7777/catalog/consoles.json` | `200` JSON |
| `curl -I http://localhost:7777/games/jalan-pulang.nes` | `200`, `Content-Type: application/octet-stream` |
| `curl -I http://localhost:7777/catalog/tidak-ada.json` | **404**, dan pasti **bukan index.html SPA** (halaman 404 bawaan Nginx wajar; bridge hanya mengelola lewat status) |
| `curl -I http://localhost:7777/vendor/tidak-ada.js` | **404** |

Setelah itu uji fungsinya di browser: pilih demo di katalog, halaman player di `/main` harus bisa memulai core NES lokal.

Validasi Compose statis pernah dilakukan saat deployment ini dibuat. Pada lingkungan pengembangan rilis 0.3.1, Docker CLI tidak tersedia; build/runtime Docker tidak diklaim telah diuji lokal. Perintah `curl` di atas tetap checklist untuk host tujuan, bukan hasil verifikasi otomatis.

## Catatan penting

- **Storage per origin.** Favorit/riwayat/save disimpan browser per origin (alamat + porta). Berpindah porta (7777 → lain), IP, atau HTTP/HTTPS tidak meneruskan data lama; pilih porta awal yang konsisten.
- **Lisensi distribusi.** Jika image ini didistribusikan, README bagian lisensi mewajibkan penerima tetap bisa mengakses sumber engine yang terkait; bukan hanya bundle minified. Sumber readable bawaan tetap berada di `public/vendor/emulatorjs/4.2.3/data/src/` dan ikut ke dalam image.
- **Hosting subpath tidak didukung.** URL runtime aplikasi memakai path absolut root (`/catalog/...`, `/player/...`), jadi aplikasi harus berada di root suatu origin (baik itu `:7777` ataupun reverse proxy yang meletakkannya di `/`).
