import { createHash } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = '0.24.0'
const base = `https://github.com/DevYukine/rom-converto/releases/download/v${version}`

// Pinned release assets. Keep every hash in one place so Docker and local
// operators can verify the same bytes. `key` is also the vendor directory.
const assets = Object.freeze({
  'win32-x64': { asset: 'rom-converto-cli-windows-x64.exe', file: 'rom-converto.exe', sha256: 'bee0ee3bac4183f8de3c9fd00fde3da6f73d92a2af2db203b525ea421d7ea5a4' },
  'linux-x64': { asset: 'rom-converto-cli-linux-x64', file: 'rom-converto', sha256: '0d4abd56cfec477ff447f68b656d45ca48f670f464363bca2d895b1eee2c356d' },
  'linux-x64-musl': { asset: 'rom-converto-cli-linux-x64-musl', file: 'rom-converto', sha256: '67964054931f7e74848bfe7b54ff1f0cacdc25596c29e3a79876f76e0f2407a8' },
  'linux-arm64': { asset: 'rom-converto-cli-linux-arm64', file: 'rom-converto', sha256: '990286bc3367342b0e04ab6dd0d28d8e95c3133ac2b4c5d6440a119e541b0b43' },
  'linux-arm7': { asset: 'rom-converto-cli-linux-arm7', file: 'rom-converto', sha256: '00b4cf7a454ae4539459cc5f908f3b42603b59b1035b8b046c6ef5ae1982247f' },
  'darwin-arm64': { asset: 'rom-converto-cli-macos-arm64', file: 'rom-converto', sha256: '4de8bbc96ddef23d8ed823ce42efcd64425c7885c4fe25058a2376ab42053aee' },
  'darwin-x64': { asset: 'rom-converto-cli-macos-x64', file: 'rom-converto', sha256: '8bf11dd14c920db3ed9d00782a0ab018cc3d1e316b63d0deb2ff7b50d19e85f9' },
})

const defaultKey = () => {
  if (process.platform === 'linux' && process.arch === 'arm') return 'linux-arm7'
  return `${process.platform}-${process.arch}`
}
const key = process.argv[2] || defaultKey()
const entry = assets[key]
if (!entry) {
  console.error(`Target tidak dikenal: ${key}. Pilihan: ${Object.keys(assets).join(', ')}`)
  process.exitCode = 1
} else {
  const response = await fetch(`${base}/${entry.asset}`, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Unduhan rom-converto gagal (${response.status}).`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== entry.sha256) throw new Error(`SHA-256 rom-converto ${key} tidak cocok. Proses dihentikan.`)
  const directory = join(root, 'vendor', 'rom-converto', key)
  const target = join(directory, entry.file)
  await mkdir(directory, { recursive: true })
  await writeFile(target, bytes, { mode: 0o755 })
  if (process.platform !== 'win32') await chmod(target, 0o755)
  console.log(`rom-converto ${version} (${key}) siap: vendor/rom-converto/${key}/${entry.file}`)
}
