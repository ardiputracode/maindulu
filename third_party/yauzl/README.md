# ZIP metadata identification dependency

- Package: **yauzl 3.4.0**, MIT, https://github.com/thejoshwolfe/yauzl
- Registry: https://www.npmjs.com/package/yauzl/v/3.4.0
- Direct version pinned in `package.json`; tarball SHA-512 integrity pinned in `package-lock.json`.
- Transitive dependency: `pend 1.2.0`, MIT, resolved/integrity recorded in the same lockfile.
- Runtime use: backend-only bounded ZIP member identification in `server/metadata/zip-identification-worker.mjs`. No extraction to disk, executable, ROM or proprietary archive fixture is shipped by this dependency integration.
- Installation/redistribution: normal `npm ci` (production: `npm ci --omit=dev`). Upstream package license files are retained under `node_modules/yauzl/LICENSE` and `node_modules/pend/LICENSE`; Docker production dependencies copy them unchanged. No vendored copy/binary or build-time download script added.
- Bounds and verification: [M7 report](../../doc/milestone-7-screenscraper-identifikasi.md). A worker thread is not an OS security sandbox.
