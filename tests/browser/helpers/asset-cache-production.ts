import { build } from 'esbuild'
import { mkdtemp, rm, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, freemem, totalmem, platform, release } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { DatabaseSync } from 'node:sqlite'
import type { Page, TestInfo } from '@playwright/test'
import { createApp } from '../../../server/app.mjs'
import { createCatalogStorage } from '../../../server/catalog/storage.mjs'
import { createCatalogRepository } from '../../../server/catalog/repository.mjs'
import { catalogDto } from '../../../server/catalog/queries.mjs'
import type { CatalogEntry } from '../../../src/lib/catalog'
import { observeAssetTransfers } from './asset-transfers'
import type * as Harness from '../../fixtures/asset-cache-production'

declare global { interface Window { productionCacheTest: typeof Harness; m5Pending: ReturnType<typeof Harness.run> } }
export const CHUNK = 4 * 1024 * 1024
export async function productionFixture() {
  const parent = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir()
  const folder = await mkdtemp(join(parent, 'asset-cache-m5-'))
  const app = await createApp({ env: { MAIN_DULU_DATA_DIR: join(folder, 'data') } })
  try {
    const bundle = (await build({ entryPoints: ['tests/fixtures/asset-cache-production.ts'], bundle: true, write: false,
      format: 'iife', globalName: 'productionCacheTest', target: 'es2022', platform: 'browser' })).outputFiles[0].text
    const db = app.getDecorator<DatabaseSync>('database'), actor = randomUUID()
    db.prepare('INSERT INTO users (id, username, password_hash, recovery_code_hash, created_at, role) VALUES (?, ?, ?, ?, ?, ?)')
      .run(actor, 'm5_admin', 'test-only', 'test-only', Date.now(), 'admin')
    const storage = await createCatalogStorage(app.getDecorator('appConfig'), db), repo = createCatalogRepository(db, storage)
    const watched = new Set<string>()
    let phase = 'setup'
    const transfers = observeAssetTransfers(app.server, watched, () => phase)
    await app.listen({ host: '0.0.0.0', port: 0 })
    const bound = app.server.address()
    if (!bound || typeof bound === 'string') throw Error('Missing M5 server port')
    return { app, db, storage, repo, actor, folder, bundle, transfers, port: bound.port,
      address: `http://127.0.0.1:${bound.port}`, phase: (value: string) => { phase = value },
      async publish(size: number, kind: 'games' | 'bios' = 'games', bytes?: Uint8Array): Promise<CatalogEntry> {
        const hash = createHash('sha256')
        async function* source() {
          // Deterministic offset-sensitive pattern; at most 1 MiB in Node RAM.
          for (let offset = 0; offset < size;) {
            const chunk = bytes ? Buffer.from(bytes) : Buffer.alloc(Math.min(1024 * 1024, size - offset))
            if (!bytes) for (let i = 0; i < chunk.length; i++) chunk[i] = ((offset + i) * 31 + Math.floor((offset + i) / 65536)) & 255
            hash.update(chunk); offset += chunk.length; yield chunk
          }
        }
        const row = await repo.publish(kind, actor, { ...(kind === 'games' ? { title: `M5 ROM ${size}` } : { name: `M5 BIOS ${size}` }),
          consoleId: 'nes', fileName: kind === 'games' ? `synthetic-${size}.nes` : `synthetic-${size}.bin` }, await storage.stage(kind, Readable.from(source())))
        if (row.sha256 !== hash.digest('hex')) throw Error('M5 fixture SHA mismatch')
        const entry = catalogDto(kind, row) as CatalogEntry
        watched.add(entry.url)
        return entry
      },
      async close() { await app.close(); await rm(folder, { recursive: true, force: true }) },
    }
  } catch (error) { await app.close(); await rm(folder, { recursive: true, force: true }); throw error }
}
export type ProductionFixture = Awaited<ReturnType<typeof productionFixture>>
export async function instrument(page: Page, fixture: ProductionFixture, origin = fixture.address) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await cdp.send('Performance.enable')
  await page.goto(origin + '/')
  await page.addScriptTag({ content: fixture.bundle })
  return cdp
}
export async function preflight(folder: string) {
  const disk = await statfs(folder), freeDisk = disk.bavail * disk.bsize
  const resource = { freeDisk, freeMemory: freemem(), totalMemory: totalmem(), os: `${platform()} ${release()}`, node: process.version }
  if (freeDisk < 6 * 1024 ** 3 || resource.freeMemory < 2 * 1024 ** 3) {
    throw Error(`M5 large suite requires >=6 GiB free disk and >=2 GiB available RAM: ${JSON.stringify(resource)}`)
  }
  return resource
}
export async function attachJson(info: TestInfo, name: string, value: unknown) {
  const path = info.outputPath(name + '.json')
  await writeFile(path, JSON.stringify(value, null, 2))
  await info.attach(name + '.json', { path, contentType: 'application/json' })
}
