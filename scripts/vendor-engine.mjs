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
await writeFile(join(target, 'data/src/emulator.js'), emulator)
const sources = await Promise.all(scripts.map(async name => name === 'emulator.js' ? emulator : readFile(join(staging, 'data/src', name), 'utf8')))
const result = await transform(sources.join('\n;\n'), { minify: true, legalComments: 'inline', target: 'es2020' })
await writeFile(join(target, 'data/emulator.min.js'), '/*! EmulatorJS v4.2.3, GPL-3.0-or-later. maindulu local-only patches; see /vendor/emulatorjs/4.2.3/LICENSE and third_party/emulatorjs. */\n' + result.code)
await writeFile(join(sourceTarget, 'provenance.json'), JSON.stringify({ version, archive: '4.2.3.7z', sha256: hash, url: 'https://github.com/EmulatorJS/EmulatorJS/releases/download/v4.2.3/4.2.3.7z', cores, patches: ['Disable remote version checks', 'Fail locally instead of CDN fallback', 'Remove default public netplay URL'] }, null, 2) + '\n')
console.log(`EmulatorJS ${version} siap: ${cores.length} core, varian normal + legacy, tanpa fallback CDN.`)
