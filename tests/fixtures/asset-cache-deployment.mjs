// Disposable subprocess only: the production app/config/asset routes are used
// unchanged. IPC observes transfers and performs graceful process shutdown.
import { createApp } from '../helpers/gated-backend.mjs'
import { networkInterfaces } from 'node:os'
import { observeAssetTransfers } from '../browser/helpers/asset-transfers.ts'

let app
process.once('message', async ({ env, watched, port }) => {
  try {
    const origins = [`http://127.0.0.1:${port}`, `http://127.0.0.2:${port}`, `http://localhost:${port}`, ...Object.values(networkInterfaces()).flat().filter(value => value?.family === 'IPv4' && !value.internal).map(value => `http://${value.address}:${port}`)]
    app = await createApp({ env: { ...env, MAIN_DULU_PUBLIC_ORIGINS: origins.join(','), MAIN_DULU_ALLOW_INSECURE_HTTP: 'true' } })
    const transfers = observeAssetTransfers(app.server, new Set(watched), () => 'deployment')
    await app.listen({ host: '0.0.0.0', port })
    process.on('message', async message => {
      if (message.type === 'transfers') process.send({ type: 'transfers', records: transfers })
      if (message.type === 'stop') {
        await app.close()
        process.disconnect()
      }
    })
    process.send({ type: 'ready', port: app.server.address().port })
  } catch (error) {
    await app?.close()
    process.send({ type: 'error', message: error.stack ?? String(error) }, () => process.disconnect())
    process.exitCode = 1
  }
})
