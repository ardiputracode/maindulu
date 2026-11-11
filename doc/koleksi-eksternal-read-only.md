# Koleksi ROM/BIOS eksternal hanya-baca (RomM)

**Mau upload dan Hapus memakai folder yang sama dengan RomM?** Gunakan [mode folder bersama baca/tulis](koleksi-folder-bersama.md), bukan konfigurasi read-only pada halaman ini. Mode tersebut memerlukan opt-in `MAIN_DULU_EXTERNAL_WRITABLE=true`; default read-only tetap dipertahankan.

Backend mendukung sumber eksternal melalui **scan manual admin**. File dibaca langsung, bukan disalin atau di-upload ulang. Sumber tetap dikelola RomM/operator; maindulu menyimpan indeks, metadata/cover, akun, dan save pada volume privat sendiri.

## Konfigurasi Docker Compose

Pada `.env.backend` privat, isi lokasi **folder host yang sudah ada**:

```dotenv
MAIN_DULU_ROM_PATH=/mnt/storage/romm/library/roms
MAIN_DULU_BIOS_PATH=/mnt/storage/romm/library/bios
```

Gunakan overlay pada **semua** perintah Compose deployment ini:

```sh
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml -f deploy/docker-compose.external.yml config --quiet
docker compose --env-file .env.backend -f deploy/docker-compose.backend.yml -f deploy/docker-compose.external.yml up -d --build
```

Overlay memasang host ROM ke `/mnt/romm/roms:ro` dan BIOS ke `/mnt/romm/bios:ro`. `create_host_path: false` mencegah Docker membuat folder kosong milik root bila path salah. Service tetap memakai named volume `storage:/var/lib/maindulu` untuk SQLite/save/upload/cover. Jangan mengganti nama project atau volume instalasi lama.

Image harus dibangun dari kode yang menyertakan fitur ini; mengubah YAML pada image lama saja tidak menambah dukungan sumber eksternal. Tidak ada perubahan pada deployment Nginx/statis.

### Stack Portainer / YAML sendiri

Pertahankan konfigurasi lainnya dan named volume asli. Tambahkan pada `environment` service backend:

```yaml
      - MAIN_DULU_EXTERNAL_ROM_DIR=/mnt/romm/roms
      - MAIN_DULU_EXTERNAL_BIOS_DIR=/mnt/romm/bios
```

Ganti dua mount lama yang menargetkan `data/roms` dan `data/bios` dengan mount **di luar data** berikut. Contoh path host, sesuaikan dengan server:

```yaml
    volumes:
      - storage:/var/lib/maindulu
      - type: bind
        source: /srv/romm/library/roms
        target: /mnt/romm/roms
        read_only: true
        bind:
          create_host_path: false
      - type: bind
        source: /srv/romm/library/bios
        target: /mnt/romm/bios
        read_only: true
        bind:
          create_host_path: false
```

Jangan sekaligus memasang koleksi RomM ke `MAIN_DULU_DATA_DIR/roms` atau `bios`: direktori tersebut tetap merupakan storage yang dikelola upload/cleanup maindulu. Konfigurasi sumber eksternal di bawah data ditolak.

### Instalasi tanpa Docker

Backend menerima path absolut melalui environment runtime:

```dotenv
MAIN_DULU_EXTERNAL_ROM_DIR=/mnt/storage/romm/library/roms
MAIN_DULU_EXTERNAL_BIOS_DIR=/mnt/storage/romm/library/bios
```

Kedua variabel independen dan opsional. Bila hanya ROM disetel, scan BIOS tetap membaca folder internal. Upload admin selalu memakai storage internal, tidak pernah sumber eksternal. `MAIN_DULU_ROM_PATH`/`BIOS_PATH` hanya untuk interpolasi Compose overlay, bukan konfigurasi Node.

## Migrasi dari mount lama

1. Tutup player, hentikan backend, backup offline akun/save/metadata dan backup koleksi secara terpisah.
2. Pertahankan volume `maindulu-backend_storage` yang sama dan `MAIN_DULU_DATA_DIR` yang sama. Jangan `down -v` atau menghapus SQLite.
3. Pindahkan **tujuan mount dalam YAML**, bukan file RomM: dari `/var/lib/maindulu/data/roms` dan `bios` ke `/mnt/romm/roms` dan `bios`, lalu tambahkan env sumber eksternal.
4. Build/deploy image baru, login sebagai admin, jalankan Scan Koleksi. Aset aktif yang kini hilang dari lokasi internal dapat disambungkan ke byte eksternal dengan hash/console yang sama; ID/save tetap dipertahankan. File internal yang masih tersedia tidak diganti otomatis, dan sumber duplikat dilaporkan.
5. Verifikasi Library, BIOS, gameplay, save, serta recreate container. Jangan hapus file/volume lama sebelum verifikasi dan backup lengkap.

Folder database harus writable oleh user container (`node`, UID/GID `1000:1000` pada image bawaan). Folder eksternal cukup bisa dibaca/traverse oleh user tersebut; **jangan chmod/chown rekursif koleksi RomM atau menggunakan chmod 777**. Fitur ini tidak memperbaiki izin volume lama otomatis. Backup/restore membutuhkan parent data dan sibling lock tetap pada volume privat yang sama.

Docker dapat meninggalkan direktori mount-point lama milik root pada `data/roms` atau `data/bios`. Setelah mount lama dilepas, periksa kepemilikan direktori internal tersebut jika ingin memakai upload admin. Perbaiki hanya direktori internal yang memang salah pemilik setelah memastikan koleksi RomM tidak lagi terpasang di sana; jangan mengubah izin sumber eksternal.

## Scan dan batas format

1. Buka **Admin → Scan Koleksi**. UI menunjukkan mode sumber ROM dan BIOS.
2. Pilih jenis/platform. Tunggu setidaknya 10 detik sejak perubahan terakhir file, lalu **Mulai Scan**.
3. Tinjau hasil. File baru valid otomatis terdaftar dan muncul di Library/pilihan BIOS.

Struktur yang didukung adalah satu tingkat platform dan file langsung:

```text
roms/nes/Game.nes
roms/snes/Game.sfc
roms/gb/Game.gb
roms/gbc/Game.gbc
roms/gba/Game.gba
roms/genesis/Game.md
roms/psx/Game.chd
bios/psx/scph5501.bin
```

- Folder platform: `nes`, `snes`, `gb`, `gbc`, `gba`, `genesis`, `psx`. BIOS GBC mengikuti console `gb` dan folder `bios/gb`; BIOS tidak dipilih otomatis hanya berdasarkan nama.
- Ekstensi/ukuran mengikuti validator katalog: ROM maksimum 768 MiB, BIOS 32 MiB. Validasi tidak menjamin file playable atau firmware autentik.
- Subfolder bertingkat, symlink/junction, hard link, file khusus, serta nama tidak aman ditolak/tidak diikuti. Tidak ada path bebas dari browser.
- PSX CUE/BIN/M3U multi-file tidak diimpor. Gunakan single-file CHD/PBP/ISO yang didukung. Slug platform lain milik RomM diabaikan.
- Scan manual, bukan watcher atau scan otomatis saat startup. Pembatalan, lease, scope, pagination, dan batas 100.000 item/10.000 detail mengikuti scan internal.
- **Semua aset yang terdaftar dapat diunduh tamu.** Hanya indekskan konten yang boleh disajikan. `:ro` bukan kontrol akses unduh.

## Identitas, konflik, dan keamanan sumber

- Identitas memakai console + SHA-256 byte; scan ulang tidak membuat duplikat atau mengubah save.
- File eksternal tidak pernah disalin, di-rename, dihapus, atau dibuatkan direktori oleh maindulu, bahkan bila mount tidak sengaja writable. Tombol Hapus dinonaktifkan dan API DELETE ditolak (`409 EXTERNAL_READ_ONLY`). Cleanup/recovery tidak menghapus sumber.
- Edit metadata/cover dan ScreenScraper tetap bisa dipakai; perubahan disimpan internal. Integrasi ini **bukan** impor metadata/cover/database RomM.
- File hilang tetap memiliki entri/ID/save; admin menampilkan **Berkas hilang** dan unduh mengembalikan 404. Scan ulang menyambungkan byte identik yang muncul di nama/lokasi baru ke ID aktif yang hilang. Metadata/cover tidak ditimpa dan metadata job baru tidak dibuat. Tombstone tidak dihidupkan kembali otomatis.
- Byte berubah di path terdaftar dilaporkan sebagai konflik; ID/hash/save lama tidak diganti otomatis. Perubahan ukuran atau `mtime` membuat download/HEAD/ETag ditolak (503) sampai scan ulang memverifikasi byte. `ctime` diabaikan karena sebagian sistem file dan mount jaringan menulis ulang nilai ini saat remount tanpa perubahan isi berkas; hanya `size` + `mtime` yang dipakai sebagai penentu validitas. Byte tetap diverifikasi SHA-256 saat scan dan oleh player saat unduh, sehingga byte yang berubah tidak pernah dijalankan.
- Sumber sebaiknya stabil selama permainan; maindulu tidak bisa mencegah RomM/operator mengubah file yang sedang di-stream. Publikasikan transfer dengan nama sementara lalu rename final, jangan overwrite file aktif.
- Path root dipin pada pemetaan server dan tidak dikirim ke frontend. Mengubah env tidak diam-diam mengalihkan aset lama ke byte lain. Root harus berupa direktori nyata, terpisah dari data/public/dist dan sumber lainnya. Sumber yang disetel tetapi tidak tersedia membuat startup gagal, bukan membuat folder kosong diam-diam.
- Kuota upload/free-space dan perhitungan physical usage hanya untuk storage internal; byte sumber eksternal tidak menghabiskan kuota upload maindulu. Ketersediaan disk eksternal dikelola operator.
- CLI backup/restore menolak tujuan yang beririsan dengan sumber eksternal, agar sumber tidak dipakai sebagai tempat penulisan backup/data baru.

## Skema, backup, dan rollback

Migrasi **17** menambah `catalog_external_files`, terpisah dari pemetaan kepemilikan upload. Tabel berisi sumber/path relatif terkontrol dan fingerprint; tidak memindahkan ROM/BIOS atau mengubah akun/save.

Backup format 2 tetap akun/save/metadata, tanpa ROM/BIOS/cover. Snapshot mengosongkan pemetaan eksternal, job/hasil scan, dan pemetaan internal; backup sumber secara terpisah. Setelah restore, pasang env/mount eksternal dan scan ulang: byte identik pada console yang sama dapat disambungkan ke ID aktif lama tanpa upload. Cover perlu dipulihkan terpisah. Backup skema 16 dan versi lama yang sebelumnya didukung tetap diverifikasi sebelum migrasi hasil restore.

Jangan downgrade database skema 17 dengan aplikasi lama; rollback memakai backup ke folder baru dan versi yang sesuai. Menonaktifkan env sumber membuat entri eksternal tidak tersedia tetapi tidak menghapus indeks/save.

## Verifikasi

```sh
node --test tests/catalog-external.test.mjs tests/catalog-scans.test.mjs tests/catalog-backup.test.mjs tests/deploy.test.mjs
npm run build
npm run test:e2e:backend -- tests/browser/catalog-scans.spec.ts tests/browser/admin-catalog.spec.ts
npm test
```

Tes Node menggunakan sumber filesystem terpisah dan API nyata. Tes browser memakai engine NES nyata serta firmware sintetis, bukan bukti BIOS/game PSX atau metadata RomM. Build/runtime Docker, mount Linux `:ro`, dan izin di server Portainer harus diuji pada server tujuan; Docker CLI tidak tersedia di lingkungan pengembangan ini.

Verifikasi browser 2026-11-09: admin + scan **15/15 lulus**, lalu scan + Library **13/13 lulus** (25 skenario unik, 3 scan dijalankan dua kali). Mencakup ROM/BIOS eksternal → Library → engine NES nyata, proteksi hapus, serta regresi upload internal, save/progres, restart, dan restore metadata. Build lulus dengan peringatan ukuran bundle Vite yang tidak memblokir.

Suite Node akhir: **585/585 lulus**, tanpa skip. Percobaan sebelumnya mengungkap tes duplikat BIOS yang juga berlomba pada nama file yang sama; fixture memakai dua nama berbeda agar assertion duplikat hash tetap ketat, sementara konflik nama diuji terpisah. Satu pengulangan terhenti pada batas shell 120 detik saat regresi browser berjalan; suite akhir dijalankan tanpa browser bersamaan dan selesai tanpa perubahan timeout/assertion aplikasi.
