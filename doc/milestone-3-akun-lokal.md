# M3 — Akun Lokal dan Sesi

Status: M3 selesai. Akun lokal, sesi, ganti password, kode pemulihan saat daftar, dan regresi mode tamu/statis telah diverifikasi.

M3 menambahkan akun lokal opsional di atas backend M2. Tidak ada ketergantungan Google, email, atau layanan autentikasi eksternal. **Login belum mengaktifkan cloud save**: favorit, riwayat, pengaturan, memcard, dan save state masih mengikuti penyimpanan browser yang ada.

## Cara Menggunakan

Gunakan Node.js 24+ dan jalankan backend, bukan preview statis:

```sh
npm install
npm run build
npm start
```

Buka **http://localhost:7777**, pilih **Masuk → Belum punya akun? Daftar**, lalu buat akun lokal. Setelah berhasil, simpan kode pemulihan yang ditampilkan sebelum menutup dialog. Kode dapat diunduh sebagai berkas teks lokal. Tombol Selesai baru aktif setelah pengguna menyatakan kode sudah disimpan.

- Pengguna tetap boleh langsung bermain tanpa membuka dialog akun.
- Setelah login, tombol Masuk berubah menjadi username. Buka tombol itu untuk ganti password atau keluar akun.
- Mengganti password mencabut semua sesi akun, termasuk perangkat/browser lain. Masuk lagi memakai password baru.
- Menutup tab bukan logout; cookie sesi bertahan sampai kedaluwarsa atau dicabut.
- Browser perlu mengizinkan cookie pihak pertama untuk fitur akun. Progres browser pada perangkat/profil yang sama belum dipisah per akun pada M3; login tidak memigrasikan atau mengganti save tamu secara otomatis.
- Pemulihan password, penerbitan ulang kode, dan reset admin lokal **belum tersedia**. Itu tetap lingkup M4. Jangan menganggap kode sudah bisa dipakai untuk reset pada M3.
- Frontend statis (`npm run dev`, `npm run preview`, atau hosting statis tanpa opt-in) tetap berjalan tanpa fitur akun dan tanpa request API autentikasi.

## Kebijakan yang Ditetapkan

| Aspek | Kebijakan M3 |
| --- | --- |
| Username | ASCII 3–24 karakter, huruf a–z/A–Z, angka, atau `_`; spasi tepi dipangkas; disimpan huruf kecil |
| Keunikan | Username yang berbeda kapitalisasi menjadi akun yang sama, bukan akun berbeda |
| Password | 6–128 Unicode code point, maksimal 512 byte UTF-8; tidak di-trim atau dinormalisasi |
| Email | Tidak diperlukan |
| Pendaftaran | Terbuka secara default pada server yang bind localhost; pengelola dapat menutupnya lewat konfigurasi |
| Sesi login | Masa berlaku tetap 7 hari, tidak otomatis diperpanjang setiap request |
| Sesi CSRF anonim | 1 jam, hanya dibuat ketika aksi akun perlu bootstrap CSRF |
| Pemulihan | Kode acak 256-bit diterbitkan saat daftar; pemakaiannya baru di M4 |

### Pengaturan Pendaftaran dan Origin

M2 tetap mendukung konfigurasi host/port/folder data. M3 menambahkan:

| Variabel | Default | Tujuan |
| --- | --- | --- |
| `MAIN_DULU_REGISTRATION_OPEN` | `true` | `true` untuk membuka atau `false` untuk menutup pendaftaran; login akun yang sudah ada tetap tersedia |
| `MAIN_DULU_PUBLIC_ORIGIN` | tidak diatur | Origin publik yang diizinkan untuk API akun; HTTPS untuk jaringan/produksi, atau HTTP localhost |

Contoh PowerShell untuk menutup pendaftaran setelah akun lokal dibuat:

```powershell
$env:MAIN_DULU_REGISTRATION_OPEN = 'false'
npm start
```

Hentikan proses lama sebelum mengubah konfigurasi dan menjalankan ulang server. Aplikasi tidak memuat file `.env` backend secara otomatis.

### Localhost Versus Jaringan

- Tanpa public origin, API akun hanya menerima host HTTP `localhost`, `127.0.0.1`, atau `[::1]`. Cookie lokal tidak memakai Secure agar dapat digunakan pada HTTP loopback.
- Akses akun lewat IP LAN HTTP ditolak; mode tamu dan aset web tetap dapat digunakan. Ini tidak menghilangkan dukungan gameplay HTTP LAN yang sudah ada.
- Untuk akun dari perangkat lain, sediakan reverse proxy HTTPS dan set `MAIN_DULU_PUBLIC_ORIGIN` ke origin yang tepat, misalnya `https://main.example.com`.
- Saat HTTPS dikonfigurasi, cookie memakai Secure. Gunakan origin publik itu untuk membuka web; akses akun langsung lewat alamat backend localhost yang berbeda akan ditolak.
- Reverse proxy harus meneruskan Host publik yang sesuai. Backend tidak mempercayai `X-Forwarded-Host`, `X-Forwarded-Proto`, atau `X-Forwarded-For` secara otomatis.
- Origin harus tanpa path, query, fragment, username, atau password. Konfigurasi HTTP selain loopback ditolak.

Untuk deployment publik, tinjau kebijakan pendaftaran, TLS, akses langsung ke backend, dan pembatasan tambahan di proxy. Pembatasan IP pada backend melihat IP proxy jika proxy dipakai; M3 tidak mengaktifkan trust-proxy secara global.

## Penyimpanan dan Migrasi

Migrasi transaksional **versi 2** menambahkan:

- `users`: ID akun stabil, username unik, hash password, hash kode pemulihan, dan waktu pembuatan.
- `sessions`: hash token sesi, ID pengguna nullable untuk sesi anonim, waktu pembuatan, serta waktu kedaluwarsa.
- Index sesi berdasarkan pengguna dan kedaluwarsa; foreign key dengan cascade saat akun dihapus dari database.

Metadata instalasi M2 dipertahankan. Tidak ada tabel atau endpoint penyimpanan progres yang ditambahkan. Backup database secara konsisten sebelum memperbarui instalasi yang sudah memiliki data; aplikasi versi M2 akan menolak database versi 2, bukan menurunkannya secara otomatis.

### Hash dan Rahasia

- Password menggunakan scrypt `N=32768`, `r=8`, `p=3`, salt acak 16 byte, dan derived key 64 byte. Format tersimpan mencantumkan algoritma/parameter/salt/key.
- Verifikasi menggunakan perbandingan constant-time untuk derived key. Username tidak dikenal tetap menjalankan KDF dengan hash dummy untuk mengurangi perbedaan waktu dari keberadaan akun.
- Maksimal dua operasi password mahal berjalan bersamaan per proses. Permintaan berlebih ditolak dengan 429, bukan ditumpuk dalam antrean tanpa batas.
- Token cookie adalah nilai acak 32 byte; database hanya menyimpan SHA-256 token tersebut. Tidak ada JWT atau token sesi di LocalStorage/sessionStorage.
- Kode pemulihan berisi 32 byte acak, ditampilkan sebagai delapan grup heksadesimal kapital. Server hanya menyimpan SHA-256 representasi tanpa tanda hubung. Hash cepat sesuai untuk kode acak berentropi tinggi, bukan untuk password pengguna.
- Kode mentah hanya dikirim pada respons pendaftaran dan berada sementara dalam state dialog. GET sesi/login tidak menampilkannya kembali. Unduhan kode adalah aksi lokal pengguna, bukan berkas publik di server.
- Identitas username yang menyertai kode diambil dari respons pendaftaran dan disimpan sebagai snapshot, sehingga pergantian akun di tab lain tidak menempelkan kode ke username lain.
- Dialog menghalangi penutupan biasa sebelum pengakuan penyimpanan kode dan memberi peringatan sebelum meninggalkan tab selama kode belum disimpan. Ini tidak menjamin pemulihan bila browser/proses berhenti mendadak.

Perubahan parameter KDF di masa depan harus mempertahankan verifikasi hash lama atau menyediakan migrasi; jangan sekadar mengubah parameter lalu membuat akun lama tidak bisa login.

## Sesi dan CSRF

Cookie `maindulu_session` menggunakan HttpOnly, SameSite=Strict, Path=/api, tanpa Domain. Secure aktif pada public origin HTTPS. Cookie berlaku untuk API, tidak perlu dikirim ke berkas ROM/BIOS/player.

Pengguna tamu tanpa cookie dapat membaca status akun anonim tanpa dibuatkan sesi database/cookie baru. Sebelum aksi akun, frontend meminta bootstrap CSRF. Server menerbitkan sesi anonim bila belum ada sesi valid; respons mengandung token CSRF yang terikat pada token sesi melalui HMAC-SHA-256.

Semua POST akun memerlukan:

- Origin yang sama dengan origin akun yang diizinkan.
- JSON body dan cookie sesi valid yang belum kedaluwarsa.
- Header `X-CSRF-Token` yang cocok.
- Fetch Metadata yang sesuai bila header tersebut tersedia; cross-site/same-site lintas origin ditolak.

Tidak ada CORS lintas origin yang diaktifkan. Pendaftaran/login mengganti token sesi dan menghapus sesi sebelumnya untuk mencegah session fixation. Sesi dibaca dari SQLite pada setiap request, bukan dipercaya hanya dari isi cookie.

Logout menghapus sesi saat ini di database dan membersihkan cookie. Ganti password memverifikasi password saat ini, mengubah hash secara transaksional, mempertahankan ID akun/kode pemulihan, menghapus seluruh sesi akun, dan membersihkan cookie. Operasi yang berlomba dengan pencabutan sesi harus memeriksa ulang sesi/hash sebelum commit dan tidak boleh menerbitkan sesi baru dari sesi yang sudah dicabut.

Frontend memeriksa ulang sesi saat fokus kembali dan setiap 60 detik ketika halaman terlihat. Server langsung menolak token yang dicabut; UI tab lain mungkin baru memperbarui label setelah pemeriksaan tersebut atau reload. Kegagalan jaringan ditampilkan sebagai informasi akun belum tersedia, bukan dianggap logout yang berhasil. Login tidak mengubah identitas ROM, key save browser, atau isi riwayat/favorit.

## Pembatasan Percobaan

| Operasi | Batas |
| --- | --- |
| Bootstrap CSRF | 60 per menit per IP |
| Daftar | 10 per 15 menit per IP |
| Login | 30 per 15 menit per IP dan 10 per 15 menit per pasangan IP + username |
| Ganti password | 10 per 15 menit per pasangan IP + ID pengguna |

Kegagalan dan keberhasilan sama-sama memakai kuota endpoint. Respons 429 menyertakan Retry-After. Limiter memakai fixed window di memori, maksimal 5.000 bucket, membersihkan bucket kedaluwarsa, dan menolak penambahan saat kapasitas habis. Batas tidak diperpanjang setiap percobaan gagal, tidak mengunci akun permanen, dan tidak memblokir akun secara global berdasarkan serangan dari satu IP. Restart proses mengosongkan limiter; ini bukan limiter terdistribusi.

Pesan login gagal sama untuk username tidak dikenal dan password salah. Pendaftaran tetap menginformasikan username yang sudah terpakai sebagai kebutuhan pemilihan username. Password, token sesi, token CSRF, dan kode pemulihan tidak dimasukkan ke URL atau log request normal. Error autentikasi yang diharapkan ditangani tanpa mencetak request body.

## Kontrak API M3

| Endpoint | Fungsi |
| --- | --- |
| `GET /api/health` | Kapabilitas `accounts: true`, `serverSaves: false` |
| `GET /api/auth/session` | User publik atau null, token CSRF bila sesi valid, dan status pendaftaran; tidak membuat sesi anonim |
| `GET /api/auth/csrf` | Bootstrap sesi/token CSRF untuk aksi akun |
| `POST /api/auth/register` | Username, password, passwordConfirmation; respons 201 berisi user publik, token CSRF baru, dan kode pemulihan sekali tampil |
| `POST /api/auth/login` | Username/password; respons berisi user publik dan token CSRF baru, tanpa kode pemulihan |
| `POST /api/auth/logout` | Mencabut sesi saat ini dan membersihkan cookie |
| `POST /api/auth/password` | currentPassword, newPassword, passwordConfirmation; mencabut seluruh sesi setelah password berubah |

User publik hanya memuat ID dan username. Tidak ada response berisi hash password/recovery, path database, atau daftar sesi pengguna lain. Response tetap memakai no-store dan header keamanan M2.

## Pengujian

```sh
npm test
npm run build
npm run test:e2e
npm run test:e2e:production
npm run test:e2e:backend
```

`tests/auth.test.mjs` mencakup normalisasi/keunikan username, KDF, kode sekali tampil, rotasi cookie, CSRF, HTTPS/origin, expiry, rate limit, perlombaan login, ganti password lintas sesi, persistensi, migrasi M2, dan log tanpa rahasia. `tests/account.test.mjs` memeriksa parser kontrak frontend.

`tests/browser/account.spec.ts` berjalan pada konfigurasi backend nyata: pendaftaran/kode unduh, sesi setelah reload, logout/login, pencabutan sesi browser lain, validasi mobile/keyboard/focus, serta outage API akun. Empat tes akun tersebut sengaja dilewati pada konfigurasi statis; pengujian bahwa mode statis tidak bergantung pada akun tetap berjalan lewat suite backend/app lainnya.

### Hasil Verifikasi

Lingkungan: Windows, Node.js 26.12.1, dan Microsoft Edge headless. Suite autentikasi/server juga dijalankan dengan Node.js 24.22.1.

| Pemeriksaan | Hasil |
| --- | --- |
| `npm test` | 48 lulus |
| `npm run build` | Lulus |
| `npm run test:e2e` | 22 lulus; 4 tes akun dilewati karena server development statis |
| `npm run test:e2e:production` | 22 lulus; 4 tes akun dilewati karena preview statis |
| `npm run test:e2e:backend` | 21 lulus, termasuk keempat tes akun pada backend nyata |
| `tests/auth.test.mjs` + `tests/server.test.mjs` pada Node.js 24.22.1 | 23 lulus |
| Pemeriksaan TypeScript ketat untuk tes akun/backend/app dan konfigurasi backend | Lulus |
| `npm audit --omit=dev` | Tidak ada kerentanan yang dilaporkan |

Kebijakan public origin dan atribut cookie Secure diuji pada lapisan request server; reverse proxy HTTPS nyata belum dipasang sebagai bagian dari M3. Ini bukan klaim audit keamanan menyeluruh atau kesiapan deployment publik tanpa konfigurasi lanjutan.

M3 ditutup dengan hasil tersebut. Tindakan pemulihan kode/reset admin tetap M4; upload dan sinkronisasi progres tetap M5/M6.
