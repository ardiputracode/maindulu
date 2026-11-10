# Pintu masuk dan akun main

Backend Node.js mewajibkan **satu username/password bersama** sebelum katalog,
ROM/BIOS, cover, atau API akun/save/admin dapat diakses. Setelah masuk, kamu
bermain sebagai **Tamu**; akun main terpisah hanya diperlukan untuk simpanan
server, progres server, dan backup. Role database tetap `user` / `admin`.

## Instalasi dan upgrade

1. Untuk `npm start`, salin `.env.example` ke `.env` **hanya jika belum ada**.
   Docker memakai `deploy/backend.env.example` → `.env.backend`; gunakan
   `--env-file .env.backend` pada semua perintah Compose.
2. Isi `MAIN_DULU_GATE_USERNAME` (3–24 huruf/angka/underscore; tidak membedakan
   huruf besar) serta `MAIN_DULU_GATE_PASSWORD` (6–128 karakter), atau hash scrypt.
   Contoh sengaja membiarkan password kosong: **server menolak start sampai
   dikonfigurasi**, termasuk saat upgrade instalasi lama. Tidak ada mode bypass.
3. `MAIN_DULU_GATE_SESSION_DAYS` opsional, default 7, rentang 1–365 hari.
4. Pasang origin yang sama dengan URL browser melalui `MAIN_DULU_PUBLIC_ORIGIN`
   / `MAIN_DULU_PUBLIC_ORIGINS`. Gunakan HTTPS untuk jaringan. HTTP LAN memerlukan
   opt-in eksplisit dan bukan koneksi terenkripsi.
5. Build dan jalankan Node, atau recreate container dengan volume lama tetap:

```sh
npm run build
npm start
# Docker:
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d --build
```

Secret hanya untuk runtime backend. Jangan memakai `VITE_`, build arg, Git,
screenshot, dump environment, atau `docker compose config` tanpa `--quiet`.
`/api/health` tetap terbuka untuk healthcheck dan menyatakan `capabilities.gate`.

## Hash password

Disarankan menjalankan `npm run gate:hash` pada terminal interaktif Node 24+.
Password dan konfirmasi tidak ditampilkan dan tidak diterima sebagai argumen.
Perintah operator ini sengaja menampilkan **satu baris hash**; simpan secara
privat di `.env` / env-file lalu hapus plaintext. Jangan membagikan outputnya.
Startup dan request server tidak mencetak hash, password, token, atau cookie.

Tanpa Node di host, image backend juga menyertakan helper ini (tidak memerlukan
server berjalan atau volume):

```sh
docker run --rm -it --entrypoint node maindulu-backend:0.5.0 scripts/hash-gate-password.mjs
```

Gunakan **petik tunggal** pada hash di env-file agar `$` tidak diinterpolasi
Compose. Di kolom Environment Portainer, masukkan nilai hash mentah (tanpa
petik pembungkus). Format yang didukung sama dengan akun:
`scrypt$32768$8$3$<salt hex 32 karakter>$<key hex 128 karakter>`.
Jika `_HASH` terisi, hash diprioritaskan; hash rusak tetap menolak startup
meskipun plaintext valid tersedia. Hash baru dari password sama memakai salt
baru dan juga mencabut cookie lama.

## Rotasi dan logout

- Ganti username/password/hash, lalu restart Node. Untuk Docker jalankan
  `docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d --force-recreate`.
  `restart` saja tidak memuat perubahan environment Compose.
- Semua cookie pintu masuk lama langsung tidak valid karena kunci HMAC berubah.
  `installation_id` juga mengikat token ke instalasi; jangan menyalin/ubah ID itu
  sebagai cara reset. Restore metadata yang mempertahankan ID bukan rotasi:
  ganti kredensial pintu masuk setelah restore jika ingin mencabut semua cookie.
  Backup akun/save tidak memuat `.env`; simpan konfigurasi secara terpisah dan privat.
- **Pengaturan → Keluar ruang main** menghapus cookie pintu masuk dan cookie
  akun perangkat ini, serta mencabut baris sesi akun di database. Perangkat lain
  tetap masuk sampai kedaluwarsa/rotasi. Cookie gerbang stateless yang sudah
  dicuri masih berlaku sampai rotasi/kedaluwarsa; logout bukan denylist token.
- **Keluar akun** hanya mengakhiri akun main, bukan akses Tamu.
- Cookie pintu masuk `maindulu_gate`: HttpOnly, SameSite Strict, path `/`, Secure
  pada origin HTTPS. Cookie akun `maindulu_session` tetap path `/api`.
- Tidak ada reset pintu masuk lewat API. Pemulihan dilakukan pengelola melalui
  env dan restart. Kredensial bersama tidak menyediakan audit per orang.

## Admin personal pertama

`MAIN_DULU_DEFAULT_USERNAME` + `MAIN_DULU_DEFAULT_PASSWORD` terpisah dari pintu
masuk. Bila keduanya terisi dan tabel `users` kosong, startup membuat satu admin
personal. Jika users sudah ada, tidak mengubah akun/role/password siapa pun.
Ganti password setelah login pertama, terbitkan kode pemulihan, lalu hapus seed
dari env. Kode seed tidak dicetak. Alternatif: daftar akun main lalu jalankan
`npm run account:role -- username admin` dengan environment backend yang sama.
Perintah npm akun/data/recovery membaca `.env` seperti `npm start`; environment
proses tetap mengalahkan file. Untuk `.env.backend` tanpa Docker, jalankan Node
dengan `--env-file=.env.backend` pada skrip terkait. `docker compose exec` memakai
environment container yang sudah dikonfigurasi, tanpa menyalin secret ke image.

## Proxy, cache, dan batas perlindungan

Proxy harus meneruskan **semua jalur** ke Node, termasuk `/catalog/`, `/games/`,
`/bios/`, dan `/covers/`, serta mempertahankan Host, Cookie dan Set-Cookie.
Jangan membuat alias Nginx/file server/CDN terpisah yang melewati guard.
Matikan shared cache untuk semua data/aset terlindungi; jangan gunakan aturan
Cache Everything. Hormati `no-store` dan `private, no-cache`: HTTP cache privat
ROM/BIOS boleh revalidate, tetapi tidak boleh mengirim byte/304 sebelum cookie
gerbang diverifikasi. IndexedDB tetap memeriksa server sebelum reuse.

HTML shell, `/assets/`, `/vendor/`, `/player/`, health dan endpoint pintu masuk
terbuka, tetapi tidak memuat katalog/data pengguna. Semua jalur lain default-deny,
termasuk API yang belum dikenal, HEAD, range, dan endpoint login akun personal.
Jangan menaruh data privat di folder aset shell. Pintu masuk tidak mengenkripsi
atau menghapus byte/cache/save browser yang pernah diterima. Pengguna dengan
akses profil browser/OS tetap dapat membaca data lokal itu; logout bukan wipe.

## Build statis

`npm run dev`, `npm run preview`, dan Compose Nginx **tanpa backend tidak punya
gerbang**. Katalog/ROM/BIOS di distribusi statis dapat diunduh siapa pun.
Pengaturan/status menampilkan peringatan “tanpa gerbang”. Jangan memakai build
statis untuk akses privat; `.env` gerbang tidak bisa mengamankan Nginx.
Backend yang diaktifkan tetapi gagal tidak turun diam-diam ke mode statis:
Workspace/data ditutup sampai pintu masuk tersedia lagi.

Desain, checklist dan bukti regresi: [rencana akses dua level](rencana-akses-dua-level.md).

Untuk mengulang tes keamanan pintu masuk secara terisolasi: `npm run build`,
lalu `npm run test:e2e:gate`. Setiap skenario membuat backend nyata dan data
sementara sendiri; limiter produksi tidak dilemahkan untuk pengujian.
