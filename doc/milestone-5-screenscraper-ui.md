# M5 ScreenScraper — Upload, Review, dan Refresh Library

Tanggal: **2026-11-08**. Status: **selesai dalam cakupan implementasi/offline**. Fitur tetap default **nonaktif**; M6/aktivasi operasional belum ditutup.

## Audit dan perbaikan

Implementasi parsial sebelumnya belum cukup: fallback judul masih ditolak repository, search melakukan request langsung di handler, hasil nama tidak bisa diterapkan, form mengirim ulang nilai lama, dan polling belum memiliki abort/backoff/snapshot revision.

- Upload cukup ROM + console. Judul kosong/absen memakai basename tervalidasi tanpa ekstensi, garis bawah menjadi spasi, maksimum 200 karakter, fallback `Game`. Sumber `filename` terbuka; judul yang diisi admin `manual` terkunci. BIOS tidak berubah.
- Checkbox scan mengikuti capability `metadata` dan kesiapan konfigurasi. Nonaktif/opt-out menghasilkan status `disabled`, bukan tugas yang kelak diam-diam memakai kuota. Restore aset lama tidak mengaktifkan scan tanpa tindakan eksplisit. Pesan sukses membaca status respons server.
- Edit hanya mengirim field berubah dan `expectedRevision` bila tersedia. Keputusan eksplisit mengosongkan deskripsi/cover mengunci field. Tab stale mendapat konflik, bukan menimpa edit terbaru.
- Dialog **Review / scan metadata** menyediakan status Indonesia, alasan aman, warning cover, waktu/cooldown, daftar kandidat, preview nilai sekarang/usulan, provenance, apply terpilih dan unlock per field.
- Search dan apply merupakan request worker persisten. Gate SQLite bersama menserialkan worker dan cooldown, dengan batas antrean, `Retry-After`, dan cooldown quota error. Retry admin tidak mempersingkatnya. Pencarian nama tidak pernah auto-apply.
- Manual apply menerima ID kandidat tersimpan + generation + expected revision + allowlist field, terikat fingerprint/sistem/retensi. Persetujuan manual boleh mengganti field terkunci yang dipilih lalu menguncinya sebagai `manual`. Auto-apply hash tetap memakai policy M0. Memilih hanya Cover memungkinkan retry tanpa lookup teks baru; transport/staging/quota/kompensasi cover lokal dipertahankan.
- Polling satu flight saat visible/online, abort saat hidden/offline/unmount, backoff sampai 60 detik, refresh fokus/online. Refresh manual memulai kembali polling segera. Library memakai satu coordinator di App; tidak polling ROM/BIOS.
- API publik membaca rows/total/revision dalam transaksi singkat. Client membandingkan revision antarhalaman, mengulang maksimal tiga snapshot, lalu mengganti daftar atomik tanpa mengosongkan grid. Query/filter/page/fokus tetap; perpindahan hasil diberitahukan.
- `coverRevision` checksum memperbarui gambar pada endpoint cover yang sama, tanpa mengubah cache/URL/identitas ROM. Favorit/riwayat diperbarui berdasarkan ID tanpa menghapus referensi lokal/game terhapus, menaikkan batas, mengganti sesi aktif, atau menulis metadata save lama.
- Mode statis tetap tanpa API discovery/scan; backend lama tanpa capability metadata tetap dapat memuat katalog. Privasi nama/hash yang dibagikan serta atribusi ScreenScraper dijelaskan di UI.

## Skema, backup, dan kontrak

Migrasi baru **13**, tanpa mengubah migrasi historis: `metadata_jobs.request_method` (`hash`, `name`, `apply`), `request_json` terbatas, dan singleton `metadata_provider_state` untuk lease/cooldown/pause lintas worker yang berbagi database.

Backup mempertahankan metadata/provenance/override, tetapi menghapus tugas/cache dan menormalkan gate **hanya pada snapshot**. Restore tidak melanjutkan tugas atau menghubungi provider. Backup skema 12 tetap diterima dan diverifikasi sebelum migrasi; tes skema lama disesuaikan agar tidak menyisakan tabel skema 13 palsu.

| Endpoint | Kontrak M5 |
| --- | --- |
| `GET /api/admin/metadata/status` | Kesiapan tanpa nilai secret, worker enabled, ringkasan antrean dan cooldown. Bukan pembacaan live saldo quota akun. |
| `GET /api/admin/games/:id/metadata` | Status/generation, alasan aman, waktu, kandidat + preview/provenance/revision. Tanpa hash pencarian, lease, atau URL media provider. |
| `POST .../metadata/scan` | Request hash idempoten; tidak menggandakan tugas aktif atau membuka override. |
| `POST .../metadata/search` | `{ query }`, maksimum 200 karakter, melalui antrean bersama. |
| `POST .../metadata/apply` | `{ candidateId, generation, expectedRevision, fields }`, queued atas kandidat tersimpan. |
| `POST .../metadata/unlock` | `{ field, expectedRevision }`, membuka satu kunci tanpa mengubah nilai. Nama DB tanggal/region: `release_date`, `region_language`. |
| `GET /api/catalog/revision` | Revision publik monoton. |

Detail privat `no-store`; status publik hanya `pending`, `ready`, `review`, `disabled`. Mutasi enqueue mengembalikan HTTP 200 dengan generation/status; pemrosesan sebenarnya asynchronous. Mutasi tetap memeriksa sesi/role/CSRF terbaru.

## Bukti pengujian akhir

Windows, Node.js 24+, Microsoft Edge headless. Backend/SQLite nyata dan engine NES lokal; provider/media berupa dependency fixture dengan kredensial `dummy`. Tidak membaca secret operator atau menghubungi ScreenScraper asli.

| Command | Hasil akhir |
| --- | --- |
| `npm test` | **406 lulus, 0 gagal/skip** |
| `npm run build` | **Lulus**, peringatan chunk frontend >500 kB tetap ada |
| `npm run test:e2e:backend -- metadata.spec.ts admin-catalog.spec.ts library.spec.ts --output=test-results/m5-final-backend` | **31 lulus, 0 gagal/skip/retry otomatis** |
| `npm run test:e2e -- backend.spec.ts library.spec.ts --grep "deployment mode\|admin deep links\|Library has portable" --output=test-results/m5-static-dev` | **3 lulus, 0 gagal/skip** |
| `npm run test:e2e:production -- backend.spec.ts library.spec.ts --grep "deployment mode\|admin deep links\|Library has portable" --output=test-results/m5-static-production` | **3 lulus, 0 gagal/skip** |

Matriks `tests/browser/metadata.spec.ts` (**10 tes**, termasuk dalam 31):

1. Upload tanpa judul → playable saat lookup ditahan → engine NES nyata berjalan → tab lain memperbarui judul/cover/favorit tanpa reload; sesi aktif tetap berjudul lama.
2. Hasil ambigu → kandidat kedua → preview/apply hanya Judul → field lain tetap → unlock → search manual; dialog mobile/Escape/fokus toolbar.
3. Edit saat lookup benar-benar ditahan → CAS menolak hasil stale → judul admin menang; deskripsi tidak diedit tetap terbuka.
4. Backend tanpa capability metadata → katalog tersedia, nol request endpoint metadata.
5. Lookup tidak ditemukan → ROM tersedia, status/waktu Indonesia, hash retry ditahan; name fallback setelah cooldown.
6. Disabled → checkbox nonaktif, pesan tidak mengklaim scan, nol provider calls.
7. Koleksi 101 upload/multi-page → judul berubah → URL filter/page/fokus tetap; 12 kartu tanpa duplikasi/snapshot campuran.
8. Cover gagal → teks sukses/warning → retry hanya Cover dari kandidat tersimpan, tanpa lookup sukses diulang.
9. Dua tab revision sama → tab stale mendapat konflik, tidak menimpa pilihan terbaru.
10. Hidden/offline menghentikan polling; visible/online memulai kembali tanpa mengosongkan grid.

Regresi admin/Library mencakup tamu/non-admin/role dicabut, validasi/cancel/error upload, BIOS, URL aset terhapus, save/progres NES, restart dan restore metadata tanpa aset. Unit tambahan memeriksa queue/CAS/cooldown lintas worker, DTO, revision berubah dengan total sama, backup 12, serta gate snapshot yang tidak mengubah sumber.

### Percobaan awal

Tidak semua percobaan langsung lulus:

- Dua putaran seluruh suite awal: 402 tes dengan **10 gagal**, lalu **2 gagal**. Fixture downgrade menyisakan tabel baru; ekspektasi lama masih melarang judul kosong atau memakai batas multipart/capability/skema lama. Diperbaiki, lalu suite akhir **406/406** lulus.
- Browser fokus awal mengalami timeout locator Favorit dengan badge jumlah dan selector status ambigu; ekspektasi favorit berjudul lama juga diperbarui sesuai perilaku M5.
- Putaran 28 tes: **26 lulus/2 gagal**; name fallback mengungkap kontrol yang belum menunggu cooldown global. DTO/UI kini menampilkan dan menghormatinya.
- Putaran 31 tes: **30 lulus/1 gagal** karena tes race belum memastikan lookup dimulai/edit sudah commit. Tes kini menunggu kedua kondisi, bukan melonggarkan CAS. Putaran akhir **31/31** lulus dan diulang setelah audit snapshot/refresh dengan hasil sama.

## Batas penutupan

M5 ditutup untuk kriteria UI/integrasi di atas, **bukan rilis atau aktivasi umum**. Tidak menjalankan seluruh matriks browser proyek, Docker, HTTPS/LAN deployment baru, smoke API ScreenScraper nyata, atau semua core/format ROM. Saldo quota live, runbook/observabilitas lengkap, regresi operasional menyeluruh, dan rollout tetap pekerjaan M6. ZIP/disc tidak menjadi eligible hash; tidak ada scan massal startup/restore atau perubahan engine/identitas save/cache ROM.
