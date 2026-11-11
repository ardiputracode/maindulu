# Rencana — Validasi Aset Eksternal Tahan Remount (Opsi B)

Status: **rencana, belum diimplementasikan** — 2026-11-11.

Rencana ini memperbaiki kasus ROM/BIOS dari sumber eksternal yang berubah menjadi
HTTP 503 setelah host di-reboot dan baru bisa dimainkan lagi setelah **Scan
Koleksi**. Perbaikannya sengaja dipilih yang paling murah: **berhenti memakai
`ctime` sebagai penentu validitas**, tanpa hashing, tanpa scan otomatis, dan
tanpa migrasi database.

## 1. Latar belakang dan bukti

Panduan terkait: [koleksi eksternal hanya-baca](koleksi-eksternal-read-only.md)
dan [folder bersama](koleksi-folder-bersama.md).

Gejala yang dilaporkan operator (OpenMediaVault + Docker, ROM di mount
`/mnt/romm/roms`):

1. Setelah host dimatikan dan dinyalakan lagi, Library tetap menampilkan game,
   tetapi saat dibuka player gagal dengan **HTTP 503 `ASSET_UNAVAILABLE`**.
2. Menjalankan **Admin → Scan Koleksi** membuat game bisa dimainkan lagi.
3. `docker restart` container saja **tidak** mereproduksi masalah.

Pengukuran operator pada berkas `roms/psx/Suikoden (Asia).chd`:

| Waktu pengukuran | `size` | `mtime` | `ctime` |
| --- | --- | --- | --- |
| Sebelum `docker restart` | 329641708 | 2026-10-26 15:07:11 UTC | 2026-11-11 16:05:19 UTC |
| Sesudah `docker restart` | 329641708 | 2026-10-26 15:07:11 UTC | 2026-11-11 16:05:19 UTC |
| Sesudah host reboot (`uptime -s` = 2026-11-11 23:22:50 WIB) | 329641708 | 2026-10-26 15:07:11 UTC | **2026-11-11 16:23:39 UTC** |

Nilai yang tersimpan di database saat itu:

```text
Suikoden (Asia).chd db_mtime 2026-10-26T15:07:11.440Z db_ctime 2026-11-11T16:05:19.879Z
```

Kesimpulan: `size` dan `mtime` stabil, sedangkan **filesystem menulis ulang
`ctime` saat mount setelah boot**. Database masih memegang `ctime` dari mount
sebelumnya, sehingga pemeriksaan `open()` menolak berkas. Ini bukan ROM hilang,
bukan database rusak, dan bukan masalah engine/player. Scan ulang
"menyembuhkan" karena `refreshAdoption()` menulis ulang `mtime_ms`/`ctime_ms`
ketika SHA-256 byte tetap sama.

Perilaku filesystem seperti ini umum pada mount yang tidak menyimpan `ctime`
asli, misalnya NTFS/exFAT, mergerfs/FUSE, atau share jaringan. Karena `ctime`
bukan waktu perubahan isi, memakainya sebagai syarat validitas justru menghasilkan
false positive di setiap remount.

## 2. Keputusan

**Gunakan Opsi B: hapus perbandingan `ctime`, pertahankan `size` + `mtime`.**

Alasan:

- `mtime` terbukti stabil lintas remount pada kasus nyata ini, sedangkan `ctime`
  tidak.
- Nol biaya runtime: tidak ada hashing tambahan, tidak ada baca ulang ROM, tidak
  ada scan otomatis.
- Tidak ada perubahan skema, API, format URL, atau identitas save.
- Integritas byte tetap dijaga:
  - Scan menolak perubahan byte/ukuran sebagai `conflict`/`damaged`.
  - ETag tetap SHA-256 yang tersimpan saat scan.
  - Player tetap memverifikasi SHA-256 seluruh hasil unduhan sebelum menjalankan
    game (`src/lib/server-assets.ts:210`), jadi byte yang berubah tidak akan
    pernah dijalankan.

Alternatif yang ditolak untuk iterasi ini:

- **Opsi A — hash saat cap waktu berbeda.** Lebih kuat, tetapi menambah satu
  pembacaan penuh ROM (hingga 768 MiB) pada permainan pertama setelah reboot dan
  membutuhkan single-flight serta penanganan TOCTOU. Tidak dipakai selama
  `mtime` masih stabil.
- **Bandingkan `size` saja.** Paling longgar dan juga murah, tetapi menurunkan
  deteksi perubahan byte di sisi server lebih jauh. Disimpan sebagai rencana
  cadangan bila di kemudian hari `mtime` ikut bergeser pada mount lain.

Keputusan ini juga berlaku untuk pemeriksaan sebelum **hapus** di mode folder
bersama (`MAIN_DULU_EXTERNAL_WRITABLE=true`). Tanpa itu, tombol Hapus akan gagal
"tidak aman" setelah setiap reboot sampai scan ulang.

## 3. Kondisi kode saat ini

| Lokasi | Peran |
| --- | --- |
| `server/catalog/storage.mjs:477-491` | `open()` aset eksternal; membandingkan `size`, `mtimeMs`, dan `ctimeMs` dengan nilai hasil scan. |
| `server/catalog/storage.mjs:118-139` | Precheck hapus berkas eksternal di mode bersama; baris 124 membandingkan `size`, `mtimeMs`, dan `ctimeMs` sebelum verifikasi SHA-256. |
| `server/catalog/storage.mjs:336-343` | `refreshAdoption()`; menulis ulang `mtime_ms`/`ctime_ms` saat scan menemukan byte identik. |
| `server/catalog/storage.mjs:344-364` | `claimAdoption()`; menyimpan `mtime_ms`/`ctime_ms` saat adopsi pertama. |
| `server/catalog/storage.mjs:266-279` | `scanFileState()`; status ketersediaan hanya memakai keberadaan berkas dan `size`. |
| `server/catalog/queries.mjs:40-56` | `adminDto()` memakai `storage.open()`, sehingga status "rusak/unsafe" di admin ikut berubah setelah perbaikan. |
| `server/catalog/assets.mjs:60-107` | Rute unduh; error `open()` non-`ENOENT` dipetakan menjadi 503 `ASSET_UNAVAILABLE`. |
| `src/lib/server-assets.ts:72-86,210` | Klien memvalidasi ukuran/ETag dan memverifikasi SHA-256 hasil unduhan. |

## 4. Perubahan yang direncanakan

### 4.1 `server/catalog/storage.mjs` — `open()` aset eksternal

Sebelum:

```js
if (stat.size !== external.size || stat.mtimeMs !== external.mtime_ms || stat.ctimeMs !== external.ctime_ms) throw new Error('Sumber eksternal berubah; jalankan scan ulang sebelum dimainkan.')
```

Sesudah:

```js
if (stat.size !== external.size || stat.mtimeMs !== external.mtime_ms) throw new Error('Sumber eksternal berubah; jalankan scan ulang sebelum dimainkan.')
```

Pesan error, status 503, dan alur rescan tidak berubah. Hanya sumber false
positive yang dihilangkan.

### 4.2 `server/catalog/storage.mjs` — precheck hapus mode bersama

Sebelum (baris 124):

```js
if (before.size !== external.size || before.mtimeMs !== external.mtime_ms || before.ctimeMs !== external.ctime_ms) throw unsafe()
```

Sesudah:

```js
if (before.size !== external.size || before.mtimeMs !== external.mtime_ms) throw unsafe()
```

Verifikasi byte setelahnya tetap wajib: `fingerprintFile()` dicocokkan dengan
`external.sha256` dan `external.size`, lalu identitas pathname (`dev`, `ino`,
`size`, `mtime`, `ctime`) dibandingkan dalam satu proses sebelum `unlink`
(baris 125-130). Perbandingan in-process itu **tetap dipertahankan** karena
membandingkan kondisi berkas pada saat yang sama, bukan nilai historis lintas
mount.

### 4.3 Tidak ada perubahan pada tulis cap waktu

`claimAdoption()`, `refreshAdoption()`, dan `promoteShared()` tetap menulis
`mtime_ms` dan `ctime_ms`. Kolom `ctime_ms` tetap ada dan tetap diisi agar:

- skema dan backup/restore tidak berubah;
- nilai historis masih tersedia untuk diagnosis;
- jika suatu saat dibutuhkan, Opsi A dapat memakai data yang sudah ada.

Dengan kata lain, `ctime_ms` menjadi **informasi diagnostik**, bukan penentu
validitas.

## 5. Yang tidak berubah

- ID katalog, metadata, cover, `storage_key`, `sha256`, dan save pengguna.
- ETag (tetap `"${sha256}"`), `Content-Length`, dukungan Range/HEAD/304, dan
  pesan error 503.
- Perilaku scan: `already_registered`, `conflict`, `missing`, `damaged`,
  `not_ready`, dan pemulihan ID lama.
- Pemeriksaan keamanan lain: symlink/junction, hard link, berkas khusus,
  `nlink !== 1`, path root, dan verifikasi hash saat hapus.
- Skema SQLite, migrasi, backup format 2, dan konfigurasi environment.
- Mode internal/managed (upload dan `data/roms`): sejak awal tidak memakai cek
  `mtime`/`ctime` saat `open()`.

## 6. Pengujian

### 6.1 Tes unit/integrasi baru — `tests/catalog-external.test.mjs`

Tambahkan satu skenario eksplisit "tahan remount":

1. Adopsi ROM lewat scan, ambil `storage_key`, `id`, dan URL aset.
2. Simulasikan remount dengan mengubah **nilai tersimpan**:
   ```sql
   UPDATE catalog_external_files SET ctime_ms = ctime_ms + 60000 WHERE storage_key = ?
   ```
   (Mengubah `ctime` berkas asli lewat `utimes` tidak praktis karena `utimes`
   mengubah `mtime` dan `ctime` sekaligus, dan tes harus membuktikan kasus
   `ctime` bergeser sementara `mtime` tetap.)
3. Pastikan:
   - `GET` aset → **200** dan byte identik, **tanpa** scan;
   - `HEAD` → **200**;
   - `GET` dengan `If-None-Match` → **304**;
   - `GET /api/admin/games` → `fileStatus: 'available'`;
   - baris `catalog_external_files` tidak berubah selain `ctime_ms` yang kita
     ubah sendiri.
4. Regresi penolakan tetap berlaku:
   - tulis byte berbeda dengan ukuran sama → `mtime` berubah → **503**;
   - kembalikan byte asli lalu scan → **200** lagi;
   - ukuran berubah → **503**.

### 6.2 Tes mode folder bersama

Pada `setup(t, { writable: true })`:

1. Scan ROM, ubah `ctime_ms` tersimpan seperti di atas.
2. Hapus lewat API admin → berhasil, berkas fisik benar-benar hilang, dan
   `catalog_external_files` menjadi `retired`/terhapus sesuai alur yang ada.
3. Regresi: berkas yang byte-nya berubah tetapi `mtime`/`size` dipertahankan
   tetap ditolak (verifikasi SHA-256), dan berkas yang diganti RomM tidak
   dihapus diam-diam.

### 6.3 Regresi yang harus tetap lulus tanpa diubah

- `tests/catalog-external.test.mjs` — termasuk kasus "same size, different
  bytes" (baris 121-151), pemulihan nama/ID, ketersediaan, dan perlindungan
  hapus/recovery.
- `tests/catalog-scans.test.mjs` — klasifikasi scan dan rekonsiliasi
  ketersediaan.
- `tests/catalog-api.test.mjs` dan `tests/catalog-platform-storage.test.mjs`
  untuk `open()` internal dan aset legacy.

### 6.4 Verifikasi browser (opsional, terarah)

Jika diperlukan bukti end-to-end: gunakan `tests/browser/app.spec.ts` dan
`tests/browser/library.spec.ts` pada konfigurasi backend, dengan fixture ROM
eksternal. Tidak ada perubahan protokol player, jadi tidak perlu skenario baru.

## 7. Dokumentasi yang diperbarui

- `doc/koleksi-eksternal-read-only.md:112` — ganti "Perubahan ukuran/timestamp"
  menjadi penjelasan bahwa validitas memakai `size` + `mtime`; `ctime` diabaikan
  karena ditulis ulang oleh sebagian mount. Tambahkan bahwa byte tetap
  diverifikasi SHA-256 saat scan dan saat player mengunduh.
- `doc/koleksi-folder-bersama.md:149` — jelaskan bahwa snapshot sebelum unlink
  memakai ukuran/waktu modifikasi/hash, bukan `ctime`.
- `doc/scan-koleksi-folder.md` — tambahkan catatan singkat: pemeriksaan usia
  minimum transfer tetap memakai `max(mtime, ctime)`; itu hanya relevan saat
  scan dalam hitungan detik setelah boot dan tidak memengaruhi pemutaran.
- `CHANGELOG.md` — entri **Diperbaiki** di bagian `[Belum dirilis]`, contoh:

  > ROM/BIOS dari sumber eksternal tidak lagi ditolak (503) setelah host reboot
  > hanya karena `ctime` berubah saat remount. Validasi aset eksternal kini
  > memakai ukuran + `mtime`; `ctime` disimpan sebagai diagnostik. Integritas
  > byte tetap diverifikasi SHA-256 saat scan dan oleh player saat unduh.
  > Tanpa migrasi skema; scan ulang tidak lagi diperlukan setelah reboot.

## 8. Risiko dan mitigasi

| Risiko | Dampak | Mitigasi |
| --- | --- | --- |
| Isi berubah tetapi `size` dan `mtime` dipertahankan persis | Server menyajikan byte baru dengan ETag lama sampai scan | Sangat tidak realistis untuk koleksi RomM/NAS; player tetap menolak karena SHA-256 unduhan tidak cocok, dan scan melaporkan `conflict`. |
| `mtime` ternyata juga berubah pada mount lain | 503 muncul lagi setelah reboot | Deteksi dengan `stat` sebelum/sesudah reboot; rencana cadangan: bandingkan `size` saja, atau naik ke Opsi A. |
| Operator mengandalkan `ctime` untuk audit | Informasi audit berkurang | Nilai `ctime_ms` tetap disimpan dan diperbarui; hanya tidak dipakai sebagai gerbang. |
| Perubahan tanpa sengaja pada jalur hapus | Berkas salah terhapus | Verifikasi `sha256` + `size` + identitas pathname in-process tidak diubah; hanya perbandingan `ctime` historis yang dihapus. |

Tidak ada risiko migrasi karena tidak ada perubahan skema atau data.

## 9. Rollback

Kembalikan dua kondisi `open()` dan precheck hapus ke versi yang membandingkan
`ctime`. Tidak ada data yang perlu dipulihkan, karena `ctime_ms` tetap diisi.

## 10. Kriteria selesai

- [ ] Setelah host reboot, ROM eksternal dapat dimainkan **tanpa** Scan Koleksi.
- [ ] Tidak ada 503 yang disebabkan hanya oleh perubahan `ctime`.
- [ ] Perubahan byte/ukuran tetap ditolak, dan scan tetap melaporkan konflik.
- [ ] Hapus di mode folder bersama tetap berfungsi setelah `ctime` bergeser.
- [ ] Semua tes regresi katalog eksternal/scan lulus.
- [ ] Dokumentasi dan CHANGELOG diperbarui.
- [ ] Tidak ada perubahan skema, API, identitas save, atau konfigurasi.

## 11. Perintah verifikasi

```sh
node --test tests/catalog-external.test.mjs
node --test tests/catalog-external.test.mjs tests/catalog-scans.test.mjs tests/catalog-api.test.mjs tests/catalog-platform-storage.test.mjs
npm test
npm run build
```

Opsional bila ingin bukti browser:

```sh
npm run test:e2e:backend -- tests/browser/library.spec.ts tests/browser/app.spec.ts --timeout=180000
```

Hasil yang dilaporkan harus berasal dari eksekusi nyata, bukan asumsi dari
dokumen ini.

## 12. Di luar cakupan

- Reverifikasi hash otomatis saat cap waktu berbeda (Opsi A).
- Scan otomatis atau watcher saat startup.
- Perubahan cara scan menandai `missing`/`damaged` atau rekonsiliasi
  ketersediaan.
- Perubahan ETag, protokol player, cache browser, save, atau backup.
- Penanganan mount yang juga mengubah `mtime` antarboot selain rencana cadangan
  yang disebut di bagian 8.

## 13. Rujukan

- [Koleksi ROM/BIOS eksternal hanya-baca](koleksi-eksternal-read-only.md)
- [Mode folder bersama RomM/maindulu](koleksi-folder-bersama.md)
- [Scan koleksi dari folder server](scan-koleksi-folder.md)
- [Rencana scan koleksi folder](rencana-scan-koleksi-folder.md)
