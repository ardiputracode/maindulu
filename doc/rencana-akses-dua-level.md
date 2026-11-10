# Rencana Gerbang Login (Gate) dan Akun Personal

Status: **Rencana — belum diimplementasikan.** Versi ini menggantikan model "Tamu vs Akun" pada revisi sebelumnya. Keputusan pengguna: gunakan **gerbang login wajib** dengan satu kredensial bersama dari `.env`; siapa pun yang tidak lolos gerbang adalah **anonim** dan tidak boleh mengakses fitur atau data apa pun. Di dalam gerbang, akun personal tetap terpisah dan opsional untuk save server.

Dokumen terkait: [Login dan progres server](rencana-login-cloud-save.md), [Role akun dan admin](admin-role-akun.md), [Akun lokal](milestone-3-akun-lokal.md), dan [API katalog](milestone-3-api-katalog.md).

## Tujuan

Menambahkan satu gerbang akses di depan seluruh aplikasi:

- **Anonim** tidak dapat melewati gerbang dan tidak dapat mengakses katalog, ROM/BIOS, game, save, atau API data.
- **Tamu** adalah pengguna yang lolos gerbang dengan kredensial bersama dari `.env`; tamu dapat memakai seluruh fitur dan data situs, dengan progres di browser.
- **Akun personal** tetap terpisah dan opsional; hanya akun personal yang dapat memakai save state server, progres server, dan backup.
- **Admin** tetap level tertinggi untuk mengelola katalog.

Gerbang bukan pengganti akun. Gerbang mengatur **siapa yang boleh masuk ke situs**; akun mengatur **siapa yang memiliki penyimpanan server**.

## Keputusan Utama

- Gerbang memakai satu username/password bersama dari `.env`, bukan akun per pengguna.
- Jika variabel gerbang tidak lengkap, **server menolak start**; tidak ada mode gerbang implisit.
- Tidak ada akses data untuk anonim, termasuk `/catalog/*.json`, `/api/games`, `/api/bios`, dan file ROM/BIOS.
- Setelah lolos gerbang, tamu dapat menjelajah katalog, mengunduh/memainkan ROM/BIOS server, dan memakai save browser.
- Save state server, progres server, dan backup tetap memerlukan login akun personal di dalam gerbang.
- Cookie gerbang dan cookie akun dipisahkan; logout gerbang juga mencabut sesi akun.
- Role database tidak berubah: tetap `user` dan `admin`. "Tamu" bukan role, melainkan status lolos gerbang.
- Build statis tanpa backend **tidak dapat menegakkan gerbang**; hanya deployment backend Node.js yang dapat menjalankannya.

## Model Akses

| Area | Anonim (tidak lolos gerbang) | Tamu (lolos gerbang) | Akun personal | Admin |
| --- | --- | --- | --- | --- |
| Halaman gerbang | Ya | — | — | — |
| Shell aplikasi (JS/CSS, tanpa data) | Ya | Ya | Ya | Ya |
| Katalog metadata | Tidak | Ya | Ya | Ya |
| Unduh & main ROM/BIOS server | Tidak | Ya | Ya | Ya |
| Main ROM lokal sendiri | Tidak | Ya | Ya | Ya |
| Save browser / IndexedDB | Tidak | Ya | Ya | Ya |
| Save state server & progres server | Tidak | Tidak | Ya | Ya |
| Kelola koleksi katalog | Tidak | Tidak | Tidak | Ya |

## Alur

```text
Buka web
  └─ Cek cookie gerbang (/api/gate/session)
       ├─ belum lolos / kedaluwarsa → GatePage (hanya halaman login)
       │     └─ POST /api/gate/login (username/password dari .env)
       │           ├─ gagal → pesan umum + rate limit
       │           └─ berhasil → cookie maindulu_gate → shell aplikasi
       └─ lolos → shell aplikasi
             ├─ Tamu: katalog, ROM/BIOS server, main, save browser
             └─ Akun personal (opsional):
                   ├─ login /api/auth/login
                   ├─ save state server & progres server
                   └─ backup akun
```

## Konfigurasi `.env`

| Variabel | Wajib | Keterangan |
| --- | --- | --- |
| `MAIN_DULU_GATE_USERNAME` | Ya | Username gerbang bersama. |
| `MAIN_DULU_GATE_PASSWORD` | Salah satu | Password gerbang plaintext; dibandingkan constant-time. |
| `MAIN_DULU_GATE_PASSWORD_HASH` | Salah satu | Alternatif hash scrypt; lebih disarankan agar `.env` tidak menyimpan plaintext. |
| `MAIN_DULU_GATE_SESSION_DAYS` | Tidak | Masa berlaku cookie gerbang; default 7 hari. |
| `MAIN_DULU_DEFAULT_USERNAME` / `MAIN_DULU_DEFAULT_PASSWORD` | Tidak | Terpisah dari gerbang; hanya untuk seed akun admin personal pertama bila tabel `users` kosong. |

Aturan konfigurasi:

- `readConfig` menolak start jika `MAIN_DULU_GATE_USERNAME` kosong atau tidak ada password/hash yang valid.
- Username divalidasi dengan aturan yang sama seperti akun; password minimal 6–128 karakter.
- Jangan mencetak password, hash, atau token gerbang ke log.
- `.env.example`, `.env.backend`, `deploy/backend.env.example`, dan compose Docker wajib memuat variabel gerbang.

## Rancangan Backend

### 1. Modul gerbang baru

Berkas baru `server/auth/gate.mjs`:

- `createGate(config, db)` mengembalikan `{ guard, login, logout, session }`.
- Token cookie: `v1.<expiresAtUnix>.<hmacHex>`.
- HMAC-SHA256 dengan kunci turunan dari kredensial gerbang + `installation_id`:
  - `key = HKDF-SHA256(ikm = password/hash, salt = installation_id, info = "maindulu-gate-v1")`.
- Verifikasi memakai `timingSafeEqual`; token rusak/kedaluwarsa ditolak.
- Karena kunci diturunkan dari kredensial, **mengganti password/hash gerbang otomatis membatalkan semua cookie lama**.
- Cookie `maindulu_gate`: `HttpOnly`, `SameSite=strict`, `Secure` bila origin HTTPS, `path=/`, `maxAge` sesuai `MAIN_DULU_GATE_SESSION_DAYS`.
- Rate limit login memakai `createLimiter` yang sudah ada (per IP).
- Validasi origin/`Sec-Fetch-Site` untuk `POST` login/logout agar tidak dapat dipanggil lintas situs.

### 2. Endpoint gerbang

| Endpoint | Akses | Perilaku |
| --- | --- | --- |
| `POST /api/gate/login` | Publik | Body JSON `{ username, password }`; bandingkan constant-time; set cookie; pesan gagal umum. |
| `GET /api/gate/session` | Publik | `{ authenticated: boolean, expiresAt?: number }`; tidak membocorkan kredensial. |
| `POST /api/gate/logout` | Publik (same-origin) | Hapus cookie gerbang dan cookie sesi akun; hapus baris sesi akun bila ada. |

Login gerbang **tidak** membuat sesi akun personal. Login akun tetap melalui `/api/auth/login` setelah gerbang lolos.

### 3. Penegakan default-deny

Tambahkan hook `onRequest` di `server/app.mjs`, sebelum route katalog, save, admin, dan static didaftarkan:

```js
const publicExact = new Set([
  '/', '/index.html',
  // seluruh route SPA yang menyajikan shell HTML
  '/console', '/library', '/riwayat', '/favorit',
  '/cara-bermain', '/pengaturan', '/main',
  '/admin', '/admin/games', '/admin/bios', '/admin/scan', '/admin/metadata',
  '/api/health',
  '/api/gate/login', '/api/gate/session', '/api/gate/logout',
])
const publicPrefixes = ['/assets/', '/vendor/', '/player/']

app.addHook('onRequest', async request => {
  const path = request.url.split('?')[0]
  if (publicExact.has(path) || publicPrefixes.some(prefix => path.startsWith(prefix))) return
  gate.requireSession(request)
})
```

Konsekuensi:

- Semua jalur lain **default-deny**: `/catalog/*`, `/api/games*`, `/api/bios*`, `/api/catalog/*`, `/games/*`, `/bios/*`, `/covers/*`, `/api/auth/*`, `/api/saves*`, `/api/game-saves*`, `/api/save-backups*`, `/api/admin/*`.
- `/api/auth/*` ikut di belakang gerbang; login akun hanya bisa dicoba setelah gerbang lolos.
- Shell HTML dan aset aplikasi tetap publik agar `GatePage` bisa dirender; keduanya tidak memuat data pengguna.
- `401` dikembalikan sebagai JSON oleh error handler global yang sudah ada.

### 4. Capability health

`GET /api/health` menambahkan `capabilities.gate: true`. Frontend memakai capability ini untuk menentukan apakah gerbang tersedia.

`src/lib/backend.ts` perlu menerima `gate` sebagai capability opsional agar respons health baru tidak ditolak parser.

### 5. Seed akun admin personal (opsional, terpisah)

- `MAIN_DULU_DEFAULT_USERNAME` / `MAIN_DULU_DEFAULT_PASSWORD` tetap terpisah dari gerbang.
- Seed hanya berjalan saat tabel `users` kosong, saat startup `createApp`, dengan role `admin`.
- Jangan mencetak password/kode; minta pengguna mengganti password setelah login pertama.
- Jika tidak dipakai, admin dapat dibuat dengan daftar akun lalu `npm run account:role`.

## Panduan Nada Teks

Teks gerbang dan akun harus terasa satu keluarga dengan halaman utama: hangat, santai, dan bernostalgia — bukan bahasa dokumen teknis.

### Prinsip

- Sapa **"kamu"**, bukan "Anda".
- Kalimat pendek; satu ide per baris.
- Metafora ringan: **pintu masuk, ruang main, simpanan, jempol, jeda**.
- Hangat tapi tetap jelas saat error: jelaskan dulu, baru lembutkan.
- Hindari istilah kaku di alur utama: *anonim, kredensial, autentikasi, publik, opsional, gerbang*.
- Istilah teknis hanya boleh di Pengaturan/status/legal, dan tetap tenang.
- Jangan bercanda saat kegagalan keamanan atau kehilangan data.

### Glosarium UI

| Istilah teknis (dokumen) | Teks UI |
| --- | --- |
| Gerbang / gate | **Pintu masuk** |
| Anonim | Tidak ditampilkan ke pengguna |
| Tamu | **Tamu** |
| Akun personal | **Akun main** |
| Save state server | **Simpanan server** |
| Save browser | **Simpanan browser** |
| Aset publik | **Terbuka untuk tamu** |

Label form tetap **Username** dan **Password** agar jelas, dengan bantuan kecil: *"Dari pengelola, ya."* Jangan mengganti label menjadi "Nama tamu/Kunci" karena membingungkan saat login.

### Contoh nada

| Jangan | Pakai |
| --- | --- |
| Autentikasi gagal. Kredensial tidak valid. | Username atau password belum cocok. Coba lagi, ya. |
| Login opsional. Kamu tetap bisa bermain tanpa akun. | Akun ini opsional. Tanpa akun, simpanan tetap di browser. |
| Aset aktif dapat diunduh publik, termasuk oleh tamu. | Aset aktif hanya terbuka untuk tamu yang sudah lewat pintu masuk. |
| Sesi berakhir. Silakan autentikasi ulang. | Pintunya terkunci lagi. Masuk sekali lagi, ya. |

## Rancangan Frontend

### 1. Gate page dan hook

Berkas baru:

- `src/components/GatePage.tsx` — layar penuh berisi form username/password gerbang.
- `src/lib/gate.ts` — pemanggilan `/api/gate/session`, `/api/gate/login`, `/api/gate/logout`.
- `src/lib/useGate.ts` — state `checking` / `authenticated` / `anonymous` / `unavailable`, plus aksi login/logout.

Perilaku:

- `checking` → splash singkat.
- `anonymous` → hanya `GatePage`; jangan memuat katalog atau API data.
- `authenticated` → shell aplikasi seperti sekarang.
- `unavailable` → pesan gangguan backend dan tombol coba lagi; jangan menampilkan data.

### 2. Pemisahan `App`

`src/App.tsx` perlu dipecah agar hook tidak dipanggil bersyarat:

- `App` menjadi pembungkus yang memanggil `useBackendStatus` dan `useGate`.
- Komponen `Workspace` (isi `App` saat ini) baru dipasang setelah gerbang lolos.
- Efek pemuatan katalog, `useAccount`, `useLiveCatalog`, dan `useMetadataTasks` dipindahkan ke `Workspace`.

Dengan pemisahan ini, tamu yang belum lolos gerbang tidak pernah memicu permintaan katalog.

### 3. Sesi kedaluwarsa dan logout

- Jika panggilan data mengembalikan `401` karena gerbang kedaluwarsa, `useGate` di-refresh dan `Workspace` dilepas; `GatePage` tampil lagi.
- Logout gerbang memanggil `/api/gate/logout`, yang juga membersihkan cookie/sesi akun personal.
- Logout akun personal saja tidak mengeluarkan pengguna dari gerbang.

### 4. Build statis tanpa backend

- Jika `capabilities.gate` tidak ada (build statis), gerbang tidak tersedia dan data bersifat publik.
- Tampilkan peringatan di Pengaturan/status: build statis tidak boleh dipakai untuk akses privat.
- Deployment privat wajib memakai backend Node.js dengan variabel gerbang terisi.

### 5. Penggantian teks UI

| Berkas | Teks sekarang | Teks pengganti |
| --- | --- | --- |
| `src/components/GatePage.tsx` (baru) | — | Eyebrow: **PINTU MASUK RUANG MAIN**. Judul: **Sebelum main, buka pintunya dulu.** Isi: Ruang ini privat. Masukkan username dan password dari pengelola, lalu biarkan jempol yang mengingat. Tombol: **Buka pintu**. Loading: **Membuka pintu…**. Error: **Username atau password belum cocok. Coba lagi, ya.** Kedaluwarsa: **Pintunya terkunci lagi. Masuk sekali lagi, ya.** |
| `src/components/AccountDialog.tsx` | Login opsional. Kamu tetap bisa bermain tanpa akun. | **Akun mainmu.** Akun ini opsional. Tanpa akun, simpanan tetap di browser. Dengan akun, simpanan ikut ke server. Footer: Main tetap bisa tanpa akun. Akun cuma buat simpanan yang ikut ke server. |
| `src/components/AccountDialog.tsx` | Informasi akun belum dapat dimuat. … Kamu tetap bisa bermain sebagai tamu. | **Informasi akun belum bisa diambil.** Kamu tetap bisa main sebagai tamu; simpanan tetap di browser. |
| `src/App.tsx` | Sesi akun belum dapat dipastikan. Mulai sebagai tamu dengan save browser? Untuk save server, batalkan dan periksa akun dahulu. | **Sesi akun belum bisa dipastikan.** Lanjut sebagai tamu? Simpanan tetap di browser, belum ikut ke server. |
| `src/App.tsx` | Save state akun · manual / Progres di browsermu | `Tamu · simpanan di browser` / `Akun · simpanan di server` |
| `src/App.tsx` (kartu privasi) | Login opsional hanya tersedia bila backend akun diaktifkan. … save tamu tetap di browser. | **Ruang mainmu, tetap milikmu.** Ruang ini dijaga pintu masuk. Setelah masuk, kamu main sebagai tamu: katalog, ROM/BIOS server, dan simpanan di browser. Mau simpanan ikut ke server? Buat akun main. ROM/BIOS milikmu tidak pernah diunggah. |
| `src/App.tsx` (panduan) | Blok **Tamu:** dan **Akun:** lama | **Tamu:** sudah di dalam ruang main. Jelajah katalog, buka ROM/BIOS server, dan simpan progres di browser. Nggak perlu akun. **Akun:** biar simpanan ikut ke server. Tiga slot manual, Autosave opsional. NES tersinkron otomatis; PS1 masih percobaan. |
| `src/App.tsx` (legal) | …file server bersifat publik. | …file server hanya terbuka setelah pintu masuk, bukan taman publik. |
| `src/components/BackendStatus.tsx` | Main sebagai tamu… / Kamu tetap bisa bermain sebagai tamu… / Mode tamu tetap bisa digunakan… | Backend tidak aktif. Tanpa backend, pintu masuk dan simpanan server tidak tersedia. / Memeriksa backend dan pintu masuk… / Pintu masuk aktif. Akun main opsional membuka simpanan server. / Backend sedang istirahat. Katalog dan data belum bisa dibuka sampai pintu masuk tersedia. |
| `src/components/AdminCatalog.tsx` | Aset aktif dapat diunduh publik, termasuk oleh tamu. | Aset aktif hanya terbuka untuk tamu yang sudah lewat pintu masuk. |
| `src/components/CatalogScan.tsx` | Berkas valid otomatis masuk katalog dan dapat diunduh publik, termasuk oleh tamu. | Berkas valid otomatis masuk katalog. Hanya tamu yang sudah lewat pintu masuk yang bisa mengunduhnya. |
| `src/components/Player.tsx` | Sesi ini dimulai sebagai tamu. Buka ulang game untuk memakai save state akun… | Sesi ini main sebagai tamu. Simpanan ada di browser. Mau simpanan ikut ke server? Masuk akun, lalu buka ulang game. |

## Keamanan

- Kredensial gerbang adalah **satu faktor bersama**; siapa pun yang memilikinya dapat masuk sebagai tamu. Tidak ada akuntabilitas per orang di lapisan gerbang.
- Simpan password sebagai hash scrypt bila memungkinkan; plaintext hanya untuk kemudahan lokal.
- Batasi percobaan login per IP; gunakan pesan gagal umum agar tidak membocorkan field yang salah.
- Jangan pernah mencatat password, hash, token, atau isi cookie di log.
- Gunakan HTTPS untuk akses jaringan; cookie `Secure` hanya aktif pada origin HTTPS.
- Logout gerbang bersifat stateless: cookie perangkat ini dihapus, tetapi cookie perangkat lain tetap berlaku sampai kedaluwarsa. Untuk mencabut semua, ganti kredensial gerbang.
- Pastikan reverse proxy/CDN tidak meng-cache respons data maupun aset yang dilindungi.
- `GET /api/health` tetap publik untuk healthcheck container, tetapi hanya berisi status/capability tanpa data pengguna.
- Jangan menambahkan endpoint reset gerbang publik; pemulihan dilakukan dengan mengubah `.env` dan restart server.

## Milestone Implementasi

### Cara Pengerjaan

- Kerjakan satu milestone dalam satu lingkup, lalu tinjau sebelum lanjut.
- Checklist dicentang hanya setelah implementasi dan pengujian selesai.
- Catat hasil uji dan batasan pada milestone terkait.
- Pengujian keamanan dilakukan di setiap milestone, bukan ditunda.

| Milestone | Hasil utama | Dependensi | Status |
| --- | --- | --- | --- |
| G1 | Backend gerbang: konfigurasi wajib, token, endpoint, default-deny | — | Rencana |
| G2 | Frontend gerbang: GatePage, useGate, pemisahan App, penanganan 401 | G1 | Rencana |
| G3 | Integrasi akun personal dan penggantian teks UI | G1, G2 | Rencana |
| G4 | Env, deployment, dokumentasi, dan rotasi kredensial | G1 | Rencana |
| G5 | Verifikasi regresi, build, dan penutupan | G1–G4 | Rencana |

### G1 — Backend Gerbang

Tujuan: menolak semua akses data bagi anonim dan menerima tamu dengan kredensial `.env`.

- [ ] Tambahkan `MAIN_DULU_GATE_USERNAME`, `MAIN_DULU_GATE_PASSWORD`/`_HASH`, dan `MAIN_DULU_GATE_SESSION_DAYS` ke `server/config.mjs`; tolak start jika tidak lengkap.
- [ ] Buat `server/auth/gate.mjs` dengan token HMAC, verifikasi constant-time, dan opsi cookie.
- [ ] Tambahkan endpoint `POST /api/gate/login`, `GET /api/gate/session`, `POST /api/gate/logout`.
- [ ] Tambahkan hook default-deny di `server/app.mjs` dengan allowlist shell dan endpoint gerbang.
- [ ] Tambahkan `capabilities.gate` pada `/api/health` dan terima di `src/lib/backend.ts`.
- [ ] Pastikan `/catalog/*`, `/api/games*`, `/api/bios*`, `/games/*`, `/bios/*`, `/covers/*`, dan `/api/auth/*` mengembalikan `401` tanpa cookie gerbang.
- [ ] Uji token rusak, kedaluwarsa, tamper, rotasi kredensial, dan rate limit.

**Selesai jika:** anonim tidak dapat mengakses satu pun jalur data, tamu dengan kredensial benar dapat mengakses semuanya, dan server menolak start bila konfigurasi gerbang tidak lengkap.

### G2 — Frontend Gerbang

Tujuan: menampilkan halaman gerbang sebelum shell aplikasi dan menangani sesi kedaluwarsa.

- [ ] Buat `src/lib/gate.ts` dan `src/lib/useGate.ts`.
- [ ] Buat `src/components/GatePage.tsx` dengan form username/password, pesan error, dan status loading.
- [ ] Pecah `src/App.tsx` menjadi pembungkus gerbang dan `Workspace`.
- [ ] Pindahkan pemuatan katalog dan hook akun ke `Workspace` agar tidak berjalan sebelum gerbang lolos.
- [ ] Tangani `401` data sebagai gerbang kedaluwarsa; tampilkan `GatePage` lagi.
- [ ] Tambahkan aksi logout gerbang yang juga membersihkan sesi akun.
- [ ] Uji alur login benar/salah, refresh, kedaluwarsa, dan logout.

**Selesai jika:** anonim hanya melihat `GatePage`, tamu masuk ke shell tanpa permintaan data sebelum gerbang lolos, dan sesi kedaluwarsa kembali ke gerbang dengan aman.

### G3 — Integrasi Akun Personal dan Teks

Tujuan: memastikan akun personal tetap terpisah dan seluruh teks UI sesuai model gerbang.

- [ ] Pastikan `/api/auth/*` hanya dapat diakses setelah gerbang lolos.
- [ ] Pastikan logout gerbang mencabut cookie dan baris sesi akun personal.
- [ ] Pastikan fitur save server tetap hanya tampil untuk akun personal.
- [ ] Terapkan [Panduan Nada Teks](#panduan-nada-teks) pada seluruh teks gerbang, akun, panduan, dan player.
- [ ] Ganti seluruh teks pada tabel [penggantian teks UI](#5-penggantian-teks-ui).
- [ ] Sapu istilah kaku di alur utama (`anonim`, `kredensial`, `autentikasi`, `publik`, `gerbang`) dan sisakan hanya di Pengaturan/status/legal.
- [ ] Perbarui assertion teks di e2e yang mengecek string lama.
- [ ] Tambahkan peringatan build statis tanpa gerbang di Pengaturan/status.
- [ ] Uji alur: gerbang → tamu main → login akun → save server → logout gerbang.

**Selesai jika:** tamu tidak dapat memakai save server tanpa akun, logout gerbang tidak meninggalkan sesi akun, dan tidak ada teks yang menyebut file server publik.

### G4 — Env, Deployment, dan Dokumentasi

Tujuan: memastikan gerbang wajib terpasang di semua deployment backend.

- [ ] Perbarui `.env.example`, `.env.backend`, `deploy/backend.env.example`, dan compose Docker.
- [ ] Dokumentasikan penolakan start bila variabel gerbang kosong.
- [ ] Dokumentasikan rotasi kredensial gerbang dan efeknya terhadap cookie lama.
- [ ] Dokumentasikan bahwa build statis tidak memiliki gerbang dan tidak untuk akses privat.
- [ ] Perbarui README/panduan deployment terkait.
- [ ] Perbarui helper tes backend agar menyertakan kredensial gerbang.

**Selesai jika:** instalasi baru dengan `.env` gerbang berjalan, instalasi tanpa gerbang menolak start, dan dokumentasi deployment menjelaskan batas build statis.

### G5 — Verifikasi dan Regresi

Tujuan: memastikan gerbang tidak merusak akun, save, admin, atau mode statis.

- [ ] Jalankan unit/integrasi backend dan build frontend.
- [ ] Jalankan e2e mode backend nyata dengan alur gerbang + akun.
- [ ] Jalankan e2e mode statis dan pastikan peringatan "tanpa gerbang" muncul.
- [ ] Uji regresi save state, progres game, backup, pemulihan akun, dan admin.
- [ ] Uji sesi gerbang kedaluwarsa, rotasi kredensial, dan logout gerbang.
- [ ] Catat bukti dan batasan pada dokumen ini.

**Selesai jika:** seluruh kriteria selesai terpenuhi dan tidak ada regresi pada akun, save, admin, maupun build statis.

## Pengujian

### Matriks `curl`

| Skenario | Harapan |
| --- | --- |
| `GET /api/gate/session` tanpa cookie | `200 { authenticated: false }` |
| `GET /catalog/games.json` tanpa cookie | `401` JSON |
| `GET /api/games` tanpa cookie | `401` JSON |
| `GET /games/<id>/rom/<file>` tanpa cookie | `401` JSON |
| `GET /bios/<id>/<file>` tanpa cookie | `401` JSON |
| `POST /api/gate/login` password salah | `401` (atau `429` bila limit) |
| `POST /api/gate/login` benar | `200` + `Set-Cookie: maindulu_gate` |
| Ulangi seluruh jalur data dengan cookie gerbang | `200`/`206` |
| `POST /api/auth/login` tanpa cookie gerbang | `401` |
| Cookie gerbang + akun → `/api/saves` | `200` |
| Cookie gerbang akun biasa → `/api/admin/*` | `403` |
| `POST /api/gate/logout` lalu akses data | `401` |
| Ganti kredensial gerbang → cookie lama | `401` |
| Akses `/`, `/assets/*`, `/vendor/*`, `/player/*` tanpa cookie | `200` |

### Unit dan integrasi

- Token HMAC valid, tamper, kedaluwarsa, dan rotasi kredensial.
- Rate limit login gerbang per IP.
- Perbandingan password constant-time; pesan gagal tidak membocorkan field.
- Hook default-deny tidak memblokir shell dan endpoint gerbang.
- Logout gerbang menghapus cookie gerbang dan sesi akun personal.
- Konfigurasi tanpa gerbang menolak start dengan pesan jelas.
- Health menyertakan `gate: true` dan parser frontend menerimanya.

### Browser

- Anonim: hanya `GatePage`; tidak ada permintaan katalog/data di Network.
- Login salah: pesan umum, tetap di `GatePage`.
- Login benar: shell tampil, katalog dimuat.
- Tamu: main ROM/BIOS server, save browser berjalan.
- Akun: save server tersedia; logout akun tetap di dalam gerbang.
- Logout gerbang: kembali ke `GatePage`; data berikutnya `401`.
- Build statis: peringatan "tanpa gerbang" tampil; data publik (sesuai batasan).

## Kriteria Selesai

- Server menolak start bila konfigurasi gerbang tidak lengkap.
- Anonim tidak dapat mengakses katalog, ROM/BIOS, game, save, atau API data.
- Tamu yang lolos gerbang dapat menjelajah katalog, mengunduh/memainkan ROM/BIOS server, dan memakai save browser.
- Save state server, progres server, dan backup hanya untuk akun personal.
- Logout gerbang mencabut sesi akun personal dan mengembalikan pengguna ke halaman gerbang.
- Mengganti kredensial gerbang membatalkan cookie gerbang lama.
- Build statis tanpa backend secara eksplisit dinyatakan tidak memiliki gerbang.
- Teks gerbang dan akun mengikuti nada halaman utama; tidak ada istilah kaku di alur utama.
- Tidak ada regresi pada akun, save, backup, pemulihan, admin, dan build frontend.

## Risiko dan Keputusan Lanjutan

- **Kredensial bersama:** tidak ada akuntabilitas per pengguna di lapisan gerbang. Jika itu dibutuhkan, gerbang harus memakai akun personal, bukan kredensial bersama.
- **Penyimpanan `.env`:** plaintext lebih mudah tetapi lebih berisiko; dukung `MAIN_DULU_GATE_PASSWORD_HASH` dan sarankan hash.
- **Logout stateless:** perangkat lain tetap login sampai cookie kedaluwarsa. Rotasi kredensial adalah cara mencabut semua.
- **Build statis:** tidak ada gerbang; jangan gunakan untuk deployment privat. Ini batasan arsitektur, bukan bug.
- **Health publik:** hanya status/capability. Jika dianggap terlalu terbuka, healthcheck container dapat dipindah ke endpoint loopback terpisah.
- **Proxy/CDN:** pastikan tidak meng-cache data atau aset yang dilindungi; cookie harus diteruskan.
- **Tes lama:** hampir semua tes backend membuat app tanpa env gerbang dan akan gagal sampai helper diperbarui; ini konsekuensi langsung dari keputusan "server menolak start".
- **Seed admin:** `MAIN_DULU_DEFAULT_*` terpisah dari gerbang; jangan mencampur keduanya agar tidak membingungkan operator.
