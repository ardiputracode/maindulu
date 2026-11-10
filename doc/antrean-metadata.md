# Antrean Metadata

Buka **Admin → Antrean Metadata** (`/admin/metadata`) dengan akun admin.

- Ringkasan menghitung tugas terbaru setiap game aktif, bukan seluruh riwayat percobaan. Game terhapus dan game dengan scan nonaktif tidak dihitung.
- Daftar mendahulukan tugas berjalan, mengantre, dan menunggu retry; hasil lain diurutkan berdasarkan pembaruan terbaru.
- Cari judul/nama berkas, filter console/status, dan gunakan pagination. Ringkasan global tidak mengikuti filter daftar.
- Tahapan identifikasi ROM, pencarian metadata, pengambilan cover, dan penerapan adalah tahapan terakhir yang dicatat worker, bukan persentase atau estimasi waktu selesai.
- Jadwal retry, kode alasan/peringatan, jeda layanan, dan cooldown ditampilkan bila tersedia. Buka **Review / scan metadata** untuk meninjau hasil atau mencoba scan lagi; aturan cooldown dan keamanan tetap berlaku.
- Data berasal dari database server, sehingga tetap tersedia setelah refresh/pindah perangkat. Tugas operasional tidak disertakan dalam backup metadata.
- Pembaruan otomatis setiap 2,5 detik ketika halaman terlihat dan online, dengan backoff saat koneksi gagal. Data lama diberi peringatan jika pembaruan gagal.

API admin hanya-baca: `GET /api/admin/metadata/jobs`, parameter `q`, `console`, `status`, `page` (default 1), `pageSize` (default 12, maksimum 100). Respons memuat `items`, `total`, `page`, `pageSize`, dan `counts` global. Tidak mengirim byte ROM, path penyimpanan, kredensial provider, lease token, atau payload kandidat.
