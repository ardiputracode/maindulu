---
name: codebase-guide
description: "Use when adding features, fixing bugs, refactoring, or navigating maindulu's ROM catalogs, browser storage, or EmulatorJS player. Load before non-trivial changes to its React frontend or static emulator runtime."
---

# Codebase Guide

Resolve all repository evidence paths below from the repository root, not this skill's directory. Runtime URL paths are identified explicitly.

## Project Overview

- Treat **maindulu** (`0.1.0`) as an Indonesian-language browser emulator frontend. Support local ROM/BIOS selection and manifest-listed server content; follow `package.json`, `src/App.tsx`, and `src/components/SetupDialog.tsx`.
- Keep the React interface separate from the locally served EmulatorJS runtime. The shipped catalog advertises NES, SNES, GB/GBC, GBA, Mega Drive, and PS1; inspect `public/catalog/consoles.json`, `src/components/Player.tsx`, and `public/player/player.js`.

## Technology Stack

Read these as **declared dependency ranges**, not verified installed versions. Dependency versions come from `package.json`; the engine version is pinned in `scripts/vendor-engine.mjs` and `public/player/player.js`.

| Area | Technology / declared version |
| --- | --- |
| Interface | `react` and `react-dom` `^19.1.0`; TypeScript/TSX |
| Routing | `react-router-dom` `^7.6.0` |
| Build | `vite` `^6.3.5`; `@vitejs/plugin-react` `^4.5.0`; `typescript` `~5.8.3` |
| Icons | `lucide-react` `^0.468.0` |
| SHA-256 fallback | `@noble/hashes` `2.4.0` |
| Browser tests | `@playwright/test` `^1.64.1` |
| Engine bundle transformation | `esbuild` `^0.25.0` |
| Emulator runtime | EmulatorJS `4.2.3`, plain JavaScript bridge and packaged cores |

Use ESM as declared by `package.json`. Follow the Node.js 24+ recommendation in `README.md` for unit tests that import TypeScript directly (`tests/domain.test.mjs`, `tests/identity.test.mjs`); this is not an enforced `engines` constraint. Retain the npm lockfile, `package-lock.json`.

## Project Structure

- Keep application routing/state in `src/App.tsx`, bootstrap in `src/main.tsx`, and global styling in `src/styles.css`.
- Place reusable UI in `src/components/`; use `src/components/GameCard.tsx` and `src/components/Dialog.tsx` as examples. Place shared contracts/helpers in `src/lib/`; follow `src/lib/domain.ts` and `src/lib/identity.ts`.
- Read content manifests in `public/catalog/`; examples are `public/catalog/consoles.json` and `public/catalog/games.json`.
- Keep the independent iframe document/bridge in `public/player/index.html` and `public/player/player.js`. Engine output belongs under `public/vendor/emulatorjs/4.2.3/`, as defined by `scripts/vendor-engine.mjs`.
- Keep distributed content in `public/games/`, `public/bios/`, and `public/covers/`; examples are `public/games/jalan-pulang.nes`, `public/bios/README.md`, and `public/covers/jalan-pulang.svg`. Branding/fonts live in `public/assets/` (`src/styles.css`, `src/App.tsx`).
- Keep content/engine generators in `scripts/` (`scripts/build-demo.mjs`, `scripts/vendor-engine.mjs`) and engine provenance/source notices in `third_party/emulatorjs/README.md`.
- Separate Node unit tests in `tests/` from browser tests in `tests/browser/`; inspect `tests/domain.test.mjs` and `tests/browser/app.spec.ts`. Use `deploy/nginx.conf` as the static-hosting template.

## Architecture

- Follow the single router bootstrap: `index.html` loads `src/main.tsx`, which mounts `RouterProvider` under `React.StrictMode` with a wildcard `App` route. Register the actual page routes and navigation in `src/App.tsx` (single route-registration implementation).
- Keep catalog data, settings, favorites, history, setup selection, and active session in `App`. Pass data/callbacks to components; keep transient selection/loading UI local to `SetupDialog` and `Player` (`src/App.tsx`, `src/components/SetupDialog.tsx`, `src/components/Player.tsx`).
- Separate domain transformations from React effects: `src/lib/domain.ts` defines records/parsers/validation; `src/lib/identity.ts` handles hashing/session IDs; `src/lib/storage.ts` provides the React persistence hook.
- Preserve the static runtime boundary: `public/player/index.html` loads `public/player/player.js` directly; `tsconfig.app.json` checks only `src`. Bridge changes are not covered by the application's TypeScript check.
- Load the engine only after a configured player session: `public/player/player.js` sets the `EJS_*` globals before appending the local loader. Keep the explicit user start action (`EJS_startOnLoaded = false`); `tests/browser/app.spec.ts` exercises that action.
- Treat browser metadata and emulator progress as different stores. `src/App.tsx` persists metadata through `useStored`; `public/player/player.js` selects browser save-state storage, and `tests/browser/app.spec.ts` verifies engine state round-trips.

## Important Modules

- Use `src/lib/domain.ts` as the contract hub: `ConsoleInfo`, `Game`, `Bios`, `Settings`, `STORAGE_KEYS`, validators, parsers, favorites, history, and relative timestamps. Its callers include `src/App.tsx`, `src/components/SetupDialog.tsx`, and `src/components/GameCard.tsx`.
- Preserve content-based identity through `hashRom` in `src/lib/identity.ts`: native SHA-256 for files up to 16 MiB when available; otherwise incremental SHA-256 in 1 MiB chunks. Verify parity against `tests/identity.test.mjs`.
- Use `useStored` in `src/lib/storage.ts` for existing settings/favorite/history state. It parses unknown JSON on initialization, writes after state changes, and exposes a blocked-write flag consumed by `src/App.tsx`.
- Reuse `src/components/Dialog.tsx` for setup modal focus/scroll handling. Use `src/components/GameCard.tsx` for game actions and `src/components/ConsoleArt.tsx` for family-specific artwork; callers are in `src/App.tsx` and `src/components/SetupDialog.tsx`.

## Application Data Flow

### Read: initial catalog to visible games

1. Enter through `index.html` → `src/main.tsx` → `src/App.tsx`.
2. In `App`'s catalog effect, fetch the three runtime URLs `/catalog/consoles.json`, `/catalog/games.json`, and `/catalog/bios.json` concurrently. Abort on cleanup; retry by changing `catalogRetry` (`src/App.tsx:61–81`).
3. Filter console records in `App`; parse games with `readGames` and filter game/BIOS console references against the loaded consoles. Check BIOS paths with `isSafeLocalUrl` (`src/App.tsx:71–75`, `src/lib/domain.ts`).
4. Render the home catalog or `Explore`; filter using the `console` search parameter and Indonesian case-insensitive title matching. Delegate game display/actions to `src/components/GameCard.tsx` (`src/App.tsx:117–118,163–169`).

### Write: local ROM launch to recorded history

1. Open `SetupDialog` from `src/App.tsx`. In `src/components/SetupDialog.tsx`, select/drop a file, detect an unambiguous console, and independently select a local/server BIOS.
2. Validate the selection with `validateRom`/`validateBios` from `src/lib/domain.ts`. For a local ROM, call `hashRom` from `src/lib/identity.ts` and construct `local-${consoleId}-${hash}`; reject a different hash when reopening a saved local game (`src/components/SetupDialog.tsx:36–57`).
3. Create a secure session ID; call `App.launch`, clear setup, retain the `LaunchSession` in memory, and navigate to the runtime URL `/main`. Mount `Player` keyed by `session.id` (`src/components/SetupDialog.tsx`, `src/App.tsx:115,150`).
4. Load `public/player/index.html`; its bridge emits `ready`. `src/components/Player.tsx` sends one `configure` message containing the session, core, ROM/BIOS objects or server paths, and initial volume.
5. In `public/player/player.js`, validate the message, check server assets when applicable, create local blob URLs, configure `EJS_*`, and append the loader. Set `EJS_gameName` to `${config.core}-${config.game.id}` to namespace saves.
6. After the user's start click, forward `starting` and then `started`. Only `started` invokes the host's `onStart` once; `src/App.tsx` then applies `recordHistory`, and `src/lib/storage.ts` writes metadata to LocalStorage (`src/components/Player.tsx:22–36`, `public/player/player.js:71–85`).
7. On navigation away, clear the session in `src/App.tsx`; unmount the iframe/listeners in `src/components/Player.tsx`; revoke bridge-created blob URLs on `pagehide` in `public/player/player.js`.

For server launches, reuse the same path without local hashing; the game ID/URL come from `public/catalog/games.json` (`src/components/SetupDialog.tsx:49–56`).

## Coding Conventions

- Match two-space indentation, single-quoted imports, and the surrounding semicolon-light TypeScript style; compare `src/components/Player.tsx` and `src/lib/identity.ts`.
- Use PascalCase component filenames/default function exports and typed props with `on...` callbacks; follow `src/components/GameCard.tsx` and `src/components/SetupDialog.tsx`.
- Use named exports for shared functions/types and separate `import type` statements; compare `src/lib/domain.ts`, `src/lib/identity.ts`, `src/components/GameCard.tsx`, and `src/components/SetupDialog.tsx`.
- Keep UI imports relative and extensionless (`src/App.tsx`, `src/components/SetupDialog.tsx`); keep direct `.ts` imports in Node unit tests (`tests/domain.test.mjs`, `tests/identity.test.mjs`).
- Keep user-facing labels, validation messages, and accessible names in Indonesian; match `src/App.tsx` and `src/components/SetupDialog.tsx`. This skill's English prose does not change the UI language.
- Reuse global classes and theme custom properties from `src/styles.css`; component consumers include `src/components/GameCard.tsx` and `src/components/SetupDialog.tsx`.
- Preserve keyboard focus, Escape/Tab handling, and focus restoration in overlays; compare the drawer effect in `src/App.tsx:91–108` with `src/components/Dialog.tsx`.
- Pair listeners, timers, and fetch effects with cleanup; follow `src/App.tsx:61–108` and `src/components/Player.tsx:19–45`.

## Authentication and Security

- Preserve origin, source-window, and channel checks on both message endpoints. The host's initial `ready` handshake precedes session-ID validation; subsequent session events must match. The bridge accepts configuration only once and checks its core allowlist (`src/components/Player.tsx:22–29`, `public/player/player.js:40–49`).
- Preserve the root-relative URL guard in both runtimes: reject protocol-relative URLs, backslashes, and whitespace/control characters. Keep `isSafeLocalUrl` in `src/lib/domain.ts` aligned with `localUrl` in `public/player/player.js`; verify with `tests/domain.test.mjs`.
- Do not describe the iframe as a cross-origin security sandbox. It is same-origin and has no `sandbox` attribute; its own CSP permits inline/eval/blob scripts and limits network connections to self/blob/data (`src/components/Player.tsx:50`, `public/player/index.html:6`).
- Keep local files as file/blob data and leave raw ROM/BIOS caching disabled through `EJS_disableDatabases` and `EJS_CacheLimit`. Preserve separate save-state storage and blob cleanup (`public/player/player.js:52–68,100`, `tests/browser/app.spec.ts:75–140`).
- Treat every distributed file under `public/` as downloadable. Follow the distribution warning in `public/bios/README.md`, the demo's scope in `public/games/LICENSE.txt`, and engine notices in `third_party/emulatorjs/README.md`; do not treat the demo's CC0 license as covering other assets.

## Error Handling

- Return an Indonesian message or `null` from file validators, following both `validateRom` and `validateBios` in `src/lib/domain.ts`. Let `src/components/SetupDialog.tsx` render the result with `role="alert"`.
- Preserve useful caught messages with `e instanceof Error ? e.message : ...`; follow catalog loading in `src/App.tsx` and launch handling in `src/components/SetupDialog.tsx`.
- Keep catalog failure/retry at the application boundary: a rejected manifest request prevents normal route rendering until retry succeeds (`src/App.tsx:61–81,136`).
- Keep player errors visible in the host: the bridge checks server assets with `HEAD`, rejects HTML or a zero `content-length` header, and forwards loader/runtime failures; the host has 90-second readiness/start timers (`public/player/player.js`, `src/components/Player.tsx`).
- Retain memory-only UI state when LocalStorage writes fail; show the blocked-storage notice instead of breaking gameplay (`src/lib/storage.ts:14–17`, `src/App.tsx:135`).
- Preserve the bridge-only wake-lock exception: suppress rejected wake-lock warnings, not arbitrary promise rejections (`public/player/player.js:93–99`; single exception implementation).

## Testing Strategy

- Model pure-function tests after `tests/domain.test.mjs` and `tests/identity.test.mjs`: use `node:test`, strict assertions, direct source imports, and real catalog/demo fixtures. Cover malformed inputs, caps, hash parity, and unavailable/rejecting browser crypto.
- Model browser scenarios after `tests/browser/app.spec.ts` and `tests/browser/http-lan.spec.ts`: locate UI by role/name, upload fixtures with `setInputFiles`, enter the iframe with `frameLocator`, and wait for a real canvas/cleared player status.
- Reuse `launchDemo` inside `tests/browser/app.spec.ts` for its engine scenarios. Cover real start/history, local/server BIOS plumbing, save/load state, missing assets, and external-request blocking rather than substituting a mock player.
- Keep LAN fallback coverage in `tests/browser/http-lan.spec.ts`: it uses a real non-loopback IPv4 origin, asserts unavailable secure-context APIs, and skips when no LAN interface exists.
- Expect installed Microsoft Edge (`channel: 'msedge'`), one worker, and retained failure traces from `playwright.config.ts`. Production configuration inherits these settings and uses preview on port 4173 (`playwright.production.config.ts`).
- Account for browser-test writes: screenshots and traces are produced during execution; output directories are ignored by `.gitignore` (`tests/browser/app.spec.ts`, `playwright.config.ts`).

## Development Workflow

Use only the following project-defined invocations. Every mapping is defined in `package.json:scripts`; commands were inspected, not executed when generating this guide.

| Invocation | Exact script definition |
| --- | --- |
| `npm run dev` | `vite --host 0.0.0.0` |
| `npm run build` | `tsc -b && vite build` |
| `npm run preview` | `vite preview --host 0.0.0.0` |
| `npm test` | `node --test tests/*.test.mjs` |
| `npm run test:e2e` | `playwright test` |
| `npm run test:e2e:production` | `playwright test --config=playwright.production.config.ts` |
| `npm run build:demo` | `node scripts/build-demo.mjs` |
| `npm run vendor:engine` | `node scripts/vendor-engine.mjs` |

- Use dev port 5173 and preview port 4173; both are strict ports (`vite.config.ts`). Both package scripts bind all interfaces; the LAN tests depend on reaching a network address (`package.json`, `tests/browser/http-lan.spec.ts`).
- Build before production browser verification: `playwright.production.config.ts` starts preview but does not build. The normal build script does not invoke either asset generator (`package.json`).
- Treat asset generators as explicit writing operations: `scripts/build-demo.mjs` writes the shipped demo ROM; `scripts/vendor-engine.mjs` verifies an archive hash, extracts selected assets with `tar`, writes patched sources/bundles, and records provenance. Vendoring accepts the archive through its first positional argument.
- Keep TypeScript build metadata and application output out of source changes (`tsconfig.app.json`, `tsconfig.node.json`, `.gitignore`). Browser tests also produce artifacts; do not describe all verification commands as read-only.
- Document only the environment variable name `CI`: both Playwright configurations use it to decide whether to reuse an existing server (`playwright.config.ts:18`, `playwright.production.config.ts:7`).

## Feature Implementation Guide

### Add or change a page/component

1. Extend the existing `navigation` and `Routes` in `src/App.tsx` when adding a navigable page; use the existing `/console`/`Explore` or `/pengaturan` implementations as templates.
2. Extract reusable UI into `src/components/` following `src/components/GameCard.tsx` or `src/components/Dialog.tsx`; pass typed data/callbacks from the owner rather than creating a second application state container.
3. Reuse `src/styles.css`; preserve desktop/mobile navigation and accessible controls. Extend the corresponding navigation/interaction scenarios in `tests/browser/app.spec.ts`.

### Add shared logic or change stored records

1. Follow the exported-function modules `src/lib/domain.ts` and `src/lib/identity.ts`; keep browser effects in callers or `src/lib/storage.ts`.
2. For metadata changes, update the relevant type, parser, defaults, and callers together. Follow `readSettings`/`readGames` and their existing tests in `tests/domain.test.mjs`; preserve explicit `history: false` and volume clamping.
3. Keep the versioned `STORAGE_KEYS` and game identity contracts compatible unless the requested change explicitly includes a migration design (`src/lib/domain.ts`, `src/App.tsx`, `tests/identity.test.mjs`).

### Add catalog content or console support

1. Use the single shipped game entry in `public/catalog/games.json` as the server-game template; pair content in `public/games/` with a cover in `public/covers/`. Keep IDs stable because favorites/history and engine save names use them (`src/lib/domain.ts`, `public/player/player.js:54`).
2. For BIOS metadata, follow the `Bios` type in `src/lib/domain.ts` and filtering in `src/App.tsx:75`; `public/catalog/bios.json` is currently empty, so it is not a populated example. Use `tests/browser/app.spec.ts:142–154` as the existing synthetic server-BIOS fixture.
3. For a console/core change, review `public/catalog/consoles.json`, the bridge's `allowedCores` in `public/player/player.js`, and the vendoring `cores` list in `scripts/vendor-engine.mjs` together. Update the file-picker formats in `src/components/SetupDialog.tsx` and family rendering in `src/components/ConsoleArt.tsx` where needed.
4. Extend asset-contract checks in `tests/domain.test.mjs`; they require normal/legacy packaged variants and a core report. Preserve distribution notices in `third_party/emulatorjs/README.md`.

### Change player behavior

1. Review the host `src/components/Player.tsx` and bridge `public/player/player.js` together; preserve the message lifecycle described above and the iframe CSP in `public/player/index.html`.
2. Extend engine scenarios in `tests/browser/app.spec.ts`; extend `tests/browser/http-lan.spec.ts` and `tests/identity.test.mjs` for identity/crypto changes.
3. Keep navigation confirmation and session disposal in `src/App.tsx` aligned with host events; the existing browser test checks both dismissed navigation and iframe removal (`tests/browser/app.spec.ts:111–118`).

## Debugging Guide

| Symptom | Inspect existing boundary |
| --- | --- |
| Entire catalog unavailable | Check all three manifest requests and the console-record filter in `src/App.tsx:61–81`; the requests form one `Promise.all`. |
| Local favorite rejects a selected file | Check content hash and console identity in `src/components/SetupDialog.tsx:51–54`; compare native/fallback behavior using `tests/identity.test.mjs`. |
| Server ROM/BIOS fails before the start screen | Check `checkServerAsset` in `public/player/player.js` and real asset 404s in `deploy/nginx.conf`; HTML fallback is rejected. |
| Engine/core never starts | Inspect loader/core paths, allowlist, forwarded error events, and host timers in `public/player/player.js`, `public/player/index.html`, and `src/components/Player.tsx`. |
| Save appears missing after a change | Compare core/game ID with `EJS_gameName` in `public/player/player.js:54` and save-key assertions in `tests/browser/app.spec.ts:89–105`. |
| HTTP phone launch breaks | Compare crypto fallback in `src/lib/identity.ts` with the actual insecure-origin expectations in `tests/browser/http-lan.spec.ts`. |

## Common Pitfalls

- Do not silently raise catalog capacity assumptions: `readGames` caps every parsed list at 100, including server catalog input. History mutations cap at 50 and favorites at 100 (`src/lib/domain.ts:60–75`, `src/App.tsx:74`).
- Do not equate extension/size validation with a valid game or firmware. Local limits are 768 MiB ROM / 32 MiB BIOS; server preflight checks status, HTML content type, and a zero-length header, not those size limits (`src/lib/domain.ts`, `public/player/player.js:11–16`).
- Do not assume zipped FDS content triggers the BIOS requirement: `biosRequired` checks the outer ROM filename/server URL extension, not archive contents (`src/components/SetupDialog.tsx:27`, `public/catalog/consoles.json`).
- Do not generalize NES browser success to every core or real BIOS. Browser fixtures use the NES demo and synthetic BIOS; the other core checks verify packaged assets, not gameplay (`tests/browser/app.spec.ts`, `tests/browser/http-lan.spec.ts`, `tests/domain.test.mjs:60–68`).
- Do not assume console manifests receive complete schema validation: `App` checks selected fields, while the player independently rejects unlisted cores (`src/App.tsx:71`, `public/player/player.js:9,43`).
- Do not treat LocalStorage history as a save or a durable ROM copy. Sessions are memory-only, `/main` has a refresh-empty state, and initial volume is frozen per session (`src/App.tsx:42–44,150`, `src/components/Player.tsx:26,43–45`).
- Do not assume subpath hosting works with the existing root-absolute runtime URLs. Preserve SPA fallback for pages but real 404s for asset directories (`src/App.tsx:67`, `public/player/player.js:55,87`, `deploy/nginx.conf:12–19`).
- Do not hand-edit generated engine bundles or the demo binary. Their reproducible writers are `scripts/vendor-engine.mjs` and `scripts/build-demo.mjs`; inspect these before regeneration.
- Do not use the historical passing-test counts in `RENCANA.md:89–90` as current validation evidence. Additional tests exist in `tests/identity.test.mjs` and `tests/browser/http-lan.spec.ts`; inspect definitions and report actual execution separately.

## Important Files Reference

| Path | Purpose |
| --- | --- |
| `package.json` | Project identity, dependency ranges, all npm scripts |
| `vite.config.ts` | React plugin, strict ports, ES2022 build target |
| `tsconfig.app.json` | Strict application checking, bundler imports, no emit, source scope |
| `src/main.tsx` | React/Router bootstrap and global CSS import |
| `src/App.tsx` | Catalog boundary, routes, shared state, navigation blocking |
| `src/lib/domain.ts` | Data contracts, parsing, validation, storage keys, list limits |
| `src/lib/identity.ts` | Portable SHA-256 and securely random session IDs |
| `src/lib/storage.ts` | LocalStorage-backed React state and blocked-write signal |
| `src/components/SetupDialog.tsx` | ROM/BIOS selection, validation, launch identity |
| `src/components/Player.tsx` | Iframe host, session messages, status/errors, unload warning |
| `public/player/player.js` | Engine bridge, asset checks, BIOS ZIP wrapping, blob cleanup |
| `public/player/index.html` | Player document, CSP, bridge loading |
| `public/catalog/consoles.json` | Advertised cores, extensions, BIOS hints, visual families |
| `public/catalog/games.json` | Shipped server-game template and stable game ID |
| `scripts/vendor-engine.mjs` | Hash-pinned extraction, local-only patches, bundle/provenance generation |
| `playwright.config.ts` | Browser/test-server configuration shared by production tests |
| `playwright.production.config.ts` | Preview-based production browser test configuration |
| `deploy/nginx.conf` | Static asset 404s and SPA page fallback |

## AI Agent Instructions

1. Start UI changes at the state-owning `src/App.tsx` and the relevant component; use the feature procedures above instead of inventing another routing/state layer (`src/components/GameCard.tsx`, `src/components/SetupDialog.tsx`).
2. For a player protocol change, review both endpoints before editing either (`src/components/Player.tsx`, `public/player/player.js`).
3. For identity/storage work, read the existing regression tests before changing record keys or hash behavior (`tests/domain.test.mjs`, `tests/identity.test.mjs`).
4. For runtime independence claims, use the real-engine external-request-blocking scenarios as evidence, not only a visible start button (`tests/browser/app.spec.ts`, `tests/browser/http-lan.spec.ts`).
5. For regeneration/deployment tasks, inspect script side effects and hosting behavior before running project commands (`scripts/vendor-engine.mjs`, `scripts/build-demo.mjs`, `deploy/nginx.conf`).
