/* maindulu player bridge. All runtime requests are same-origin (also enforced by CSP). */
(() => {
  let sessionId = null
  let configured = false
  const urls = []
  let widescreenWanted = false
  let widescreenState = false
  let widescreenObserver = null
  let memorySaves = false
  let gameStarted = false
  // Save-state overlay bookkeeping: remember whether the game was running when
  // the host asked for a pause, so closing the overlay only resumes a game that
  // was actually playing (user-paused games stay paused).
  let overlayState = null
  let gameRunning = false
  let builds = null
  let progressEnabled = false
  let progressPath = null
  let progressLayout = null
  let progressBootError = ''
  function buildMetadata() {
    const file = window.EJS_emulator?.mainduluCoreFile
    const hash = builds?.cores?.[file]
    return memorySaves && typeof hash === 'string' ? { formatVersion: 1, engineVersion: builds.engineVersion, runtimeBuild: builds.runtimeBuild, coreBuild: hash, variant: file.includes('-legacy-') ? 'legacy' : 'normal' } : null
  }
  function checkProgressPath() {
    const gm = window.EJS_emulator?.gameManager
    if (!progressEnabled || !progressPath || gm?.getSaveFilePath() !== progressPath) throw new Error('Layout save core tidak cocok. Sinkronisasi dihentikan; ekspor save melalui emulator.')
    const folder = progressPath.slice(0, progressPath.lastIndexOf('/'))
    // Do not silently claim to synchronize cores that create extra card files.
    const extra = gm.FS.analyzePath(folder).exists ? gm.FS.readdir(folder).filter(name => name !== '.' && name !== '..' && `${folder}/${name}` !== progressPath) : []
    if (extra.length) throw new Error('Core menghasilkan berkas save tambahan. Cakupan layout belum didukung; ekspor cadangan sebelum keluar.')
    return gm
  }
  function syncHostFullscreen(fullscreen) {
    const e = window.EJS_emulator
    const buttons = e?.elements?.bottomBar?.fullscreen
    if (buttons) {
      buttons[0].style.display = fullscreen ? 'none' : ''
      buttons[1].style.display = fullscreen ? '' : 'none'
    }
    if (e?.isMobile) {
      try {
        if (fullscreen) screen.orientation.lock('landscape').catch(() => {})
        else screen.orientation.unlock()
      } catch { /* Orientation lock is optional. */ }
    }
    applyWidescreen()
  }
  const maxStateBytes = 64 * 1024 * 1024
  const send = (type, extra = {}) => parent.postMessage({ channel: 'maindulu:player', type, sessionId, ...extra }, location.origin)
  // An engine abort may emit later generic errors/rejections. Preserve the
  // actionable restore failure instead of replacing it with that fallout.
  const fail = message => send('error', { message: progressBootError || message })
  const localUrl = value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !/[\u0000-\u0020]/.test(value)

  function hideNativeStateSettings() {
    // EmulatorJS 4.2.3 uses this literal group title (not localized). Hide only
    // its gear-menu entry for everyone; leave native save/load buttons and the
    // internal System Save interval/default initialization untouched.
    const rows = window.EJS_emulator?.settingsMenu?.querySelectorAll('.ejs_settings_main_bar') || []
    for (const row of rows) {
      if (row.firstElementChild?.textContent.trim() === 'Save States') row.style.display = 'none'
    }
  }

  // "Layar lebar" (widescreen): the core's active 4:3 picture is centered inside
  // the canvas bitmap with black side bars. Stretching the bitmap horizontally
  // by playerAspect/gameAspect removes those bars without touching the engine,
  // the picture contents, or the input mapping; scaling follows the player box,
  // so narrow (phone-portrait) layouts stay neutral instead of cropping.
  function widescreenTransform() {
    const emulator = window.EJS_emulator
    if (!emulator?.canvas || !emulator?.gameManager?.getVideoDimensions) return null
    const parent = emulator.canvas.parentElement
    const box = parent?.getBoundingClientRect()
    if (!parent || !box.width || !box.height) return null
    const shown = box.width / box.height
    const aspect = Number(emulator.gameManager.getVideoDimensions('aspect')) || 4 / 3
    if (!(shown > aspect)) return null
    return { parent, scaleX: shown / aspect }
  }
  function observeWidescreen() {
    const emulator = window.EJS_emulator
    // The canvas is only attached to the DOM late during engine start; observing
    // while detached would throw and abort the start sequence.
    if (widescreenObserver || !emulator?.canvas?.parentElement) return
    widescreenObserver = new ResizeObserver(() => applyWidescreen())
    widescreenObserver.observe(emulator.canvas.parentElement)
  }
  function applyWidescreen() {
    const emulator = window.EJS_emulator
    if (!emulator?.canvas) return
    const canvas = emulator.canvas
    const on = widescreenWanted ? widescreenTransform() : null
    if (on) {
      canvas.style.transform = `scaleX(${on.scaleX})`
      on.parent.style.overflow = 'hidden'
      widescreenState = true
    } else if (widescreenState) {
      canvas.style.transform = ''
      if (canvas.parentElement) canvas.parentElement.style.overflow = ''
      widescreenState = false
    }
    if (widescreenWanted || widescreenState) observeWidescreen()
    else if (widescreenObserver) { widescreenObserver.disconnect(); widescreenObserver = null }
  }
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

  // No cookies, tokens or account IDs cross this bridge. HTTP belongs to React.
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== parent || event.data?.channel !== 'maindulu:host' || event.data.sessionId !== sessionId || !memorySaves) return
    const { type, requestId } = event.data
    if (type === 'fullscreen-state' && typeof event.data.fullscreen === 'boolean') {
      syncHostFullscreen(event.data.fullscreen)
      return
    }
    if (!gameStarted) return
    // Save-state overlay pause: pause only if started, and remember whether the
    // game was running so closing the overlay (resume-session) restores exactly
    // that condition. While the overlay wants a pause, state RPCs must not
    // resume the game after exporting/importing.
    if (type === 'pause-session') {
      const e = window.EJS_emulator
      if (e?.gameManager && e.started && !overlayState) { overlayState = { resume: !e.paused }; e.pause() }
      return
    }
    if (type === 'resume-session') {
      const resume = overlayState?.resume === true
      overlayState = null
      if (resume) window.EJS_emulator?.play?.()
      return
    }
    if (!['export-state', 'import-state', 'export-progress'].includes(type) || typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId)) return
    try {
      const e = window.EJS_emulator
      if (type === 'export-progress') {
        const gm = checkProgressPath()
        const bytes = gm.getSaveFile()
        checkProgressPath()
        if (bytes !== null && (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 8 * 1024 * 1024 - 4096)) throw new Error('Ukuran save dalam game tidak valid.')
        send('state-result', { requestId, bytes })
        return
      }
      if (!e.gameManager.supportsStates()) throw new Error('Core tidak mendukung save state.')
      const paused = e.paused
      e.pause()
      try {
        if (type === 'export-state') {
          const bytes = e.gameManager.getState()
          if (!(bytes instanceof Uint8Array) || bytes.length < 32 || bytes.length > maxStateBytes) throw new Error('Ukuran state tidak valid atau melebihi batas player.')
          send('state-result', { requestId, bytes })
        } else {
          const bytes = event.data.bytes
          if (!(bytes instanceof Uint8Array) || bytes.length < 32 || bytes.length > maxStateBytes || new TextDecoder().decode(bytes.subarray(0, 7)) !== 'RASTATE') throw new Error('Format state tidak valid.')
          e.gameManager.loadState(bytes)
          // Engine 4.2.3 does not expose a reliable deserialization acknowledgment.
          send('state-result', { requestId, applied: true })
        }
      } finally { if (!paused && !overlayState) e.play() }
    } catch (error) { send('state-result', { requestId, error: error instanceof Error ? error.message : 'Operasi state gagal.' }) }
  })

  window.addEventListener('message', async event => {
    if (event.origin !== location.origin || event.source !== parent || event.data?.channel !== 'maindulu:host' || event.data.type !== 'configure' || configured) return
    const config = event.data
    if (typeof config.sessionId !== 'string' || !allowedCores.includes(config.core) || !config.game || typeof config.game.id !== 'string') return
    sessionId = config.sessionId; configured = true
    try {
      memorySaves = config.memorySaves === true
      progressEnabled = memorySaves && config.gameSaves === true && ['fceumm', 'pcsx_rearmed'].includes(config.core)
      progressLayout = config.core === 'fceumm' ? 'nes-sram-v1' : 'ps1-active-memcard-v1'
      if (progressEnabled && config.initialProgress !== null && (!(config.initialProgress?.bytes instanceof Uint8Array) || !config.initialProgress.bytes.length || config.initialProgress.bytes.length > 8 * 1024 * 1024 || config.initialProgress.metadata?.layout !== progressLayout)) throw new Error('Pemulihan progres awal tidak valid.')
      if (memorySaves) {
        const response = await fetch('/player/builds.json', { cache: 'no-store' })
        if (!response.ok) throw new Error('Metadata build engine tidak tersedia.')
        builds = await response.json()
      }
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
      window.EJS_mainduluMemorySaves = memorySaves
      window.EJS_disableLocalStorage = memorySaves
      window.EJS_mainduluBeforeBoot = progressEnabled ? e => {
        try {
          const metadata = buildMetadata()
          if (!metadata) throw new Error('Metadata core tidak tersedia untuk pemulihan progres.')
          const initial = config.initialProgress
          if (initial && ['formatVersion', 'engineVersion', 'coreBuild', 'runtimeBuild', 'variant'].some(key => initial.metadata[key] !== metadata[key])) throw new Error('Versi engine/core progres berbeda. Game ditahan agar save tidak tertimpa; unduh cadangan dari pengelola progres.')
          // fileName is final only after downloadRom/extraction. Unlike state
          // names, server PS1 names may originate from the CHD URL.
          const name = e.fileName
          if (typeof name !== 'string' || !/^[^/\\\x00-\x1f]{1,240}$/.test(name) || name === '.' || name === '..') throw new Error('Nama ROM tidak cocok dengan layout progres yang didukung.')
          const stem = name.replace(/\.[^.]+$/, '')
          progressPath = `/data/saves/${config.core === 'fceumm' ? 'FCEUmm' : 'PCSX-ReARMed'}/${stem}.srm`
          if (initial) e.gameManager.writeFile(progressPath, initial.bytes)
        } catch (error) { progressBootError = error instanceof Error ? error.message : 'Pemulihan progres gagal.'; fail(progressBootError); throw error }
      } : undefined
      window.EJS_CacheLimit = 0
      window.EJS_defaultOptions = { 'save-state-location': 'browser', ejs_threads: 'disabled', mainduluWidescreen: config.widescreen === true ? 'enabled' : 'disabled' }
      window.EJS_hideSettings = memorySaves ? ['ejs_threads', 'save-state-location', 'save-state-slot'] : ['ejs_threads']
      // Bottom toolbar: account sessions get a "Save state server" button between
      // "Import Save File" and the spacer. The engine adds every `custom: true`
      // entry to the bar, so the overlay button never touches game-level
      // Save State buttons (hidden above for memory sessions).
      window.EJS_Buttons = {
        netplay: false,
        gamepad: true,
        exitEmulation: false,
        ...(memorySaves ? {
          saveState: false,
          loadState: false,
          quickSave: false,
          quickLoad: false,
          loadSavFiles: false,
          mainduluServerState: {
            visible: true,
            custom: true,
            icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>',
            displayName: 'Save state server',
            callback: () => send('state-server')
          }
        } : {})
      }
      window.EJS_ready = () => {
        hideNativeStateSettings()
        // Account dialogs live in React. Fullscreen the host's shared shell so
        // the iframe, save overlay and autosave notices stay in the same layer.
        // Keep guest fullscreen behavior unchanged and avoid editing the engine.
        if (memorySaves) window.EJS_emulator.toggleFullscreen = fullscreen => send('fullscreen-request', { fullscreen: fullscreen === true })
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
        window.EJS_emulator.startGameError = message => { fail(progressBootError || String(message)); return original(message) }
      }
      window.EJS_onGameStart = () => {
        // The engine rebuilds its settings menu when the core starts.
        hideNativeStateSettings()
        gameStarted = true
        gameRunning = true
        applyWidescreen()
        send('session-running', { running: true })
        const metadata = buildMetadata()
        let progressReady = false
        if (progressEnabled) {
          try {
            // getSaveFilePath is defined after boot. A mismatch never enables uploads.
            const gm = window.EJS_emulator.gameManager
            if (gm.getSaveFilePath() !== progressPath) throw new Error('Path save aktual berbeda dari layout pemulihan. Sinkronisasi dihentikan; ekspor cadangan.')
            progressReady = true
          } catch (error) { send('progress-error', { message: error instanceof Error ? error.message : 'Layout progres tidak didukung.' }) }
        }
        send('started', { metadata, progressReady, supportsStates: window.EJS_emulator.gameManager.supportsStates(), browserKeys: memorySaves ? { state: window.EJS_emulator.getBaseFileName() + '.state', progress: ['fceumm', 'pcsx_rearmed'].includes(config.core) ? window.EJS_emulator.gameManager.getSaveFilePath() : null } : null })
      }
      // Toggle from the engine menu (Settings → Graphics → Layar lebar).
      window.EJS_onWidescreen = value => {
        widescreenWanted = value === true
        applyWidescreen()
        send('display', { widescreen: widescreenWanted })
      }
      // Engine patch reports play/pause transitions (toolbar button, overlay, RPC).
      window.EJS_onPlayPause = running => {
        gameRunning = running === true
        send('session-running', { running: gameRunning })
      }
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
