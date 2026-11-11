# Scan Koleksi dari folder server

Fitur backend: **Admin → Scan Koleksi** (`/admin/scan`). Hosting statis tidak menyediakan scanner. Upload browser tetap tersedia.

## Lokasi dan transfer WinSCP

Untuk instalasi Node, gunakan direktori `MAIN_DULU_DATA_DIR` yang benar-benar dipakai proses server, bukan `public/`, `dist/`, atau folder proyek secara sembarang.

```text
<MAIN_DULU_DATA_DIR>/
  roms/{nes,snes,gb,gbc,gba,genesis,psx}/<nama ROM>
  bios/{nes,snes,gb,gba,genesis,psx}/<nama BIOS>
```

- `.gbc` berada di `roms/gbc/`, `.gb` dan arsip GB/GBC di `roms/gb/`. Keduanya memakai console aplikasi `gb`.
- Mega Drive memakai folder `genesis`, console aplikasi `megadrive`. PlayStation memakai `psx`, bukan `ps1`.
- BIOS GB/GBC memakai `bios/gb/`, bukan `bios/gbc/`.
- Hanya file langsung dalam folder platform. Subfolder tidak diikuti. Folder tidak ada dianggap kosong; folder asing, aset UUID legacy di `games/`, staging, cover, database, dan save bukan sumber scan.
- Maksimum ROM 768 MiB, BIOS 32 MiB; kosong/format salah ditolak. ZIP/7z/RAR tidak diekstrak menjadi beberapa game. PSX `.cue`, `.m3u`, dan track `.bin` tidak diadopsi; gunakan single-file CHD/PBP/ISO yang didukung. Upload lama tidak diubah.

### Docker backend

Compose `deploy/docker-compose.backend.yml` memasang volume `storage` pada **`/var/lib/maindulu`**, dan default root data di container adalah **`/var/lib/maindulu/data`**. Jadi tujuan ROM misalnya `/var/lib/maindulu/data/roms/nes/game.nes`, bukan `/var/lib/maindulu/roms/nes/game.nes`.

Volume bernama default umumnya `maindulu-backend_storage`; pastikan nama dan mount aktual lewat `docker volume ls`, `docker volume inspect`, dan `docker inspect` container. WinSCP mengakses filesystem **host**, bukan otomatis filesystem container. Jangan menebak lokasi internal Docker atau menyalin ke layer image/container.

Untuk akses SFTP/WinSCP yang jelas, operator dapat memasang bind mount host, misalnya `/srv/maindulu:/var/lib/maindulu` lewat override Compose. Dalam konfigurasi ini tujuan host adalah `/srv/maindulu/data/roms/nes/`. Target volume tetap seluruh `/var/lib/maindulu` agar direktori lock saudara data ikut persisten. **Jangan mengganti mount instalasi berisi data dengan direktori kosong**: hentikan server, backup, dan migrasikan data/permission secara eksplisit terlebih dahulu. Jika `MAIN_DULU_CONTAINER_DATA_DIR` diubah, sesuaikan pemetaan host/container dengan nilai aktual.

Image berjalan sebagai user `node`. Verifikasi UID/GID runtime (`docker compose -f deploy/docker-compose.backend.yml exec backend id`) dan atur ownership/ACL agar user SFTP serta proses server dapat membaca file dan menelusuri folder; server juga memerlukan izin tulis/hapus untuk lifecycle aset. Jangan memakai `chmod 777`. Jangan membuat symlink, junction, atau hard link sebagai pengganti file asli.

### Prosedur transfer aman

1. Salin memakai nama sementara, misalnya `game.nes.filepart` (aktifkan transfer temporary filename/resume di WinSCP).
2. Setelah transfer benar-benar selesai, rename di folder yang sama menjadi `game.nes`.
3. Tunggu **setidaknya 10 detik setelah perubahan terakhir** (mtime dan ctime), lalu jalankan scan.
4. **Jangan overwrite file yang sudah dikelola aplikasi lewat WinSCP.** Untuk isi berbeda, pilih basename lain. Jangan mengubah atau menghapus file saat scan/publikasi berlangsung.

Usia minimum dan kestabilan sebelum/sesudah hashing bukan bukti transfer selesai: transfer yang berhenti sementara dapat tampak stabil. Rename final adalah pengamanan operasional utama. Scanner tidak dapat mencegah operator mengganti byte setelah publikasi. Usia minimum transfer tetap memakai `max(mtime, ctime)` untuk memastikan file benar-benar selesai ditulis; ini hanya relevan saat scan dalam hitungan detik setelah boot dan tidak memengaruhi pemutaran game yang sudah terdaftar.

## Menjalankan scan

1. Masuk sebagai admin, buka **Scan Koleksi**.
2. Pilih ROM/BIOS/Keduanya (default Keduanya) dan semua/beberapa platform folder.
3. Opsional aktifkan **Cari metadata dan cover untuk game baru** (default mati). Opsi memerlukan konfigurasi ScreenScraper siap dan ROM dalam scope. Nama, ukuran, hash, sistem, dan untuk CHD serial disc dapat dikirim; byte ROM/BIOS tidak dikirim. Hasil provider/cover disimpan lokal. Metadata existing dan BIOS tidak diperbarui.
4. Klik **Mulai Scan**. Setiap file valid langsung terdaftar tanpa pratinjau/konfirmasi kedua. Aset aktif dapat diunduh publik, termasuk oleh tamu. Hanya distribusikan berkas yang memang berhak Anda distribusikan; scanner tidak mengarang lisensi atau menjamin ROM playable/BIOS autentik.
5. Pantau jumlah ditemukan/diproses, ditambahkan/dilewati/bermasalah. Selama enumerasi belum selesai tidak ada persentase total. Filter status/pencarian hanya mengubah tampilan.

File tidak disalin, dipindah, di-rename, atau dihapus oleh scan. **Setelah diadopsi, tindakan Hapus di Manage Game/BIOS dapat membersihkan file fisiknya**, sama seperti hasil upload. Identitas katalog/save tetap memakai ID stabil, bukan nama file.

Menutup tab tidak membatalkan worker. Refresh menemukan job aktif; tab menyimpan referensi hasil terakhir jika session storage tersedia. **Batalkan scan** menghentikan pendaftaran berikutnya, tidak menghapus entri sukses atau membatalkan job metadata yang sudah diantrekan. Sesi kedaluwarsa/dicabut atau demosi admin menghentikan scan. Provider gagal/review tidak membatalkan game baru; kelola lewat Review/scan metadata existing.

## Membaca hasil

| Status | Arti / tindak lanjut |
| --- | --- |
| `added` | Berhasil didaftarkan otomatis. |
| `already_registered` | Path terdaftar dan hash byte masih cocok; metadata tidak disentuh. |
| `duplicate` | Jenis + console + SHA-256 sama; ID existing ditampilkan, file ekstra tetap ada. |
| `conflict` | Path/nama berbenturan atau byte berubah, termasuk ukuran sama; tidak ditimpa. |
| `restore_required` | Ada tombstone/metadata dengan ID lama atau aset hilang. Gunakan Upload dan konfirmasi **Pulihkan ID lama**; jangan membuat ID baru. |
| `busy` | Klaim upload/delete/cleanup masih aktif; ulangi nanti. |
| `invalid` | Nama, ekstensi, platform, ukuran, atau subfolder tidak didukung. |
| `unsafe` | Symlink/junction, hard link, file khusus, atau direktori tidak aman; tidak diikuti. |
| `not_ready` | Temporary file, terlalu baru, hilang, berubah, atau pathname diganti saat verifikasi; selesaikan transfer lalu scan lagi. |
| `unsupported_multifile` | Paket/track PSX bukan cakupan scanner; gunakan format single-file. |
| `failed` | I/O gagal; periksa permission/log server dan scan lagi. |

Counter tidak dihitung ganda. Jumlah game **masuk antrean metadata** berbeda dari hasil metadata sukses. Scan ulang idempoten, bukan overwrite, rescan metadata existing, atau pemulihan massal.

## Batas dan pemulihan operasi

- Satu job aktif per database/direktori data, ditegakkan SQLite lintas koneksi/proses. Start kedua mengembalikan `409` dan referensi job aktif.
- Hashing satu file sekaligus dengan buffer 1 MiB, maksimal 100.000 item/job. Maksimum 6 start/menit dan 240 request scan/menit per admin pada proses server.
- Counter/job disimpan 7 hari; maksimal 10.000 detail per job pada 20 job terbaru. Jika detail dipangkas, counter tetap utuh dan UI memberi pemberitahuan.
- Lease 30 detik dengan heartbeat 5 detik. Job crash menjadi `interrupted` setelah kedaluwarsa (pemeriksaan berkala 10 detik atau saat API diakses), tidak dilanjutkan otomatis. Scan ulang setelah server sehat. Worker lama tidak boleh menerbitkan setelah lease hilang. Shutdown memeriksa pembatalan pada setiap chunk hash.
- Sampling kuota menghitung file fisik termasuk yang belum diadopsi, tanpa menghitung adopsi dua kali. UI melaporkan jika sampling gagal atau volume sudah over-quota; adopsi tidak menambah byte dan tidak menghapus file untuk memperbaiki kuota. Perubahan eksternal saat sampling tetap memerlukan disiplin operator.
- Recovery/backup/restore offline tetap memerlukan lock eksklusif; hentikan server dahulu. Recovery tidak menghapus unknown file operator. Backup hanya akun/save/metadata, bukan ROM/BIOS/cover; job/hasil/lease scan dan mapping aset dinormalisasi keluar dari snapshot. Restore tidak menghidupkan job lama.

## Verifikasi implementasi

Suite otomatis: `tests/catalog-scans.test.mjs`, `tests/browser/catalog-scans.spec.ts`, beserta regresi katalog, metadata, backup, library, dan aset existing. Catatan eksekusi akhir ada di [rencana implementasi](rencana-scan-koleksi-folder.md). Pengujian filesystem/API/browser otomatis **bukan** pengujian transfer WinSCP atau deployment Docker nyata.
