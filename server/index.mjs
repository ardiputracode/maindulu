// No database/server dependencies are loaded by the static React build.
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('Backend maindulu memerlukan Node.js 24 atau lebih baru.')
  process.exitCode = 1
} else {
  let app
  try {
    const { createApp } = await import('./app.mjs')
    app = await createApp()
    const { host, port } = app.appConfig
    const address = await app.listen({ host, port })
    console.log(`maindulu berjalan di ${address}`)
    console.log('Akun lokal, save state server, dan sinkronisasi progres pada core terverifikasi tersedia. Mode tamu tetap memakai browser.')
    let closing = false
    const close = async () => {
      if (closing) return
      closing = true
      try { await app.close() }
      catch (error) { console.error(error.message); process.exitCode = 1 }
    }
    process.once('SIGINT', close)
    process.once('SIGTERM', close)
  } catch (error) {
    console.error(`Server gagal dimulai: ${error.message}`)
    if (app) await app.close()
    process.exitCode = 1
  }
}
