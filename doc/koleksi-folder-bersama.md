# Satu folder ROM/BIOS untuk RomM dan maindulu

Mode ini memenuhi alur **scan + upload + hapus pada folder fisik yang sama**. Berbeda dari mode eksternal read-only, maindulu boleh menulis dan menghapus ROM/BIOS, termasuk file yang berasal dari hasil scan RomM.

> **Hapus maindulu ikut menghapus file yang dipakai RomM. Hapus file di RomM membuat file maindulu tidak tersedia.** Ini bukan sinkronisasi database dua aplikasi. Jalankan scan/refresh masing-masing aplikasi untuk memperbarui daftarnya. Backup koleksi sebelum mengaktifkan mode ini.

## Alur

```text
RomM / salin manual ──► folder bersama ◄── upload admin maindulu
                              │
                         Scan Koleksi
                              ▼
                      Library maindulu
```

- Upload admin ROM → `<ROM_DIR>/<platform>/<nama-asli>`.
- Upload admin BIOS → `<BIOS_DIR>/<platform>/<nama-asli>`.
- Scan mendaftarkan file langsung di lokasi yang sama, tanpa duplikasi.
- Tombol Hapus maindulu menolak akses URL segera dan menjadwalkan penghapusan file fisik dengan retry. UI konfirmasi menjelaskan dampak ke RomM; kegagalan izin/storage tetap terlihat sebagai pembersihan tertunda.
- File yang dihapus RomM menghasilkan 404 pada GET/HEAD maindulu. Entri aktif ditampilkan admin sebagai **Berkas hilang**; akun, save/progres, dan ID tidak dihapus. Ini bukan watcher atau penghapusan metadata otomatis.
- Metadata, cover, akun, SQLite, save, staging upload, dan lock tetap di volume privat maindulu.

## Docker Compose

Isi `.env.backend` privat (gunakan folder host yang benar-benar sudah ada):

```dotenv
MAIN_DULU_ROM_PATH=/mnt/storage/romm/library/roms
MAIN_DULU_BIOS_PATH=/mnt/storage/romm/library/bios
```

Jalankan dari akar repo dengan **overlay shared**, bukan overlay external read-only:

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml -f deploy/docker-compose.shared.yml config --quiet
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml -f deploy/docker-compose.shared.yml up -d --build
```

Gunakan dua file dan env-file yang sama pada operasi selanjutnya. Overlay menetapkan:

```yaml
    environment:
      - MAIN_DULU_EXTERNAL_ROM_DIR=/mnt/romm/roms
      - MAIN_DULU_EXTERNAL_BIOS_DIR=/mnt/romm/bios
      - MAIN_DULU_EXTERNAL_WRITABLE=true
```

Serta memasang kedua sumber **read-write** di luar `/var/lib/maindulu`. `create_host_path: false` mencegah salah ketik membuat folder kosong milik root. Root filesystem container tetap read-only; bind mount dan volume data saja writable. Jangan gabungkan `docker-compose.shared.yml` dengan `docker-compose.external.yml`.

## Portainer: contoh stack satu file (200 GiB)

Gunakan **[`deploy/docker-compose.portainer.example.yml`](../deploy/docker-compose.portainer.example.yml)** sebagai isi **Stacks → Add stack → Web editor**, atau pilih file tersebut melalui deployment Git Portainer. Ini stack lengkap (bukan overlay); jangan digabung dengan Compose lain. Kuota katalog ditetapkan **200 GiB = 214748364800 byte**. Default backend/overlay lainnya tetap 20 GiB kecuali dikonfigurasi sendiri.

Isi bagian **Environment variables** stack Portainer menggunakan contoh [`deploy/portainer.env.example`](../deploy/portainer.env.example):

| Variabel | Isi |
| --- | --- |
| `MAIN_DULU_PUBLIC_ORIGIN` | URL browser persis, misalnya `http://IP-SERVER:7777` |
| `MAIN_DULU_ROM_PATH` | Folder ROM di **host**, sudah ada dan writable |
| `MAIN_DULU_BIOS_PATH` | Folder BIOS host, berbeda/terpisah dari ROM |
| `MAIN_DULU_STORAGE_VOLUME` | Opsional, default `maindulu-backend_storage`; pastikan volume lama yang benar |
| `MAIN_DULU_IMAGE` | Opsional, default `maindulu-backend:latest`; image baru sudah di-import/dibangun di endpoint |

Template memakai volume **external yang harus sudah ada** untuk mencegah migrasi tanpa sengaja ke database kosong. Untuk instalasi baru, buat volume privat lebih dahulu dan pastikan UID `1000` bisa menulis data/lock; jangan menghapus atau mengganti volume instalasi lama. Template ini untuk Docker Standalone/Compose, bukan Swarm stack. HTTP tetap hanya untuk LAN tepercaya, bukan internet.

**Aman menyimpan template `.example` ini di Git** karena tidak berisi password/token asli, path UUID disk, atau alamat server operator. Isi kredensial ScreenScraper secara privat di Environment Portainer lalu aktifkan fiturnya. Variabel environment bukan secret vault: admin Docker/Portainer dan output `inspect`/Compose config dapat melihat nilainya. Jangan bagikan output tersebut. File `.env.portainer` di akar repo dan `deploy/docker-compose.portainer.local.yml` diabaikan Git; file yang sudah pernah dilacak tidak otomatis menjadi privat hanya karena `.gitignore`.

Jika ingin menguji lewat Compose CLI dengan file privat dari akar repo:

```sh
docker compose --env-file .env.portainer -f deploy/docker-compose.portainer.example.yml config --quiet
```

Variabel env saja tidak membangun image atau memperbarui image lama. Setelah deploy image baru, jalankan **Admin → Scan Koleksi**. **Hapus maindulu akan menghapus file fisik bersama yang dipakai RomM.**

## Portainer: edit stack yang sudah ada

Pertahankan image baru, environment akun/ScreenScraper milik sendiri, dan **volume data yang sama**. Tambahkan tiga env di atas. Ganti hanya dua mount ROM/BIOS menjadi seperti berikut (path host bisa langsung diisi atau memakai variabel stack):

```yaml
    volumes:
      - storage:/var/lib/maindulu
      - type: bind
        source: ${MAIN_DULU_ROM_PATH:?Isi lokasi folder ROM host}
        target: /mnt/romm/roms
        read_only: false
        bind:
          create_host_path: false
      - type: bind
        source: ${MAIN_DULU_BIOS_PATH:?Isi lokasi folder BIOS host}
        target: /mnt/romm/bios
        read_only: false
        bind:
          create_host_path: false
```

Isi variabel host di bagian Environment stack Portainer. Jangan menargetkan `/var/lib/maindulu/data/roms` atau `/bios` bersamaan. Mount data privat harus tetap writable.

Untuk instalasi lama yang memakai volume **`maindulu-backend_storage`**, pastikan volume itu tetap digunakan. Jika stack berubah nama, deklarasi eksplisit berikut mencegah volume baru kosong:

```yaml
volumes:
  storage:
    external: true
    name: maindulu-backend_storage
```

Deklarasi tersebut untuk volume yang **sudah ada**, bukan pembuatan instalasi baru. Jangan menghapus volume/SQLite atau memakai `down -v`.

### Image baru wajib

Perubahan YAML saja tidak memperbarui kode dalam image lama. Compose repo dapat membangun image melalui `--build`. Untuk image lokal `maindulu-backend:latest` pada stack sendiri, bangun dari checkout kode baru di host Docker:

```sh
docker build -f deploy/Dockerfile.backend -t maindulu-backend:latest .
```

Lalu recreate/update stack memakai image tersebut. Jika Portainer menggunakan endpoint mesin lain, image harus dibangun/dikirim ke endpoint itu, bukan hanya tersedia di komputer pengembangan.

## Tanpa Docker

Set environment runtime backend:

```dotenv
MAIN_DULU_EXTERNAL_ROM_DIR=/mnt/storage/romm/library/roms
MAIN_DULU_EXTERNAL_BIOS_DIR=/mnt/storage/romm/library/bios
MAIN_DULU_EXTERNAL_WRITABLE=true
```

Flag writable hanya menerima `true`/`false`, default **false** demi kompatibilitas sumber read-only. Ia berlaku untuk semua sumber eksternal yang dikonfigurasi; satu jenis yang tidak disetel tetap memakai storage internal. Mengaktifkannya tanpa sumber ditolak.

## Migrasi dan izin

1. Tutup semua player dan hentikan backend. Backup offline akun/save/metadata dengan aplikasi versi lama dan backup file koleksi secara terpisah.
2. Pertahankan project/volume data dan path `MAIN_DULU_DATA_DIR`. Ubah mount ke `/mnt/romm/roms` dan `/mnt/romm/bios`, tambah flag writable, dan pastikan mount read-write.
3. Pastikan user maindulu (default UID/GID `1000:1000`) **dan** RomM dapat membaca, membuat, dan menghapus file dalam folder platform. Gunakan UID yang sesuai atau ACL/group/default ACL yang benar. Mode penciptaan file/direktori tetap dipengaruhi umask/ACL host; jangan memakai `chmod -R 777`.
4. Deploy image baru. Migrasi **18** mempertahankan pemetaan skema 17 dan semua akun/save; tidak menyalin, memindah, atau menghapus ROM saat startup. Dengan flag writable, entri eksternal lama pada root yang sama menjadi dapat dihapus secara eksplisit oleh admin.
5. Jalankan **Admin → Scan Koleksi**. Uji satu upload legal kecil, pastikan file muncul di folder RomM yang sama, lalu scan RomM. Uji Hapus hanya pada fixture/file uji yang memang boleh dihapus.

Upload lama yang sudah berada di storage internal **tidak otomatis dipindahkan**. Jika ingin menyatukannya, hentikan server dan pindahkan file terpilih ke folder platform bersama setelah backup; jangan timpa file yang sudah ada. Scan ulang byte identik dapat menyambungkan ID aktif lama yang filenya hilang. Jangan pindahkan SQLite/save/cover ke folder RomM.

## Benturan, perubahan eksternal, dan cleanup

- Nama dan ekstensi asli dipertahankan. Nama yang sudah ada, termasuk alias case/Unicode yang belum diindeks, ditolak; file tidak ditimpa. Publikasi memakai exclusive create dan reservasi path lintas koneksi SQLite.
- Duplikat console + hash tetap satu identitas. Scan ulang tidak membuat duplikat/save baru. Identitas file yang hilang dapat disambungkan kembali bila byte identik; tombstone tetap memerlukan pemulihan eksplisit.
- Folder bersama tidak boleh berada di dalam data/public/dist atau saling bertumpuk, dan harus sudah tersedia. Tidak ada path bebas dari browser.
- Penghapusan fisik hanya untuk token yang secara eksplisit dihapus admin atau hasil upload milik maindulu yang gagal diterbitkan. Gagal adopsi/scan **tidak** memberikan izin menghapus file RomM. File tak terdaftar tidak disapu otomatis.
- Token yang sudah dipensiunkan tidak dapat menghapus pemilik baru pada nama yang sama. Sebelum unlink, snapshot ukuran dan waktu modifikasi/hash serta identitas pathname diperiksa; `ctime` tidak dipakai karena ditulis ulang oleh sebagian mount tanpa perubahan isi berkas. File yang diganti RomM sesudah permintaan Hapus tidak dihapus diam-diam; cleanup tertunda dan operator perlu memeriksa konflik.
- Hindari mengedit/menimpa file yang sedang dimainkan, di-upload, dipindai, atau dihapus. RomM dan maindulu tidak berbagi transaksi filesystem/database; pemeriksaan ini bukan jaminan atomik terhadap aplikasi lain yang mengganti path tepat saat unlink. Gunakan operasi terkoordinasi untuk administrasi koleksi.
- Saat upload, file tujuan dapat terlihat sebelum penyalinan/verifikasi selesai. Scan maindulu memagari path yang masih direservasi, tetapi RomM tidak membaca reservasi itu: tunggu konfirmasi upload selesai sebelum menjalankan scan RomM. File parsial tidak boleh dianggap ROM siap pakai.
- Transfer manual memakai nama sementara lalu rename final. Tunggu minimum 10 detik sebelum scan. Slug/format/batas sama dengan [scan eksternal](koleksi-eksternal-read-only.md#scan-dan-batas-format): single-file per platform, bukan subfolder bertingkat/PSX multi-track; symlink/junction/hard link ditolak.
- Kuota katalog pada mode shared menghitung byte folder bersama **dan** storage internal/staging. Koleksi RomM yang lebih besar dari default 20 GiB memerlukan `MAIN_DULU_CATALOG_QUOTA_BYTES` yang sesuai sebelum upload. Free-space dicek pada disk staging dan disk tujuan. File tambahan dari aplikasi lain tidak dapat dipesan kuotanya oleh maindulu.
- Recovery offline melaporkan sumber tak dikenal tanpa menghapusnya, serta dapat menyelesaikan cleanup yang memiliki bukti kepemilikan/izin. Partial upload akibat crash yang belum memiliki snapshot valid tidak dihapus otomatis: periksa laporan dan file secara manual setelah semua penulis berhenti.

## Backup dan rollback

Backup format 2 tetap **akun/save/metadata saja**, bukan koleksi ROM/BIOS/cover. Pemetaan operasional dan izin cleanup tidak dibawa ke snapshot. Setelah restore, mount sumber yang sama dan scan ulang untuk menyambungkan byte identik ke ID aktif. Backup tujuan/restore tidak boleh beririsan dengan sumber bersama.

Backup skema 17/16 dan versi lama yang sudah didukung tetap dapat diverifikasi dan direstore sebelum migrasi hasilnya. Jangan downgrade SQLite skema 18 dengan aplikasi lama; gunakan backup ke folder baru. Untuk menghentikan penulisan sementara, hentikan backend lalu nonaktifkan flag writable dan ubah mount menjadi `:ro`; cleanup shared yang belum selesai menunggu writable, bukan menghapus sumber lewat mode read-only.

## Verifikasi

```sh
node --test tests/catalog-external.test.mjs tests/catalog-scans.test.mjs tests/catalog-platform-storage.test.mjs tests/catalog-backup.test.mjs tests/deploy.test.mjs
npm run build
npm run test:e2e:backend -- tests/browser/catalog-scans.spec.ts tests/browser/admin-catalog.spec.ts tests/browser/library.spec.ts
npm test
```

Tes menggunakan folder sumber dan API nyata; penghapusan RomM disimulasikan lewat filesystem, bukan database/API RomM asli. Tidak ada integrasi sinkronisasi metadata RomM. Docker/Portainer/Linux read-write mount dan izin disk NAS harus diverifikasi pada server tujuan; Docker CLI tidak tersedia di lingkungan pengembangan ini.

Hasil verifikasi 2026-11-09: **597/597 tes Node lulus**, **26/26 tes browser admin/scan/Library lulus**, dan build lulus (peringatan ukuran bundle Vite non-blocking). Mencakup upload UI ke folder bersama, scan sumber, emulator NES nyata + BIOS sintetis, konfirmasi Hapus dan file fisik hilang, simulasi penghapusan RomM, snapshot/retry/token basi, adopsi gagal, quota, publikasi dua koneksi, migrasi 17→18, backup/restore 17, dan regresi akun/save/progres. Tidak ada klaim pengujian RomM API asli, BIOS/game proprietary, Docker/Alpine atau NAS nyata.
