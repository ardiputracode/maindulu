# Rencana Auto-Apply Metadata CHD via Serial (ScreenScraper)

Status: **rencana, belum diimplementasikan.** Disusun 2026-11-09. Dokumen ini hanya rencana; tidak mengubah kode, skema, konfigurasi operator, atau mengaktifkan scan.

Keputusan yang dipilih operator: **Opsi A** — metadata CHD boleh diterapkan otomatis tanpa kecocokan hash byte, dengan syarat serial + kandidat tunggal. Kebijakan raw ROM (ZIP/raw M7) **tidak berubah**.

## 1. Tujuan

- Game katalog berformat **CHD (PlayStation 1)** yang di-upload mendapat metadata ScreenScraper otomatis.
- Auto-apply hanya jika identitas disc dapat dibuktikan lewat **serial** dan provider mengembalikan **tepat satu kandidat** yang konsisten.
- Bila bukti tidak cukup, hasil tetap masuk `needs_review` seperti sekarang.
- Format raw/ZIP tetap memakai syarat lama: ukuran + MD5 + SHA-1 persis.

## 2. Non-tujuan

- Tidak menambah console baru. `public/catalog/consoles.json` saat ini hanya `psx` yang menerima `.chd`; rencana ini fokus `psx` + `.chd` polos.
- Tidak mengubah byte ROM, URL, SHA-256, ID game, console, `saveIdentity`, save state, progres, atau cache ROM/BIOS.
- Tidak auto-apply dari nama file, region, atau tebakan serial.
- Tidak mendukung CHD di dalam ZIP/7z/RAR pada tahap ini (tetap review). Bisa diperluas setelah ada bukti.
- Tidak melakukan hash inner disc / ekstraksi ISO. Itu tetap opsi masa depan, bukan syarat Opsi A.
- Tidak mengklaim dukungan PS2/PSP/Saturn/Dreamcast sebelum console tersebut ada di katalog dan dipetakan.

## 3. Alur yang dituju

```text
Upload .chd (console psx)
  -> dipublikasikan + game langsung playable (perilaku sekarang)
  -> metadata_jobs queued (perilaku sekarang)
  -> worker fase identifying
       -> resolve path aset aman
       -> jalankan rom-converto `info <path> --json`
       -> validasi JSON + ambil serial disc
       -> serial tidak ada: status unsupported, alasan serial_missing
  -> worker fase lookup
       -> ScreenScraper jeuInfos.php dengan serialnum + systemeid
       -> 0 kandidat: not_found
       -> >1 kandidat / system beda / notGame bukan false: needs_review
       -> tepat 1 kandidat valid: auto-apply sesuai Opsi A
  -> worker fase cover/apply
       -> field yang dikunci admin tetap dihormati
       -> metadata baru + revision katalog naik
```

## 4. Dependensi rom-converto

Sumber rilis: <https://github.com/DevYukine/rom-converto/releases>

### 4.1 Versi dan aset

Pin rilis **v0.24.0** (rilis saat rencana disusun). Jangan memakai `latest` di runtime.

| Platform | Aset | SHA-256 |
| --- | --- | --- |
| Windows x64 | `rom-converto-cli-windows-x64.exe` | `bee0ee3bac4183f8de3c9fd00fde3da6f73d92a2af2db203b525ea421d7ea5a4` |
| Linux x64 (glibc) | `rom-converto-cli-linux-x64` | `0d4abd56cfec477ff447f68b656d45ca48f670f464363bca2d895b1eee2c356d` |
| Linux x64 (musl, Alpine/Docker) | `rom-converto-cli-linux-x64-musl` | `67964054931f7e74848bfe7b54ff1f0cacdc25596c29e3a79876f76e0f2407a8` |
| Linux arm64 | `rom-converto-cli-linux-arm64` | `990286bc3367342b0e04ab6dd0d28d8e95c3133ac2b4c5d6440a119e541b0b43` |
| Linux arm7 | `rom-converto-cli-linux-arm7` | `00b4cf7a454ae4539459cc5f908f3b42603b59b1035b8b046c6ef5ae1982247f` |
| macOS arm64 | `rom-converto-cli-macos-arm64` | `4de8bbc96ddef23d8ed823ce42efcd64425c7885c4fe25058a2376ab42053aee` |
| macOS x64 | `rom-converto-cli-macos-x64` | `8bf11dd14c920db3ed9d00782a0ab018cc3d1e316b63d0deb2ff7b50d19e85f9` |

Lisensi rom-converto: MIT. Catat atribusi di `README.md`/dokumentasi fitur.

### 4.2 Layout vendor

```text
vendor/rom-converto/
  VERSION                      # 0.24.0
  win32-x64/rom-converto.exe
  linux-x64/rom-converto
  linux-x64-musl/rom-converto
  linux-arm64/rom-converto
  linux-arm7/rom-converto
  darwin-arm64/rom-converto
  darwin-x64/rom-converto
```

- File binary di-ignore dari Git jika terlalu besar; simpan checksum + skrip unduh.
- Tambah `scripts/vendor-rom-converto.mjs` (atau lanjutkan pola `scripts/vendor-engine.mjs`) untuk mengunduh aset sesuai platform, memverifikasi SHA-256, dan `chmod +x` di Unix.
- Alternatif operator: letakkan binary sendiri dan set `MAIN_DULU_ROM_CONVERTO_PATH`.

### 4.3 Urutan resolusi binary

1. `MAIN_DULU_ROM_CONVERTO_PATH` (path absolut file).
2. `vendor/rom-converto/<platform>-<arch>/rom-converto[.exe]` di root proyek.
3. `rom-converto` dari `PATH`.

Jika tidak ditemukan: fitur CHD otomatis `unsupported` dengan alasan `chd_tool_unavailable`; upload, play, dan scan raw tetap berjalan. Jangan menggagalkan startup backend.

### 4.4 Docker

- `deploy/Dockerfile.backend` memakai `node:24-alpine` → gunakan **`rom-converto-cli-linux-x64-musl`**.
- Copy ke `/app/vendor/rom-converto/linux-x64-musl/rom-converto`, `chmod 0755`, `chown node:node`.
- Verifikasi `--version` saat build image (opsional) dan saat startup (sekali, log tanpa path sensitif).
- Ukuran image bertambah ±30 MB.

### 4.5 Windows (`npm start`)

- Simpan `rom-converto-cli-windows-x64.exe` sebagai `vendor/rom-converto/win32-x64/rom-converto.exe`.
- Tidak perlu `chmod`. Pastikan path tidak mengandung spasi bermasalah karena dipanggil via `execFile` (array argumen, bukan shell).

## 5. Modul baru: `server/metadata/rom-converto.mjs`

Tanggung jawab:

```js
resolveRomConvertoBinary({ env, root, platform, arch })
probeRomConverto(binary)          // `--version`, cache hasil per proses
readChdSerial({ filePath, signal, timeoutMs, binary })
```

### 5.1 Pemanggilan proses

- Gunakan `execFile` dari `node:child_process` (bukan `exec`, bukan shell).
- Argumen: `['info', filePath, '--json']`.
- Opsi: `windowsHide: true`, `timeout: timeoutMs` (default 30_000, range 5_000–120_000), `maxBuffer: 2 * 1024 * 1024`, `killSignal: 'SIGKILL'`.
- `env`: warisan minimal; jangan teruskan secret ScreenScraper ke proses anak (buat allowlist `PATH`, `SystemRoot`, `TEMP`, `TMP` di Windows; `PATH`, `HOME` di Unix).
- Abort: `signal` → `child.kill('SIGKILL')`; promisified `execFile` harus berhenti dan reject dengan `ScreenScraperError('identification_timeout')` atau `ScreenScraperError('disabled')` saat abort.
- Jangan pernah memasukkan output mentah ke log; hanya kode error.

### 5.2 Parsing dan validasi JSON

- Batas ukuran JSON 2 MiB; decode UTF-8 fatal.
- Ambil serial dari field yang tersedia pada payload `info` (nama final mengikuti hasil probe; kemungkinan `serial`, `disc.serial`, `metadata.serial`). Selalu validasi:
  - tipe string, panjang 4–32
  - uppercase, hanya `A-Z`, `0-9`, `-`
  - mengandung minimal satu digit
  - tidak ada karakter kontrol
- Simpan juga `title`/`console` hanya untuk audit internal, tidak dipakai sebagai bukti auto-apply.
- Jika serial tidak ada: `ScreenScraperError('chd_serial_missing')`.
- Jika JSON rusak/field hilang: `ScreenScraperError('chd_invalid')`.

### 5.3 Gerbang bukti format (wajib sebelum coding parser final)

1. Unduh binary Windows v0.24.0.
2. Jalankan `rom-converto --version`.
3. Jalankan `rom-converto info sample-ps1.chd --json` pada minimal satu CHD PS1 nyata.
4. Bila generic `info` tidak memuat serial, uji `rom-converto chd info sample-ps1.chd --json`.
5. Simpan **fixture JSON sintetis** (bukan capture berhak cipta) yang meniru bentuk field serial.
6. Catat hasil di dokumen ini atau subdokumen; jika serial tidak tersedia untuk PS1, hentikan implementasi auto-apply dan kembali ke review/nama.

## 6. Identifikasi CHD: `server/metadata/identification.mjs`

- Tambah `isIdentifiableChd(consoleId, fileName)`:
  - `consoleId === 'psx'`
  - ekstensi `.chd` (case-insensitive)
  - nama file lolos validasi target yang ada (tanpa path/karakter kontrol)
- Tambah parameter `filePath` (opsional) pada `identifyCatalogRom` agar wrapper CLI bisa membaca aset.
- Branch baru sebelum fallback raw:
  ```js
  if (isIdentifiableChd(consoleId, fileName)) {
    if (!filePath) throw new ScreenScraperError('invalid_target')
    const serial = await readChdSerial({ filePath, signal, timeoutMs })
    return { fileName, hashes: {}, serial, identification: { kind: 'chd-serial', version: 1 } }
  }
  ```
- Branch raw dan ZIP tidak diubah.
- `candidateTarget` tetap memakai `resolveScreenScraperSystem`; untuk `psx` + `chd`, target sudah `systemId: '57'`, `hashLookup: false`, `reason: 'format_requires_review'`. Tidak perlu perubahan di sana.

## 7. Akses path aset aman: `server/catalog/storage.mjs`

CLI memerlukan path filesystem, sedangkan `storage.open()` hanya mengembalikan `FileHandle` tanpa path.

- Tambah `storage.assetPath(kind, key)`:
  1. resolve path lewat `pathFor(kind, key)` yang sudah ada;
  2. jalankan `openRegular(path)` (lstat + O_NOFOLLOW + cek inode/link);
  3. tutup handle;
  4. kembalikan path absolut.
- Hanya dipakai server-side oleh worker. Jangan pernah mengirim path ini ke API/frontend.
- Dokumentasikan bahwa volume data adalah milik operator dan tidak boleh berisi symlink/hardlink tak terduga (sudah menjadi asumsi storage sekarang).
- Worker memanggil `storage.assetPath('games', game.storage_key)` hanya untuk branch CHD.

## 8. Klien ScreenScraper: `server/metadata/screenscraper.mjs`

Tambah method:

```js
async searchBySerial({ consoleId, fileName, serial, signal })
```

- `ensureReady()`.
- `target = resolveScreenScraperSystem(consoleId, fileName)`; wajib `target.systemId` dan format `.chd`.
- Validasi serial dengan regex yang sama.
- Request `jeuInfos.php` dengan:
  - `systemeid`: `target.systemId`
  - `serialnum`: serial
  - `romnom`: basename file (opsional, sanitized)
  - `romtype`: `iso` (verifikasi saat probe; jika provider menolak, hilangkan)
  - tidak mengirim `crc`/`md5`/`sha1`/`romtaille`
- `normalizeResponse(json, target.systemId)`.
- Return `Object.freeze({ method: 'serial', systemId: target.systemId, serial, candidates })`.
- 404 tetap `not_found` lewat `classifyHttpStatus`.

Catat di dokumentasi privasi: **serial disc dikirim ke ScreenScraper**, bukan byte ROM.

## 9. Kebijakan Opsi A: `assessChdSerialEvidence`

Tambah fungsi terpisah di `server/metadata/screenscraper-policy.mjs`; jangan mengubah `assessScreenScraperEvidence`.

```js
export function assessChdSerialEvidence(input, candidates)
```

Aturan (semua wajib):

1. `input.method === 'serial'`.
2. `input.consoleId === 'psx'` dan ekstensi `input.fileName` adalah `.chd`.
3. `input.serial` valid (4–32, `A-Z0-9-`, minimal satu digit).
4. `target = screenScraperTarget(consoleId, fileName)` punya `systemId` dan format `.chd`.
5. `candidates` array dengan **tepat 1** elemen.
6. `candidate.id` identifier valid.
7. `candidate.systemId === target.systemId`.
8. `candidate.notGame === false`.
9. Jika `candidate.rom` ada dan `rom.totalSupports` adalah integer aman, nilainya harus `1`. Jika `rom` tidak ada, **tidak** memblokir (Opsi A tidak mensyaratkan hash).

Hasil:

- Lolos → `{ verified: true, reason: 'serial_unique' }`.
- Gagal → `{ verified: false, reason: '<kode>' }` dengan kode stabil:
  - `manual_lookup`, `invalid_target`, `invalid_serial`, `non_unique_result`,
    `unconfirmed_game`, `system_mismatch`, `unconfirmed_rom`.

Dokumentasikan eksplisit bahwa ini **menyimpang dari kebijakan raw** dan hanya berlaku untuk CHD PS1. Konsekuensi: kandidat tunggal dari serial bisa salah; admin tetap bisa mengoreksi lewat review/edit.

### 9.1 Kill switch

- `MAIN_DULU_CHD_SERIAL_AUTOAPPLY` default `true`.
- Jika `false`: lookup serial tetap berjalan, tetapi worker selalu berhenti di `needs_review` dengan alasan `serial_autoapply_disabled`.
- Perubahan env tidak hot-reload (sama seperti fitur metadata lain).

## 10. Worker: `server/metadata/worker.mjs`

Perubahan:

1. Import `assessChdSerialEvidence`, `isIdentifiableChd`.
2. `identify()`:
   - buka handle seperti sekarang;
   - untuk CHD, ambil `filePath = await storage.assetPath('games', game.storage_key)`;
   - panggil `identifyCatalogRom(file, { ..., filePath })`.
3. Branch lookup:
   ```js
   if (result.method === 'serial') {
     result = await lookup(metadataSerialCacheKey(target.systemId, serial, lookupName),
       () => client.searchBySerial({ consoleId, fileName: lookupName, serial, signal }))
   } else { /* hash/name existing */ }
   ```
   - `hashes` untuk CHD adalah `{}`; sertakan `serial` di payload.
4. Evidence:
   ```js
   const evidence = result.method === 'serial'
     ? assessChdSerialEvidence({ method: 'serial', consoleId, fileName, serial }, candidates)
     : assessScreenScraperEvidence({ ...existing... }, candidates)
   if (!manual && config?.chdSerialAutoapply === false && result.method === 'serial')
     evidence = { verified: false, reason: 'serial_autoapply_disabled' }
   ```
5. Payload: `fingerprint` berisi `{ serial }` untuk CHD, bukan `{ size, md5, sha1 }`.
6. `applyVerifiedMetadata(..., matchMethod: result.method === 'serial' ? 'serial' : 'hash')`.
7. `classifyError`:
   - `chd_tool_unavailable`, `chd_invalid`, `chd_serial_missing` → `unsupported`, non-retry.
   - `identification_timeout` sudah `unsupported`.
   - `chd_serial_missing` jangan retry terus-menerus.
8. Phase tetap `identifying` → `lookup` → `cover` → `apply`; metrik phase otomatis mengikuti.
9. Cover: mengikuti alur yang ada. Jika `chdSerialAutoapply=false`, tidak ada cover yang diunduh karena berhenti di review.

## 11. Cache: `server/metadata/cache.mjs`

- Tambah `metadataSerialCacheKey(systemId, serial, fileName)`:
  ```js
  const fingerprint = sha256(JSON.stringify(['serial', serial, cleanRomName(fileName)]))
  return { key: sha256(JSON.stringify([systemId, fingerprint, preferences, version])), systemId, fingerprint }
  ```
- `readMetadataCache` allowlist method: `['hash', 'name', 'serial']`.
- Tidak perlu bump versi cache karena key hash berbeda; entry lama tetap valid.
- Negative cache TTL tetap 24 jam, positive 7 hari.

## 12. Apply dan skema database

### 12.1 `server/metadata/apply.mjs`

- Tambah parameter `matchMethod = 'hash'` pada `applyVerifiedMetadata`.
- Tulis `match_method` dari parameter, bukan hardcode `'hash'`.
- Manual tetap `'manual'`.
- Tidak ada perubahan pada field lock, revision CAS, atau cover.

### 12.2 Migrasi skema 15 (`server/database.mjs`)

`game_metadata.match_method` saat ini:
```sql
CHECK(match_method IS NULL OR match_method IN ('hash', 'name', 'game_id', 'manual'))
```

SQLite tidak bisa mengubah CHECK secara langsung. Migrasi baru:

```sql
CREATE TABLE game_metadata_new ( ...sama..., match_method TEXT CHECK(match_method IS NULL OR match_method IN ('hash','name','game_id','manual','serial')) ) STRICT;
INSERT INTO game_metadata_new SELECT * FROM game_metadata;
DROP TABLE game_metadata;
ALTER TABLE game_metadata_new RENAME TO game_metadata;
```

- Jalankan dalam transaksi migrasi yang sudah ada.
- Tidak ada index pada `game_metadata`, jadi tidak ada index yang perlu dibuat ulang.
- `game_metadata_field_sources` tidak berubah.
- `schemaVersion` menjadi 15.

### 12.3 Backup/restore

- Snapshot database menyertakan tabel `game_metadata`; nilai `serial` harus lolos validasi restore.
- Tambah test round-trip backup skema 15 dan penerimaan backup skema 14 (nilai `match_method` lama).
- Tidak ada perubahan pada `data-backup` lain.

## 13. Konfigurasi

`server/metadata/screenscraper.mjs` (`readScreenScraperConfig`):

| Env | Default | Validasi | Fungsi |
| --- | --- | --- | --- |
| `MAIN_DULU_ROM_CONVERTO_PATH` | kosong | path absolut bila diisi | override binary |
| `MAIN_DULU_ROM_CONVERTO_TIMEOUT_MS` | `30000` | integer 5000–120000 | timeout per panggilan |
| `MAIN_DULU_CHD_SERIAL_AUTOAPPLY` | `true` | `true`/`false` | kill switch auto-apply |

- Jika `MAIN_DULU_SCREENSCRAPER_ENABLED` bukan `true`, seluruh fitur tetap nonaktif; CHD tidak diproses.
- `getScreenScraperConfigStatus` boleh ditambah `chdTool: 'available'|'missing'` (opsional) untuk status admin.
- Health capabilities: tambah `metadataChd: true|false` (opsional, additive).

## 14. UI dan dokumentasi

- `src/lib/metadata.ts`: tambah `matchMethod?: 'hash'|'serial'|'manual'` pada `MetadataDetail` bila server mengirimnya (opsional).
- `server/metadata/queue.mjs` `metadataDetail`: sertakan `matchMethod` dari `game_metadata` (opsional, additive).
- `MetadataReview.tsx`: tampilkan badge kecil “Kecocokan serial” saat `matchMethod === 'serial'` (opsional).
- `AdminCatalog.tsx`: teks bantuan upload diperbarui: “Untuk CHD PS1, serial disc dibagikan ke ScreenScraper; kecocokan tunggal dapat diterapkan otomatis.”
- `README.md` / `CHANGELOG.md`: catat dependency rom-converto, atribusi MIT, risiko serial, dan kill switch.
- Dokumen privasi: serial disc adalah data yang dikirim, bukan byte ROM.

## 15. Keamanan

- `execFile` + argumen array; tidak ada shell, tidak ada interpolasi string perintah.
- Path binary dari env/vendor/PATH, bukan input client.
- Path aset berasal dari `storage.assetPath` yang sudah memakai `openRegular` (O_NOFOLLOW, cek inode, nlink 1).
- Timeout + kill; output JSON dibatasi 2 MiB; decode UTF-8 fatal.
- Jangan meneruskan env ScreenScraper ke proses anak.
- Log hanya kode error; jangan log serial mentah, path penuh, atau output CLI.
- Serial tidak boleh masuk URL frontend, cache browser, atau pesan error publik.
- Tetap hormati `storage` quota/cleanup dan field lock admin.

## 16. Matriks test

### 16.1 Unit — policy

File baru: `tests/screenscraper-chd-policy.test.mjs` (atau tambahan di `screenscraper-policy.test.mjs`).

- Serial valid + 1 kandidat + system cocok + notGame false → `verified: true`, `reason: 'serial_unique'`.
- Serial invalid (kosong, karakter kontrol, tanpa digit, >32) → `invalid_serial`.
- Kandidat 0 / 2 → `non_unique_result`.
- System kandidat beda → `unconfirmed_game` / `system_mismatch`.
- `notGame: true` / `null` → `unconfirmed_game`.
- `rom.totalSupports` 2 → gagal; `rom` null → tetap lolos (sesuai Opsi A).
- Method `hash` tidak diarahkan ke fungsi CHD.
- Fungsi raw lama tetap menghasilkan keputusan yang sama (regresi).

### 16.2 Unit — wrapper rom-converto

File baru: `tests/rom-converto.test.mjs`.

- Resolusi binary: env override menang; vendor menang atas PATH; tidak ada binary → `chd_tool_unavailable`.
- `readChdSerial` memanggil `execFile` dengan argumen yang benar (mock `execFile`).
- Output JSON valid → serial ternormalisasi uppercase.
- JSON rusak / field hilang / serial invalid → kode error benar.
- Timeout → `identification_timeout`; abort signal → `disabled`.
- Output > 2 MiB ditolak.
- Argumen file path dengan spasi tetap satu argumen (tidak dipecah shell).

### 16.3 Unit — identifikasi

Tambahan di `tests/screenscraper-m7.test.mjs` atau file baru `tests/screenscraper-chd.test.mjs`.

- `isIdentifiableChd('psx', 'game.chd') === true`.
- Console lain / ekstensi lain → false.
- `identifyCatalogRom` branch CHD memakai `filePath` dan mengembalikan `{ serial, identification.kind: 'chd-serial' }`.
- Tanpa `filePath` → `invalid_target`.
- Runner error diteruskan tanpa membocorkan path.

### 16.4 Unit — klien ScreenScraper

Tambahan di `tests/screenscraper-m2.test.mjs`.

- `searchBySerial` membangun URL dengan `serialnum`, `systemeid`, `romtype=iso` (atau sesuai hasil probe), dan `output=json`.
- Tidak mengirim `md5`/`sha1`/`crc`/`romtaille`.
- 404 → `not_found`; 200 envelope valid → kandidat ternormalisasi.
- Serial invalid → `invalid_fingerprint` sebelum request.
- Error tidak membocorkan kredensial.

### 16.5 Integrasi worker

Tambahan di `tests/screenscraper-m4.test.mjs` / `m6`.

Siapkan game `psx` dengan `original_name = 'game.chd'`, `clientFactory` yang menyediakan `searchBySerial`, dan `readChdSerial` yang diinjeksi/mock.

- 1 kandidat valid → `succeeded`, metadata terisi, `match_method = 'serial'`, revision naik.
- 2 kandidat → `needs_review`, `error_code = 'non_unique_result'`, tidak ada perubahan metadata.
- `notGame: true` → `needs_review`.
- Binary tidak ada → `unsupported`, `error_code = 'chd_tool_unavailable'`, upload/game tetap ada.
- `MAIN_DULU_CHD_SERIAL_AUTOAPPLY=false` → `needs_review`, `serial_autoapply_disabled`, tidak ada request cover.
- Abort saat identifikasi → job `cancelled`/`disabled`; lease dilepas.
- Field title/description/cover yang dikunci admin tidak berubah.
- Cache hit kedua tidak memanggil provider; key serial berbeda untuk serial berbeda.
- Asset fingerprint berubah saat job berjalan → job dibatalkan.

### 16.6 Migrasi dan backup

- Migrasi 14 → 15: data `game_metadata` utuh; insert `match_method='serial'` diterima; nilai lama tetap.
- Backup skema 15 → restore → metadata + `match_method='serial'` utuh.
- Restore backup skema 14 pada kode baru → sukses, migrasi berjalan.
- `data:verify` menghitung tabel dengan benar.

### 16.7 Browser E2E

Tambahkan skenario di `tests/browser/metadata.spec.ts` (provider tiruan, runner diinjeksi):

- Upload `game.chd` (byte fixture kecil, ekstensi `.chd`, console psx).
- Scan berjalan → game tampil dengan judul/cover hasil serial.
- Review page menampilkan kandidat dan label kecocokan serial.
- Admin edit judul sebelum scan selesai → edit menang (CAS).
- Scan kedua dengan serial sama memakai cache (tidak ada request provider tambahan).

Catat bahwa test tidak menjalankan binary rom-converto asli; itu manual/opt-in.

### 16.8 Manual / opt-in (operator)

- Binary asli + CHD PS1 nyata: `info --json` menghasilkan serial.
- Upload satu game legal → auto-apply metadata.
- Serial yang tidak ada di provider → `not_found`.
- Serial duplikat (jika ada) → `needs_review`.
- Matikan `MAIN_DULU_CHD_SERIAL_AUTOAPPLY=false`, restart → scan berikutnya review.
- Docker Alpine: binary musl berjalan (`--version`).

### 16.9 Regresi wajib

- `npm test`
- `npm run build`
- `npm run test:e2e`
- `npm run test:e2e:production`
- `npm run test:e2e:backend`

Catat hasil aktual, skip, dan percobaan gagal di laporan milestone.

## 17. Rollout dan rollback

1. Default fitur tetap nonaktif (`MAIN_DULU_SCREENSCRAPER_ENABLED=false`).
2. Aktifkan di lingkungan pribadi/LAN dengan binary tersedia.
3. Upload satu CHD legal → verifikasi metadata + review.
4. Perluas ke beberapa upload.
5. Jika masalah: set `MAIN_DULU_CHD_SERIAL_AUTOAPPLY=false` (tetap review) atau nonaktifkan seluruh fitur.
6. Rollback kode: binary lama tidak boleh dijalankan pada database skema 15; gunakan backup/restore eksplisit sesuai runbook yang ada.

## 18. Risiko dan batas yang diakui

- **Serial tidak unik**: satu serial dapat muncul untuk beberapa rilis/region; provider bisa mengembalikan lebih dari satu kandidat. Karena itu syarat kandidat tunggal wajib.
- **Salah game**: kandidat tunggal tetap bisa salah jika provider memetakan serial secara longgar. Admin harus bisa mengoreksi; auto-apply tidak boleh menyentuh field yang dikunci.
- **Cover ikut auto-apply**: sesuai alur existing, jika field cover tidak dikunci maka cover kandidat diunduh. Risiko cover salah lebih tinggi daripada teks; kill switch menurunkan risiko.
- **Bentuk JSON rom-converto dapat berubah**: pin versi + validasi skema + fixture.
- **Binary per platform**: Alpine butuh musl; Windows butuh `.exe`; jangan salah pilih aset.
- **CHD di dalam ZIP** belum didukung; tetap review.
- **Console lain** belum didukung; jangan memetakan system ID tanpa bukti.
- **Serial sebagai data keluar**: perlu pembaruan dokumentasi privasi.

## 19. Urutan implementasi yang disarankan

1. Probe `info --json` + catat bentuk serial (gerbang bukti).
2. `rom-converto.mjs` + `storage.assetPath` + test wrapper.
3. `isIdentifiableChd` + branch `identifyCatalogRom` + test.
4. `searchBySerial` + policy Opsi A + test unit.
5. Migrasi skema 15 + `applyVerifiedMetadata` matchMethod + test backup.
6. Worker wiring + cache + test integrasi.
7. Config/env + status/capability + UI opsional.
8. Browser E2E + regresi penuh + dokumentasi.
9. Smoke manual operator (binary asli + CHD nyata).

## 20. Referensi

- Rilis rom-converto: <https://github.com/DevYukine/rom-converto/releases>
- Repositori rom-converto: <https://github.com/DevYukine/rom-converto>
- Dokumentasi CLI rom-converto: <https://github.com/DevYukine/rom-converto/blob/main/docs/cli.md>
- API ScreenScraper v2: <https://www.screenscraper.fr/webapi2.php>
- Rencana metadata ScreenScraper yang ada: [rencana-screenscraper-metadata.md](rencana-screenscraper-metadata.md)
