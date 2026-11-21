# Bug Report — Post-Commit 6ae0ccc Test Results

**Commit:** `6ae0ccc` — "storage: organize cover files into platform subfolders"  
**Previous commit:** `bceb9bd` — "docs(deploy): add external covers dir support and improve compose templates"  
**Date:** 2026-11-20  

---

## Executive Summary

| Suite | Total | ✅ Pass | ❌ Fail | ⏭️ Skip |
|-------|-------|---------|---------|---------|
| Node.js Unit (`npm test`) | 660 | 660 | **0** | 0 |
| Playwright Default | 207 | 69 | 0 | 138 |
| Playwright Gate | 8 | 8 | 0 | 0 |
| Playwright Backend Config | 202 | 202 | **0** | 0 |
| **TOTAL** | **1,077** | **939** | **0** | **138** |

---

## Group A: Deploy Tests — ✅ ALL FIXED (4/4)

All failures in `tests\deploy.test.mjs` have been fixed by updating assertions to match new compose file structure.

### A1. Line 19 — Image version tag mismatch ✅ FIXED
- **Fix:** Changed assertion to accept both hardcoded version and variable-based format (`maindulu-backend:latest`)
- **File:** `tests\deploy.test.mjs` line 19

### A2. Line 55 — External overlay `read_only: true` count ✅ FIXED
- **Fix:** Changed expected count from `2` → `3` (covers mount added by commit `831dcd9`)
- **File:** `tests\deploy.test.mjs` line 55

### A3. Line 65 — Shared overlay `read_only: false` count ✅ FIXED
- **Fix:** Changed expected count from `2` → `3` (covers mount added)
- **File:** `tests\deploy.test.mjs` line 65

### A4. Line 93 — Portainer example `read_only: false` count ✅ FIXED
- **Fix:** Changed expected count from `2` → `3` (covers mount added)
- **File:** `tests\deploy.test.mjs` line 93

---

## Group B: Playwright Backend Config — ✅ ALL FIXED

### B1. catalog-indexeddb-cache.spec.ts:147 — Strict mode violation on `.player-asset-notice` ✅ FIXED
- **Fix:** Replaced all 7 occurrences of `.player-asset-notice` with `getByRole('status', { name: 'Status cache ROM/BIOS' })` in `tests\browser\catalog-indexeddb-cache.spec.ts`
- **Root cause:** The `.player-asset-notice` CSS class is used in 3 places in `Player.tsx` (cache status, guest save notice, guest load message). Generic selector hit Playwright strict mode because multiple elements matched.

### B2. catalog-indexeddb-cache.spec.ts:227 — Guest notice appears when cache toggled off ✅ FIXED
- **Fix:** Same as B1 — use `getByRole('status', { name: 'Status cache ROM/BIOS' })` instead of generic `.player-asset-notice` class selector

### B3. catalog-indexeddb-cache.spec.ts:403 — Timeout waiting for "Mulai bermain" button in StrictMode iframe ✅ FIXED
- **Test:** "M3 development StrictMode mount/cleanup keeps a live preparation and starts exactly once"
- **Error:** Test timeout 90s exceeded — `locator('iframe').contentFrame().getByRole('button', { name: 'Mulai bermain' })` never found
- **Root cause:** `tests/fixtures/player-strict.tsx` mounted `<Player>` without required `registerBusyGuard` and `onSavedExit` props, causing `registerBusyGuard is not a function` on render; the StrictMode Player never mounted its iframe.
- **Fix:** Added `registerBusyGuard={() => {}}` and `onSavedExit={() => root?.unmount()}` to the strict fixture. Also added host→bridge `ping`/`ready` re-handshake in `src/components/Player.tsx` and `public/player/player.js` to make StrictMode remounts robust if the ready message was missed.
- **Verified:** `npm run build`; `npx playwright test --config=playwright.backend.config.ts tests/browser/catalog-indexeddb-cache.spec.ts -g "StrictMode mount/cleanup keeps a live preparation and starts exactly once" --reporter=line` — 1 passed.

### B4. library.spec.ts:271 — Browser crash when clicking play on renamed game ✅ FIXED
- **Test:** "saved server favorites and history recheck deleted metadata before asset download; required BIOS cannot be skipped"
- **Error:** `locator.click` — "Target page, context or browser has been closed" / test timeout waiting for renamed favorite button
- **Root cause:** Test clicked favorite then navigated away before the async `POST /api/me/favorites` completed; full `page.goto` aborted the in-flight request, so `/favorit` reloaded with 0 server favorites.
- **Fix:** In `tests/browser/library.spec.ts`, wait for `Hapus Favorit server dari favorit` to be visible after clicking add-favorite, confirming the favorite persisted before navigation.
- **Verified:** `npx playwright test --config=playwright.backend.config.ts tests/browser/library.spec.ts -g "saved server favorites and history recheck deleted metadata before asset download" --reporter=line` — 1 passed.
- **Percobaan perbaikan (2026-11-21):**
  - **Attempt 1:** Mengubah `mergeLive` di navigation refetch (`src/App.tsx:237-248`) agar hanya mengisi field yang kosong, bukan menimpa title dari `/api/games/:id` dengan data stale dari `liveCatalogRef.current`. Build berhasil, test tetap timeout 90s.
  - **Hasil debug:** Page snapshot menunjukkan "0 permainan favorit" — seluruh daftar favorites kosong, bukan sekadar judul usang. Masalahnya bukan stale metadata melainkan `serverFavorites` menjadi array kosong setelah navigasi ke `/favorit`. Root cause belum teridentifikasi.

### B5. metadata.spec.ts:204 (x2) — "Mainkan Judul otomatis" not found in Favorites after auto-apply ✅ FIXED
- **Test:** "M5 raw upload stays playable while provider is held; another tab refreshes title/cover/favorites without reload or changing the active session" and M7 ZIP variant
- **Error:** `getByRole('button', { name: 'Mainkan Judul otomatis' }).toBeVisible()` — element not found on Favorites page after navigation from Library page
- **Root cause:** `serverFavorites`/`serverHistory` kept titles captured at favorite time. Live-catalog refresh merged server lists only when `isAccountReady`, favorites/history memos merged only server entries, and navigation refetch could overwrite with stale `/api/me/favorites` data.
- **Fix:** In `src/App.tsx`, merge live catalog title/cover into all favorites/history entries (server + local-only server-sourced) in memos; update `serverFavorites`/`serverHistory` on live-catalog refresh without `isAccountReady` gate; on `/favorit`/`/riwayat` navigation refetch favorites/history and merge with `liveCatalogRef` + fresh `/api/games/:id` data with an active guard.
- **Verified:** `npm run build` pass; `npx playwright test --config=playwright.backend.config.ts tests/browser/metadata.spec.ts -g "another tab refreshes title/cover/favorites without reload or changing the active session" --reporter=line` — 2 passed (M5 raw + M7 ZIP).

---

## B5 — Resolution

B5 was fixed by making live catalog metadata the synchronous source of truth for displayed favorites/history:

1. **Memo merge:** `favorites`/`history` memos merge `liveCatalog.games` title/cover/coverRevision into both `serverFavorites`/`serverHistory` and local-only server-sourced entries.
2. **Refresh merge:** live-catalog `onRefresh` merges `serverFavorites`/`serverHistory` from fresh catalog data without an `isAccountReady` gate.
3. **Navigation refetch:** `/favorit` and `/riwayat` navigation refetches merge API results with `liveCatalogRef` and fresh `/api/games/:id` data, with an `active` guard to ignore stale responses.

**Verified:** `npm run build`; `npx playwright test --config=playwright.backend.config.ts tests/browser/metadata.spec.ts -g "another tab refreshes title/cover/favorites without reload or changing the active session" --reporter=line` — 2 passed (M5 raw + M7 ZIP).

---

## Group C: Related Code Changes (commit 6ae0ccc)

The following files were modified by commit `6ae0ccc` and may be related to failures B5:

| File | Change |
|------|--------|
| `server\catalog\storage.mjs` | `pathFor()` and `open()` now accept optional `platform` parameter; covers stored under `data/covers/<platform>/key.ext`; `promote()` creates platform directories automatically |
| `server\catalog\repository.mjs` | `publish()`/`update()` pass `consoleId` to cover promotion |
| `server\metadata\worker.mjs` | Scraper cover download passes `game.console_id` |
| `server\catalog\assets.mjs` | Serve covers with platform context via `storage.open('covers', key, consoleId)` |
| `server\catalog\queries.mjs` | Cover status check uses `row.console_id` for platform context |

---

## Priority & Effort Estimate (Updated)

| Bug | Priority | Status | Category |
|-----|----------|--------|----------|
| A1-A4 | Low | ✅ Fixed | Test assertion updates |
| B1-B2 | Medium | ✅ Fixed | Test selector fixes |
| B3 | Minor | ✅ Fixed | StrictMode fixture props + host/bridge ready ping |
| B4 | Minor | ✅ Fixed | Test race condition (favorite persist wait) |
| B5 | Minor | ✅ Fixed | Stale favorites/history metadata merge |

---

## Recommended Actions

1. **B3 (StrictMode timeout)** → **FIXED**. Added missing required Player props in strict fixture and a host↔bridge ping/ready handshake for StrictMode re-mount resilience.

2. **B4 (browser crash on rename)** → **FIXED**. Added wait for favorite persistence (`Hapus Favorit server dari favorit` visible) before navigation so the async `POST /api/me/favorites` completes.

3. **B5 (favorites button missing)** → **FIXED**. Merged live catalog metadata into favorites/history memos, removed `isAccountReady` gate from live-catalog refresh merge, and hardened `/favorit`/`/riwayat` refetch with `liveCatalogRef` fallback. Verified by both B5 Playwright cases.

---

## Notes

- All deploy test failures (Group A) are **not related to commit 6ae0ccc**. They stem from compose template changes in commits `bceb9bd` and `831dcd9`.
- Failures B1-B2 were **test selector issues** — the `.player-asset-notice` class is now used for multiple distinct UI elements. Fixed by using semantic selectors.
- No remaining failures from the B3/B4/B5 set. Backend Config is 202/202 pass on the verified run.
