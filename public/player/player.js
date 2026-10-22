/* maindulu player bridge. All runtime requests are same-origin (also enforced by CSP). */
(() => {
  let sessionId = null
  let configured = false
  const urls = []
  const send = (type, extra = {}) => parent.postMessage({ channel: 'maindulu:player', type, sessionId, ...extra }, location.origin)
  const fail = message => send('error', { message })
  const localUrl = value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !/[\u0000-\u0020]/.test(value)
  const allowedCores = ['fceumm', 'snes9x', 'gambatte', 'mgba', 'genesis_plus_gx', 'pcsx_rearmed']
  function blobUrl(blob) { const url = URL.createObjectURL(blob); urls.push(url); return url }
  async function checkServerAsset(url, label) {
    const response = await fetch(url, { method: 'HEAD' })
    if (!response.ok) throw new Error(`${label} server tidak ditemukan atau tidak bisa dibaca (HTTP ${response.status}). Periksa manifest dan berkasnya.`)
    if ((response.headers.get('content-type') || '').includes('text/html')) throw new Error(`${label} server mengembalikan halaman HTML, bukan file game/firmware. Periksa path dan konfigurasi hosting.`)
    if (response.headers.get('content-length') === '0') throw new Error(`${label} server kosong. Pilih berkas lain.`)
  }

  // The v4.2.3 raw-BIOS path derives the firmware name from its URL. Wrap a local
  // raw BIOS in a stored ZIP so its original, core-required filename is preserved.
  async function biosArchive(file) {
    if (/\.(zip|7z|rar)$/i.test(file.name)) return file
    const bytes = new Uint8Array(await file.arrayBuffer())
    const name = new TextEncoder().encode(file.name.replace(/[^a-zA-Z0-9_.-]/g, '_'))
    let crc = 0xffffffff
    for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
    crc = (crc ^ 0xffffffff) >>> 0
    const header = new Uint8Array(30 + name.length)
    const h = new DataView(header.buffer)
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true)
    h.setUint32(14, crc, true); h.setUint32(18, bytes.length, true); h.setUint32(22, bytes.length, true); h.setUint16(26, name.length, true); header.set(name, 30)
    const central = new Uint8Array(46 + name.length)
    const c = new DataView(central.buffer)
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true)
    c.setUint32(16, crc, true); c.setUint32(20, bytes.length, true); c.setUint32(24, bytes.length, true); c.setUint16(28, name.length, true); central.set(name, 46)
    const end = new Uint8Array(22), e = new DataView(end.buffer)
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, 1, true); e.setUint16(10, 1, true); e.setUint32(12, central.length, true); e.setUint32(16, header.length + bytes.length, true)
    return new Blob([header, bytes, central, end], { type: 'application/zip' })
  }

  window.addEventListener('message', async event => {
    if (event.origin !== location.origin || event.source !== parent || event.data?.channel !== 'maindulu:host' || event.data.type !== 'configure' || configured) return
    const config = event.data
    if (typeof config.sessionId !== 'string' || !allowedCores.includes(config.core) || !config.game || typeof config.game.id !== 'string') return
    sessionId = config.sessionId; configured = true
    try {
      if (!(config.rom instanceof Blob) && !localUrl(config.game.url)) throw new Error('Sumber ROM tidak valid. Pilih ROM kembali.')
      if (config.biosUrl && !localUrl(config.biosUrl)) throw new Error('Sumber BIOS server tidak valid.')
      if (!(config.rom instanceof Blob)) await checkServerAsset(config.game.url, 'ROM')
      if (config.biosUrl) await checkServerAsset(config.biosUrl, 'BIOS')
      window.EJS_player = '#game'
      window.EJS_core = config.core
      window.EJS_gameUrl = config.rom instanceof Blob ? blobUrl(config.rom) : config.game.url
      window.EJS_biosUrl = config.bios instanceof File ? blobUrl(await biosArchive(config.bios)) : config.biosUrl || ''
      window.EJS_gameName = `${config.core}-${config.game.id}`
      window.EJS_pathtodata = '/vendor/emulatorjs/4.2.3/data/'
      window.EJS_color = '#a9ecc3'
      window.EJS_backgroundColor = '#080e0b'
      window.EJS_startButtonName = 'Mulai bermain'
      window.EJS_startOnLoaded = false
      window.EJS_volume = Math.max(0, Math.min(1, Number(config.volume) || 0))
      window.EJS_threads = false
      window.EJS_language = 'en-US'
      window.EJS_disableAutoLang = false
      window.EJS_noAutoFocus = false
      // Never persist a user's raw ROM/BIOS. Engine states remain separate.
      window.EJS_disableDatabases = true
      window.EJS_CacheLimit = 0
      window.EJS_defaultOptions = { 'save-state-location': 'browser', ejs_threads: 'disabled' }
      window.EJS_hideSettings = ['ejs_threads']
      window.EJS_Buttons = { netplay: false, gamepad: true, exitEmulation: false }
      window.EJS_ready = () => {
        const startButton = document.querySelector('.ejs_start_button')
        if (startButton) {
          startButton.setAttribute('role', 'button')
          startButton.setAttribute('tabindex', '0')
          startButton.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); startButton.click() }
          })
          startButton.addEventListener('click', () => send('starting'), { once: true })
        }
        send('loaded')
        const original = window.EJS_emulator.startGameError.bind(window.EJS_emulator)
        window.EJS_emulator.startGameError = message => { fail(String(message)); return original(message) }
      }
      window.EJS_onGameStart = () => send('started')
      const script = document.createElement('script')
      script.src = '/vendor/emulatorjs/4.2.3/data/loader.js'
      script.onerror = () => fail('Loader lokal tidak ditemukan. Periksa folder vendor/emulatorjs/4.2.3/data.')
      document.head.appendChild(script)
    } catch (error) { fail(error instanceof Error ? error.message : 'Player gagal disiapkan.') }
  })
  window.addEventListener('error', event => fail(event.message || 'Terjadi kesalahan pada engine. Periksa format ROM dan BIOS.'))
  window.addEventListener('unhandledrejection', event => {
    const message = event.reason?.message || ''
    // Screen wake lock is optional and is denied in hidden/background tabs.
    // Do not obscure an otherwise running game with this browser-policy warning.
    if (/wake\s?lock/i.test(message)) { event.preventDefault(); return }
    fail(message || 'File atau core tidak dapat dimuat. Periksa format dan kelengkapan berkas.')
  })
  window.addEventListener('pagehide', () => { for (const url of urls) URL.revokeObjectURL(url) })
  send('ready')
})()
