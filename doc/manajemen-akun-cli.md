# Manajemen akun via CLI

Perintah administrasi akun yang dijalankan dari terminal server (akar proyek). Semua perintah membaca konfigurasi `MAIN_DULU_DATA_DIR` (default `data`) dan tidak membuat database baru jika database tidak ada.

## Lihat daftar user

```sh
npm run account:list
```

Filter opsional:

```sh
npm run account:list -- --role admin
npm run account:list -- --username alice
```

Output menampilkan `username`, `role`, `created_at (UTC)`, dan `id`. Hash password dan kode pemulihan tidak pernah ditampilkan. Koneksi dibuka **read-only** sehingga aman dijalankan saat server aktif.

## Jadikan admin / turunkan ke user

Daftarkan akun biasa melalui aplikasi terlebih dahulu, lalu:

```sh
npm run account:role -- username admin
npm run account:role -- username user
```

Username dinormalisasi seperti saat login. Menetapkan role yang sama aman diulang. Perubahan berlaku pada request berikutnya tanpa login ulang.

## Reset password (admin)

```sh
npm run account:reset -- username
```

Perintah ini interaktif: meminta password baru dan konfirmasi, lalu mencetak kode pemulihan baru satu kali. Jangan masukkan password sebagai argumen. Semua sesi dan kode lama dibatalkan.

## Docker (backend aktif)

Gunakan exec ke container yang sama:

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml exec backend npm run account:list
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml exec backend npm run account:role -- username admin
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml exec backend npm run account:reset -- username
```

Jika server sudah berhenti, gunakan `run --rm --no-deps backend ...` dengan volume/environment yang sama. Jangan jalankan container maintenance terpisah terhadap server aktif: lock namespace berbeda sengaja ditolak. Jangan hapus lock hidup untuk melewatinya.

## Portainer

Jika container dikelola lewat Portainer dan Anda tidak punya akses shell host:

1. Buka **Containers → backend → Console → Connect** (pilih `/bin/sh`).
2. Jalankan salah satu perintah:
   ```sh
   npm run account:list -- --role admin
   # atau
   node scripts/list-accounts.mjs --role admin
   ```

Jika image yang sedang berjalan belum menyertakan `scripts/list-accounts.mjs` (misalnya image lama sebelum pembaruan ini), jalankan query read-only langsung di Console:

```sh
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.MAIN_DULU_DATA_DIR+'/maindulu.sqlite',{readOnly:true});console.table(db.prepare(\"SELECT username,role,datetime(created_at/1000,'unixepoch') AS created,id FROM users WHERE role=? ORDER BY username\").all('admin'));db.close();"
```

Untuk image lama, perintah `npm run account:list` tidak tersedia sampai image dibangun ulang. Image yang sudah diperbarui menyertakan `scripts/list-accounts.mjs` (lihat `deploy/Dockerfile.backend`).

## Catatan keamanan

- Akses terminal/OS harus dibatasi kepada pengelola tepercaya.
- `account:list` tidak memerlukan kredensial pintu masuk; cukup akses folder data.
- `account:role` dan `account:reset` memakai `openDatabase` (shared lease), sama seperti backup/restore.
- Backup/verify/restore dengan lease eksklusif memblokir perubahan role/reset.
- Tidak ada larangan menurunkan admin terakhir; operator OS dapat mempromosikan akun lagi.
- Reset/pemulihan kredensial mempertahankan role; operator perlu mendemosikan secara eksplisit bila ingin mencabut akses admin.