# HTTPS Cloudflare Tunnel + akun lokal bersamaan

Satu backend Node.js melayani frontend/API, satu database dan satu port. Cloudflare Tunnel menjadi pintu HTTPS; localhost tetap dapat dipakai langsung tanpa menjalankan backend kedua. Frontend selalu memanggil API same-origin.

## 1. Konfigurasi backend

Untuk `npm start`, isi `.env` di akar repo:

```dotenv
MAIN_DULU_HOST=127.0.0.1
MAIN_DULU_PORT=7777
MAIN_DULU_PUBLIC_ORIGINS=https://maindulu.putraserver.biz.id,http://localhost:7777
MAIN_DULU_ALLOW_INSECURE_HTTP=false
```

Ganti domain dengan domain tunnel Anda, jalankan `npm run build` bila belum ada build, kemudian restart `npm start`. Jangan mengubah folder data untuk mengaktifkan fitur ini.

- Origin adalah skema + hostname/IP + port, tanpa path/query/fragment/kredensial. Spasi di sekitar entri diabaikan; entri kosong (termasuk koma terakhir) atau invalid membuat startup gagal.
- `MAIN_DULU_PUBLIC_ORIGIN` lama tetap berlaku. Bila keduanya diisi, daftar plural didahulukan, lalu singular ditambahkan dan duplikat dihapus setelah normalisasi. `config.publicOrigin` tetap tersedia sebagai entri pertama.
- Hapus/ganti singular LAN lama jika beralih ke konfigurasi di atas: entri HTTP jaringan yang tersisa tetap memerlukan `MAIN_DULU_ALLOW_INSECURE_HTTP=true`.
- Daftar eksplisit menggantikan fallback localhost otomatis. Tambahkan `http://127.0.0.1:7777` atau `http://[::1]:7777` hanya jika URL tersebut juga dipakai browser. Tanpa kedua variabel, semua port HTTP pada keluarga localhost itu tetap didukung seperti sebelumnya.
- HTTPS + HTTP localhost tidak memerlukan opt-in HTTP jaringan. Jangan membuka port Node langsung ke internet: variabel origin tidak memasang TLS, dan Host bukan bukti koneksi terenkripsi. Lindungi backend dengan bind loopback/firewall dan proxy tepercaya.

## 2. Hubungkan tunnel

Gunakan `cloudflared` dan tunnel/domain yang sudah disiapkan pada akun Cloudflare Anda. Pada konfigurasi hostname publik, arahkan domain HTTPS ke layanan **HTTP `localhost:7777`** pada mesin backend. Cloudflare menangani sertifikat publik; koneksi lokal dari connector ke Node tetap HTTP.

Contoh ingress untuk tunnel yang dikelola lewat file lokal (sesuaikan ID dan lokasi credential; jangan commit credential/token):

```yaml
tunnel: ID-TUNNEL-ANDA
credentials-file: /lokasi-privat/ID-TUNNEL-ANDA.json
ingress:
  - hostname: maindulu.putraserver.biz.id
    service: http://localhost:7777
  - service: http_status:404
```

Jalankan connector memakai konfigurasi tunnel Anda. Bila memakai dashboard, atur pasangan hostname/service yang sama di sana; tidak perlu file ingress kedua. Jangan override **HTTP Host Header** menjadi `localhost`: backend harus menerima `Host` publik asli. `X-Forwarded-Host`/`X-Forwarded-Proto` bukan sumber izin origin atau flag cookie. Teruskan seluruh path, header Origin, cookie, CSRF, serta body biner/multipart; jangan ubah kegagalan API menjadi HTML atau menambahkan CORS.

Jangan aktifkan cache bersama untuk data akun/save/metadata atau menimpa kebijakan cache backend. Pertahankan `private, no-cache`, ETag, dan validasi ulang untuk ROM/BIOS upload; jangan gunakan aturan cache-everything pada API/aset privat. Batas upload/timeout paket proxy/tunnel tetap berlaku untuk ROM besar; lihat [panduan proxy katalog](milestone-3-api-katalog.md#reverse-proxy).

### Docker

Untuk connector pada **host Docker**, isi `.env.backend` dengan:

```dotenv
MAIN_DULU_BIND_ADDRESS=127.0.0.1
MAIN_DULU_PORT=7777
MAIN_DULU_PUBLIC_ORIGINS=https://maindulu.putraserver.biz.id,http://localhost:7777
MAIN_DULU_ALLOW_INSECURE_HTTP=false
```

Hapus singular lama jika tidak dibutuhkan, lalu jalankan:

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml up -d --force-recreate
```

Compose meneruskan env plural ke container. Perubahan env membutuhkan recreate, bukan sekadar restart. Image lama perlu dibangun/diperbarui terlebih dahulu agar memiliki implementasi multi-origin. Jika connector berada di container terpisah, `localhost` menunjuk connector itu sendiri: gunakan jaringan Docker bersama dan service `http://backend:7777`, tetap pertahankan Host publik. Browser lokal tetap memakai port host yang dipublikasikan. Template Portainer mewajibkan `MAIN_DULU_PUBLIC_ORIGIN` utama dan menerima `MAIN_DULU_PUBLIC_ORIGINS` opsional untuk alamat tambahan.

## 3. Pemeriksaan

1. Buka `http://localhost:7777`, daftar atau login. Refresh harus mempertahankan sesi.
2. Buka `https://maindulu.putraserver.biz.id`, login dengan akun yang sama. ID akun dan save server sama; tidak perlu daftar ulang.
3. Periksa cookie `maindulu_session` di DevTools: `HttpOnly`, `SameSite=Strict`, path `/api`, tanpa Domain. HTTPS harus `Secure`; HTTP localhost tidak `Secure`. Periksa juga logout dan login ulang pada kedua alamat.
4. Request dengan Host tak terdaftar atau Origin milik alamat lain harus ditolak 403, walaupun kedua origin ada di allowlist. Tidak ada CORS lintas situs.

Login tidak otomatis berpindah antar-hostname: cookie host-only. Storage browser, cache, favorit/riwayat dan progres tamu tetap terpisah per origin. Ganti password/pemulihan mencabut semua sesi akun, termasuk pada origin lain; logout hanya mencabut sesi saat ini. Cookie tidak terisolasi menurut port, jadi hindari menjalankan layanan tak tepercaya pada hostname yang sama.

Gunakan authority berbeda untuk HTTP lokal dan HTTPS publik. Jika HTTP/HTTPS sengaja memakai Host+port yang sama, header Origin yang cocok memilih skema; request tanpa Origin memilih HTTPS agar urutan konfigurasi tidak menurunkan keamanan cookie.

## Troubleshooting dan batas verifikasi

- **Alamat akun tidak sesuai konfigurasi**: periksa Host yang diteruskan connector, port browser, serta daftar origin. Jangan memperbaikinya dengan mempercayai `X-Forwarded-Host`.
- **Permintaan harus berasal dari situs yang sama**: pastikan skema/host/port Origin browser persis cocok. Origin lain dalam allowlist tidak mengizinkan permintaan silang.
- **Cookie tidak tersimpan/terkirim**: periksa flag Secure, path `/api`, profil browser dan kebijakan cookie. HTTPS harus benar-benar tersedia, bukan sekadar mengubah env.
- **HTTP LAN**: tambahkan origin LAN eksplisit dan opt-in `MAIN_DULU_ALLOW_INSECURE_HTTP=true` hanya pada LAN tepercaya. Password, kode pemulihan, cookie dan save tidak terenkripsi; jangan gunakan password layanan lain. Tidak ada pembatasan subnet otomatis.

Tes otomatis menjalankan proxy TLS lokal nyata (sertifikat self-signed khusus tes) dan HTTP localhost ke instance backend yang sama, termasuk login, cookie dan penolakan Origin silang. Tes ini tidak memerlukan akun Cloudflare dan bukan bukti bahwa tunnel/domain/sertifikat produksi atau deployment Docker operator telah diverifikasi.
