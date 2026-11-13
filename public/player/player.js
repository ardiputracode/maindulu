/* maindulu player bridge. All runtime requests are same-origin (also enforced by CSP). */
(() => {
  let sessionId = null
  let configured = false
  const urls = []
  const lifecycle = new AbortController()
  let disposed = false
  let romInput = null
  let assetConfig = null
  function releaseAssets() {
    romInput?.release(); romInput = null
    if (window.EJS_emulator?.config?.gameUrl instanceof File) window.EJS_emulator.config.gameUrl = undefined
    window.EJS_gameUrl = undefined
    window.EJS_biosUrl = undefined
    if (assetConfig) {
      assetConfig.preparedRom = undefined; assetConfig.preparedBios = undefined
      assetConfig.rom = undefined; assetConfig.bios = undefined
      assetConfig.initialProgress = null
    }
    for (const url of urls.splice(0)) URL.revokeObjectURL(url)
  }
  let widescreenWanted = false
  let widescreenState = false
  let widescreenObserver = null
  let memorySaves = false
  let hostFullscreen = false
  let hostFullscreenActive = false
  let gameStarted = false
  // Save-state overlay bookkeeping: remember whether the game was running when
  // the host asked for a pause, so closing the overlay only resumes a game that
  // was actually playing (user-paused games stay paused).
  let overlayState = null
  let gameRunning = false
  let supportsStates = false
  let exitBusy = false
  let guestStateAvailable = false
  let guestStateSize = 0
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
    hostFullscreenActive = fullscreen
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
  const fail = message => { releaseAssets(); if (!disposed) send('error', { message: progressBootError || message }) }
  const localUrl = value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !/[\u0000-\u0020]/.test(value)

  // Guest Save & exit uses its own versioned IndexedDB key. The native
  // `.state` key stays untouched so the engine's own Save/Load buttons keep
  // working independently.
  const guestExitSuffix = '.maindulu-exit.v1.state'
  function guestStateKey() {
    const base = window.EJS_emulator?.getBaseFileName?.()
    if (typeof base !== 'string' || !base || base.length > 240) throw new Error('Identitas simpanan browser belum siap. Mulai game terlebih dahulu.')
    return base + guestExitSuffix
  }
  function validStateBytes(bytes) {
    return bytes instanceof Uint8Array && bytes.length >= 32 && bytes.length <= maxStateBytes && new TextDecoder().decode(bytes.subarray(0, 7)) === 'RASTATE'
  }
  function sameBytes(a, b) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }
  // iOS/WebKit dapat men-suspend AudioContext setelah main thread diblokir
  // operasi state besar (khususnya PS1). Resume dari gestur pengguna dan
  // setelah load; kalau tetap suspended, emulasi bisa tampak membeku.
  function audioContexts() {
    const sources = window.EJS_emulator?.Module?.AL?.currentCtx?.sources
    if (!sources || typeof sources.forEach !== 'function') return []
    const contexts = []
    sources.forEach(source => {
      const context = source?.gain?.context
      if (context && typeof context.resume === 'function' && !contexts.includes(context)) contexts.push(context)
    })
    return contexts
  }
  function resumeAudio() {
    for (const context of audioContexts()) {
      try { if (context.state !== 'running') void context.resume().catch(() => {}) } catch { /* optional */ }
    }
  }
  // WebGL context loss is common on iOS under memory pressure from large state
  // loads; EmulatorJS 4.2.3 has no recovery, so surface it and try to resume.
  let graphicsLossTimer = null
  function watchGraphicsContext() {
    const canvas = window.EJS_emulator?.canvas
    if (!canvas || canvas.dataset.mainduluGraphicsWatch === '1') return
    canvas.dataset.mainduluGraphicsWatch = '1'
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault()
      clearTimeout(graphicsLossTimer)
      graphicsLossTimer = setTimeout(() => send('error', {
        message: 'Konteks grafis berhenti (umum terjadi di iOS saat memuat state PS1). Buka kembali game; state server dan progres tetap tersimpan.'
      }), 2500)
    })
    canvas.addEventListener('webglcontextrestored', () => {
      clearTimeout(graphicsLossTimer)
      resumeAudio()
      try { window.EJS_emulator?.play?.() } catch { /* recover on next input */ }
    })
  }
  // Loading is not proof the core resumed. Verify frame progress and nudge
  // audio/play before reporting a persistent stall instead of freezing silently.
  let runningCheck = 0
  async function ensureRunningAfterLoad(e) {
    const gameManager = e?.gameManager
    if (!gameManager || typeof gameManager.getFrameNum !== 'function') return
    const token = ++runningCheck
    const readFrame = () => { try { return gameManager.getFrameNum() } catch { return null } }
    const first = readFrame()
    const stillStalled = async wait => {
      await new Promise(resolve => setTimeout(resolve, wait))
      return token === runningCheck && e?.paused !== true && first !== null && readFrame() === first
    }
    if (!await stillStalled(1200)) return
    resumeAudio()
    try { e.play?.() } catch { /* noop */ }
    if (!await stillStalled(1200)) return
    try { if (!e.paused) { e.pause(); await new Promise(resolve => setTimeout(resolve, 0)) } e.play?.() } catch { /* noop */ }
    if (!await stillStalled(1200)) return
    send('error', { message: 'State berhasil dimuat, tetapi emulasi tidak berjalan lagi di browser ini. Buka kembali game; state server tetap tersimpan.' })
  }
  function resumePlayback(e) {
    if (!e) return
    resumeAudio()
    try { e.play?.() } catch { /* noop */ }
    void ensureRunningAfterLoad(e)
  }
  async function readGuestState() {
    const store = window.EJS_emulator?.storage?.states
    if (!store || typeof store.get !== 'function') throw new Error('Penyimpanan state browser tidak tersedia.')
    const value = await store.get(guestStateKey())
    if (value === undefined || value === null) return null
    if (!validStateBytes(value)) throw new Error('Simpanan Simpan & keluar di browser tidak valid. State tidak dimuat.')
    return value
  }
  async function writeGuestState(bytes) {
    if (!window.indexedDB) throw new Error('Penyimpanan browser tidak tersedia. State tidak tersimpan.')
    const store = window.EJS_emulator?.storage?.states
    if (!store || typeof store.put !== 'function') throw new Error('Penyimpanan state browser tidak tersedia. State tidak tersimpan.')
    const key = guestStateKey()
    let timer
    try {
      // EJS_STORAGE.put can resolve late when IndexedDB never opens; bound the
      // wait so the host can report a real failure instead of hanging.
      await Promise.race([store.put(key, bytes), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Penyimpanan browser tidak merespons. State belum tersimpan.')), 10000) })])
    } finally { clearTimeout(timer) }
    const read = await readGuestState()
    if (!read || !sameBytes(read, bytes)) throw new Error('Verifikasi simpanan browser gagal. State belum tersimpan.')
  }
  function menuButton(label) {
    const menu = window.EJS_emulator?.elements?.menu
    return menu ? [...menu.querySelectorAll('button.ejs_menu_button')].find(button => button.textContent.trim() === label) : null
  }
  function updateExitButtons() {
    const exitButton = menuButton('Keluar game')
    if (exitButton) exitButton.disabled = exitBusy
    const saveExit = menuButton('Simpan & keluar')
    if (saveExit) {
      saveExit.disabled = exitBusy || !gameStarted || !supportsStates
      saveExit.title = !gameStarted ? 'Mulai game terlebih dahulu.' : !supportsStates ? 'Core ini tidak mendukung save state.' : exitBusy ? 'Operasi simpan sedang berjalan.' : 'Simpan state lalu keluar ke beranda.'
    }
    const loadGuest = menuButton('Muat simpanan terakhir')
    if (loadGuest) {
      loadGuest.disabled = exitBusy || !gameStarted || !supportsStates || !guestStateAvailable
      loadGuest.title = !guestStateAvailable ? 'Belum ada simpanan Simpan & keluar di browser ini.' : 'Muat state Simpan & keluar dari browser ini.'
    }
  }
  // Custom buttons are appended before the toolbar spacer, but the fullscreen
  // pair is created later. Move our nodes immediately before the visible
  // fullscreen control; moving an existing node is idempotent.
  function positionExitButtons() {
    const enter = window.EJS_emulator?.elements?.bottomBar?.fullscreen?.[0]
    const parent = enter?.parentElement
    if (!parent) return
    for (const label of ['Muat simpanan terakhir', 'Keluar game', 'Simpan & keluar']) {
      const button = menuButton(label)
      if (button && button.parentElement === parent && button.nextElementSibling !== enter) parent.insertBefore(button, enter)
    }
  }
  async function refreshGuestStatus() {
    if (memorySaves || !gameStarted) { guestStateAvailable = false; guestStateSize = 0; updateExitButtons(); return }
    try {
      const bytes = await readGuestState()
      guestStateAvailable = !!bytes
      guestStateSize = bytes?.length ?? 0
    } catch {
      guestStateAvailable = false
      guestStateSize = 0
    }
    updateExitButtons()
    send('exit-capability', { supportsStates, guest: true, guestAvailable: guestStateAvailable, guestSize: guestStateSize })
  }

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
    const response = await fetch(url, { method: 'HEAD', signal: lifecycle.signal })
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
  window.addEventListener('message', async event => {
    if (event.origin !== location.origin || event.source !== parent || event.data?.channel !== 'maindulu:host' || event.data.sessionId !== sessionId || !configured) return
    const { type, requestId } = event.data
    if (type === 'fullscreen-state' && hostFullscreen && typeof event.data.fullscreen === 'boolean') {
      syncHostFullscreen(event.data.fullscreen)
      return
    }
    // The host disables toolbar controls while a save/exit operation owns the
    // session. Validation still happens on the host regardless of button state.
    if (type === 'exit-state') {
      exitBusy = event.data.busy === true
      updateExitButtons()
      return
    }
    // Pause/resume bookkeeping is shared by account and guest sessions. Only
    // the game's actual running state decides whether resume is allowed.
    if (type === 'pause-session') {
      if (!gameStarted) return
      const e = window.EJS_emulator
      if (e?.gameManager && e.started && !overlayState) { overlayState = { resume: !e.paused }; e.pause() }
      return
    }
    if (type === 'resume-session') {
      if (!gameStarted) return
      const resume = overlayState?.resume === true
      overlayState = null
      if (resume) resumePlayback(window.EJS_emulator)
      return
    }
    if (!gameStarted) return
    if (!memorySaves) {
      // Guest browser-state RPCs are rejected outright for account sessions,
      // and account state RPCs never fall back to the guest store.
      if (!['guest-export-state', 'guest-commit-state', 'guest-load-state', 'guest-state-status'].includes(type) || typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId)) return
      try {
        const e = window.EJS_emulator
        if (!e?.gameManager?.supportsStates()) throw new Error('Core tidak mendukung save state.')
        if (type === 'guest-state-status') {
          const bytes = await readGuestState()
          guestStateAvailable = !!bytes
          guestStateSize = bytes?.length ?? 0
          updateExitButtons()
          send('state-result', { requestId, available: guestStateAvailable, size: guestStateSize })
          return
        }
        if (type === 'guest-export-state') {
          const paused = e.paused
          e.pause()
          try {
            const bytes = e.gameManager.getState()
            if (!validStateBytes(bytes)) throw new Error('Ukuran state tidak valid atau melebihi batas player.')
            send('state-result', { requestId, bytes })
          } finally { if (!paused && !overlayState) e.play() }
          return
        }
        if (type === 'guest-commit-state') {
          const bytes = event.data.bytes
          if (!validStateBytes(bytes)) throw new Error('Format state tidak valid.')
          await writeGuestState(bytes)
          await refreshGuestStatus()
          send('state-result', { requestId, applied: true })
          return
        }
        const paused = e.paused
        e.pause()
        try {
          const bytes = await readGuestState()
          if (!bytes) throw new Error('Belum ada simpanan Simpan & keluar di browser ini.')
          if (!validStateBytes(bytes)) throw new Error('Format state tidak valid.')
          e.gameManager.loadState(bytes)
          // Beri jeda ke browser setelah operasi WASM sinkron agar WebGL/main
          // loop dapat menetap sebelum resume dan kirim hasil, terutama di iOS.
          await new Promise(resolve => setTimeout(resolve, 0))
          // Loading is not proof of successful deserialization; the host tells
          // the user to verify the restored position.
          send('state-result', { requestId, applied: true })
        } finally { if (!paused && !overlayState) setTimeout(() => resumePlayback(e), 50) }
      } catch (error) { send('state-result', { requestId, error: error instanceof Error ? error.message : 'Operasi state gagal.' }) }
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
          // Beri jeda ke browser setelah operasi WASM sinkron agar WebGL/main
          // loop dapat menetap sebelum resume dan kirim hasil, terutama di iOS.
          await new Promise(resolve => setTimeout(resolve, 0))
          // Engine 4.2.3 does not expose a reliable deserialization acknowledgment.
          send('state-result', { requestId, applied: true })
        }
      } finally { if (!paused && !overlayState) setTimeout(() => resumePlayback(e), 50) }
    } catch (error) { send('state-result', { requestId, error: error instanceof Error ? error.message : 'Operasi state gagal.' }) }
  })

  window.addEventListener('message', async event => {
    if (event.origin !== location.origin || event.source !== parent || event.data?.channel !== 'maindulu:host' || event.data.type !== 'configure' || configured) return
    const config = event.data
    if (disposed || typeof config.sessionId !== 'string' || !/^[a-f0-9-]{36}$/.test(config.sessionId) || !allowedCores.includes(config.core) || !config.game || typeof config.game.id !== 'string') return
    sessionId = config.sessionId; configured = true
    assetConfig = config
    try {
      MainduluAssets.validatePreparedAssets(config)
      if (config.rom !== undefined && (!(config.rom instanceof File) || !config.rom.size || config.rom.size > 768 * 1024 * 1024)) throw new Error('ROM lokal tidak valid.')
      if (config.bios !== undefined && (!(config.bios instanceof File) || !config.bios.size || config.bios.size > 32 * 1024 * 1024)) throw new Error('BIOS lokal tidak valid.')
      memorySaves = config.memorySaves === true
      progressEnabled = memorySaves && config.gameSaves === true && ['fceumm', 'pcsx_rearmed'].includes(config.core)
      progressLayout = config.core === 'fceumm' ? 'nes-sram-v1' : 'ps1-active-memcard-v1'
      if (progressEnabled && config.initialProgress !== null && (!(config.initialProgress?.bytes instanceof Uint8Array) || !config.initialProgress.bytes.length || config.initialProgress.bytes.length > 8 * 1024 * 1024 || config.initialProgress.metadata?.layout !== progressLayout)) throw new Error('Pemulihan progres awal tidak valid.')
      if (memorySaves) {
        const response = await fetch('/player/builds.json', { cache: 'no-store', signal: lifecycle.signal })
        if (!response.ok) throw new Error('Metadata build engine tidak tersedia.')
        builds = await response.json()
      }
      if (!(config.rom instanceof Blob) && !localUrl(config.game.url)) throw new Error('Sumber ROM tidak valid. Pilih ROM kembali.')
      if (config.biosUrl && !localUrl(config.biosUrl)) throw new Error('Sumber BIOS server tidak valid.')
      if (!(config.rom instanceof Blob) && !config.preparedRom) await checkServerAsset(config.game.url, 'ROM')
      if (config.biosUrl && !config.preparedBios) await checkServerAsset(config.biosUrl, 'BIOS')
      if (disposed) return
      window.EJS_player = '#game'
      window.EJS_core = config.core
      if (config.preparedRom) romInput = MainduluAssets.engineRomInput(config.preparedRom.file)
      window.EJS_gameUrl = romInput ? romInput.file : config.rom instanceof Blob ? blobUrl(config.rom) : config.game.url
      const biosBlob = config.preparedBios ? await MainduluAssets.preparedBiosBlob(config.preparedBios.file, config.preparedBios.descriptor.url)
        : config.bios instanceof File ? await biosArchive(config.bios) : null
      if (disposed) { releaseAssets(); return }
      window.EJS_biosUrl = biosBlob ? blobUrl(biosBlob) : config.biosUrl || ''
      config.preparedRom = undefined; config.preparedBios = undefined; config.rom = undefined; config.bios = undefined
      window.EJS_gameName = config.saveId || `${config.core}-${config.game?.sha256 || config.game.id}`
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
      // The application owns the prepared-asset cache. Legacy URL assets keep
      // HTTP caching; local files and engine save states remain separate.
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
      // Bottom toolbar. Custom entries are appended before the spacer, then
      // positionExitButtons() moves them next to the fullscreen control. The
      // guest load control only exists for guest sessions; account sessions
      // keep their server-state button and never see the browser store action.
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
        } : {
          mainduluGuestLoad: {
            visible: true,
            custom: true,
            icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 14.59V7h-2v9.59l-3.3-3.3-1.4 1.42L12 20.41l5.7-5.7-1.4-1.42z"/></svg>',
            displayName: 'Muat simpanan terakhir',
            callback: () => send('guest-load-request')
          }
        }),
        mainduluExit: {
          visible: true,
          custom: true,
          icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M10 17v-2h4V9h-4V7l-5 5 5 5zm9-14H5a2 2 0 0 0-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/></svg>',
          displayName: 'Keluar game',
          callback: () => send('exit-request', { mode: 'exit' })
        },
        mainduluSaveExit: {
          visible: true,
          custom: true,
          icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zm-5 16a3 3 0 1 1 3-3 3 3 0 0 1-3 3zm3-10H7V5h8z"/></svg>',
          displayName: 'Simpan & keluar',
          callback: () => send('exit-request', { mode: 'save-and-exit' })
        }
      }
      window.EJS_ready = () => {
        hideNativeStateSettings()
        // Account dialogs live in React. Browsers without element fullscreen
        // (notably iPhone) also need the host's viewport-filling fallback.
        const emulator = window.EJS_emulator
        // Always fullscreen the host `.player-shell`: React confirmations,
        // errors and backup controls must remain visible above the game for
        // guests as well as accounts.
        hostFullscreen = true
        if (hostFullscreen) {
          emulator.toggleFullscreen = fullscreen => {
            // Escape can arrive before the async host acknowledgment. Track the
            // pending intent too, so a quick enter → Escape cannot get stuck.
            hostFullscreenActive = fullscreen === true
            send('fullscreen-request', { fullscreen: hostFullscreenActive })
          }
          syncHostFullscreen(false) // The engine hides both buttons if its API is absent.
        }
        const startButton = document.querySelector('.ejs_start_button')
        if (startButton) {
          startButton.setAttribute('role', 'button')
          startButton.setAttribute('tabindex', '0')
          startButton.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); startButton.click() }
          })
          startButton.addEventListener('click', () => send('starting'), { once: true })
        }
        positionExitButtons()
        updateExitButtons()
        // The toolbar is fully built now; re-run after the engine's own layout
        // pass so adjacency survives start/rebuild without duplicating nodes.
        setTimeout(() => { positionExitButtons(); updateExitButtons() }, 0)
        send('loaded')
        const original = window.EJS_emulator.startGameError.bind(window.EJS_emulator)
        window.EJS_emulator.startGameError = message => { fail(progressBootError || String(message)); return original(message) }
      }
      window.EJS_onGameStart = () => {
        releaseAssets()
        // The engine rebuilds its settings menu when the core starts.
        hideNativeStateSettings()
        gameStarted = true
        gameRunning = true
        supportsStates = window.EJS_emulator.gameManager.supportsStates() === true
        watchGraphicsContext()
        resumeAudio()
        applyWidescreen()
        positionExitButtons()
        updateExitButtons()
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
        send('started', { metadata, progressReady, supportsStates, browserKeys: memorySaves ? { state: window.EJS_emulator.getBaseFileName() + '.state', progress: ['fceumm', 'pcsx_rearmed'].includes(config.core) ? window.EJS_emulator.gameManager.getSaveFilePath() : null } : null })
        // Let the host reflect capability immediately; guest availability is
        // read back from the dedicated browser key asynchronously.
        send('exit-capability', { supportsStates, guest: !memorySaves, guestAvailable: false, guestSize: 0 })
        if (!memorySaves) void refreshGuestStatus()
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
  window.addEventListener('keydown', event => {
    if (hostFullscreen && hostFullscreenActive && event.key === 'Escape') send('fullscreen-request', { fullscreen: false })
  })
  // iOS hanya mengizinkan AudioContext resume dari gestur pengguna. Setiap
  // sentuhan di player juga dipakai untuk memulihkan audio setelah load state.
  window.addEventListener('pointerdown', () => resumeAudio(), { passive: true })
  window.addEventListener('touchstart', () => resumeAudio(), { passive: true })
  window.addEventListener('error', event => fail(event.message || 'Terjadi kesalahan pada engine. Periksa format ROM dan BIOS.'))
  window.addEventListener('unhandledrejection', event => {
    const message = event.reason?.message || ''
    // Screen wake lock is optional and is denied in hidden/background tabs.
    // Do not obscure an otherwise running game with this browser-policy warning.
    if (/wake\s?lock/i.test(message)) { event.preventDefault(); return }
    fail(message || 'File atau core tidak dapat dimuat. Periksa format dan kelengkapan berkas.')
  })
  window.addEventListener('pagehide', () => { disposed = true; lifecycle.abort(); releaseAssets(); assetConfig = null; widescreenObserver?.disconnect() })
  send('ready')
})()
