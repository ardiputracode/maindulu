# M2 — Fondasi Backend Lokal Tanpa Docker

Status: M2 selesai. Web + API satu proses, SQLite persisten, mode frontend statis mandiri, dan skenario kegagalan backend telah diverifikasi.

Catatan: dokumen ini mencatat lingkup dan hasil M2. Akun/sesi kemudian ditambahkan pada [M3](milestone-3-akun-lokal.md); keterangan kapabilitas serta skema di bawah menggambarkan kondisi saat penutupan M2, bukan batas versi terbaru.

M2 menambahkan server web dan API dalam satu proses Node.js, SQLite persisten, dan status backend opsional pada halaman Pengaturan. Belum ada akun, sesi login, endpoint upload save, atau penyimpanan progres server. Seluruh progres emulator masih menggunakan perilaku browser yang ada.

## Pilihan Teknologi

- Fastify 5 untuk routing dan lifecycle server.
- `@fastify/static` 10 untuk penyajian aset, MIME, HEAD, dan HTTP byte ranges.
- `node:sqlite` / `DatabaseSync`, bawaan Node.js; tidak memerlukan instalasi MySQL/PostgreSQL atau kompilasi addon SQLite.
- Node.js **24 atau lebih baru**, mengikuti `package.json:engines`.
- Target penggunaan Windows dan Linux dengan Node.js yang didukung. Verifikasi pada pengerjaan ini dilakukan di Windows; Linux belum diuji langsung.

Docker tidak dibutuhkan. Container Nginx yang sudah ada tetap merupakan opsi frontend statis; M2 tidak mengubah container tersebut menjadi server backend.

## Menjalankan di Satu Komputer

```sh
npm install
npm run build
npm start
```

Buka **http://127.0.0.1:7777** atau **http://localhost:7777**. Setelah dependensi dan build tersedia, cukup jalankan `npm start` untuk menyalakan web beserta API. Build tidak dijalankan otomatis oleh `npm start`.

Satu proses melayani:

- Halaman React dari `dist/` beserta halaman SPA yang terdaftar di aplikasi.
- Player dan aset engine dari hasil build, tanpa CDN.
- `GET /api/health`, yang memeriksa koneksi SQLite dan mengumumkan kapabilitas backend.

Jika hasil build tidak ditemukan/tidak valid, startup gagal dengan petunjuk menjalankan build. Jika port sudah dipakai atau SQLite tidak bisa dibuka, startup gagal tanpa membuat server yang seolah-olah sehat. Hentikan melalui Ctrl+C; server menutup koneksi database saat shutdown normal.

### Konfigurasi Lingkungan

| Variabel | Default | Tujuan |
| --- | --- | --- |
| `MAIN_DULU_HOST` | `127.0.0.1` | Alamat bind backend; default hanya komputer sendiri |
| `MAIN_DULU_PORT` | `7777` | Port web + API, angka 1–65535 |
| `MAIN_DULU_DATA_DIR` | `data` | Folder SQLite dan data privat, di luar `public`/hasil build |
| `MAIN_DULU_DIST_DIR` | `dist` | Folder hasil build yang disajikan server |
| `VITE_BACKEND_ENABLED` | tidak diaktifkan | Opt-in frontend saat build/dev untuk instalasi dengan reverse proxy API same-origin |

Path relatif folder backend dihitung dari akar proyek, bukan direktori kerja terminal. Path absolut juga dapat digunakan. Nilai lingkungan diberikan oleh shell/process manager; aplikasi tidak membaca file `.env` backend secara otomatis. Variabel `VITE_*` mengikuti mekanisme Vite dan bukan tempat menyimpan rahasia.

Contoh PowerShell untuk port dan folder data berbeda:

```powershell
$env:MAIN_DULU_PORT = '8888'
$env:MAIN_DULU_DATA_DIR = 'C:\maindulu-data'
npm start
```

Untuk mengizinkan koneksi perangkat LAN, set `MAIN_DULU_HOST` ke `0.0.0.0`, lalu buka alamat IP komputer server dari perangkat lain. Komputer server harus menyala dan firewall harus mengizinkan port tersebut. Jangan menganggap `localhost` pada HP mengarah ke komputer server. Gunakan HTTPS melalui reverse proxy untuk akses jaringan/produksi, terutama setelah autentikasi ditambahkan.

`MAIN_DULU_PORT` pada Docker Compose lama hanya mengatur port host Nginx. Konfigurasi backend Node.js di atas berlaku untuk `npm start`, bukan untuk mengaktifkan API dalam container lama.

## Frontend Tetap Bisa Berdiri Sendiri

```sh
npm run dev
```

Atau untuk preview build statis:

```sh
npm run build
npm run preview
```

Build `dist/` tetap dapat dipasang pada hosting statis. Tidak ada import modul server/SQLite ke bundle React. Tanpa konfigurasi backend, frontend tidak melakukan request API dan tidak menampilkan fitur login/cloud save.

### Deteksi Mode Backend

Server Node.js menyisipkan marker HTML `meta[name="maindulu-backend"]` hanya pada respons halaman yang dilayaninya. Berkas `dist/index.html` di disk tidak diubah, sehingga build yang sama tetap bisa dipakai sebagai frontend statis.

- **Mode web statis:** tidak ada marker/opt-in; tidak ada probing API.
- **Memeriksa backend:** marker atau opt-in ada; pemeriksaan `/api/health` berjalan terpisah dari pemuatan katalog.
- **Backend lokal terhubung:** respons JSON cocok dengan identitas, versi API, status, dan kapabilitas yang diharapkan.
- **Backend tidak dapat dihubungi:** request gagal, timeout 5 detik, respons error, HTML SPA fallback, atau format respons tidak sesuai. Status ini tidak diubah menjadi mode statis secara diam-diam; tersedia tombol coba lagi.

Pemeriksaan backend tidak menjadi syarat pemuatan katalog atau bermain sebagai tamu. Jika hanya API mengalami gangguan tetapi web/aset masih tersedia, gameplay tamu tetap dapat berjalan. Jika seluruh proses server berhenti, web dan aset pada origin itu juga tidak dapat dimuat baru; ini bukan jaminan mode offline.

Opt-in `VITE_BACKEND_ENABLED=true` hanya diperlukan untuk deployment khusus yang menyediakan `/api` melalui proxy same-origin. Menyetel variabel itu saja tidak membuat Vite/hosting statis menjalankan API. Tidak ada proxy lintas origin atau server development backend tambahan yang dikonfigurasi pada M2.

### Kontrak Health API

```json
{
  "service": "maindulu",
  "apiVersion": 1,
  "status": "ok",
  "capabilities": {
    "accounts": false,
    "serverSaves": false
  }
}
```

Health API tidak mengembalikan path database, isi metadata privat, atau installation ID. Jika pembacaan SQLite gagal saat request, respons menjadi HTTP 503. Route API yang tidak tersedia mengembalikan JSON 404, bukan fallback HTML. Kapabilitas M2 sengaja `false`: backend sehat tidak berarti login atau cloud save sudah tersedia.

## Data dan Migrasi

Default data privat:

```text
data/
├─ maindulu.sqlite
├─ maindulu.sqlite-wal   # dapat muncul saat database aktif
└─ maindulu.sqlite-shm   # dapat muncul saat database aktif
```

Migrasi pertama membuat:

- `schema_migrations`: catatan versi/nama/waktu migrasi.
- `app_metadata`: identitas instalasi acak dan waktu pembuatan, sebagai data persisten awal.
- `PRAGMA user_version = 1` untuk versi skema.

Migrasi dilakukan dalam transaksi; menjalankan server lagi tidak mengulang atau menghapus migrasi lama. Database dengan versi skema lebih baru ditolak agar aplikasi lama tidak merusaknya. SQLite memakai WAL, foreign keys, dan busy timeout. Belum ada tabel akun/sesi/save; penambahannya mengikuti milestone masing-masing.

Folder `data/` default diabaikan Git. Untuk lokasi custom di dalam repository, tambahkan aturan ignore sendiri; lebih aman memakai lokasi privat di luar repository. Perubahan/build ulang frontend tidak menghapus folder data. Jangan menghapus database untuk mengatasi masalah startup; periksa konfigurasi dan versi aplikasi terlebih dahulu.

Pada penutupan M2, backup/restore terkoordinasi belum tersedia. **Versi terbaru menyediakan CLI offline M8**; gunakan [prosedur backup/verifikasi/restore M8](milestone-8-backup-operasi.md), bukan salinan sembarang SQLite aktif. Hentikan server/admin sesuai panduan dan simpan cadangan di lokasi lain; jangan menghapus WAL/SHM saat database berjalan.

## Batas Penyajian Berkas dan Keamanan

- Data privat tidak boleh berada di dalam `public/` atau folder build, maupun menjadi induk keduanya. Pemeriksaan mengikuti symlink/junction yang sudah ada, termasuk ancestor folder data baru.
- Server hanya menyajikan root build, halaman SPA yang terdaftar, dan folder aset aplikasi yang dikenal; bukan akar repository atau folder data.
- Listing direktori dan dotfile tidak disajikan. Berkas database tidak dilayani sebagai aset, dan symlink/junction aset yang keluar dari root build ditolak.
- Aset hilang mengembalikan error nyata, bukan HTML. File besar tetap dilayani sebagai stream dengan dukungan HEAD/range.
- Respons menggunakan `X-Content-Type-Options: nosniff`, `Referrer-Policy`, dan cache control konservatif. Server tidak menambahkan CSP global yang merusak kebutuhan player.
- Aset build dianggap dikelola operator, bukan direktori upload yang dapat dimutasi pengunjung. Jangan menaruh data rahasia di dalamnya, termasuk melalui hard link.
- Seluruh `public/` tetap bersifat publik dan ikut build. `.gitignore` untuk BIOS/CHD hanya mencegah pencatatan Git, bukan distribusi web; keluarkan aset yang tidak boleh didistribusikan sebelum deployment.

Proteksi akun, CSRF endpoint autentikasi, rate limit login, dan kepemilikan save akan ditambahkan ketika endpoint terkait diimplementasikan. M2 tidak membuka endpoint tulis data pengguna.

## Berkas Implementasi

| Berkas | Peran |
| --- | --- |
| `server/index.mjs` | Entrypoint `npm start`, pemeriksaan Node, bind/listen, shutdown |
| `server/config.mjs` | Validasi host/port dan pemisahan folder privat/publik |
| `server/database.mjs` | SQLite, migrasi transaksional, metadata persisten |
| `server/app.mjs` | Fastify, health API, HTML marker, penyajian aset |
| `src/lib/backend.ts` | Kontrak/validasi health dan keputusan opt-in |
| `src/lib/useBackendStatus.ts` | Pemeriksaan non-blocking, timeout, abort, dan retry |
| `src/components/BackendStatus.tsx` | Status backend di Pengaturan |
| `tests/server.test.mjs` | Konfigurasi, migrasi, restart, HTTP, dan isolasi file |
| `tests/backend.test.mjs` | Validasi kontrak frontend dan opt-in |
| `tests/browser/backend.spec.ts` | Mode statis/aktif/gagal, timeout, retry, dan gameplay tamu |
| `playwright.backend.config.ts` | Tes terhadap server Node.js yang benar-benar dijalankan lewat `npm start` |

## Cara Verifikasi

```sh
npm test
npm run build
npm run test:e2e
npm run test:e2e:production
npm run test:e2e:backend
```

Build wajib diperbarui sebelum tes production dan backend. Suite backend memakai port 4174 serta database di `test-results/backend-data`, bukan data pengguna default. Fixture unit berada pada direktori temporer unik dan dibersihkan setelah tes; fixture itu terpisah dari output Playwright.

### Hasil Verifikasi

Lingkungan: Windows, Node.js 26.12.1; suite server juga diulang dengan Node.js 24.22.1. Browser menggunakan Microsoft Edge headless sesuai konfigurasi proyek.

| Pemeriksaan | Hasil |
| --- | --- |
| `npm test` | 34 lulus, termasuk konfigurasi, migrasi, keamanan file, dan restart proses CLI nyata |
| `npm run build` | Lulus |
| `npm run test:e2e` | 22 lulus, termasuk mode statis tanpa request API dan regresi HTTP LAN |
| `npm run test:e2e:production` | 22 lulus terhadap preview build statis |
| `npm run test:e2e:backend` | 17 lulus terhadap `npm start`, termasuk gameplay dan mode backend aktif/gagal |
| Suite `tests/server.test.mjs` dengan Node.js 24.22.1 | 10 lulus, termasuk restart proses server |
| Pemeriksaan TypeScript ketat untuk tes player/backend dan konfigurasi browser terkait | Lulus |
| `npm audit --omit=dev` | Tidak ada kerentanan yang dilaporkan |

Tes restart menjalankan entrypoint `server/index.mjs` dalam proses anak, memeriksa web dan API pada port yang sama, menghentikan proses, lalu menjalankannya kembali dengan folder data yang sama. Installation ID SQLite tetap sama. Tes keamanan juga memeriksa folder data privat, symlink/junction keluar root, dotfile, nama database, dan variasi path traversal.

Dengan hasil tersebut M2 ditutup. Milestone berikutnya adalah M3: akun lokal dan sesi. Hasil ini tidak menyatakan login, pemulihan akun, maupun cloud save sudah tersedia; endpoint dan tabel terkait belum ditambahkan.
