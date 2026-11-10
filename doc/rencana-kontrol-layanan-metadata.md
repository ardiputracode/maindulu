# Rencana Kontrol Layanan & Aksi Massal Metadata

Status: **rencana; belum diimplementasikan** — 2026-11-10.

Dokumen pendamping: [Antrean Metadata](antrean-metadata.md), [Operasi ScreenScraper](milestone-6-screenscraper-operasi.md), [UI ScreenScraper](milestone-5-screenscraper-ui.md).

## 1. Tujuan dan keputusan pengguna

Halaman **Admin → Antrean Metadata** saat ini hanya bisa memantau dan melakukan aksi **per game**. Rencana ini menambahkan kontrol tingkat layanan dan aksi massal:

- **Lanjutkan layanan** — membersihkan `paused_reason` tanpa menunggu retry per game.
- **Hentikan semua scan** — membatalkan tugas `queued`/`retry_wait`/`paused` dan meminta tugas `running` berhenti.
- **Scan game tanpa metadata** — mengantrekan scan ulang massal untuk game yang belum pernah dipindai (dan opsional: tidak ditemukan/gagal/dijeda).
- **Visibilitas game belum dipindai** — status `disabled` saat ini disembunyikan dari daftar, filter, dan counter sehingga admin tidak punya angka untuk di-backfill.
- **Alasan jeda dalam bahasa manusia** — kode mentah seperti `disabled` tidak lagi menjadi satu-satunya teks.

Keputusan menu: **tidak menambah tab baru**. Semua kontrol ditempatkan di tab **Antrean Metadata** yang sudah ada, karena status, filter, daftar, dan aksi menyangkut objek yang sama.

## 2. Diagnosis kondisi saat ini

Gejala: halaman menampilkan **“Layanan dijeda: `disabled`”** dan seluruh antrean berhenti.

Rantai penyebabnya:

1. `src/components/MetadataQueue.tsx:64` menampilkan `service.pausedReason` apa adanya. Nilainya dibaca dari `metadata_provider_state.paused_reason` lewat `server/catalog/routes.mjs:292`.
2. `server/metadata/worker.mjs:34` mengklasifikasikan kode `disabled` sebagai `{ status: 'paused' }`.
3. Saat job gagal/abort dengan kode `disabled`, `worker.mjs:348-349` menulis `paused_reason = 'disabled'` ke database.
4. Kode `disabled` dipakai sebagai sinyal internal untuk tiga kondisi berbeda:
   - `abortable()` membatalkan I/O saat signal abort (`worker.mjs:24`);
   - `checkCurrent()` mendeteksi job basi/lease hilang/game dihapus/generasi digantikan (`worker.mjs:124`);
   - `stop()` meng-abort job saat shutdown/restart server (`worker.mjs:404-414`), atau interval `checkEnabled`/heartbeat mendeteksi konfigurasi tidak aktif (`worker.mjs:156-164`).
5. `claimJob()` menolak semua job selama `paused_reason` terisi (`worker.mjs:75`). Status tersimpan permanen di SQLite; tidak ada pembersihan otomatis saat startup.
6. Satu-satunya pembersihan saat ini ada di `enqueueMetadata` (`server/metadata/queue.mjs:85`), yang hanya terpicu oleh scan/retry per game.

Artinya: **restart server saat scan berjalan** sudah cukup untuk mengunci seluruh antrean metadata sampai admin membuka satu game dan menekan “Coba scan lagi”.

Temuan tambahan:

- `server/metadata/list.mjs:3,13` dan `src/components/MetadataQueue.tsx:29` sengaja membuang status `disabled` dari daftar/filter/counter. Game yang belum pernah dipindai tidak terlihat sama sekali.
- `src/lib/metadata.ts:15,18` juga menolak item/status `disabled`, sehingga visibilitas tidak bisa dibuka hanya dari server.
- Status `disabled` pada job berarti **scan tidak diminta** (opt-out upload atau `scanMetadata: false`), bukan “fitur mati”. Label UI existing: “Scan nonaktif”.

## 3. Keputusan desain menu

### 3.1 Posisi

Tetap di tab **Antrean Metadata** (`/admin/metadata`). Struktur halaman:

```text
Antrean Metadata
[deskripsi existing]

┌─ Kontrol layanan ─────────────────────────────────────────────┐
│ ● Siap                     Antre 12 · Jalan 1 · Review 3 · Masalah 2 │
│                                                               │
│ [Scan game tanpa metadata]          [Hentikan semua scan]     │
└───────────────────────────────────────────────────────────────┘

[ Cari game/berkas ] [ Filter console ] [ Status metadata ]
Diperbarui otomatis…                              [Muat ulang antrean]

[ kartu ringkasan status ]
[ daftar job — tombol “Review / scan metadata” tetap per game ]
[ pagination ]
```

Panel menggantikan empat paragraf `.notice` yang sekarang menumpuk (tidak siap / worker mati / dijeda / cooldown) menjadi satu sumber status.

### 3.2 Panel “Kontrol layanan”

Kiri — status dan angka:

| Kondisi | Tampilan |
| --- | --- |
| Config siap, worker jalan, tidak dijeda | `● Siap` (mint) |
| `pausedReason` terisi | `● Dijeda` + alasan manusiawi + kode mentah kecil |
| `cooldownUntil > now` | `● Dibatasi sampai <jam>` (amber) |
| `!service.ready` | `● Belum siap` + petunjuk konfigurasi server |
| `service.ready && !worker.running` | `● Worker berhenti` |
| `pausedReason` + cooldown bersamaan | Tampilkan jeda sebagai status utama, cooldown sebagai keterangan |

Angka diambil dari `counts` yang sudah ada: **Antre**, **Jalan**, **Perlu review**, **Masalah**. Tambahan angka **Belum dipindai** (lihat 3.4).

Kanan — tombol kontekstual:

- **Lanjutkan layanan** (primary) — hanya muncul saat `pausedReason` terisi.
  - Aktif hanya jika `service.ready === true` dan `cooldownUntil <= now`.
  - Jika tidak aktif, tampilkan alasan: *“Perbaiki konfigurasi ScreenScraper di server, lalu muat ulang”* atau *“Tunggu cooldown berakhir”*.
  - Tidak boleh “resume lalu langsung pause lagi” tanpa penjelasan.
- **Scan game tanpa metadata** (secondary) — membuka dialog backfill (3.5).
- **Hentikan semua scan** (outline danger) — hanya muncul bila ada job `queued`, `running`, `retry_wait`, atau `paused`.
  - Saat proses, label menjadi **“Menghentikan… N tersisa”** dan tombol disabled.

Panel memakai pola visual existing: `.admin-panel`, `.admin-toolbar`, `.notice`, `.button`, dan warna token yang sudah ada. Di layar sempit, status dan tombol bertumpuk vertikal (`.admin-toolbar` sudah `flex-wrap`).

### 3.3 Alasan jeda dalam bahasa manusia

Tambahkan peta label di `src/lib/metadata.ts`, misalnya `pausedReasonLabels`:

| Kode | Teks |
| --- | --- |
| `disabled` | Scan otomatis tidak aktif / layanan berhenti saat pemrosesan |
| `auth_rejected` | Kredensial ScreenScraper ditolak — periksa DEV_ID/DEV_PASSWORD/USER/PASSWORD |
| `not_configured` | Konfigurasi ScreenScraper belum lengkap |
| `quota_unknown` | Kuota ScreenScraper belum dapat diverifikasi |
| `forbidden` | Akses developer ditolak provider |
| `client_rejected` | Identitas/versi aplikasi ditolak provider |

Kode mentah tetap ditampilkan kecil (`<code>`) untuk admin teknis. Kode yang tidak dikenal ditampilkan apa adanya dengan label netral.

### 3.4 Visibilitas “belum dipindai”

Perluasan kontrak daftar (tetap kompatibel dengan perilaku default):

- `GET /api/admin/metadata/jobs` menerima `status=disabled` sebagai filter eksplisit.
- Tanpa `status` (default), daftar **tetap mengecualikan** `disabled` seperti sekarang, agar antrean tidak dibanjiri game yang memang tidak pernah diminta scan.
- Respons menambah `counts.disabled` = jumlah game aktif yang job terbarunya berstatus `disabled`. Counter lama tetap.
- UI menambah opsi filter **“Belum dipindai”** pada select status, dan opsional satu kartu ringkasan **Belum dipindai**.
- `src/lib/metadata.ts` harus menerima item berstatus `disabled` (hapus penolakan buta di `readMetadataJobs`) dan menerima `counts.disabled` opsional.

Estimasi backfill memakai `total` dari query `status=disabled` (atau status terpilih) sehingga tidak perlu endpoint hitung terpisah.

### 3.5 Dialog “Scan game tanpa metadata”

Isi dialog:

- Kelompok yang disertakan (checkbox):
  - ☑ **Belum pernah dipindai** (`disabled`) — default
  - ☐ **Tidak ditemukan** (`not_found`)
  - ☐ **Gagal** (`failed`)
  - ☐ **Dijeda** (`paused`)
- Scope: **Semua console** atau **Console: `<filter aktif>`**. Default mengikuti filter console halaman; jika kosong berarti semua.
- ☐ **Ganti juga metadata yang terkunci** — **default mati** (aksi massal lebih konservatif daripada scan per game yang default nyala).
- Ringkasan estimasi: *“≈ 87 game akan diantrekan · 982 slot antrean tersisa.”*
  Jika melebihi kapasitas: *“Hanya 982 yang diantrekan; sisanya dapat dijalankan lagi nanti.”*
- Peringatan kontekstual:
  - `pausedReason` terisi → tombol nonaktif dengan *“Lanjutkan layanan terlebih dahulu.”*
  - cooldown → tombol nonaktif + jam berakhir.
  - `!ready` → tombol nonaktif + petunjuk konfigurasi.
- Tombol aksi: **“Antrekan N scan”** (primary). Tombol batal menutup dialog.

Setelah selesai (toast): *“87 scan diantrekan · 5 dilewati (batas antrean).”*

### 3.6 Dialog “Hentikan semua scan”

- Judul: *“Hentikan N scan?”*
- Isi: *“12 menunggu dan 1 sedang berjalan akan dihentikan. Metadata yang sudah diterapkan tidak dihapus. Scan yang berjalan berhenti pada titik pemeriksaan berikutnya.”*
- Tombol: **Batalkan** dan **Hentikan N scan** (danger).
- Setelah selesai (toast): *“13 scan dihentikan.”* Jika ada job running yang masih berhenti: *“12 dihentikan · 1 sedang dihentikan.”*
- Hentikan **tidak** mengubah `pausedReason` dan **tidak** mengubah cooldown. Resume tetap aksi terpisah.

## 4. Semantik status dan aksi

### 4.1 Hentikan semua scan

| Status job | Tindakan |
| --- | --- |
| `queued` | Langsung → `cancelled`, `error_code = 'CANCELLED_BY_ADMIN'`. |
| `retry_wait` | Langsung → `cancelled`. |
| `paused` | Langsung → `cancelled`. |
| `running` | Set `cancel_requested = 1`; worker membatalkan pada pemeriksaan berikutnya → `cancelled`. |
| `needs_review`, `succeeded`, `not_found`, `unsupported`, `failed`, `cancelled` | Tidak disentuh (sudah selesai). |

Aturan:

- Operasi idempoten; pemanggilan berulang tidak menghasilkan error.
- Tidak menulis `paused_reason`. Tidak mengubah `next_at`/cooldown provider.
- Scope opsional: `statuses` dan `consoleId`; default semua job aktif.
- Job `cancelled` tidak dihitung sebagai masalah dan tidak memblokir scan baru.

### 4.2 Lanjutkan layanan

- Hanya membersihkan `paused_reason`.
- **Tidak** mengubah `next_at`; cooldown tetap berlaku.
- Ditolak `409 METADATA_NOT_READY` bila konfigurasi belum siap.
- Ditolak `409 METADATA_COOLDOWN` bila `next_at > now`.
- “Siap” berarti variabel environment lengkap, **bukan** bukti kredensial valid. Jika kredensial salah, worker akan menjeda lagi dan UI menampilkan alasan `auth_rejected`.
- Idempoten.

### 4.3 Scan game tanpa metadata (backfill)

- Hanya game aktif (`deleted_at IS NULL`).
- Kandidat = game yang job generasi terbarunya berstatus salah satu dari kelompok terpilih, **dan** tidak punya job aktif (`queued`/`running`/`retry_wait`).
- Game tanpa baris job (warisan skema lama) diperlakukan sebagai `disabled`; inisialisasi metadata legacy dijalankan sebelum insert.
- Menghormati:
  - kesiapan config (`ready`), jika tidak → `409 METADATA_DISABLED`;
  - `pausedReason` terisi → `409 METADATA_PAUSED` (admin harus resume dulu);
  - cooldown `next_at > now` → `429 METADATA_COOLDOWN`;
  - `maxQueuedJobs = 1000` (`server/metadata/screenscraper-policy.mjs:32`) dikurangi jumlah job aktif;
  - batas permintaan: maksimum 1000 game per panggilan.
- Urutan deterministik: `games.created_at ASC, id`.
- Satu transaksi: buat job baru dengan `generation = MAX+1`, `phase='identifying'`, `status='queued'`, `attempts=0`, `request_method='hash'`, `request_json={replaceLocked, expectedRevision}`; perbarui `catalog_revision` sekali.
- `replaceLocked` default `false`.
- Respons memuat `{ queued, skipped, capacity }` agar UI dapat menampilkan hasil jujur.

### 4.4 Perbaikan akar masalah worker

Sentinel pembatalan dibedakan dari kegagalan provider; hanya kegagalan provider sungguhan yang boleh menyetel `paused_reason`.

| Sentinel | Pemicu | Status job | `paused_reason` |
| --- | --- | --- | --- |
| `cancelled_by_admin` | `cancel_requested` | `cancelled` | tidak diubah |
| `stopped` | shutdown/`stop()` | `retry_wait` (`next_at = now`) | tidak diubah |
| `stale` | game dihapus, aset berubah, generasi digantikan, lease hilang | `cancelled` | tidak diubah |
| `config_disabled` | config dimatikan saat job berjalan | `cancelled` | tidak diubah |
| `auth_rejected`, `forbidden`, `not_configured`, `quota_unknown`, `client_rejected` | respons provider | `paused` | **diisi kode** |

Detail:

- `abortable()` dan `checkCurrent()` memakai sentinel yang sesuai, bukan `'disabled'` generik.
- `classifyError` memetakan `cancelled_by_admin`/`stopped`/`stale`/`config_disabled` ke status non-pause; `disabled` tidak lagi masuk daftar pause.
- `checkCurrent` memeriksa `cancel_requested` dan melempar `cancelled_by_admin`.
- Interval `checkEnabled`/heartbeat membaca flag cancel (satu row terindeks per interval) dan meng-abort I/O secepat mungkin.
- Shutdown: job yang ter-abort kembali ke `retry_wait` sehingga otomatis dilanjutkan setelah restart, bukan mengunci antrean.
- `finishJob` tetap memakai fencing `status='running' AND lease_token = ?`; job yang sudah `cancelled` tidak ditimpa.

## 5. API usulan

Semua endpoint admin, memakai guard sesi/role, origin, dan CSRF existing (`security.protectAdmin`, `security.requireAdmin`, header `X-CSRF-Token`), dengan rate limit seperti `registerCatalogScans`.

| Endpoint | Body | Respons | Catatan |
| --- | --- | --- | --- |
| `POST /api/admin/metadata/service/resume` | `{}` | `{ pausedReason: null, cooldownUntil }` | 409 `METADATA_NOT_READY`, 409 `METADATA_COOLDOWN` |
| `POST /api/admin/metadata/jobs/cancel` | `{ statuses?, consoleId? }` | `{ cancelled, cancelling, total }` | Tidak menyentuh gate provider |
| `POST /api/admin/metadata/backfill` | `{ statuses, consoleId?, replaceLocked? }` | `{ queued, skipped, capacity }` | 409/429 sesuai aturan 4.3 |
| `GET /api/admin/metadata/jobs` (perluasan) | query `status=disabled` | `items`, `total`, `counts` + `counts.disabled` | Default tetap mengecualikan `disabled` |
| `GET /api/admin/metadata/status` (perluasan) | — | tambah `queue.notScanned`; manfaatkan `worker.processing` yang sudah dikirim | Tidak mengekspos token/lease/payload |

Validasi input:

- `statuses`: subset `['disabled','not_found','failed','paused']`, tanpa duplikat, minimal satu.
- `consoleId`: string ≤ 80 karakter, harus console yang dikenal jika diisi.
- Tolak properti tak dikenal (pola validasi route existing).
- Jangan pernah mengembalikan kredensial, lease token, `request_json`, `candidate_json`, path storage, atau fingerprint aset.

## 6. Skema dan migrasi

Migrasi baru: **versi 19** (`server/database.mjs`), karena skema terbaru saat rencana ini ditulis adalah 18.

```sql
ALTER TABLE metadata_jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
UPDATE metadata_provider_state SET paused_reason = NULL WHERE paused_reason = 'disabled';
```

- `cancel_requested` meniru `catalog_scans.cancel` (skema 16) dan memungkinkan pembatalan kooperatif tanpa menunggu timeout jaringan.
- `UPDATE ... WHERE paused_reason = 'disabled'` adalah pembersihan satu kali untuk instalasi yang sudah terkunci oleh bug shutdown/abort. Tidak menghapus `auth_rejected`/`forbidden` agar kegagalan kredensial nyata tetap terlihat.
- Tidak perlu tabel baru.
- `server/data-backup.mjs:88` harus menambahkan `18` ke daftar versi legacy yang diterima, dan manifest backup baru memakai `schemaVersion` 19. `metadata_jobs` tetap dikecualikan dari isi backup (data operasional), dan gate provider tetap dinormalisasi saat snapshot/restore (`data-backup.mjs:106-107,238-239,308-311`).

## 7. Komponen dan berkas yang disentuh

| Berkas | Perubahan |
| --- | --- |
| `server/metadata/worker.mjs` | Sentinel baru, cek `cancel_requested`, shutdown → `retry_wait`, klasifikasi pause hanya untuk kegagalan provider. |
| `server/metadata/queue.mjs` | `resumeMetadataService`, `cancelMetadataJobs`, `backfillMetadata`; reuse `ensureLegacyMetadata` dan aturan `enqueueMetadata`. |
| `server/metadata/list.mjs` | Dukungan filter `disabled`, `counts.disabled`, tetap mengecualikan default. |
| `server/catalog/routes.mjs` | Tiga route baru + perluasan status endpoint + rate limit/validasi. |
| `server/database.mjs` | Migrasi 19. |
| `server/data-backup.mjs` | Terima versi legacy 18. |
| `src/lib/metadata.ts` | Tipe/label alasan jeda, terima status `disabled`, helper aksi baru, validasi respons. |
| `src/components/MetadataQueue.tsx` | Panel kontrol, dialog backfill/stop, filter “Belum dipindai”, status manusiawi, toast. |
| `src/lib/useMetadataTasks.ts` | Notifikasi untuk status baru bila diperlukan (`cancelled_by_admin`). |
| `src/styles.css` | Gaya panel kontrol dan varian tombol danger (pakai token existing). |
| `doc/antrean-metadata.md` | Panduan operator diperbarui setelah implementasi. |

## 8. Milestone implementasi

### Milestone 1 — Perbaikan akar masalah

- [ ] Bedakan sentinel `cancelled_by_admin`, `stopped`, `stale`, `config_disabled`, dan kegagalan provider.
- [ ] Hentikan penulisan `paused_reason='disabled'` untuk abort/shutdown/stale.
- [ ] Shutdown mengembalikan job ke `retry_wait` agar otomatis lanjut setelah restart.
- [ ] Migrasi 19: `cancel_requested` + pembersihan legacy `disabled`.
- [ ] Tes: restart saat job berjalan tidak mengunci antrean; abort tidak menyetel `paused_reason`.

**Kriteria selesai:** tidak ada lagi jalur non-provider yang bisa mengunci seluruh antrean.

### Milestone 2 — API kontrol layanan

- [ ] `resume` dan `cancel` beserta guard ready/cooldown/CSRF/rate limit.
- [ ] Cancel kooperatif untuk job running lewat `cancel_requested`.
- [ ] Tes otorisasi, idempotensi, dan gate provider tidak berubah.

**Kriteria selesai:** antrean bisa dihentikan dan dilanjutkan tanpa menyentuh database secara manual.

### Milestone 3 — Backfill dan visibilitas

- [ ] Filter `status=disabled`, `counts.disabled`, perluasan status endpoint.
- [ ] Endpoint backfill dengan kapasitas, cooldown, status, dan console.
- [ ] Tes kapasitas 1000, skip job aktif, game terhapus, dan game tanpa baris job.

**Kriteria selesai:** admin dapat melihat dan mengantrekan game belum dipindai secara massal dengan angka yang jujur.

### Milestone 4 — UI

- [ ] Panel kontrol, label alasan jeda, dialog backfill dan stop dengan konfirmasi.
- [ ] Filter “Belum dipindai”, kartu ringkasan, toast hasil, status disabled saat proses.
- [ ] Validasi respons baru di `src/lib/metadata.ts`.
- [ ] Aksesibilitas: `aria-live` untuk hasil, fokus dialog, tombol disabled beralasan, tata letak sempit.
- [ ] Tes browser: resume, stop, backfill, refresh saat proses, sesi/role hilang.

**Kriteria selesai:** seluruh alur dapat diselesaikan dari halaman Antrean Metadata tanpa membuka game satu per satu.

### Milestone 5 — Regresi dan dokumentasi

- [ ] `npm test`, `npm run build`, suite backend/browser relevan.
- [ ] Perbarui `doc/antrean-metadata.md` dan catatan operasional.
- [ ] Catat hasil tes nyata, bukan asumsi.

## 9. Matriks pengujian minimum

- Restart/shutdown saat job `running`: tidak ada `paused_reason`, job lanjut setelah server hidup.
- Abort karena game dihapus/aset berubah/generasi digantikan: job `cancelled`/`stale`, gate tetap bersih.
- Config dimatikan saat job berjalan: job berhenti tanpa mengunci antrean.
- Kegagalan provider nyata (`401`/`403`/`426`/kuota): `paused_reason` terisi dan hanya resume eksplisit yang membersihkan.
- Resume saat config tidak siap → 409; saat cooldown → 409; setelah siap → 200 dan idempoten.
- Cancel campuran `queued`/`retry_wait`/`paused`/`running`: hitungan benar, running berhenti pada titik pemeriksaan, tidak menyentuh `next_at`.
- Cancel berulang, cancel saat tidak ada job, cancel dengan filter status/console.
- Backfill: default hanya `disabled`; kombinasi status; `replaceLocked` default `false`; game terhapus/aktif dilewati; kapasitas 1000 dihormati; cooldown/pause/not-ready ditolak dengan kode yang benar; game tanpa baris job ikut.
- Daftar: default tetap mengecualikan `disabled` (kontrak tes existing `tests/screenscraper-m5-backend.test.mjs:50`), `status=disabled` mengembalikan total benar, `counts.disabled` akurat.
- Validasi klien: item `disabled` diterima hanya pada respons baru; payload rusak tetap ditolak.
- Keamanan: tamu 401, user 403, CSRF/origin invalid, input status/console invalid → 400.
- Backup: snapshot skema 18 tetap dapat direstore ke 19; job/gate operasional tetap dinormalisasi.
- Regresi: scan per game, Review metadata, `useMetadataTasks`, queue polling, dan player/save tidak berubah.

Perintah verifikasi yang relevan setelah implementasi:

```sh
npm test
npm run build
npm run test:e2e:backend -- tests/browser/admin-catalog.spec.ts tests/browser/library.spec.ts
```

## 10. Di luar cakupan

- Penjadwalan otomatis/berkala atau watch folder.
- Retry tanpa batas atau backfill otomatis tanpa aksi admin.
- Manajemen multi-akun/multi-provider secara paralel.
- Riwayat job per game di luar generasi terbaru.
- Mengubah kontrak player, save, atau alur upload.
