# EmulatorJS v4.2.3 — local-only distribution

Runtime: `public/vendor/emulatorjs/4.2.3/data/`.
Unmodified JavaScript sources, upstream README/license, and provenance: `4.2.3/`.
Patched readable sources: `public/vendor/emulatorjs/4.2.3/data/src/`.
Reproducible patch/build: `scripts/vendor-engine.mjs`.

## Changes

1. `checkForUpdates()` does not contact the upstream CDN.
2. Missing local cores produce an actionable error instead of falling back to the CDN.
3. Remove the default public netplay server; the frontend hides netplay.
4. Add the Layar lebar display toggle and bridge callback.
5. Account players opt into memory-only save state storage and an unmounted MEMFS save directory; guest IndexedDB/IDBFS behavior remains unchanged. The loader forwards the explicit `EJS_mainduluMemorySaves` flag. This does not implement memcard synchronization.
6. Expose the selected core filename and generate `public/player/builds.json` with SHA-256 core/runtime fingerprints for save-state compatibility checks.
7. Report play/pause transitions to the bridge (`EJS_onPlayPause`) so the app can pause around the save-state overlay and gate autosave to running sessions.
8. Accept fully specified custom bottom-bar buttons through `buildButtonOptions`; upstream 4.2.3 rejected unknown keys before its custom-button validation.

Both WebGL and legacy, non-threaded variants are included for six cores. Core selection is pinned by the manifest. Threaded cores and unsupported systems are not advertised. Account state integration is automatically verified on NES only; availability of the other cores is not proof of server-save compatibility.

## Rebuild

Download the full `4.2.3.7z` release asset (not the GitHub source ZIP), then:

```sh
npm run vendor:engine -- /path/to/4.2.3.7z
```

The script checks the release SHA-256 before extraction and refuses a different archive. It requires `tar` with 7z support (Windows includes a compatible bsdtar).

## Licenses and corresponding source

EmulatorJS is GPL-3.0-or-later. Preserve its copyright, license, source availability, and modification notices when distributing. The individual cores have their own licenses, included in their `.data` packages and shown in the emulator's About dialog. Core build/source references are recorded in `data/cores/reports/*.json` and the upstream projects:

- EmulatorJS: https://github.com/EmulatorJS/EmulatorJS/tree/v4.2.3
- Core builds: https://github.com/EmulatorJS/EmulatorJS-cores
- RetroArch: https://github.com/libretro/RetroArch

When distributing a deployed build, provide the accompanying source package/repository and the corresponding core sources/build information required by each license. A link alone is not a blanket exemption from source-distribution obligations. No commercial ROM or proprietary BIOS is included.
