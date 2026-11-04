# Rencana Implementasi: Save Identity Berbasis Hash ROM (Opsi B)

Status: Diimplementasikan (2026-11-04)
Tanggal: 2026-11-04
Area: Frontend maindulu + catalog + (opsional) backend admin

## 1. Latar belakang & masalah

Saat ini identitas save (browser state EmulatorJS, slot save state server 1-3 + autosave 99,
dan progres akun NES/PS1) memakai `game.id`:

- ROM lokal → `game.id = local-<console>-<sha256>` (`SetupDialog.tsx`)
- ROM server → `game.id` dari katalog, mis. `jalan-pulang-v1` (`games.json`)

Akibatnya, ROM yang sama tetapi berasal dari sumber berbeda memiliki `game.id` berbeda,
sehingga save tidak nyambung. Tujuan Opsi B: **identitas game tetap stabil (katalog)**,
tetapi **identitas save dibuat dari hash ROM**, sehingga ROM yang sama (hash sama) berbagi save.

Kehilangan data save/user selama proses implementasi **diterima** (tidak perlu migrasi).

## 2. Prinsip desain

1. `game.id` tetap stabil untuk favorit/riwayat/URL/cover.
2. Identitas save kanonik: `saveId = game.sha256 ? `${core}-${game.sha256}` : `${core}-${game.id}``.
3. `Game.sha256` wajib tersedia:
   - ROM server: dari catalog/DB (dihitung sekali saat admin upload).
   - ROM lokal: dihitung saat launch via `hashRom`, lalu disimpan di `Game`.
4. Backend API tidak berubah skema; `gameId` pada save hanyalah string (regex `^[a-zA-Z0-9_-]{1,160}$`).
   `saveId` memenuhi regex tersebut (core + `-` + 64 hex).

## 3. Ruang lingkup perubahan

| File | Perubahan |
| --- | --- |
| `src/lib/domain.ts` | Tambah helper `saveIdentity` |
| `src/components/SetupDialog.tsx` | Set `sha256` lokal; isi `saveId` saat launch |
| `src/components/Player.tsx` | `LaunchSession.saveId`; `GameSaveSync` & transfer memakai `saveId` |
| `src/components/ServerStates.tsx` | Semua save memakai `saveId` |
| `public/player/player.js` | `EJS_gameName` memakai `saveId`/hash |
| `public/catalog/games.json` | Tambah `sha256` untuk game demo |
| `tests/browser/app.spec.ts` | Perbarui asersi key save |

## 4. Milestone detail

### Milestone 0 — Helper + hash demo

**4.0.1 Helper `saveIdentity`**

Tambah di `src/lib/domain.ts` (atau `src/lib/identity.ts`):

```ts
export function saveIdentity(game: { id: string; sha256?: string }, core: string): string {
  const base = game.sha256 && /^[a-f0-9]{64}$/i.test(game.sha256)
    ? game.sha256.toLowerCase()
    : game.id
  return `${core}-${base}`
}
```

**4.0.2 Hash demo**

Hitung SHA-256 dari `public/games/jalan-pulang.nes`, lalu tambahkan ke `public/catalog/games.json`:

```json
{
  "id": "jalan-pulang-v1",
  "title": "Jalan Pulang",
  "...": "...",
  "sha256": "<64 hex lowercase>",
  "size": <bytes>
}
```

**Verifikasi M0**
- `npm test` (unit) lulus.
- `readGames` tetap valid (field `sha256` opsional, sudah didukung).

### Milestone 1 — ROM lokal menyimpan `sha256`

File: `src/components/SetupDialog.tsx`

Di branch ROM lokal (sekitar baris 106-111), ubah:

```ts
const hash = await hashRom(rom!)
const id = `local-${consoleId}-${hash}`
// ...
game = { id, title: ..., consoleId, source: 'local', fileName: rom!.name, sha256: hash }
```

**Verifikasi M1**
- `tsc -b` lulus.
- Game lokal kini membawa `sha256`.

### Milestone 2 — Plumbing `saveId` di session

File: `src/components/Player.tsx`

Tambah ke type `LaunchSession`:

```ts
export type LaunchSession = { ..., saveId?: string }
```

File: `src/components/SetupDialog.tsx`

Saat `onLaunch(...)`:

```ts
const launched = await onLaunch({
  id: createSessionId(),
  game,
  consoleInfo,
  rom,
  bios: ...,
  biosUrl: ...,
  biosSha256: ...,
  saveId: saveIdentity(game, consoleInfo.core),
})
```

Import `saveIdentity` dari `../lib/domain`.

**Verifikasi M2**
- `tsc -b` lulus.

### Milestone 3 — Gunakan `saveId` di runtime

#### 3a. Bridge EmulatorJS
File: `public/player/player.js`

Ganti:

```js
window.EJS_gameName = `${config.core}-${config.game.id}`
```

Menjadi:

```js
window.EJS_gameName = config.saveId || `${config.core}-${config.game?.sha256 || config.game.id}`
```

#### 3b. Host player
File: `src/components/Player.tsx`

- `GameSaveSync` identity:
  ```ts
  gameId: session.saveId ?? saveIdentity(session.game, session.consoleInfo.core)
  ```
- Transfer target:
  ```ts
  target={{ gameId: session.saveId ?? saveIdentity(...), consoleId, core, title }}
  ```

#### 3c. Server state UI
File: `src/components/ServerStates.tsx`

Tambah:

```ts
const saveId = session.saveId ?? saveIdentity(session.game, session.consoleInfo.core)
```

Ganti:
- `slotInfo`: `s.gameId === saveId`
- `upload`: `gameId: saveId`
- nama file cadangan: gunakan `saveId`.

Import `saveIdentity`.

#### 3d. Progres akun
`GameSaveSync` sudah memakai `gameId` dari identity; pastikan nilainya `saveId`.

**Verifikasi M3**
- `npm run build` lulus.
- `npm run preview` + main game demo: save browser key sekarang `${core}-<hash>.state`.

### Milestone 4 — Tes & asersi

File: `tests/browser/app.spec.ts`

- Key save browser memuat hash demo, bukan `jalan-pulang-v1`. Perbarui:
  ```ts
  expect(roundTrip.key).toContain('<hash-demo>')
  ```
- History tetap:
  ```ts
  expect(history[0].id).toBe('jalan-pulang-v1')
  ```

**Verifikasi M4**
- `npm run build`
- `npm run test:e2e` (butuh preview server).

### Milestone 5 — (Opsional) Fallback baca save lama

Karena data loss diterima, milestone ini **boleh dilewati**. Jika ingin:
- di `useSaveLibrary`, jika daftar untuk `saveId` kosong dan berbeda dari `game.id`,
  coba ambil daftar lama (read-only); unggahan tetap ke `saveId`.

## 5. Verifikasi otomatis yang akan dikerjakan

### Unit (Node)
Perintah: `npm test`

Cakupan yang diharapkan lulus:
- `tests/domain.test.mjs`: `readGames` tetap valid dengan field `sha256` opsional.
- (Opsional) tambah test `saveIdentity` di `tests/domain.test.mjs`:
  - dengan `sha256` → `${core}-${sha256}`.
  - tanpa `sha256` → `${core}-${id}`.

### Build
Perintah: `npm run build` (`tsc -b && vite build`)
- Harus lulus tanpa error TypeScript.

### E2E (Playwright)
Perintah: `npm run test:e2e` (dev server) atau `npm run test:e2e:production` (preview).

Skenario yang harus lulus:
1. `cold-cache server game runs...`:
   - `roundTrip.key` contains hash demo.
   - `history[0].id` === `jalan-pulang-v1`.
   - tidak ada request eksternal.
2. `local ROM and a local raw BIOS run...`:
   - game lokal tetap berjalan.
3. (Opsional) tambah skenario verifikasi save identity:
   - main game lokal dengan ROM demo → catat key save.
   - main game server dengan ROM demo yang sama → key save identik.

### Verifikasi manual (opsional)
- Main game lokal → aktifkan autosave → tutup.
- Main game server (ROM sama) → buka Save state server → slot Autosave harus terisi.

## 6. Risiko & catatan

- Frontend mempercayai `sha256` dari catalog; admin harus mengisinya benar saat upload.
- Save lama (di bawah `game.id`) tidak otomatis terbaca (sesuai kesepakatan data loss).
- Backend tidak perlu perubahan skema, hanya perlu menyimpan/mengembalikan `sha256`.

## 7. Urutan eksekusi yang disarankan

1. M0 (helper + hash demo)
2. M1 (sha256 lokal)
3. M2 (saveId plumbing)
4. M3 (runtime)
5. M4 (tes)

## 8. Checklist implementasi

- [x] Helper `saveIdentity` ditambahkan
- [x] Catalog demo berisi `sha256`
- [x] `SetupDialog` set `sha256` lokal
- [x] `LaunchSession` berisi `saveId`
- [x] `player.js` memakai `saveId`
- [x] `Player.tsx` memakai `saveId` di sync/transfer
- [x] `ServerStates.tsx` memakai `saveId`
- [x] Tes diperbarui
- [x] `npm test` lulus
- [x] `npm run build` lulus
- [x] `npm run test:e2e` lulus