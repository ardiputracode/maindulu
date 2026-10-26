import { Readable } from 'node:stream'
import { openDatabase } from '../../server/database.mjs'
import { createCatalogStorage } from '../../server/catalog/storage.mjs'
import { createCatalogRepository } from '../../server/catalog/repository.mjs'

const [config, actor, kind] = JSON.parse(process.argv[2])
const db = await openDatabase(config.dataDir)
try {
  const storage = await createCatalogStorage(config)
  const repository = createCatalogRepository(db, storage)
  const stage = await storage.stage(kind, Readable.from([Buffer.from('concurrent archive bytes')]))
  const go = new Promise(resolve => process.once('message', resolve))
  process.send({ phase: 'ready' })
  await go
  try {
    const row = await repository.publish(kind, actor, { [kind === 'games' ? 'title' : 'name']: 'Concurrent', consoleId: 'nes', fileName: 'fixture.zip' }, stage)
    process.send({ phase: 'result', code: 'created', id: row.id })
  } catch (error) {
    if (!['CATALOG_DUPLICATE', 'CATALOG_RESTORE_REQUIRED'].includes(error.code)) throw error
    process.send({ phase: 'result', code: error.code, id: error.id })
  }
} finally { db.close(); process.disconnect() }
