# Rencana: ID Game & BIOS Berbasis SHA-256

Status: Draft — keputusan desain dikunci, belum diimplementasi  
Tanggal: 2026-11-22  
Area: `server/database.mjs`, `server/catalog/*`, `server/data-backup.mjs`, `src/lib/catalog.ts`, klien/admin yang memakai ID katalog

## Keputusan Terkunci

| ID | Keputusan | Status |
|---|---|---|
| D1 | `id = sha256` (hex lowercase, 64 karakter) untuk `games` dan `bios` | Terkunci |
| D2 | Keunikan **global**: satu konten hash = satu entri total; hash sama tidak boleh ada lintas console | Terkunci |
| D3 | Managed storage fisik deterministik `<sha256>.bin`; `original_name` tetap dipakai untuk tampilan/download. External/shared adoption **tidak rename** file sumber; konflik nama/path mengikuti aturan adoption/mapping yang ada. Semua nama asli tetap disanitasi | Terkunci |
| D4 | Backup lama ditolak dengan error jelas | Terkunci |
| D5 | Save/history orphan dibersihkan otomatis saat migrasi | Terkunci |
| D6 | Kolom `sha256` dihapus total; semua kode pakai `id` | Terkunci |

## 1. Latar Belakang

Saat ini entri `games` dan `bios` memakai dua identitas:

- `id TEXT PRIMARY KEY` — UUID v4 acak, dihasilkan dengan `randomUUID()`.
- `sha256 TEXT NOT NULL` — hash konten berkas, unik per `console_id`.

ID acak berguna sebagai identitas stabil yang tidak bergantung pada konten, tetapi membuat identitas katalog tidak deterministik. Pengguna meminta perubahan agar game/BIOS baru disimpan dengan **hash-nya saja** sebagai ID.

Konfirmasi pengguna untuk tahap ini:

- Save state dan metadata boleh hilang/tidak ikut dimigrasikan.
- Fokus pada perubahan identitas katalog game/BIOS.

## 2. Tujuan

1. Entri `games` dan `bios` baru memakai SHA-256 konten sebagai `id`.
2. Lookup, route param, validasi, dan penyimpanan file katalog memakai ID hash yang sama.
3. Duplikasi konten terdeteksi langsung lewat primary key/identitas hash.
4. Migrasi database lama ke skema baru terdokumentasi dan dapat dijalankan dengan aman.

## 3. Non-Tujuan

- Mempertahankan save state (`saves`, `user_history`, `user_favorites` yang menunjuk `game_id` lama) pada tahap ini.
- Mempertahankan metadata ScreenScraper/job provenance lama pada tahap ini.
- Mengubah format ID untuk scan job, cleanup task, upload reservation, session, user, atau entitas non-katalog lain.
- Mengubah algoritma hash dari SHA-256.
- Menambah deduplikasi byte lintas storage key yang tidak terkait identitas katalog.

## 4. Keadaan Saat Ini (Bukti Kode)

### 4.1 Skema

`server/database.mjs`:

- `games.id TEXT PRIMARY KEY NOT NULL`
- `games.sha256 ... UNIQUE(console_id, sha256)`
- `games.storage_key TEXT NOT NULL UNIQUE`
- `bios.id TEXT PRIMARY KEY NOT NULL`
- `bios.sha256 ... UNIQUE(console_id, sha256)`
- `bios.storage_key TEXT NOT NULL UNIQUE`

Tabel yang bergantung ke `games.id` lewat FK:

- `game_metadata.game_id REFERENCES games(id) ON DELETE CASCADE`
- `game_metadata_field_sources.game_id REFERENCES games(id) ON DELETE CASCADE`
- `metadata_jobs.game_id REFERENCES games(id) ON DELETE CASCADE`

Tabel lain menyimpan `game_id` sebagai TEXT tanpa FK (contoh: `saves`, `user_history`, `user_favorites`, `game_save_files`). Ini akan menjadi orphan saat ID berubah.

### 4.2 Pembuatan ID

`server/catalog/repository.mjs`:

- Validasi ID: regex UUID v4.
- Publish/adopt: `const id = previous?.id ?? randomUUID()`.
- Metadata job baru juga memakai `randomUUID()` untuk job ID — ini **bukan** ID game.

`server/catalog/storage.mjs`:

- `promoteShared` menghasilkan `key = randomUUID() + '.bin'`.
- `adoption()` menghasilkan `key: randomUUID() + '.bin'`.
- `stage()` menghasilkan `randomUUID() + '.tmp'` (sementara, boleh tetap acak).
- `promote()` menghasilkan `randomUUID() + '.' + ext` untuk file final.

### 4.3 Validasi Route/API

`server/catalog/routes.mjs` memakai `validId()` dari `server/catalog/validation.mjs`:

```js
export const validId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(value)
```

Route admin/public katalog menerima `:id` dan menolak jika bukan UUID.

### 4.4 Klien

`src/lib/catalog.ts` dan komponen admin/library memakai `entry.id` sebagai identitas entri. Perubahan format ID akan mengubah nilai yang dikirim/diterima API, tetapi bentuk field (`id: string`) tetap sama.

## 5. Keputusan Desain

### D1 — Format ID baru

**Terkunci:** `id = sha256` (hex lowercase, 64 karakter).

Alasan:

- Sesuai permintaan "hash-nya saja".
- Deterministik dari konten.
- Sudah dihitung saat staging/adoption.

### D2 — Cakupan keunikan hash

**Terkunci:** PK global `id = sha256`. Satu konten hash = satu entri total.

Konsekuensi:

- Hash yang sama **tidak boleh** ada di dua baris mana pun, termasuk lintas console.
- Constraint lama `UNIQUE(console_id, sha256)` menjadi redundan dan diganti oleh PK global.
- Kasus "hash sama, console berbeda" ditolak sebagai konflik/duplicate sesuai aturan katalog.

### D3 — Storage key / nama file fisik

**Terkunci (revisi rekomendasi):**

1. **Managed storage (`data/games`, `data/bios`)**
   - File fisik disimpan deterministik sebagai `<sha256>.bin`.
   - `storage_key` untuk managed game/bios menjadi deterministik dan selaras dengan `id` (bentuk final dikunci saat implementasi: `sha256.bin` atau nilai kanonik setara).
   - Nama asli **tidak** dipakai sebagai nama file fisik managed; nama asli tetap disimpan di `original_name` dan dipakai untuk tampilan/download (`Content-Disposition`).
2. **External/shared adoption**
   - Jangan rename file sumber di folder eksternal/shared.
   - File nyata tetap memakai nama asli yang ada; mapping internal (`catalog_external_files`/storage mapping) menunjuk ke file itu.
   - Konflik nama/path di disk mengikuti aturan adoption yang sudah ada: identitas sama dapat reattach/already_registered; konten berbeda/unsafe/conflict ditolak.
3. **Sanitasi**
   - Semua nama asli yang masuk tetap divalidasi oleh `safeStorageName`/validasi path yang ada.

**Alasan:** deterministik, bebas konflik nama, mudah rebuild/cleanup, dan tidak bergantung urutan upload.

### D4 — Backup lama

**Terkunci:** backup lama yang memakai format ID UUID **ditolak dengan error jelas**. Tidak ada migrator backup lama pada tahap ini.

### D5 — Save/history orphan

**Terkunci:** save/history orphan **dibersihkan otomatis saat migrasi**.

Cakupan minimal yang dibersihkan:

- `saves` yang `game_id` tidak ada di `games.id` baru.
- `user_history` yang `game_id` tidak ada di `games.id` baru.
- `user_favorites` yang `game_id` tidak ada di `games.id` baru.
- Audit tabel terkait save-backup/blob (`save_backups`, dll.) dan bersihkan referensi yang tidak valid sesuai kebijakan implementasi.

### D6 — Kolom `sha256`

**Terkunci:** kolom `sha256` **dihapus total** dari `games` dan `bios`. Semua kode, query, DTO, backup, dan tes memakai `id` sebagai hash konten.

## 6. Dampak Skema

## 6.1 Tabel `games`

Perubahan target:

```sql
CREATE TABLE games (
  id TEXT PRIMARY KEY NOT NULL
    CHECK(length(id) = 64 AND id NOT GLOB '*[^a-f0-9]*'),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  console_id TEXT NOT NULL CHECK(console_id IN ('nes', 'snes', 'gb', 'gba', 'megadrive', 'psx')),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 10000),
  license TEXT NOT NULL DEFAULT '' CHECK(length(license) <= 2000),
  original_name TEXT NOT NULL CHECK(length(original_name) BETWEEN 1 AND 240),
  storage_key TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 805306368),
  cover_storage_key TEXT UNIQUE,
  cover_type TEXT,
  cover_size INTEGER,
  cover_sha256 TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK((cover_storage_key IS NULL AND cover_type IS NULL AND cover_size IS NULL AND cover_sha256 IS NULL)
    OR (cover_storage_key IS NOT NULL AND cover_type IS NOT NULL AND cover_size IS NOT NULL AND cover_sha256 IS NOT NULL
      AND cover_type IN ('image/png', 'image/jpeg', 'image/webp') AND cover_size BETWEEN 1 AND 8388608
      AND length(cover_sha256) = 64 AND cover_sha256 NOT GLOB '*[^a-f0-9]*'))
) STRICT;
```

Catatan:

- **Kolom `sha256` dihapus total** (D6). `id` adalah satu-satunya identitas hash konten.
- **`UNIQUE(console_id, sha256)` dihapus** (D2). PK global `id` sudah menjamin keunikan konten global.
- Semua query/kode yang membaca `row.sha256` harus pindah ke `row.id`.

## 6.2 Tabel `bios`

Perubahan serupa dengan `games`: kolom `sha256` dihapus, `id` menjadi SHA-256 global PK.

## 6.3 Tabel metadata terkait

Karena metadata boleh hilang dan `game_id` lama (UUID) tidak kompatibel:

1. Drop `game_metadata_field_sources`, `metadata_jobs`, `game_metadata`.
2. Buat ulang dengan FK ke `games(id)` baru.
3. Untuk game yang bertahan setelah migrasi, buat baris metadata minimal/default bila aplikasi membutuhkannya.
4. Jangan remap metadata lama; data boleh hilang sesuai keputusan.

## 6.4 Tabel save/history

**Terkunci (D5): dibersihkan otomatis saat migrasi.**

Tidak ada FK schema saat ini, tetapi tabel ini menyimpan `game_id` katalog sebagai TEXT:

- `saves.game_id`
- `user_history.game_id`
- `user_favorites.game_id`

Langkah migrasi:

1. Setelah tabel `games` baru final, hapus baris `saves`, `user_history`, `user_favorites` yang `game_id` tidak cocok dengan `games.id` baru.
2. Audit tabel save-backup/blob terkait (`save_backups`, dll.) dan bersihkan referensi yang tidak valid/atau tidak dapat direkonsiliasi.
3. Catat jumlah baris yang dibersihkan di log migrasi/backup report.

> Catatan: ini adalah breaking data loss yang sudah disetujui pengguna.

## 7. Perubahan Kode

## 7.1 `server/catalog/validation.mjs`

- Ganti `validId` dari UUID ke SHA-256 hex:

```js
export const validId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
```

- Update pesan error `restoreId`/ID invalid agar sesuai format hash.
- Audit semua pemakai `validId`.

## 7.2 `server/catalog/repository.mjs`

- Ganti regex `uuid` lokal menjadi SHA-256.
- `get()` memvalidasi ID sebagai SHA-256.
- `publish()`/`adopt()`:
  - `const id = file.sha256.toLowerCase()` (atau `file.key` hash-derived yang setara).
  - Jangan pakai `randomUUID()` untuk ID game/bios.
  - Karena D2 global, cek konflik berdasarkan `id`/hash global; kasus hash sama di console berbeda ditolak dengan error konflik yang jelas.
- Hapus semua asumsi `row.sha256`; gunakan `row.id`.
- Metadata job fingerprint/asset identity yang sebelumnya memakai `${file.sha256}:${file.size}` harus direview (bisa jadi `${id}:${file.size}`).

## 7.3 `server/catalog/storage.mjs`

- Managed game/bios file final: `key = ${sha256}.bin`.
- `adoption()` untuk managed: key deterministik hash-based.
- `stage()` tetap acak (`.tmp`) untuk hindari tabrakan upload paralel.
- `promote()` untuk managed game/bios tidak lagi membuat UUID random; gunakan hash.
- Cover tetap UUID/random.
- External/shared adoption: **tidak rename file sumber**. Mapping internal boleh tetap memakai key internal, tetapi file fisik sumber tetap nama asli.
- Pastikan `removeUnreferenced`/cleanup tidak menghapus file yang masih direferensikan entri aktif lain (penting saat ID/hash global).

## 7.4 `server/catalog/routes.mjs`

- Pastikan semua route `:id` game/bios/metadata memakai `validId()` baru.
- DTO/response tidak mengembalikan `sha256` terpisah; identitas hash ada di `id`.
- Audit klien admin yang menampilkan/menyalin SHA-256 dari field lama.

## 7.5 `server/catalog/scans.mjs`

- Scan result memakai ID game/bios yang dihasilkan repository; tidak perlu generate UUID.
- Pastikan logika `already_registered`/`duplicate`/`restore_required` cocok dengan ID hash global.
- Rescan file identik harus menghasilkan ID yang sama (deterministik).

## 7.6 `server/data-backup.mjs`

- Update validasi backup: `id` katalog harus SHA-256, bukan UUID.
- Backup lama yang berisi ID UUID / format lama **ditolak dengan error jelas** (D4).
- Sertakan kode/pesan error yang bisa dipahami operator, mis. menyebut bahwa format backup lama tidak kompatibel dan perlu backup baru setelah migrasi.
- Pastikan restore tidak menulis sebagian data saat format lama terdeteksi.

## 7.7 `src/lib/catalog.ts` dan UI

- ID tetap `string`, tetapi format berubah menjadi 64-char hash.
- Audit asumsi UUID di UI/admin/test: truncation, placeholder, copy label, tooltip, validasi form, sorting.
- Audit semua pemakaian `sha256` field dari API katalog; karena D6, field itu dihapus dan diganti `id`.
- Tampilan "short id" disarankan menampilkan prefix hash (mis. 8-12 char) dengan affordance copy full ID.

## 7.8 Skrip/tes

Audit dan update:

- `tests/` yang membuat/mengharapkan UUID game/bios.
- Fixture catalog, backup, scan, metadata, dan API tests.
- Script CLI/admin yang menerima ID katalog.

Pencarian awal yang wajib diperiksa:

```text
validId
randomUUID() // khusus game/bios/storage key managed
/[a-f0-9]{8}-.../ // UUID regex game/bios
row.sha256 / entry.sha256 / sha256
existingId
restoreId
storage_key
```

## 8. Rencana Migrasi

## M0 — Keputusan & Inventaris

- [x] D1-D6 dikunci.
- Inventaris semua FK/logical references ke `games.id`/`bios.id`.
- Inventaris semua pemakaian `row.sha256`, `entry.sha256`, UUID regex, dan `randomUUID()` khusus katalog game/bios.
- Tetapkan strategi backup lama: ditolak dengan error jelas.

**Verifikasi:** daftar file terdampak lengkap; tidak ada keputusan desain terbuka.

## M1 — Migrasi Schema

Buat migration SQLite baru (versi berikutnya) dengan urutan aman:

1. Siapkan backup/pre-migration guard sesuai mekanisme proyek.
2. `PRAGMA foreign_keys=OFF` bila memakai pola rebuild table SQLite; jalankan dalam transaksi yang aman.
3. Buat tabel baru `games_vNext`, `bios_vNext` tanpa kolom `sha256`, dengan `id` SHA-256 PK global.
4. Salin data existing:
   - `id = lower(sha256)`
   - `storage_key` dipetakan ke target D3.
   - Jika ada bentrok `id` target (hash duplikat global, termasuk lintas console), hentikan migrasi dengan error jelas dan laporan konflik.
5. Drop/recreate tabel metadata terkait game (`game_metadata_field_sources`, `metadata_jobs`, `game_metadata`) agar FK menunjuk ke `games.id` baru.
6. Bersihkan orphan sesuai D5: `saves`, `user_history`, `user_favorites`, dan audit/bersihkan `save_backups`/tabel terkait yang tidak valid.
7. Drop tabel lama, rename tabel baru.
8. Recreate indexes/constraints.
9. `PRAGMA foreign_key_check`.

**Verifikasi:** DB lama dapat dibuka; `games.id`/`bios.id` SHA-256; tidak ada kolom `sha256`; orphan terbersihkan; FK check lulus.

## M2 — Storage/File Migration

Sesuai D3:

1. Tentukan mapping `old storage_key -> new storage_key` untuk managed game/bios (`<sha256>.bin`).
2. Rename/move file fisik managed di `data/games` dan `data/bios`.
3. Update `storage_key` di DB.
4. Update `catalog_asset_files` untuk managed entries; pastikan `name_identity`/path mapping tetap valid.
5. External/shared: **tidak rename** file sumber. Perbarui mapping internal seperlunya tanpa memindahkan file asli.
6. Pastikan cleanup tidak menghapus file target yang sudah direferensikan.

**Verifikasi:** semua entri aktif dapat dibuka lewat storage; external/shared reattach/adoption tetap benar; tidak ada missing file setelah migrasi.

## M3 — Kode Aplikasi

- Update validasi ID (`validId` SHA-256).
- Update repository publish/adopt/get/delete/update untuk ID hash global.
- Update storage key generation/adoption/promotion sesuai D3.
- Hapus semua penggunaan `row.sha256`/`entry.sha256` di server dan client; pakai `id`.
- Update backup/restore: format lama ditolak jelas.
- Update routes/API/DTO/tests.

**Verifikasi:** unit/integration tests untuk catalog, scan, backup, metadata lulus.

## M4 — Kompatibilitas & Rollout

- Dokumentasikan breaking change: ID lama UUID tidak valid.
- Backup lama ditolak dengan error jelas (D4).
- Client/cache lama yang menyimpan ID UUID harus refresh katalog; pastikan error 404/invalid id ditangani wajar.
- Tambahkan catatan migrasi di README/deploy doc yang relevan.

**Verifikasi:** fresh install dan upgrade dari DB lama berjalan sesuai dokumen; backup lama ditolak dengan pesan jelas.

## 9. Strategi Verifikasi

### Otomatis

- Unit tests untuk `validId` SHA-256, repository publish/adopt/restore, storage key generation.
- Migration test: DB fixture versi lama -> migrasi -> assert schema/data/cleanup.
- Assert migrasi: `games`/`bios` tidak punya kolom `sha256`; `id` adalah SHA-256; orphan `saves`/`user_history`/`user_favorites` terbersihkan.
- API tests: create/list/get/update/delete game/bios dengan ID SHA-256.
- Scan/adoption tests: rescan file identik menghasilkan ID sama.
- External/shared adoption tests: file sumber tidak di-rename; konflik path ditangani benar.
- Backup/restore tests: format baru diterima; format lama ditolak dengan error jelas.

### Manual

1. Upload game baru -> respons `id` == SHA-256 file.
2. Upload file yang sama lagi -> duplicate/restore behavior benar.
3. Upload hash sama pada console berbeda -> ditolak sesuai D2.
4. Scan folder berisi file sama -> `already_registered`/`duplicate` benar.
5. Restart server -> entri tetap terbaca.
6. Hapus entri lalu restore sesuai flow yang didukung -> ID tetap hash sama.
7. Restore backup lama -> ditolak dengan error jelas.
8. Setelah migrasi, cek `saves`/`user_history`/`user_favorites` tidak punya `game_id` orphan.

## 10. Risiko

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Hash sama lintas console (D2 global) | Upload/adopt console berbeda ditolak | Error konflik jelas; test kasus eksplisit; dokumentasikan batasan |
| Data loss save/history/metadata | User kehilangan progres/metadata lama | Sudah disetujui; cleanup otomatis saat migrasi; komunikasikan di release note |
| Storage key rename gagal | File katalog hilang dari DB | Backup sebelum migrasi, mapping log, verifikasi post-migration, rollback plan |
| Backup lama tidak kompatibel | Restore gagal | D4: ditolak dengan error jelas; dokumentasikan prosedur backup baru |
| Klien cache ID lama | Link/detail lama 404/invalid | Refresh catalog setelah upgrade; UI tangani invalid id wajar |
| External/shared adoption | Mapping/path salah atau file sumber ter-rename | D3: jangan rename sumber; uji shared writable/read-only/reattach |
| Referensi `row.sha256` tersisa | Bug runtime/DTO/test | Grep audit `sha256`; hapus kolom total sesuai D6; tes API/DTO |

## 11. Pertanyaan Terbuka

Tidak ada keputusan desain terbuka. Keputusan D1-D6 sudah dikunci.

Hal yang tetap perlu diaudit saat implementasi (bukan keputusan produk):

- Daftar lengkap tabel/kolom yang menyimpan referensi game id lama (`save_backups` dan tabel terkait).
- Bentuk final error code/message untuk backup lama yang ditolak.
- Apakah perlu endpoint/mekanisme refresh katalog paksa di client setelah upgrade besar.

## 12. Checklist Implementasi

- [x] Keputusan D1-D6 dikunci
- [ ] Inventaris lengkap referensi `games.id`/`bios.id`/`sha256`/UUID
- [ ] Migration schema games/bios dibuat (tanpa kolom `sha256`, PK hash global)
- [ ] Metadata terkait di-drop/recreate sesuai FK baru
- [ ] Save/history/favorites orphan dibersihkan otomatis saat migrasi
- [ ] `validId` dan semua validator ID diperbarui ke SHA-256
- [ ] Repository publish/adopt/get/update/delete memakai ID hash global
- [ ] Managed storage key/file naming dimigrasikan ke `<sha256>.bin`
- [ ] External/shared adoption tetap tidak rename file sumber
- [ ] Semua pemakaian `row.sha256`/`entry.sha256` dihapus
- [ ] Routes/API/DTO diuji dengan ID hash
- [ ] Scan/adoption/restore flow diuji
- [ ] Backup lama ditolak dengan error jelas
- [ ] Tes unit/integrasi/migrasi lulus
- [ ] Dokumen deploy/README diperbarui
