import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export async function backendFixture(t) {
  // Keep unit fixtures outside Playwright's output directory: its startup
  // cleanup must not delete a running SQLite test when suites run in parallel.
  const output = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir()
  await mkdir(output, { recursive: true })
  const root = await mkdtemp(join(output, 'm2-unit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['dist/assets', 'dist/catalog', 'dist/games', 'dist/vendor', 'dist/player', 'public']) await mkdir(join(root, dir), { recursive: true })
  await writeFile(join(root, 'dist/index.html'), '<!doctype html><html><head><title>Fixture</title></head><body>frontend fixture</body></html>')
  await writeFile(join(root, 'dist/assets/app.js'), 'console.log("frontend")')
  await writeFile(join(root, 'dist/catalog/games.json'), '[]')
  await writeFile(join(root, 'dist/games/sample.chd'), Buffer.from('0123456789'))
  await writeFile(join(root, 'dist/vendor/sample.wasm'), Buffer.from([0, 97, 115, 109]))
  return root
}
