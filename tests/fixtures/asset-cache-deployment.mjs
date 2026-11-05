// Disposable subprocess only: the production app/config/asset routes are used
// unchanged. IPC observes transfers and performs graceful process shutdown.
import { createApp } from '../../server/app.mjs'
import { observeAssetTransfers } from '../browser/helpers/asset-transfers.ts'

let app
process.once('message', async ({ env, watched, port }) => {
  try {
    app = await createApp({ env })
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
