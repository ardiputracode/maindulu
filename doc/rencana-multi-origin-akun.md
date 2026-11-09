# Rencana: Dukungan Multi-Origin Akun (Online + Lokal)

> Implementasi tersedia. Bagian masalah/desain di bawah mencatat kondisi awal dan rencana; hasil serta batas verifikasi ada pada bagian Status. Panduan penggunaan: [HTTPS Cloudflare Tunnel + multi-origin](https-cloudflare-tunnel.md).

## Tujuan

Mengizinkan satu instance backend maindulu menerima login akun dari **beberapa origin sekaligus** — misalnya `https://maindulu.putraserver.biz.id` (via Cloudflare Tunnel) **dan** `http://localhost:7777` (lokal) — tanpa harus memilih salah satu atau menjalankan dua instance.

## Masalah Sebelum Implementasi

`MAIN_DULU_PUBLIC_ORIGIN` hanya menampung **satu origin**. `protectRequest()` di `server/auth/security.mjs` membandingkan `Host` request dengan origin tunggal itu, sehingga origin lain ditolak (`403 Akses akun memerlukan HTTPS` / `Alamat akun tidak sesuai konfigurasi server`).

Konsekuensinya, konfigurasi saat ini bersifat *exclusive*:

| Konfigurasi | Tunnel HTTPS | localhost | LAN HTTP |
|---|---|---|---|
| Tanpa `PUBLIC_ORIGIN` | ❌ | ✅ | ❌ |
| `PUBLIC_ORIGIN=https://maindulu...` | ✅ | ❌ | ❌ |
| `PUBLIC_ORIGIN=http://192.168.x:7777` + `ALLOW_INSECURE_HTTP=true` | ❌ | ❌ | ✅ |

## Ruang Lingkup

- **Backend only** — frontend tidak perlu perubahan karena selalu memanggil `same-origin` (origin browser).
- Tetap satu database, satu port, satu proses.
- Kompatibel mundur dengan `MAIN_DULU_PUBLIC_ORIGIN` (tunggal).
- Tidak mengubah kontrak cookie selain flag `Secure` per-request.

## Desain

### 1. Env baru: `MAIN_DULU_PUBLIC_ORIGINS` (plural)

Daftar origin yang dipisah koma, contoh:

```dotenv
MAIN_DULU_PUBLIC_ORIGINS=https://maindulu.putraserver.biz.id,http://localhost:7777
```

- `MAIN_DULU_PUBLIC_ORIGIN` (singular) tetap didukung untuk kompatibilitas; jika keduanya diset, keduanya digabung (dedup).
- Jika tidak ada yang diset, perilaku lama tetap: hanya `localhost`/`127.0.0.1`/`[::1]` HTTP.
- Validasi per-entry sama seperti sekarang (origin HTTPS, atau HTTP localhost, atau HTTP jaringan dengan `ALLOW_INSECURE_HTTP=true`).

### 2. Config (`server/config.mjs`)

- Tambah parsing `MAIN_DULU_PUBLIC_ORIGINS` → array `publicOrigins` (dedup, validasi tiap entry).
- Gabungkan dengan `MAIN_DULU_PUBLIC_ORIGIN` bila ada.
- Simpan `config.publicOrigins` (array) dan pertahankan `config.publicOrigin` (entry pertama, untuk kompatibilitas/test lama).
- `allowInsecureHttp` tetap berlaku global: jika ada entry HTTP non-localhost, `ALLOW_INSECURE_HTTP=true` wajib.

### 3. Keamanan (`server/auth/security.mjs`)

Ubah `protectRequest()`:

1. Resolve daftar origin yang diizinkan (`config.publicOrigins` atau fallback localhost).
2. Bandingkan `request.headers.host` dengan host tiap origin; pilih origin yang host-nya cocok (`matchedOrigin`).
3. Jika tidak ada yang cocok → `403 Akses akun memerlukan HTTPS` (atau pesan origin tidak sesuai).
4. Validasi `Origin` header terhadap `matchedOrigin.origin`.
5. Validasi `sec-fetch-site` tetap.
6. Kembalikan `matchedOrigin` (atau sediakan helper) agar `routes.mjs` tahu skema-nya untuk flag cookie.

Pseudo:

```js
function resolveAllowedOrigins(config) {
  if (config.publicOrigins?.length) return config.publicOrigins
  return ['http://localhost', 'http://127.0.0.1', 'http://[::1]'] // localhost family
}
```

### 4. Cookie `Secure` per-request

Saat ini `cookieOptions` di `routes.mjs:24` statis berdasarkan `config.publicOrigin`. Dengan multi-origin, `Secure` harus mengikuti origin yang cocok:

- Jika request datang via `https://...` → `Secure=true`.
- Jika via `http://localhost` → `Secure=false`.

Solusi: buat `cookieOptions` dinamis per-request berdasarkan `matchedOrigin`. Karena `setCookie`/`clearCookie` dipanggil di banyak tempat, sediakan helper `cookieOptionsFor(request)` yang membaca origin yang sudah di-resolve oleh hook `onRequest` (simpan di `request.allowedOrigin`).

### 5. Hook `onRequest`

Di `routes.mjs:56-58`, hook memanggil `protectRequest(request, config, current)`. Simpan hasil:

```js
auth.addHook('onRequest', async request => {
  request.accountOrigin = protectRequest(request, config, current) // return matched origin
})
```

Lalu `newSession`, `logout`, `password`, `recover` memakai `cookieOptionsFor(request)`.

### 6. Frontend

Tidak perlu perubahan. Frontend memanggil `same-origin` (relative `/api/...`), jadi browser otomatis memakai origin yang sedang dibuka. Cookie akan dikirim sesuai origin.

### 7. CSRF

Tidak berubah — token CSRF terikat ke token sesi, bukan origin.

## File yang Disentuh

| File | Perubahan |
|---|---|
| `server/config.mjs` | Parse `MAIN_DULU_PUBLIC_ORIGINS`, gabung singular, validasi, expose `publicOrigins` |
| `server/auth/security.mjs` | `protectRequest` multi-origin, return matched origin |
| `server/auth/routes.mjs` | `cookieOptions` dinamis per-request, simpan `request.accountOrigin` |
| `tests/auth.test.mjs` | Test multi-origin: host match, origin mismatch, mixed http/https |
| `tests/server.test.mjs` | (jika ada) konfigurasi multi-origin |
| `doc/https-cloudflare-tunnel.md` | (nanti) panduan HTTPS + multi-origin |
| `README.md` | Tambah env `MAIN_DULU_PUBLIC_ORIGINS` |
| `deploy/backend.env.example` | Contoh multi-origin |

## Kompatibilitas Mundur

- `MAIN_DULU_PUBLIC_ORIGIN` (singular) tetap bekerja persis seperti sekarang.
- Jika keduanya diset, digabung dedup.
- `config.publicOrigin` (singular, entry pertama) tetap diekspos untuk kode/test lama yang membacanya.

## Keamanan

- Tiap entry harus lolos validasi yang sama (HTTPS, atau HTTP localhost, atau HTTP jaringan dengan `ALLOW_INSECURE_HTTP=true`).
- Mixed origin (HTTPS + HTTP localhost) diizinkan karena localhost memang dianggap aman.
- Cookie `Secure` mengikuti skema origin yang cocok — tidak pernah `Secure=false` untuk origin HTTPS.
- `SameSite=Strict` tetap; lintas origin tetap ditolak.
- Tidak ada CORS lintas origin yang diaktifkan.

## Pengujian

Unit (`tests/auth.test.mjs`):
- `protectRequest` dengan `publicOrigins=['https://a.example','http://localhost:7777']` → host `a.example` lolos, host `localhost:7777` lolos, host lain 403.
- Mixed skema: request HTTPS → cookie Secure; request localhost → cookie non-Secure.
- Origin header mismatch → 403.
- Backward compat: hanya `PUBLIC_ORIGIN` (singular) → perilaku lama identik.

E2E backend (`tests/browser/account.spec.ts`):
- Login via `https://...` (tunnel) lolos.
- Login via `http://localhost:7777` lolos pada instance yang sama.
- Cookie Secure benar per origin.

## Risiko & Mitigasi

| Risiko | Mitigasi |
|---|---|
| Cookie `Secure` salah skema → browser menolak kirim cookie | Tentukan Secure per matched origin, bukan global |
| Origin spoofing via `Host` header | Validasi host persis; tidak percaya `X-Forwarded-Host` |
| Backward break pada test yang baca `config.publicOrigin` | Pertahankan `publicOrigin` (entry pertama) |
| Mixed HTTP/HTTPS membingungkan pengguna | Dokumentasikan jelas di README + panduan HTTPS |

## Langkah Implementasi

1. Update `server/config.mjs` — parse + validasi + gabung origin.
2. Update `server/auth/security.mjs` — multi-origin matching, return matched.
3. Update `server/auth/routes.mjs` — cookie dinamis per request.
4. Tambah test di `tests/auth.test.mjs`.
5. Update `README.md` dan `deploy/backend.env.example`.
6. (Opsional) Buat `doc/https-cloudflare-tunnel.md` dengan bagian multi-origin.
7. Jalankan `npm test`, `npm run build`, `npm run test:e2e:backend`.

## Status

Implementasi selesai pada 2026-11-09, tanpa perubahan frontend atau migrasi database:

- [x] Parsing, validasi setiap entri, normalisasi/dedup dan penggabungan singular/plural. Plural didahulukan; `config.publicOrigin` tetap entri pertama.
- [x] Pencocokan Host multi-origin, fallback localhost pada port request, penolakan Host invalid dan Origin silang; header forwarded tidak dipercaya. Konfigurasi singular tetap didukung oleh helper keamanan.
- [x] Hook menyimpan `request.accountOrigin`; bootstrap/register/login serta clear-cookie logout/password/recover memakai flag Secure per request. SameSite/HttpOnly/path dan CSRF tidak berubah.
- [x] Env plural diteruskan oleh Compose/Portainer; peringatan startup memeriksa seluruh daftar, dan informasi backup mencatat daftar tanpa mengaktifkannya otomatis saat restore.
- [x] Tes konfigurasi/keamanan dan siklus akun pada dua origin; tes browser dengan proxy TLS lokal nyata ke backend yang sama.
- [x] README, contoh env, panduan deployment, dan panduan Cloudflare Tunnel diperbarui.

Keputusan tambahan: bila dua skema memakai Host+port yang sama, Origin yang cocok menentukan pilihan; tanpa Origin, HTTPS didahulukan agar urutan env tidak menurunkan keamanan cookie. Untuk konfigurasi online + lokal, gunakan hostname berbeda seperti contoh.

Verifikasi:

- `npm test`: **603 lulus**, tanpa gagal/skip.
- `npm run build`: **lulus**; peringatan ukuran chunk Vite >500 kB masih ada, tidak terkait perubahan backend.
- Skenario browser baru HTTPS proxy + localhost: **lulus**, termasuk login akun sama, cookie Secure/non-Secure, refresh, logout/login ulang dan penolakan Origin silang.
- `npm run test:e2e:backend`: **183 lulus** (15,6 menit), tanpa gagal/skip.

Batas: HTTPS diuji lewat proxy TLS loopback dengan sertifikat self-signed khusus tes. Tidak ada tunnel Cloudflare/domain/sertifikat publik atau container produksi yang diubah atau diklaim telah diuji. Aktivasi deployment memerlukan konfigurasi env dan restart/recreate oleh operator.
