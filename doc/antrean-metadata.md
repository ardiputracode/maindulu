# Antrean Metadata

Buka **Admin → Antrean Metadata** (`/admin/metadata`) dengan akun admin.

- Ringkasan menghitung tugas terbaru setiap game aktif, bukan seluruh riwayat percobaan. Game terhapus tidak dihitung. **Belum dipindai** mencakup status `disabled` (scan belum diminta/opt-out) dan game lama tanpa job. Daftar default tetap menyembunyikan kelompok ini; pilih filter **Belum dipindai** untuk melihatnya.
- Daftar mendahulukan tugas berjalan, mengantre, dan menunggu retry; hasil lain diurutkan berdasarkan pembaruan terbaru.
- Cari judul/nama berkas, filter console/status, dan gunakan pagination. Ringkasan global tidak mengikuti filter daftar.
- Tahapan identifikasi ROM, pencarian metadata, pengambilan cover, dan penerapan adalah tahapan terakhir yang dicatat worker, bukan persentase atau estimasi waktu selesai.
- Jadwal retry, kode alasan/peringatan, jeda layanan, dan cooldown ditampilkan bila tersedia. Buka **Review / scan metadata** untuk meninjau hasil atau mencoba scan lagi; aturan cooldown dan keamanan tetap berlaku.
- Data berasal dari database server, sehingga tetap tersedia setelah refresh/pindah perangkat. Tugas operasional tidak disertakan dalam backup metadata.
- Pembaruan otomatis setiap 2,5 detik ketika halaman terlihat dan online, dengan backoff saat koneksi gagal. Data lama diberi peringatan jika pembaruan gagal.

## Kontrol layanan

Panel **Kontrol layanan** menyatukan status kesiapan, worker, jeda provider, cooldown, dan angka antrean. Alasan jeda ditampilkan dalam bahasa manusia beserta kode teknisnya.

- **Lanjutkan layanan** membersihkan jeda saja, bukan cooldown. Perbaiki konfigurasi server dan tunggu cooldown bila tombol nonaktif. Kesiapan konfigurasi bukan bukti kredensial valid: bila provider menolak, worker akan menjeda lagi dengan alasan yang sesuai.
- **Scan game tanpa metadata** membuka konfirmasi massal. Default hanya **Belum pernah dipindai**, mengikuti filter console aktif; pencarian teks halaman tidak membatasi backfill. Kelompok **Tidak ditemukan**, **Gagal**, dan **Dijeda** bersifat opsional. Metadata terkunci **tidak diganti** kecuali checkbox dipilih. Estimasi dapat berubah karena admin/worker lain; hasil akhir menyebut jumlah diantrekan dan dilewati.
- Maksimum 1000 job aktif (`queued`/`running`/`retry_wait`) dan 1000 scan per panggilan. Kandidat diurutkan dari game paling lama; game terhapus atau yang masih punya job aktif tidak diantrekan ulang. Jalankan lagi setelah kapasitas tersedia jika ada yang dilewati.
- **Hentikan semua scan** membatalkan job menunggu, retry, dan dijeda; job berjalan menerima permintaan berhenti kooperatif. Metadata yang sudah diterapkan tidak dihapus. Tombol menampilkan jumlah job yang masih berhenti; status tetap dapat dipantau setelah reload. Aksi ini tidak menjeda layanan dan tidak mengubah cooldown: scan baru tetap dapat diminta setelahnya.
- Shutdown/restart mengembalikan job berjalan ke `retry_wait` segera tanpa menulis jeda provider. Perubahan aset, game terhapus, atau konfigurasi dinonaktifkan membatalkan job tanpa mengunci layanan. Migrasi skema 19 membersihkan sekali jeda legacy `disabled`, tetapi mempertahankan jeda autentikasi nyata.

## API admin

Semua endpoint memerlukan sesi admin. Mutasi juga memerlukan origin yang valid dan `X-CSRF-Token`, serta dibatasi 240 permintaan per menit per admin.

| Endpoint | Input | Hasil |
| --- | --- | --- |
| `GET /api/admin/metadata/jobs` | `q`, `console`, `status` (termasuk `disabled`), `page` (1), `pageSize` (12, maks. 100) | `items`, `total`, `page`, `pageSize`, `counts` global termasuk `disabled` |
| `GET /api/admin/metadata/status` | — | Kesiapan, jeda, cooldown, `worker.processing`, `queue.notScanned`, `queue.cancelling`, `queue.capacity` |
| `POST /api/admin/metadata/service/resume` | `{}` | `pausedReason: null`, `cooldownUntil`; 409 `METADATA_NOT_READY` / `METADATA_COOLDOWN` |
| `POST /api/admin/metadata/jobs/cancel` | `{ statuses?, consoleId? }` | `cancelled`, `cancelling`, `total`; status opsional: `queued`, `running`, `retry_wait`, `paused` |
| `POST /api/admin/metadata/backfill` | `{ statuses?, consoleId?, replaceLocked? }` | `queued`, `skipped`, `capacity` (slot tersedia sebelum enqueue); default `statuses: ['disabled']`, `replaceLocked: false` |

Backfill menerima subset unik `disabled`, `not_found`, `failed`, `paused`; menolak konfigurasi belum siap (409 `METADATA_DISABLED`), jeda (409 `METADATA_PAUSED`), dan cooldown (429 `METADATA_COOLDOWN`). Properti tak dikenal, status kosong/duplikat, dan console tidak dikenal ditolak 400. Cancel dan resume idempoten. Respons tidak mengirim byte ROM, path penyimpanan, kredensial provider, lease token, fingerprint aset, atau payload kandidat.

Backup baru memakai skema 19; backup skema 18 tetap dapat diverifikasi dan direstore. Job dan gate operasional tetap dinormalisasi, bukan dipulihkan menjadi scan aktif.
