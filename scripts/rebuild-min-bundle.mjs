// One-off: rebuild data/emulator.min.js and builds.json from the already-patched
// vendored sources, mirroring scripts/vendor-engine.mjs (which requires the
// pristine 4.2.3 archive; the vendored src here already carries every patch).
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { transform } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'public/vendor/emulatorjs/4.2.3')
const scripts = ['emulator.js', 'nipplejs.js', 'shaders.js', 'storage.js', 'gamepad.js', 'GameManager.js', 'socket.io.min.js', 'compression.js']
const sources = await Promise.all(scripts.map(name => readFile(join(target, 'data', 'src', name), 'utf8')))
const result = await transform(sources.join('\n;\n'), { minify: true, legalComments: 'inline', target: 'es2020' })
await writeFile(join(target, 'data', 'emulator.min.js'), '/*! EmulatorJS v4.2.3, GPL-3.0-or-later. maindulu local-only patches; see /vendor/emulatorjs/4.2.3/LICENSE and third_party/emulatorjs. */\n' + result.code)
const builds = JSON.parse(await readFile(join(root, 'public/player/builds.json'), 'utf8'))
builds.runtimeBuild = createHash('sha256').update(result.code).digest('hex')
await writeFile(join(root, 'public/player/builds.json'), JSON.stringify(builds, null, 2) + '\n')
console.log('emulator.min.js direbuild, runtimeBuild =', builds.runtimeBuild)
