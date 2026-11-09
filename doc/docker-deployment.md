# Panduan Deployment Docker — maindulu 0.5.0

Panduan singkat untuk pemula (orang awam) mengenai deploy pertama kali ke Docker, variabel lingkungan, menjadikan admin, backup database, dan update deployment.

Proyek `maindulu` menyediakan dua opsi Docker:

| Mode | Apa yang dijalankan | Cocok untuk |
|------|---------------------|-------------|
| **Statis** (Nginx) | Hanya frontend, tidak ada akun/login/save server | Coba-coba cepat, tanpa database |
| **Backend** (Node.js + SQLite) | Frontend + API akun, login, save state, progres game | Deploy asli dengan akun dan data simpan |

Karena topik admin dan backup database hanya relevan pada mode **Backend**, panduan di bawah difokuskan ke sana.

---

## 1. Prasyarat

- Docker Engine + plugin Compose v2 (Linux/LXC), atau Docker Desktop dengan Linux containers (Windows: WSL2).
- `docker info` dan `docker compose version` berhasil dijalankan.
- Salinan repo lengkap, termasuk folder `public/vendor/`.
- Jalankan semua perintah dari **akar repo** (folder tempat ada `package.json`), misalnya `C:\Users\Ardi Putra\Documents\side project\maindulu`.
- Pilih **satu** deployment pada port 7777: statis **atau** backend. Jangan jalankan keduanya pada port host yang sama.

---

## 2. Deploy Pertama Kali (Mode Backend)

Dari terminal di akar repo:

```sh
# Pastikan Docker sudah hidup
docker info
docker compose version

# Salin file contoh env (hanya jika .env.backend belum ada)
cp deploy/backend.env.example .env.backend

# Edit .env.backend sesuai kebutuhan (lihat bagian berikutnya)

# Bangun image dan jalankan container di background
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d --build
```

Tunggu sampai selesai. Build pertama kali mengunduh image Node.js dan menginstal dependensi, butuh waktu beberapa menit.

Setelah selesai, buka di browser:
- **Di server itu sendiri:** `http://localhost:7777`
- **Di komputer lain di Wi-Fi sama:** `http://IP-SERVER:7777`

### Jika hanya ingin versi statis (tanpa akun/database):

```sh
docker compose -f deploy/docker-compose.yml up --build
```

Buka `http://localhost:7777` (port bisa diubah lewat variabel `MAIN_DULU_PORT`).

---

## 3. Variabel Lingkungan (Env) yang Perlu Di-set

Buat file `.env.backend` di akar repo. Isi sesuai cara akses Anda.

### Opsi A: Hanya di server sendiri (localhost) — paling aman
Jalankan langsung tanpa `.env.backend`:
```sh
docker compose -f deploy/docker-compose.backend.yml up -d --build
```

### Opsi B: Akses dari komputer lain via LAN (HTTP tanpa enkripsi)
Hanya untuk jaringan rumah/kantor yang Anda percaya. **Jangan buka ke internet.**

```dotenv
MAIN_DULU_BIND_ADDRESS=0.0.0.0
MAIN_DULU_PORT=7777
MAIN_DULU_PUBLIC_ORIGIN=http://192.168.2.251:7777
MAIN_DULU_ALLOW_INSECURE_HTTP=true
MAIN_DULU_REGISTRATION_OPEN=true
```
Ganti `192.168.2.251` dengan IP server Anda.

### Opsi C: Via HTTPS dengan reverse proxy (Nginx di depan)
```dotenv
MAIN_DULU_BIND_ADDRESS=127.0.0.1
MAIN_DULU_PORT=7777
MAIN_DULU_PUBLIC_ORIGIN=https://main.example.com
MAIN_DULU_ALLOW_INSECURE_HTTP=false
```
*Catatan: Docker ini tidak memasang sertifikat HTTPS sendiri. Proxy/sertifikat harus diatur terpisah di host atau container lain.*

### Tabel variabel penting

| Variabel | Default | Fungsi |
|----------|---------|--------|
| `MAIN_DULU_BIND_ADDRESS` | `127.0.0.1` | Interface yang dibuka; `0.0.0.0` untuk LAN |
| `MAIN_DULU_PORT` | `7777` | Port host yang dibuka di browser |
| `MAIN_DULU_PUBLIC_ORIGIN` | (kosong) | Origin akun yang diizinkan, harus sama persis dengan URL browser |
| `MAIN_DULU_PUBLIC_ORIGINS` | (kosong) | Beberapa origin dipisah koma; digabung dengan singular, misalnya HTTPS + HTTP localhost ([panduan](https-cloudflare-tunnel.md)) |
| `MAIN_DULU_ALLOW_INSECURE_HTTP` | `false` | `true` = izinkan HTTP LAN (hanya jaringan tepercaya) |
| `MAIN_DULU_REGISTRATION_OPEN` | `true` | `false` = tutup pendaftaran akun baru |
| `MAIN_DULU_CONTAINER_DATA_DIR` | `/var/lib/maindulu/data` | Folder data di dalam container/volume |

Setelah mengubah env, gunakan:
```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d --force-recreate
```

---

## 4. Menjadikan User Jadi Admin

Secara default, setiap akun yang daftar adalah role **user**. Tidak ada pendaftar pertama yang otomatis jadi admin. Promosi dilakukan lewat terminal, tidak ada tombol di UI untuk ini.

Pertama, pastikan akun sudah dibuat lewat browser (Masuk → Daftar). Jalankan perintah ini dari akar repo:

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml exec backend npm run account:role -- namauser admin
```

Ganti `namauser` dengan username yang sudah terdaftar. Contoh:
```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml exec backend npm run account:role -- budi admin
```

Untuk mengembalikan jadi user biasa:
```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml exec backend npm run account:role -- budi user
```

**Penting:**
- Perintah ini butuh container sedang berjalan (`exec`, bukan `run`).
- Role baru berlaku pada sesi berikutnya, progres dan save tidak hilang.
- Setelah login sebagai admin, buka `/admin/games` (kelola ROM/cover) dan `/admin/bios` (kelola firmware).

---

## 5. Backup Database

Data utama ada di **named volume Docker**, bukan di folder biasa di host. Jadi tidak cukup copy-paste file biasa. Backup harus lewat skrip bawaan sambil server mati.

### Langkah backup (pra-update atau rutin)

```sh
# 1. Hentikan server dulu (jangan tutup paksa)
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml stop backend

# 2. Buat backup ke folder baru di dalam volume
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml run --rm --no-deps backend node scripts/data-backup.mjs backup /var/lib/maindulu/backup-sebelum-update

# 3. Verifikasi backup tidak rusak
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml run --rm --no-deps backend node scripts/data-backup.mjs verify /var/lib/maindulu/backup-sebelum-update

# 4. Salin hasil backup keluar dari volume ke host (agar aman kalau disk server rusak)
mkdir -p ~/maindulu-backups
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml cp backend:/var/lib/maindulu/backup-sebelum-update ~/maindulu-backups/backup-sebelum-update
```

**Penting:**
- Folder tujuan backup **belum boleh ada** sebelum perintah backup dijalankan.
- Backup mencakup **akun, save/progres, dan metadata katalog** — **tidak mencakup file ROM, BIOS, dan cover**. Setelah restore, ROM/BIOS/cover harus diupload ulang.
- Backup **tidak terenkripsi**. Simpan di tempat aman dan private.
- Jangan gunakan `down -v` atau `docker volume prune` — itu akan menghapus semua data.

### Restore (pindah data ke folder baru)

```sh
# Server harus tetap mati
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml run --rm --no-deps backend node scripts/data-backup.mjs restore /var/lib/maindulu/backup-sebelum-update --to /var/lib/maindulu/data-restored
```

Lalu tambah ke `.env.backend`:
```dotenv
MAIN_DULU_CONTAINER_DATA_DIR=/var/lib/maindulu/data-restored
```

Dan jalankan ulang:
```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d --force-recreate
```

Setelah restore, semua sesi lama dicabut, Anda harus login ulang, dan ROM/BIOS/cover muncul sebagai "Berkas hilang" di admin sampai diupload ulang.

---

## 6. Update Deployment

Jika ada versi baru dari Git, caranya:

```sh
# 1. Backup dulu (langkah di bagian 5 di atas)

# 2. Ambil kode baru
git pull --ff-only

# 3. Bangun dan jalankan ulang dengan env, project, dan volume yang sama
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d --build

# 4. Cek status dan log
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml ps
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml logs --tail=50 backend
```

Jika hanya ingin ubah env tanpa build ulang:
```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d --force-recreate
```

**Jangan** paksa downgrade database. Rollback harus lewat restore backup ke folder baru, bukan overwrite database yang sudah aktif.

---

## 7. Daftar Perintah Terminal (Cheat Sheet)

Semua dijalankan dari **akar repo** (`maindulu/`). Jika pakai mode LAN, selalu sertakan `--env-file .env.backend`.

| Tujuan | Perintah |
|--------|----------|
| Cek Docker siap | `docker info` |
| Build & jalankan pertama kali | `docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d --build` |
| Jalankan tanpa build | `docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d` |
| Terapkan perubahan env | `docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d --force-recreate` |
| Lihat container yang jalan | `docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml ps` |
| Lihat log | `docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml logs -f backend` |
| Hentikan sementara | `docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml stop backend` |
| Hapus container (data volume aman) | `docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml down` |
| Promosi jadi admin | `docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml exec backend npm run account:role -- username admin` |
| Reset password admin | `docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml exec backend npm run account:reset -- username` |
| Backup | `stop backend` → `run --rm --no-deps backend node scripts/data-backup.mjs backup /var/lib/maindulu/backup-nama` → verifikasi → `cp` keluar |
| Restore | `run --rm --no-deps backend node scripts/data-backup.mjs restore <backup> --to /var/lib/maindulu/data-baru` |
| Update | `git pull` → `up -d --build` |
| Cek kesehatan server | `curl http://localhost:7777/api/health` (atau ganti dengan IP server) |

---

## 8. Ringkasan Singkat untuk Pemula

1. **Instal Docker**, buka terminal di folder `maindulu/`.
2. Salin `deploy/backend.env.example` ke `.env.backend`, edit IP jika mau akses dari HP/PC lain.
3. Jalankan `docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d --build`.
4. Daftar akun lewat browser, lalu promosi jadi admin lewat perintah `account:role`.
5. Sebelum update, **stop server → backup data → copy backup keluar container → baru update**.
6. Jangan pernah `down -v` kalau takut kehilangan data akun dan save.

---

*Sumber: `deploy/README.backend.md`, `deploy/docker-compose.backend.yml`, `deploy/Dockerfile.backend`, dan skrip di `scripts/`.*
