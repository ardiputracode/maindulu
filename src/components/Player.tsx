import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, ChevronDown, Download, Heart, Info, Keyboard, LoaderCircle, LogOut, Save, ShieldCheck } from 'lucide-react'
import type { ConsoleInfo, Game, Settings } from '../lib/domain'
import { saveIdentity } from '../lib/domain'
import type { AccountState } from '../lib/account'
import type { StateMetadata } from '../lib/saves'
import { AUTOSAVE_SLOT, EXIT_SLOT, downloadState, readStateMetadata } from '../lib/saves'
import { createSessionId } from '../lib/identity'
import ServerStates from './ServerStates'
import type { AutosaveStatus, ServerStatesHandle } from './ServerStates'
import Dialog from './Dialog'
import { OperationLock } from '../lib/operation-lock'
import { findSlotSave } from '../lib/state-pipeline'
import type { StateTarget } from '../lib/state-pipeline'
import { decodeGameSave, encodeGameSave, gameSaveLayout } from '../lib/game-save-format'
import { downloadGameSave, GameSaveClient, GameSaveSync } from '../lib/game-saves'
import type { ProgressView } from '../lib/game-saves'
import type { ServerGameSave } from '../lib/game-saves'
import SaveTransfer from './SaveTransfer'
import type { TransferRequest } from './SaveTransfer'
import { createPortal } from 'react-dom'
import type { AssetDescriptor } from '../lib/asset-cache-policy'
import { preparePlayerAssets } from '../lib/player-assets'
import type { AssetPreparationProgress } from '../lib/server-assets'
import { assetPreparationStatus, assetPersistenceNotice } from '../lib/asset-cache-ui'

export type LaunchSession = { id: string; game: Game; consoleInfo: ConsoleInfo; rom?: File; bios?: File; biosUrl?: string; biosSha256?: string; serverRom?: AssetDescriptor; serverBios?: AssetDescriptor; storageOwner?: string | null; gameSaves?: boolean; saveId?: string }

type ExitMode = 'account' | 'guest'
type ExitPhase = 'confirm' | 'capturing' | 'saving' | 'syncing' | 'error' | 'partial' | 'done'
type ExitRetry = 'all' | 'state' | 'progress'
type ExitFlow = {
  phase: ExitPhase
  mode: ExitMode
  message: string
  error: string
  bytes: Uint8Array | null
  captured: boolean
  stateSaved: boolean
  progressSaved: boolean
  retry: ExitRetry | null
}

export default function Player({ session, settings, favorite, onFavorite, onStart, onExit, onSavedExit, onWidescreen, account, registerExitGuard, registerBusyGuard, onRestart }: {
  session: LaunchSession; settings: Settings; favorite: boolean;
  onFavorite: () => void; onStart: () => void; onExit: () => void; onSavedExit: () => void; onWidescreen: (widescreen: boolean) => void;
  account: AccountState; onRestart: () => void;
  registerExitGuard: (guard: (() => Promise<boolean>) | null) => void;
  registerBusyGuard: (guard: (() => boolean) | null) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const shell = useRef<HTMLDivElement>(null)
  const pseudoFullscreenRef = useRef(false)
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false)
  const started = useRef(false)
  const [status, setStatus] = useState('Menyiapkan ruang bermain…')
  const [error, setError] = useState('')
  const [assetNotice, setAssetNotice] = useState('')
  const [assetProgress, setAssetProgress] = useState<AssetPreparationProgress | null>(null)
  const [controls, setControls] = useState(false)
  const startCallback = useRef(onStart)
  startCallback.current = onStart
  const widescreenCallback = useRef(onWidescreen)
  widescreenCallback.current = onWidescreen
  const widescreenValue = useRef(settings.widescreen === true)
  const [widescreen, setWidescreen] = useState(settings.widescreen === true)
  const [metadata, setMetadata] = useState<StateMetadata | null>(null)
  const [terminated, setTerminated] = useState(false)
  const [stateError, setStateError] = useState('')
  const [saveOverlay, setSaveOverlay] = useState(false)
  const [transfer, setTransfer] = useState<TransferRequest | null>(null)
  const [preparingTransfer, setPreparingTransfer] = useState(false)
  const [browserKeys, setBrowserKeys] = useState<{ state: string; progress: string | null }>({ state: '', progress: null })
  const [stateResolution, setStateResolution] = useState(0)
  const [supportsStates, setSupportsStates] = useState(false)
  const [guestExitAvailable, setGuestExitAvailable] = useState(false)
  const [guestLoad, setGuestLoad] = useState<{ busy: boolean; message: string } | null>(null)
  const [exitFlow, setExitFlow] = useState<ExitFlow | null>(null)
  const exitFlowRef = useRef<ExitFlow | null>(null)
  const exitBusy = useRef(false)
  const guestLoadBusy = useRef(false)
  const [exitBusyState, setExitBusyState] = useState(false)
  const stateLock = useRef<OperationLock | null>(null)
  if (!stateLock.current) stateLock.current = new OperationLock()
  const serverHandle = useRef<ServerStatesHandle | null>(null)
  const savedExitCallback = useRef(onSavedExit)
  savedExitCallback.current = onSavedExit
  const plainExitCallback = useRef(onExit)
  plainExitCallback.current = onExit
  const modalOpen = saveOverlay || !!transfer || preparingTransfer || !!exitFlow
  const [gameRunning, setGameRunning] = useState(false)
  const [saveNotice, setSaveNotice] = useState<{ kind: 'saving' | 'success' | 'error'; message: string } | null>(null)
  const owner = session.storageOwner
  const ownerName = useRef(account.user && account.user.id === owner ? account.user.username : '')
  const layout = gameSaveLayout(session.consoleInfo.core)
  const saveId = session.saveId ?? saveIdentity(session.game, session.consoleInfo.core)
  const stateTarget: StateTarget = { gameId: saveId, consoleId: session.consoleInfo.id, core: session.consoleInfo.core, title: session.game.title }
  const exitSlotSave = findSlotSave(serverHandle.current?.list ?? null, stateTarget, EXIT_SLOT)
  const progressAvailable = !!owner && session.gameSaves === true && !!layout
  const progressSync = useRef<GameSaveSync | null>(null)
  const [progress, setProgress] = useState<ProgressView>({ status: 'loading', message: 'Menyiapkan progres akun…', pending: false })
  const progressRef = useRef(progress)
  progressRef.current = progress
  const [progressRetry, setProgressRetry] = useState(0)
  const enabled = !!owner && !terminated && account.status === 'authenticated' && account.user?.id === owner
  const active = useRef(enabled)
  active.current = enabled
  const sessionAlive = useRef(true)
  const supportsStatesRef = useRef(supportsStates)
  supportsStatesRef.current = supportsStates
  const metadataRef = useRef(metadata)
  metadataRef.current = metadata
  const notifyAutosave = useCallback((status: AutosaveStatus) => {
    if (!active.current) return
    setSaveNotice(status === 'saving' ? { kind: 'saving', message: 'Autosave…' } : status === 'saved'
      ? { kind: 'success', message: 'Autosave tersimpan' }
      : { kind: 'error', message: 'Autosave gagal. Buka Save state server.' })
  }, [])
  useEffect(() => {
    if (!enabled) { setSaveNotice(null); return }
    if (!saveNotice || saveNotice.kind === 'saving') return
    const timer = setTimeout(() => setSaveNotice(null), saveNotice.kind === 'error' ? 6000 : 3000)
    return () => clearTimeout(timer)
  }, [saveNotice, enabled])
  useEffect(() => {
    if (!guestLoad || guestLoad.busy) return
    const timer = setTimeout(() => setGuestLoad(null), 8000)
    return () => clearTimeout(timer)
  }, [guestLoad])
  type RpcType = 'export-state' | 'import-state' | 'export-progress' | 'guest-export-state' | 'guest-commit-state' | 'guest-load-state'
  const requests = useRef(new Map<string, { type: RpcType; resolve: (bytes: Uint8Array | null) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>())
  useEffect(() => {
    if (owner && (account.status === 'anonymous' || account.status === 'authenticated' && account.user?.id !== owner)) { sessionAlive.current = false; setTerminated(true) }
    if (owner && account.status === 'authenticated' && account.user?.id !== owner) progressSync.current?.close(true)
    else if (owner && account.status === 'anonymous') progressSync.current?.close(false)
  }, [owner, account.status, account.user?.id])
  const rpc = useCallback((type: RpcType, bytes?: Uint8Array) => new Promise<Uint8Array | null>((resolve, reject) => {
    if (!sessionAlive.current || !frame.current?.contentWindow) { reject(new Error(owner ? 'Player akun dihentikan. Buka ulang permainan setelah login.' : 'Player sudah ditutup. Buka ulang permainan.')); return }
    const requestId = createSessionId()
    const timer = setTimeout(() => { requests.current.delete(requestId); reject(new Error('Operasi state terlalu lama. Unduh cadangan sebelum keluar bila tersedia.')) }, 15000)
    requests.current.set(requestId, { type, resolve, reject, timer })
    frame.current.contentWindow.postMessage({ channel: 'maindulu:host', type, sessionId: session.id, requestId, ...(bytes ? { bytes } : {}) }, location.origin)
  }), [session.id])
  const liveRef = useRef(true)
  useEffect(() => {
    if (!pseudoFullscreen) return
    const previousBodyOverflow = document.body.style.overflow
    const previousRootOverflow = document.documentElement.style.overflow
    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousBodyOverflow
      document.documentElement.style.overflow = previousRootOverflow
    }
  }, [pseudoFullscreen])
  // Opening the overlay always pauses; closing resumes only games that were
  // running when the overlay opened (the bridge keeps that decision).
  useEffect(() => {
    if (!modalOpen) return
    const win = frame.current?.contentWindow
    if (!win) return
    win.postMessage({ channel: 'maindulu:host', type: 'pause-session', sessionId: session.id }, location.origin)
    return () => { frame.current?.contentWindow?.postMessage({ channel: 'maindulu:host', type: 'resume-session', sessionId: session.id }, location.origin) }
  }, [modalOpen, session.id])

  useEffect(() => {
    if (!progressAvailable) return
    const timer = setInterval(() => {
      if (active.current && started.current && !document.hidden && gameRunning && !modalOpen) void progressSync.current?.sync()
    }, 10000)
    return () => clearInterval(timer)
  }, [progressAvailable, gameRunning, modalOpen])
  useEffect(() => {
    if (!progressAvailable) return
    registerExitGuard(async () => {
      if (transfer || preparingTransfer) return false
      if (!started.current) return true
      if (!active.current) return window.confirm('Sesi sinkronisasi tidak tersedia. Keluar tanpa sinkronisasi? Pilih Batal untuk mengunduh cadangan progres terlebih dahulu.')
      const win = frame.current?.contentWindow
      win?.postMessage({ channel: 'maindulu:host', type: 'pause-session', sessionId: session.id }, location.origin)
      try {
        const saved = await progressSync.current?.sync(true)
        if (saved) return true
        return window.confirm('Progres belum tersinkron. Keluar tanpa sinkronisasi? Pilih Batal untuk mencoba lagi atau mengunduh cadangan progres.')
      } finally {
        if (!modalOpen) win?.postMessage({ channel: 'maindulu:host', type: 'resume-session', sessionId: session.id }, location.origin)
      }
    })
    return () => registerExitGuard(null)
  }, [progressAvailable, registerExitGuard, session.id, modalOpen, transfer, preparingTransfer])
  // Alternative navigation (sidebar, browser Back, new game) must not detach
  // the iframe while capture/upload/navigation is still in flight.
  useEffect(() => {
    registerBusyGuard(() => exitBusy.current)
    return () => registerBusyGuard(null)
  }, [registerBusyGuard])

  useEffect(() => {
    if (terminated) return
    let configured = false
    let disposed = false
    const controller = new AbortController()
    let sync: GameSaveSync | null = null
    let timeout: ReturnType<typeof setTimeout> | undefined
    liveRef.current = true
    sessionAlive.current = true
    setError('')
    setAssetNotice('')
    setAssetProgress(null)
    setStatus('Menyiapkan ruang bermain…')
    const armTimeout = (message: string) => {
      clearTimeout(timeout)
      timeout = setTimeout(() => { controller.abort(); setStatus(''); setError(message) }, 90000)
    }
    async function configure() {
      // The resolver has connection/idle timers, not a total 90s download cap.
      clearTimeout(timeout)
      if (owner && !active.current) throw new Error('Sesi akun belum bisa dipastikan. Masuk akun, lalu buka ulang game.')
      const assets = await preparePlayerAssets(session, controller.signal, value => {
        if (!disposed && !controller.signal.aborted) { setStatus(assetPreparationStatus(value)); setAssetProgress(value.phase === 'ready' ? null : value) }
      })
      if (disposed || controller.signal.aborted) return
      if (owner && !active.current) throw new Error('Sesi akun berubah atau belum dapat dipastikan. Buka ulang permainan setelah login.')
      setAssetProgress(null)
      setAssetNotice([assets.cacheNotice, ...assets.outcomes.map(assetPersistenceNotice)].filter(Boolean).join(' · '))
      let initialProgress = null
      if (progressAvailable && owner && layout) {
        sync = new GameSaveSync(new GameSaveClient(owner), { gameId: session.saveId ?? saveIdentity(session.game, session.consoleInfo.core), consoleId: session.consoleInfo.id, core: session.consoleInfo.core, title: session.game.title }, async () => {
          const bytes = await rpc('export-progress')
          return bytes ? encodeGameSave({ layout, files: [{ key: 'sram', bytes }] }) : null
        }, view => {
          if (disposed) return
          setProgress(view)
          if (view.status === 'stopped') { setTerminated(true); sync?.close(false) }
        })
        progressSync.current = sync
        const initial = await sync.prepare()
        if (initial.bytes) initialProgress = { bytes: decodeGameSave(initial.bytes).files[0].bytes, metadata: initial.metadata }
      }
      if (disposed || controller.signal.aborted) return
      if (owner && !active.current) throw new Error('Sesi akun berubah atau belum dapat dipastikan. Buka ulang permainan setelah login.')
      frame.current?.contentWindow?.postMessage({ channel: 'maindulu:host', type: 'configure', sessionId: session.id, game: session.game, core: session.consoleInfo.core, consoleId: session.consoleInfo.id, rom: session.rom, bios: session.bios, biosUrl: session.biosUrl, biosSha256: session.biosSha256, preparedRom: assets.preparedRom, preparedBios: assets.preparedBios, volume: settings.volume / 100, widescreen: settings.widescreen === true, memorySaves: !!owner, gameSaves: progressAvailable, initialProgress }, location.origin)
      setStatus('Memuat engine dan core lokal…')
      armTimeout('Engine belum siap. Periksa kelengkapan aset engine, lalu buka game kembali.')
    }
    const syncFullscreen = () => {
      frame.current?.contentWindow?.postMessage({ channel: 'maindulu:host', type: 'fullscreen-state', sessionId: session.id, fullscreen: pseudoFullscreenRef.current || !!shell.current && document.fullscreenElement === shell.current }, location.origin)
    }
    function setFallbackFullscreen(value: boolean) {
      pseudoFullscreenRef.current = value
      setPseudoFullscreen(value)
      syncFullscreen()
    }
    async function toggleFullscreen(fullscreen: boolean) {
      const target = shell.current
      if (!target) return
      if (!fullscreen) {
        if (pseudoFullscreenRef.current) setFallbackFullscreen(false)
        else if (document.fullscreenElement === target) await document.exitFullscreen().catch(() => {})
        syncFullscreen()
        return
      }
      if (target.requestFullscreen && document.fullscreenEnabled) {
        try {
          await target.requestFullscreen()
          syncFullscreen()
          return
        } catch { /* Fullscreen can be denied, e.g. across an iframe click. */ }
      }
      setFallbackFullscreen(true)
    }
    const escapePseudoFullscreen = (event: KeyboardEvent) => { if (event.key === 'Escape' && pseudoFullscreenRef.current) setFallbackFullscreen(false) }
    function receive(event: MessageEvent) {
      if (disposed || controller.signal.aborted || event.origin !== location.origin || event.source !== frame.current?.contentWindow || event.data?.channel !== 'maindulu:player') return
      if (event.data.type === 'ready' && !configured) {
        configured = true
        void configure().catch(e => { if (!disposed && !controller.signal.aborted) { clearTimeout(timeout); controller.abort(); setStatus(''); setError(e instanceof Error ? e.message : 'Persiapan game gagal. Buka ulang permainan.') } })
      }
      if (event.data.sessionId !== session.id) return
      // Fullscreen the shared player shell, not the iframe alone: React save
      // dialogs and notices must be descendants of the fullscreen element.
      if (event.data.type === 'fullscreen-request' && (!owner || active.current) && typeof event.data.fullscreen === 'boolean') {
        void toggleFullscreen(event.data.fullscreen)
      }
      // The "Save state server" button lives inside the emulator toolbar; the
      // bridge forwards its click so the overlay can attach above the player.
      if (event.data.type === 'state-server') { clearTimeout(timeout); setStatus(''); setSaveOverlay(true) }
      // Toolbar intent is validated here: origin, source window, channel and
      // session ID were already checked above. The bridge cannot navigate.
      if (event.data.type === 'exit-request') {
        if (exitBusy.current) return
        if (event.data.mode === 'exit') { plainExitCallback.current() }
        else if (event.data.mode === 'save-and-exit') { requestSaveExit() }
        return
      }
      if (event.data.type === 'guest-load-request') { void loadGuestState(); return }
      if (event.data.type === 'exit-capability') {
        if (typeof event.data.supportsStates === 'boolean') setSupportsStates(event.data.supportsStates)
        if (!owner) setGuestExitAvailable(event.data.guestAvailable === true)
      }
      // Engine patch reports play/pause transitions; drives autosave gating.
      if (event.data.type === 'session-running' && typeof event.data.running === 'boolean') setGameRunning(event.data.running)
      if (event.data.type === 'started') {
        clearTimeout(timeout); setStatus('')
        setGameRunning(true)
        setSupportsStates(event.data.supportsStates === true)
        if (session.storageOwner) {
          const keys = event.data.browserKeys
          if (keys && typeof keys.state === 'string' && keys.state.length < 512 && (keys.progress === null || typeof keys.progress === 'string' && keys.progress.length < 512)) setBrowserKeys(keys)
          const value = event.data.supportsStates === true ? readStateMetadata(event.data.metadata) : null
          setMetadata(value)
          if (!value) setStateError('Core tidak mendukung state atau metadata build tidak tersedia. Save server tidak diaktifkan.')
        }
        if (progressAvailable && event.data.progressReady === true) {
          const value = readStateMetadata(event.data.metadata)
          if (value && layout) sync?.start({ ...value, layout })
        }
        if (!started.current) { started.current = true; startCallback.current() }
      }
      if (event.data.type === 'state-result' && typeof event.data.requestId === 'string') {
        const request = requests.current.get(event.data.requestId)
        if (!request) return
        clearTimeout(request.timer); requests.current.delete(event.data.requestId)
        if (!sessionAlive.current) request.reject(new Error('Sesi player berubah; hasil state diabaikan.'))
        else if (typeof event.data.error === 'string') request.reject(new Error(event.data.error))
        else if ((request.type === 'export-state' || request.type === 'guest-export-state') && event.data.bytes instanceof Uint8Array && event.data.bytes.length >= 32 && event.data.bytes.length <= 64 * 1024 * 1024) request.resolve(event.data.bytes as Uint8Array)
        else if (request.type === 'export-progress' && (event.data.bytes === null || event.data.bytes instanceof Uint8Array && event.data.bytes.length > 0 && event.data.bytes.length <= 8 * 1024 * 1024)) request.resolve(event.data.bytes)
        else if ((request.type === 'import-state' || request.type === 'guest-commit-state' || request.type === 'guest-load-state') && event.data.applied === true) request.resolve(null)
        else request.reject(new Error('Respons state player tidak valid.'))
      }
      if (event.data.type === 'loaded') { clearTimeout(timeout); setStatus('Engine siap. Klik “Mulai bermain” di layar.'); syncFullscreen() }
      if (event.data.type === 'starting') {
        setStatus('Memuat ROM dan core dari server maindulu…')
        armTimeout('Pemuatan core terlalu lama. Periksa ROM/BIOS, lalu buka game kembali.')
      }
      if (event.data.type === 'error') {
        clearTimeout(timeout); setStatus(''); setError(String(event.data.message || 'Engine tidak dapat dimuat.'))
        // The iframe's HEAD preflight does not use the host's fetch wrapper.
        // Only relay after the origin, source window and session checks above.
        if (typeof event.data.message === 'string' && /\bHTTP 401\b/.test(event.data.message)) window.dispatchEvent(new Event('maindulu:gate-check'))
      }
      if (event.data.type === 'progress-error') setProgress({ status: 'failed', message: String(event.data.message || 'Layout progres tidak didukung.'), pending: false })
      if (event.data.type === 'display' && typeof event.data.widescreen === 'boolean' && event.data.widescreen !== widescreenValue.current) {
        widescreenValue.current = event.data.widescreen
        setWidescreen(event.data.widescreen)
        widescreenCallback.current(event.data.widescreen)
      }
    }
    window.addEventListener('message', receive)
    document.addEventListener('fullscreenchange', syncFullscreen)
    document.addEventListener('keydown', escapePseudoFullscreen)
    armTimeout('Player belum siap. Periksa koneksi ke server maindulu dan kelengkapan aset engine, lalu buka game kembali.')
    const warn = (e: BeforeUnloadEvent) => { if (started.current) e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => {
      disposed = true; controller.abort()
      // Logout may retain a downloadable pending snapshot. A real account
      // switch already clears it in the ownership effect above.
      sync?.close(!owner || active.current)
      if (!owner || active.current) progressSync.current = null
      clearTimeout(timeout); window.removeEventListener('message', receive); window.removeEventListener('beforeunload', warn); document.removeEventListener('fullscreenchange', syncFullscreen); document.removeEventListener('keydown', escapePseudoFullscreen); liveRef.current = false; sessionAlive.current = false
      for (const request of requests.current.values()) { clearTimeout(request.timer); request.reject(new Error('Sesi player ditutup.')) }
      requests.current.clear()
    }
    // The initial volume is frozen for this session; changing settings affects the next session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, progressRetry, terminated])

  function setExit(next: ExitFlow | null) {
    exitFlowRef.current = next
    setExitFlow(next)
  }
  function patchExit(patch: Partial<ExitFlow>) {
    const current = exitFlowRef.current
    if (!current) return
    setExit({ ...current, ...patch })
  }
  function notifyExitBusy(busy: boolean) {
    frame.current?.contentWindow?.postMessage({ channel: 'maindulu:host', type: 'exit-state', sessionId: session.id, busy }, location.origin)
  }
  function requestSaveExit() {
    if (exitBusy.current || exitFlowRef.current) return
    if (guestLoadBusy.current) { setStateError('Muat simpanan masih berjalan. Tunggu hingga selesai sebelum Simpan & keluar.'); return }
    if (!started.current) { setStateError('Mulai game terlebih dahulu sebelum Simpan & keluar.'); return }
    if (!supportsStatesRef.current) { setStateError('Core ini tidak mendukung save state. Gunakan Keluar game tanpa save baru atau ekspor cadangan dari menu emulator.'); return }
    if (owner && (!active.current || !metadataRef.current)) { setStateError('Sesi akun atau metadata core belum siap. Buka ulang game setelah login; simpanan akun tidak dialihkan ke browser.'); return }
    setExit({ phase: 'confirm', mode: owner ? 'account' : 'guest', message: '', error: '', bytes: null, captured: false, stateSaved: false, progressSaved: false, retry: null })
  }
  function closeExit() {
    if (exitBusy.current) return
    setExit(null)
  }
  function emergencyExit() {
    if (exitBusy.current) return
    const flow = exitFlowRef.current
    if (!flow) return
    const message = flow.stateSaved
      ? 'State sudah tersimpan, tetapi progres belum tersinkron. Keluar sekarang tanpa progres tersinkron?'
      : 'Keluar tanpa membuat state baru? Simpanan lama tidak dihapus, tetapi posisi terakhir bisa hilang.'
    if (!window.confirm(message)) return
    setExit(null)
    savedExitCallback.current()
  }
  async function captureExitState() {
    const bytes = await rpc(owner ? 'export-state' : 'guest-export-state')
    if (!bytes) throw new Error('State tidak tersedia. Kembali ke game dan coba lagi sebelum keluar.')
    return bytes
  }
  async function loadGuestState() {
    if (owner || exitBusy.current || guestLoadBusy.current) return
    if (!started.current || !supportsStatesRef.current) { setStateError('Simpanan browser hanya dapat dimuat setelah game dan core mendukung save state.'); return }
    if (!window.confirm('Muat simpanan Simpan & keluar dari browser ini? Kondisi permainan saat ini akan diganti. Slot native, Autosave server, dan slot manual tidak berubah.')) return
    guestLoadBusy.current = true
    setGuestLoad({ busy: true, message: 'Memuat simpanan Simpan & keluar dari browser…' })
    frame.current?.contentWindow?.postMessage({ channel: 'maindulu:host', type: 'pause-session', sessionId: session.id }, location.origin)
    try {
      await rpc('guest-load-state')
      if (sessionAlive.current) setGuestLoad({ busy: false, message: 'Perintah muat dikirim ke core. Periksa posisi permainan; engine tidak memberikan konfirmasi deserialisasi.' })
    } catch (e) {
      if (sessionAlive.current) setGuestLoad({ busy: false, message: e instanceof Error ? e.message : 'Muat simpanan browser gagal.' })
    } finally {
      guestLoadBusy.current = false
      frame.current?.contentWindow?.postMessage({ channel: 'maindulu:host', type: 'resume-session', sessionId: session.id }, location.origin)
    }
  }
  async function runSaveExit(retry: ExitRetry = 'all') {
    const initial = exitFlowRef.current
    if (!initial || exitBusy.current || !sessionAlive.current) return
    if (owner && !active.current) { patchExit({ phase: 'error', error: 'Sesi akun berubah. State tidak diteruskan ke akun lain.', retry: 'all' }); return }
    exitBusy.current = true
    setExitBusyState(true)
    notifyExitBusy(true)
    const token = await stateLock.current!.acquireWithin(15000)
    if (!token) {
      exitBusy.current = false
      setExitBusyState(false)
      notifyExitBusy(false)
      patchExit({ phase: 'error', error: 'Operasi save lain masih berjalan. Tunggu sebentar, lalu coba lagi tanpa menutup tab.', retry: 'state' })
      return
    }
    let navigate = false
    try {
      if (retry !== 'progress') {
        if (owner) {
          const handle = serverHandle.current
          if (!handle) throw new Error('Panel save server belum siap. Kembali ke game dan coba lagi.')
          if (handle.conflict) throw new Error('Ada konflik simpanan. Tinjau konflik di Save state server sebelum Simpan & keluar.')
          if (handle.pending && handle.pending.slot !== EXIT_SLOT) throw new Error(`Ada snapshot ${handle.pending.slot === AUTOSAVE_SLOT ? 'Autosave' : 'state'} tertunda. Buka Save state server untuk menyimpan ulang, mengunduh cadangan, atau mengabaikannya sebelum Simpan & keluar.`)
        }
        const flow = exitFlowRef.current
        if (!flow) return
        let bytes = flow.bytes
        if (!flow.captured || !bytes) {
          patchExit({ phase: 'capturing', message: owner ? 'Mengambil state terakhir dari core…' : 'Mengambil state terakhir dari browser…', error: '', retry: null })
          bytes = await captureExitState()
          if (!sessionAlive.current) throw new Error('Sesi player ditutup sebelum state tersimpan.')
          patchExit({ bytes, captured: true })
        }
        if (!exitFlowRef.current?.stateSaved) {
          patchExit({ phase: 'saving', message: owner ? 'Menyimpan state ke server…' : 'Menyimpan state di browser ini…', error: '', retry: 'state' })
          if (owner) {
            const handle = serverHandle.current
            if (!handle) throw new Error('Panel save server belum siap. Kembali ke game dan coba lagi.')
            try { await handle.saveExit(bytes!) }
            catch (error) {
              // A timeout can leave the commit outcome unknown. Resolve it
              // against the confirmed list before reporting failure.
              const committed = await handle.checkExitCommit(bytes!).catch(() => null)
              if (!committed) throw error
            }
          } else {
            await rpc('guest-commit-state', bytes!)
          }
          if (!sessionAlive.current) throw new Error('Sesi player ditutup sebelum penyimpanan dikonfirmasi.')
          patchExit({ stateSaved: true, retry: null })
        }
      }
      // Final account progress sync is a companion to the state snapshot, not
      // a replacement. It runs only after the state commit is confirmed.
      if (owner && progressAvailable && !exitFlowRef.current?.progressSaved) {
        patchExit({ phase: 'syncing', message: 'Menyinkronkan progres terakhir…', error: '', retry: 'progress' })
        const sync = progressSync.current
        if (!sync) throw new Error('Sinkronisasi progres tidak siap. Kembali ke game dan periksa panel progres.')
        await sync.hold()
        sync.release()
        const saved = await sync.sync(true)
        if (!saved) {
          const conflict = progressRef.current.status === 'conflict'
          patchExit({
            phase: 'partial',
            message: '',
            error: conflict
              ? 'State tersimpan, tetapi progres belum tersinkron karena konflik revisi. Tinjau konflik progres sebelum keluar.'
              : 'State tersimpan, tetapi progres belum tersinkron. Coba lagi atau unduh cadangan sebelum keluar.',
            retry: 'progress'
          })
          return
        }
        patchExit({ progressSaved: true, retry: null })
      }
      if (!sessionAlive.current) throw new Error('Sesi player ditutup sebelum navigasi.')
      if (owner && !active.current) throw new Error('Sesi akun berubah. State/progres tidak diteruskan ke akun lain.')
      patchExit({ phase: 'done', message: owner ? 'State dan progres tersimpan. Kembali ke beranda…' : 'State tersimpan di browser ini. Kembali ke beranda…', error: '', retry: null })
      navigate = true
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Simpan & keluar gagal.'
      const flow = exitFlowRef.current
      if (flow?.stateSaved) patchExit({ phase: 'partial', error: `State tersimpan, tetapi langkah berikut gagal: ${message}`, retry: 'progress' })
      else patchExit({ phase: 'error', error: message, retry: flow?.captured ? 'state' : 'all' })
    } finally {
      stateLock.current?.release(token)
      exitBusy.current = false
      setExitBusyState(false)
      notifyExitBusy(false)
      if (navigate) savedExitCallback.current()
    }
  }
  function exit() { onExit() }
  async function openTransfer(request: TransferRequest) {
    if (!enabled || transfer || preparingTransfer) return
    setPreparingTransfer(true)
    frame.current?.contentWindow?.postMessage({ channel: 'maindulu:host', type: 'pause-session', sessionId: session.id }, location.origin)
    try {
      // Before importing different SRAM, preserve the CURRENT paused game at
      // the server baseline so the atomic replacement backs up that version.
      if (request.mode === 'import' && request.kind === 'progress' && !await progressSync.current?.sync(true)) throw new Error('Sinkronkan/selesaikan konflik progres sesi ini dahulu sebelum impor.')
      await progressSync.current?.hold()
      if (active.current) setTransfer(request)
    } catch (e) { if (active.current) setStateError(e instanceof Error ? e.message : 'Tidak dapat membuka impor.') }
    finally { setPreparingTransfer(false) }
  }
  function closeTransfer() { setTransfer(null); progressSync.current?.release() }
  return <div className="player-page">
    <div className="player-heading"><button className="button secondary small" onClick={exit}><ArrowLeft size={17} />Kembali</button><div className="player-title"><h1>{session.game.title}</h1><span>{session.consoleInfo.shortName} <i>·</i> {session.game.source === 'local' ? 'ROM lokal' : 'Koleksi server'}</span></div><button className={`icon-button ${favorite ? 'is-favorite' : ''}`} onClick={onFavorite} aria-label={favorite ? 'Hapus dari favorit' : 'Tambahkan ke favorit'} aria-pressed={favorite}><Heart fill={favorite ? 'currentColor' : 'none'} size={21} /></button></div>
    <div ref={shell} className={`player-shell${widescreen ? ' is-widescreen' : ''}${pseudoFullscreen ? ' is-pseudo-fullscreen' : ''}`}>{!terminated && <iframe key={progressRetry} ref={frame} src="/player/index.html" title={`Emulator ${session.game.title}`} allow="autoplay; fullscreen; gamepad" allowFullScreen />}{(error || terminated) && <div className="player-error" role="alert"><Info size={27} /><h2>{terminated ? 'Sesi akun berakhir.' : 'Belum bisa mulai.'}</h2><p>{terminated ? 'Player dibersihkan untuk mencegah pencampuran data akun. Unduh snapshot tertunda di bawah bila tersedia, lalu login dan buka game kembali.' : error}</p>{!terminated && !started.current && progressAvailable && <button className="button secondary" onClick={() => setProgressRetry(v => v + 1)}>Coba ambil progres lagi</button>}<button className="button primary" onClick={onExit}>Kembali dan coba lagi<ArrowLeft size={17} /></button></div>}
      {enabled && !saveOverlay && saveNotice && <div className={`player-save-notice player-save-notice--${saveNotice.kind}`} role="status" aria-live="polite" aria-atomic="true">
        {saveNotice.kind === 'saving' ? <LoaderCircle size={15} className="spin" /> : saveNotice.kind === 'success' ? <Check size={15} /> : <Info size={15} />}
        <span>{saveNotice.message}</span>
      </div>}
      {progressAvailable && enabled && ['failed', 'conflict', 'stopped'].includes(progress.status) && <div className="player-progress-notice" role="alert">Progres belum tersinkron. {progress.message} Gunakan kontrol progres di bawah player; keluar fullscreen bila perlu.</div>}
      {transfer && owner && !terminated && !(account.status === 'authenticated' && account.user?.id !== owner) && metadata && createPortal(<SaveTransfer owner={owner} ownerName={ownerName.current} enabled={enabled} request={transfer}
        target={{ gameId: session.saveId ?? saveIdentity(session.game, session.consoleInfo.core), consoleId: session.consoleInfo.id, core: session.consoleInfo.core, title: session.game.title }}
        metadata={transfer.kind === 'progress' && layout ? { ...metadata, layout } as StateMetadata : metadata}
        stateKey={browserKeys.state} progressPath={browserKeys.progress}
        capture={async () => { const bytes = transfer.kind === 'progress' ? await progressSync.current?.conflictSnapshot() : await rpc('export-state'); if (!bytes) throw new Error('Snapshot tidak tersedia.'); return bytes }}
        onClose={closeTransfer} onApplied={(save, bytes, action) => {
          if (!active.current) return
          if (transfer.kind === 'progress') {
            if (action === 'preserve' || transfer.mode === 'import') { progressSync.current?.close(); registerExitGuard(null); onRestart(); return }
            if (save) progressSync.current?.acceptDecision(save as ServerGameSave, bytes)
          } else setStateResolution(n => n + 1)
          closeTransfer()
        }} />, shell.current ?? document.body)}
      {exitFlow && createPortal(<Dialog title="Simpan & keluar" eyebrow="KELUAR GAME" onClose={closeExit} busy={exitBusyState || !['confirm', 'error', 'partial'].includes(exitFlow.phase)} className="exit-dialog" backdropClassName="server-overlay">
        <div className="server-state-content exit-flow">
          {exitFlow.phase === 'confirm' && <>
            <p className="server-state-intro"><strong>{session.game.title}</strong><span>{exitFlow.mode === 'account' ? 'State terakhir disimpan ke slot Simpan & keluar di server akun.' : 'State terakhir disimpan di browser ini pada slot Simpan & keluar khusus.'}</span></p>
            <p>{exitFlow.mode === 'account'
              ? <>Snapshot <strong>Simpan &amp; keluar</strong> terbaru untuk game/core ini akan diganti{exitSlotSave && !exitSlotSave.deleted ? ' (snapshot lama tetap dapat diunduh lewat Kelola simpanan sebelum diganti)' : ''}. Slot manual 1–3, Autosave, dan save dalam game tidak disentuh.</>
              : <>State native <code>.state</code> dan simpanan akun tidak disentuh. Simpanan browser dapat hilang bila data situs dibersihkan; fitur ini bukan jaminan lintas perangkat.</>}</p>
            <p className="notice">Setelah state tersimpan, player ditutup dan kamu kembali ke beranda. {exitFlow.mode === 'account' ? 'Untuk melanjutkan: buka game yang sama, mulai core, lalu Save state server → Muat pada Simpan & keluar.' : 'Untuk melanjutkan: buka game yang sama, mulai core, lalu tekan “Muat simpanan terakhir” di toolbar.'}</p>
            <div className="account-actions">
              <button className="button primary" onClick={() => void runSaveExit('all')}><Save size={16} />Simpan &amp; keluar</button>
              <button className="button secondary" onClick={closeExit}><ArrowLeft size={16} />Kembali ke game</button>
            </div>
          </>}
          {['capturing', 'saving', 'syncing', 'done'].includes(exitFlow.phase) && <p className="exit-status" role="status" aria-live="polite"><LoaderCircle size={18} className="spin" />{exitFlow.message || 'Menyiapkan Simpan & keluar…'}</p>}
          {exitFlow.phase === 'error' && <>
            <p className="server-status server-status--error" role="alert">{exitFlow.error}</p>
            <p className="notice">Player tetap terbuka. Snapshot state yang sudah diambil disimpan untuk retry; unduh cadangan bila perlu sebelum menutup tab.</p>
            <div className="account-actions">
              <button className="button primary" disabled={exitBusyState} onClick={() => void runSaveExit(exitFlow.retry ?? 'state')}>Coba lagi</button>
              {exitFlow.bytes && <button className="button secondary" disabled={exitBusyState} onClick={() => downloadState(exitFlow.bytes!, `${saveId}-simpan-keluar-cadangan`)}><Download size={16} />Unduh cadangan state</button>}
              <button className="button secondary" disabled={exitBusyState} onClick={closeExit}><ArrowLeft size={16} />Kembali ke game</button>
              <button className="text-link" disabled={exitBusyState} onClick={emergencyExit}><LogOut size={15} />Keluar tanpa save baru</button>
            </div>
          </>}
          {exitFlow.phase === 'partial' && <>
            <p className="server-status server-status--error" role="alert">{exitFlow.error}</p>
            <p className="notice">State sudah tersimpan dan tidak perlu diunggah ulang. Retry hanya mengulang sinkronisasi progres yang gagal.</p>
            <div className="account-actions">
              <button className="button primary" disabled={exitBusyState || progressRef.current.status === 'conflict'} onClick={() => void runSaveExit('progress')}>Coba sinkronkan progres</button>
              {exitFlow.bytes && <button className="button secondary" disabled={exitBusyState} onClick={() => downloadState(exitFlow.bytes!, `${saveId}-simpan-keluar-cadangan`)}><Download size={16} />Unduh cadangan state</button>}
              <button className="button secondary" disabled={exitBusyState} onClick={closeExit}><ArrowLeft size={16} />Kembali ke game</button>
              <button className="text-link" disabled={exitBusyState} onClick={emergencyExit}><LogOut size={15} />Keluar tanpa progres tersinkron</button>
            </div>
          </>}
        </div>
      </Dialog>, shell.current ?? document.body)}
    </div>
    {status && <p className="player-status" role="status"><LoaderCircle size={15} className="spin" />{status}</p>}
    {assetProgress && !error && !terminated && <div className="player-asset-progress" role="region" aria-label="Persiapan aset ROM/BIOS">
      {assetProgress.phase === 'downloading' && <progress aria-label={`Progres download ${assetProgress.kind.toUpperCase()}`} max={assetProgress.totalBytes} value={assetProgress.receivedBytes} />}
      <button className="button secondary small" onClick={onExit}>Batalkan persiapan</button>
    </div>}
    {assetNotice && !terminated && <p className="player-asset-notice" role="status" aria-label="Status cache ROM/BIOS">{assetNotice}</p>}
    <div className="player-note"><ShieldCheck size={16} /><span>{session.game.source === 'local' ? 'File tetap di perangkatmu.' : 'Dimuat dari server maindulu.'} Semua core berjalan lokal di browser.</span></div>
    {stateError && <p className="notice" role="alert">{stateError}</p>}
    {progressAvailable && !(account.status === 'authenticated' && account.user?.id !== owner) && <section className="progress-sync" aria-label="Sinkronisasi progres game">
      <p role="status" aria-live="polite">{!enabled && !terminated ? 'Sinkronisasi ditahan sampai sesi akun dapat dipastikan. Tidak dialihkan ke penyimpanan tamu.' : progress.message}</p>
      {metadata && <small>Core {session.consoleInfo.core} · {metadata.variant} · engine {metadata.engineVersion} · build {metadata.coreBuild.slice(0, 12)}</small>}
      <div className="account-actions"><button className="button secondary small" disabled={!enabled || !started.current || progress.status === 'saving' || progress.status === 'conflict'} onClick={() => void progressSync.current?.sync(true)}>Sinkronkan progres sekarang</button>
        {progress.status === 'conflict' && <button className="button primary small" disabled={!enabled || !!transfer || preparingTransfer} onClick={() => void openTransfer({ mode: 'conflict', kind: 'progress' })}>Tinjau konflik progres</button>}
        <button className="button secondary small" disabled={!enabled || !metadata || !!transfer || preparingTransfer || progress.status === 'conflict'} onClick={() => void openTransfer({ mode: 'import', kind: 'progress' })}>Impor progres</button>
        <button className="button secondary small" disabled={!progressSync.current?.snapshot() && (!enabled || !started.current)} onClick={() => void (async () => {
          try {
            const current = enabled && started.current ? await rpc('export-progress') : null
            const bytes = current && layout ? encodeGameSave({ layout, files: [{ key: 'sram', bytes: current }] }) : progressSync.current?.snapshot()
            if (bytes) downloadGameSave(bytes, (session.saveId ?? saveIdentity(session.game, session.consoleInfo.core)) + '-cadangan')
            else setProgress(v => ({ ...v, message: 'Game belum menghasilkan berkas progres untuk diunduh.' }))
          } catch (e) { setProgress(v => ({ ...v, message: e instanceof Error ? e.message : 'Ekspor progres gagal. Gunakan ekspor native emulator.' })) }
        })()}>Unduh cadangan progres</button></div>
      {session.consoleInfo.core === 'pcsx_rearmed' && <p className="notice">Ekspor dan pemulihan memcard aktif PS1 telah dikonfirmasi manual pada skenario pengguna. Dukungan di luar skenario tersebut masih percobaan. Hanya berkas save aktif core (.srm) yang dicakup; seluruh game/slot/card, varian, dan pergantian disk belum dinyatakan terverifikasi. Ekspor cadangan sebelum keluar.</p>}
      {session.consoleInfo.core === 'fceumm' && metadata?.variant === 'normal' && <p className="notice">Sinkronisasi NES varian normal belum diuji terpisah. Bukti otomatis M6 saat ini menggunakan varian legacy; unduh cadangan progres.</p>}
    </section>}
    {owner && !progressAvailable && <p className="notice">Sinkronisasi save dalam game belum tersedia untuk core/backend ini. Save akun sementara di memori; ekspor cadangan atau simpan state sebelum keluar.</p>}
    {owner && <ServerStates session={session} owner={owner} enabled={enabled} accountChanged={account.status === 'authenticated' && account.user?.id !== owner} metadata={metadata} rpc={rpc} show={saveOverlay && !transfer && !preparingTransfer && !exitFlow} onToggle={() => setSaveOverlay(!saveOverlay)} gameActive={gameRunning && !modalOpen} overlayContainer={shell.current} onAutosaveStatus={notifyAutosave} onTransfer={request => void openTransfer(request)} resolution={stateResolution} progressAvailable={progressAvailable} progressConflict={progress.status === 'conflict'} lock={stateLock.current!} handleRef={serverHandle} />}
    {!owner && supportsStates && <p className="player-asset-notice" role="status">Simpan &amp; keluar tamu menyimpan state di browser ini {guestExitAvailable ? 'dan snapshot terakhir tersedia' : 'saat kamu menekan tombolnya'}. Gunakan “Muat simpanan terakhir” di toolbar emulator untuk melanjutkan.</p>}
    {guestLoad && <p className="player-asset-notice" role="status" aria-live="polite">{guestLoad.busy && <LoaderCircle size={14} className="spin" />} {guestLoad.message}</p>}
    {!owner && account.status === 'authenticated' && <p className="notice">Sesi ini main sebagai tamu. Simpanan ada di browser. Mau simpanan ikut ke server? Masuk akun, lalu buka ulang game. Simpanan browser tidak otomatis diimpor.</p>}
    <button className="controls-toggle" aria-expanded={controls} onClick={() => setControls(!controls)}><Keyboard size={18} />Panduan kontrol & simpan progres<ChevronDown size={17} className={controls ? 'rotated' : ''} /></button>
    {controls && <div className="controls-panel"><p>Klik layar emulator agar input keyboard masuk ke permainan. Buka menu emulator untuk melihat atau memetakan kontrol sesuai console, atau menyalakan <strong>Layar lebar</strong> (Settings → Graphics Settings) bila ingin gambar stretched mengisi layar.</p><div className="key-grid"><span><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> Arah</span><span><kbd>Z</kbd><kbd>X</kbd> Tombol NES A/B</span><span><kbd>Enter</kbd> Start</span><span><kbd>Shift</kbd> Select</span></div><p><strong>Progres:</strong> save dalam game dan save state berbeda. Gunakan menu emulator untuk save/load serta ekspor cadangan. Riwayat maindulu hanya mencatat game yang dimainkan. Data browser dapat hilang saat penyimpanan situs dibersihkan.</p><p>Gamepad mengikuti dukungan browser; kontrol sentuh tersedia pada perangkat mobile. Core dan pemetaan tombol bisa berbeda.</p></div>}
  </div>
}
