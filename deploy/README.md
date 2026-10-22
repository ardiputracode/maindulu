# Deployment Docker (maindulu)

Dokumentasi implementasi container web statis maindulu: Vite membangun `dist/`, lalu Nginx menyajikan keluaran build tersebut tanpa backend.

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
| `.dockerignore` | Menjaga konteks build tetap kecil; hanya berkas yang dibutuhkan build yang ikut ke daemon. |

## Prasyarat

1. Docker Desktop (atau engine Docker lain) dengan backend **WSL2** terpasang. Cek: `docker info` harus menampilkan bagian `Server:` tanpa error.
2. Jika `docker info` gagal dengan `500 Internal Server Error ... dockerDesktopLinuxEngine`, biasanya **WSL2 belum terpasang**. Pasang lewat PowerShell Administrator: `wsl --install`, lalu restart komputer. Saat implementasi ini dibuat, engine Docker Desktop di mesin pengembang gagal jalan dengan kondisi tersebut, sehingga verifikasi hanya dilakukan secara statik (`docker compose config` valid; lihat bagian Verifikasi).

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

Konteks build dijaga kecil oleh `.dockerignore`; `node_modules/`, `dist/`, `tests/`, `scripts/`, `third_party/`, dan berkas lain yang tidak dibutuhkan build dikecualikan. Engine EmulatorJS yang dipakai runtime sudah ter-bundle di `public/vendor/emulatorjs/4.2.3/`, sehingga `npm run build` di container mandiri tanpa langkah vendoring.

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

Saat ini yang sudah dijalankan: `docker compose -f deploy/docker-compose.yml config` (struktur compose valid, build context menunjuk akar repo). Build image sendiri belum dieksekusi di mesin ini karena engine Docker Desktop butuh WSL2 yang belum terpasang (lihat Prasyarat) — semua perintah `curl` di atas adalah checklist pertama kali engine berjalan.

## Catatan penting

- **Storage per origin.** Favorit/riwayat/save disimpan browser per origin (alamat + porta). Berpindah porta (7777 → lain), IP, atau HTTP/HTTPS tidak meneruskan data lama; pilih porta awal yang konsisten.
- **Lisensi distribusi.** Jika image ini didistribusikan, README bagian lisensi mewajibkan penerima tetap bisa mengakses sumber engine yang terkait; bukan hanya bundle minified. Sumber readable bawaan tetap berada di `public/vendor/emulatorjs/4.2.3/data/src/` dan ikut ke dalam image.
- **Hosting subpath tidak didukung.** URL runtime aplikasi memakai path absolut root (`/catalog/...`, `/player/...`), jadi aplikasi harus berada di root suatu origin (baik itu `:7777` ataupun reverse proxy yang meletakkannya di `/`).
