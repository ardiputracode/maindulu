import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = '4.2.3'
const expectedHash = '07d451bc06fa3ad04ab30d9b94eb63ac34ad0babee52d60357b002bde8f3850b'
const archive = process.argv[2] || join(tmpdir(), `emulatorjs-${version}.7z`)
const staging = join(dirname(archive), `maindulu-emulatorjs-${version}`)
const target = join(root, 'public/vendor/emulatorjs', version)
const sourceTarget = join(root, 'third_party/emulatorjs', version)
const cores = ['fceumm', 'snes9x', 'gambatte', 'mgba', 'genesis_plus_gx', 'pcsx_rearmed']
const scripts = ['emulator.js', 'nipplejs.js', 'shaders.js', 'storage.js', 'gamepad.js', 'GameManager.js', 'socket.io.min.js', 'compression.js']
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

const hash = createHash('sha256').update(await readFile(archive)).digest('hex')
if (hash !== expectedHash) throw new Error('SHA-256 arsip tidak cocok dengan rilis v4.2.3. Proses dihentikan.')
await mkdir(staging, { recursive: true })
const entries = ['data/src', 'data/compression', 'data/localization', 'data/loader.js', 'data/emulator.css', 'data/emulator.min.css', 'data/version.json', 'LICENSE', 'README.md']
for (const core of cores) entries.push(`data/cores/${core}-wasm.data`, `data/cores/${core}-legacy-wasm.data`, `data/cores/reports/${core}.json`)
execFileSync('tar', ['-xf', archive, '-C', staging, ...entries], { stdio: 'inherit' })

async function copyTree(from, to) {
  await mkdir(to, { recursive: true })
  for (const item of await readdir(from, { withFileTypes: true })) {
    if (item.isDirectory()) await copyTree(join(from, item.name), join(to, item.name))
    else await copyFile(join(from, item.name), join(to, item.name))
  }
}
await copyTree(join(staging, 'data'), join(target, 'data'))
await copyTree(join(staging, 'data/src'), join(sourceTarget, 'upstream-src'))
await mkdir(sourceTarget, { recursive: true })
await copyFile(join(staging, 'LICENSE'), join(sourceTarget, 'LICENSE'))
await copyFile(join(staging, 'LICENSE'), join(target, 'LICENSE'))
await copyFile(join(staging, 'README.md'), join(sourceTarget, 'UPSTREAM-README.md'))

let emulator = await readFile(join(staging, 'data/src/emulator.js'), 'utf8')
const updateStart = emulator.indexOf('    checkForUpdates() {')
const updateEnd = emulator.indexOf('    versionAsInt(ver) {', updateStart)
if (updateStart < 0 || updateEnd < 0) throw new Error('Batas patch checkForUpdates tidak ditemukan.')
emulator = emulator.slice(0, updateStart) + '    checkForUpdates() {\n        // maindulu: vendored v4.2.3; no remote update checks.\n    }\n' + emulator.slice(updateEnd)
const fallbackStart = emulator.indexOf('            if (res === -1) {\n                console.log("File not found, attemping to fetch from emulatorjs cdn.");')
const fallbackEnd = emulator.indexOf('            gotCore(res.data);', fallbackStart)
if (fallbackStart < 0 || fallbackEnd < 0) throw new Error('Batas patch CDN fallback tidak ditemukan.')
emulator = emulator.slice(0, fallbackStart) + `            if (res === -1) {
                this.startGameError("Core lokal tidak tersedia: " + filename + ". Periksa instalasi maindulu.");
                return;
            }
` + emulator.slice(fallbackEnd)
// Netplay is outside this product's scope; remove the external default defensively.
emulator = emulator.replace('this.config.netplayUrl = this.config.netplayUrl || "https://netplay.emulatorjs.org";', 'this.config.netplayUrl = this.config.netplayUrl || ""; // maindulu: no public netplay service')
// Graphics Settings gains a widescreen display toggle ("Layar lebar"); rendering stays in the bridge.
const videoRotationMenu = `        addToMenu(this.localization("Video Rotation"), "videoRotation", {
            "0": "0 deg",
            "1": "90 deg",
            "2": "180 deg",
            "3": "270 deg"
        }, this.videoRotation.toString(), graphicsOptions, true);`
if (!emulator.includes(videoRotationMenu)) throw new Error('Batas patch menu Layar lebar tidak ditemukan.')
emulator = emulator.replace(videoRotationMenu, `${videoRotationMenu}
        // maindulu: widescreen display stretch toggle, applied by the bridge hook.
        addToMenu("Layar lebar", "mainduluWidescreen", {
            "enabled": "Nyala",
            "disabled": "Mati"
        }, this.preGetSetting("mainduluWidescreen") || "disabled", graphicsOptions, true);`)
const lockMouseOption = `        } else if (option === "lockMouse") {
            this.enableMouseLock = (value === "enabled");
        }`
if (!emulator.includes(lockMouseOption)) throw new Error('Batas patch aksi Layar lebar tidak ditemukan.')
emulator = emulator.replace(lockMouseOption, `${lockMouseOption} else if (option === "mainduluWidescreen") {
            // maindulu: widescreen display stretch is applied by the bridge hook.
            if (typeof window.EJS_onWidescreen === "function") window.EJS_onWidescreen(value === "enabled");
        }`)
// Upstream 4.2.3 rejects any buttonOpts key that is not in the default button
// list before its custom-button validation runs, so fully-specified custom
// buttons (displayName + icon + callback) can never reach the bar. Accept them.
const invalidButton = `                if (!mergedButtonOptions[searchKey]) {
                    console.warn(\`Button "\${searchKey}" is not a valid button.\`);
                    continue;
                }`
if (!emulator.includes(invalidButton)) throw new Error('Batas patch tombol kustom tidak ditemukan.')
emulator = emulator.replace(invalidButton, `                if (!mergedButtonOptions[searchKey]) {
                    // maindulu: allow fully specified custom buttons through the
                    // "not a valid button" gate so the bridge can add its own
                    // bottom-bar entries (save-state server overlay).
                    const rawCustom = buttonUserOpts[searchKey];
                    if (rawCustom && typeof rawCustom === "object" && rawCustom.displayName && rawCustom.icon && rawCustom.callback) {
                        mergedButtonOptions[searchKey] = { visible: true, displayName: rawCustom.displayName, icon: rawCustom.icon, callback: rawCustom.callback, custom: true };
                        continue;
                    }
                    console.warn(\`Button "\${searchKey}" is not a valid button.\`);
                    continue;
                }`)
// Account sessions use memory-only progress; guest IDBFS/state behavior is unchanged.
const statesStore = 'this.storage.states = new window.EJS_STORAGE("EmulatorJS-states", "states");'
if (!emulator.includes(statesStore)) throw new Error('Batas patch state memory tidak ditemukan.')
emulator = emulator.replace(statesStore, 'this.storage.states = this.config.mainduluMemorySaves ? new window.EJS_DUMMYSTORAGE() : new window.EJS_STORAGE("EmulatorJS-states", "states");')
const coreFile = 'let filename = this.getCore() + (threads ? "-thread" : "") + legacy + "-wasm.data";'
if (!emulator.includes(coreFile)) throw new Error('Batas patch identitas core tidak ditemukan.')
emulator = emulator.replace(coreFile, coreFile + '\n            this.mainduluCoreFile = filename;')
// Report play/pause so the bridge gates autosave and the save-state overlay to running sessions.
const pauseToggle = '            this.paused = !this.paused;'
if (!emulator.includes(pauseToggle)) throw new Error('Batas patch laporan play/pause tidak ditemukan.')
emulator = emulator.replace(pauseToggle, `${pauseToggle}
            // maindulu: report running state to the bridge (save overlay + autosave gating).
            if (typeof window.EJS_onPlayPause === "function") window.EJS_onPlayPause(!this.paused);`)
await writeFile(join(target, 'data/src/emulator.js'), emulator)
let manager = await readFile(join(staging, 'data/src/GameManager.js'), 'utf8')
const mount = '            this.FS.mount(this.FS.filesystems.IDBFS, { autoPersist: true }, "/data/saves");'
if (!manager.includes(mount)) throw new Error('Batas patch IDBFS memory tidak ditemukan.')
manager = manager.replace(mount, '            if (this.EJS.config.mainduluMemorySaves) { resolve(); return; } // maindulu: MEMFS only, never import/persist shared IDBFS\n' + mount)
await writeFile(join(target, 'data/src/GameManager.js'), manager)
let loader = await readFile(join(staging, 'data/loader.js'), 'utf8')
loader = loader.replace('    config.disableDatabases = window.EJS_disableDatabases;', '    config.disableDatabases = window.EJS_disableDatabases;\n    config.mainduluMemorySaves = window.EJS_mainduluMemorySaves === true;')
await writeFile(join(target, 'data/loader.js'), loader)
const sources = await Promise.all(scripts.map(async name => name === 'emulator.js' ? emulator : name === 'GameManager.js' ? manager : readFile(join(staging, 'data/src', name), 'utf8')))
const result = await transform(sources.join('\n;\n'), { minify: true, legalComments: 'inline', target: 'es2020' })
await writeFile(join(target, 'data/emulator.min.js'), '/*! EmulatorJS v4.2.3, GPL-3.0-or-later. maindulu local-only patches; see /vendor/emulatorjs/4.2.3/LICENSE and third_party/emulatorjs. */\n' + result.code)
const builds = {}
for (const core of cores) for (const suffix of ['', '-legacy']) {
  const name = `${core}${suffix}-wasm.data`
  builds[name] = sha256(await readFile(join(target, 'data/cores', name)))
}
await writeFile(join(root, 'public/player/builds.json'), JSON.stringify({ engineVersion: version, runtimeBuild: sha256(result.code), cores: builds }, null, 2) + '\n')
await writeFile(join(sourceTarget, 'provenance.json'), JSON.stringify({ version, archive: '4.2.3.7z', sha256: hash, url: 'https://github.com/EmulatorJS/EmulatorJS/releases/download/v4.2.3/4.2.3.7z', cores, patches: ['Disable remote version checks', 'Fail locally instead of CDN fallback', 'Remove default public netplay URL', 'Add widescreen display toggle (Layar lebar) and bridge hook to Graphics Settings', 'Memory-only state store and save filesystem for account players; retain guest persistence', 'Expose selected core filename and publish build fingerprints', 'Report play/pause transitions to the bridge (EJS_onPlayPause) for autosave and overlay gating', 'Accept fully specified custom bottom-bar buttons through buildButtonOptions (bridge save-state overlay button)'] }, null, 2) + '\n')
console.log(`EmulatorJS ${version} siap: ${cores.length} core, varian normal + legacy, tanpa fallback CDN.`)
