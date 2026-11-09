# Rencana: Dukungan Multi-Origin Akun (Online + Lokal)

## Tujuan

Mengizinkan satu instance backend maindulu menerima login akun dari **beberapa origin sekaligus** — misalnya `https://maindulu.putraserver.biz.id` (via Cloudflare Tunnel) **dan** `http://localhost:7777` (lokal) — tanpa harus memilih salah satu atau menjalankan dua instance.

## Masalah Saat Ini

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

Rencana — belum diimplementasikan. Implementasi menunggu persetujuan dan switch ke agent Build.