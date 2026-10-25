import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, ChevronDown, Heart, Info, Keyboard, LoaderCircle, ShieldCheck } from 'lucide-react'
import type { ConsoleInfo, Game, Settings } from '../lib/domain'
import type { AccountState } from '../lib/account'
import type { StateMetadata } from '../lib/saves'
import { readStateMetadata } from '../lib/saves'
import { createSessionId } from '../lib/identity'
import ServerStates from './ServerStates'
import type { AutosaveStatus } from './ServerStates'
import { decodeGameSave, encodeGameSave, gameSaveLayout } from '../lib/game-save-format'
import { downloadGameSave, GameSaveClient, GameSaveSync } from '../lib/game-saves'
import type { ProgressView } from '../lib/game-saves'
import type { ServerGameSave } from '../lib/game-saves'
import SaveTransfer from './SaveTransfer'
import type { TransferRequest } from './SaveTransfer'
import { createPortal } from 'react-dom'

export type LaunchSession = { id: string; game: Game; consoleInfo: ConsoleInfo; rom?: File; bios?: File; biosUrl?: string; storageOwner?: string | null; gameSaves?: boolean }

export default function Player({ session, settings, favorite, onFavorite, onStart, onExit, onWidescreen, account, registerExitGuard, onRestart }: {
  session: LaunchSession; settings: Settings; favorite: boolean;
  onFavorite: () => void; onStart: () => void; onExit: () => void; onWidescreen: (widescreen: boolean) => void;
  account: AccountState; onRestart: () => void;
  registerExitGuard: (guard: (() => Promise<boolean>) | null) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const shell = useRef<HTMLDivElement>(null)
  const started = useRef(false)
  const [status, setStatus] = useState('Menyiapkan ruang bermain…')
  const [error, setError] = useState('')
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
  const modalOpen = saveOverlay || !!transfer || preparingTransfer
  const [gameRunning, setGameRunning] = useState(false)
  const [saveNotice, setSaveNotice] = useState<{ kind: 'saving' | 'success' | 'error'; message: string } | null>(null)
  const owner = session.storageOwner
  const ownerName = useRef(account.user && account.user.id === owner ? account.user.username : '')
  const layout = gameSaveLayout(session.consoleInfo.core)
  const progressAvailable = !!owner && session.gameSaves === true && !!layout
  const progressSync = useRef<GameSaveSync | null>(null)
  const [progress, setProgress] = useState<ProgressView>({ status: 'loading', message: 'Menyiapkan progres akun…', pending: false })
  const [progressRetry, setProgressRetry] = useState(0)
  const enabled = !!owner && !terminated && account.status === 'authenticated' && account.user?.id === owner
  const active = useRef(enabled)
  active.current = enabled
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
  const requests = useRef(new Map<string, { type: 'export-state' | 'import-state' | 'export-progress'; resolve: (bytes: Uint8Array | null) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>())
  useEffect(() => {
    if (owner && (account.status === 'anonymous' || account.status === 'authenticated' && account.user?.id !== owner)) setTerminated(true)
    if (owner && account.status === 'authenticated' && account.user?.id !== owner) progressSync.current?.close(true)
    else if (owner && account.status === 'anonymous') progressSync.current?.close(false)
  }, [owner, account.status, account.user?.id])
  const rpc = useCallback((type: 'export-state' | 'import-state' | 'export-progress', bytes?: Uint8Array) => new Promise<Uint8Array | null>((resolve, reject) => {
    if (!active.current || !frame.current?.contentWindow) { reject(new Error('Player akun dihentikan. Buka ulang permainan setelah login.')); return }
    const requestId = createSessionId()
    const timer = setTimeout(() => { requests.current.delete(requestId); reject(new Error('Operasi state terlalu lama. Unduh cadangan sebelum keluar bila tersedia.')) }, 15000)
    requests.current.set(requestId, { type, resolve, reject, timer })
    frame.current.contentWindow.postMessage({ channel: 'maindulu:host', type, sessionId: session.id, requestId, ...(bytes ? { bytes } : {}) }, location.origin)
  }), [session.id])
  const liveRef = useRef(true)
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

  useEffect(() => {
    let configured = false
    let disposed = false
    let sync: GameSaveSync | null = null
    let timeout: ReturnType<typeof setTimeout>
    setError('')
    setStatus('Menyiapkan ruang bermain…')
    async function configure() {
      let initialProgress = null
      if (progressAvailable && owner && layout) {
        sync = new GameSaveSync(new GameSaveClient(owner), { gameId: session.game.id, consoleId: session.consoleInfo.id, core: session.consoleInfo.core, title: session.game.title }, async () => {
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
      if (disposed || owner && !active.current) return
      frame.current?.contentWindow?.postMessage({ channel: 'maindulu:host', type: 'configure', sessionId: session.id, game: session.game, core: session.consoleInfo.core, rom: session.rom, bios: session.bios, biosUrl: session.biosUrl, volume: settings.volume / 100, widescreen: settings.widescreen === true, memorySaves: !!owner, gameSaves: progressAvailable, initialProgress }, location.origin)
      setStatus('Memuat engine dan core lokal…')
    }
    const syncFullscreen = () => {
      frame.current?.contentWindow?.postMessage({ channel: 'maindulu:host', type: 'fullscreen-state', sessionId: session.id, fullscreen: !!shell.current && document.fullscreenElement === shell.current }, location.origin)
    }
    async function toggleFullscreen(fullscreen: boolean) {
      try {
        const target = shell.current
        if (fullscreen) {
          if (!target?.requestFullscreen) throw new Error('Fullscreen tidak tersedia.')
          await target.requestFullscreen()
        } else if (document.fullscreenElement === target) await document.exitFullscreen()
      } catch {
        setSaveNotice({ kind: 'error', message: 'Fullscreen tidak tersedia. Coba lagi.' })
      } finally { syncFullscreen() }
    }
    function receive(event: MessageEvent) {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow || event.data?.channel !== 'maindulu:player') return
      if (event.data.type === 'ready' && !configured) {
        configured = true
        void configure().catch(e => { if (!disposed) { clearTimeout(timeout); setStatus(''); setError(e instanceof Error ? e.message : 'Pengambilan progres awal gagal. Game tidak dimulai.') } })
      }
      if (event.data.sessionId !== session.id) return
      // Fullscreen the shared player shell, not the iframe alone: React save
      // dialogs and notices must be descendants of the fullscreen element.
      if (event.data.type === 'fullscreen-request' && active.current && typeof event.data.fullscreen === 'boolean') {
        void toggleFullscreen(event.data.fullscreen)
      }
      // The "Save state server" button lives inside the emulator toolbar; the
      // bridge forwards its click so the overlay can attach above the player.
      if (event.data.type === 'state-server') { clearTimeout(timeout); setStatus(''); setSaveOverlay(true) }
      // Engine patch reports play/pause transitions; drives autosave gating.
      if (event.data.type === 'session-running' && typeof event.data.running === 'boolean') setGameRunning(event.data.running)
      if (event.data.type === 'started') {
        clearTimeout(timeout); setStatus('')
        setGameRunning(true)
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
        if (!active.current) request.reject(new Error('Sesi player berubah; hasil state diabaikan.'))
        else if (typeof event.data.error === 'string') request.reject(new Error(event.data.error))
        else if (request.type === 'export-state' && event.data.bytes instanceof Uint8Array && event.data.bytes.length >= 32 && event.data.bytes.length <= 64 * 1024 * 1024) request.resolve(event.data.bytes as Uint8Array)
        else if (request.type === 'export-progress' && (event.data.bytes === null || event.data.bytes instanceof Uint8Array && event.data.bytes.length > 0 && event.data.bytes.length <= 8 * 1024 * 1024)) request.resolve(event.data.bytes)
        else if (request.type === 'import-state' && event.data.applied === true) request.resolve(null)
        else request.reject(new Error('Respons state player tidak valid.'))
      }
      if (event.data.type === 'loaded') { clearTimeout(timeout); setStatus('Engine siap. Klik “Mulai bermain” di layar.'); syncFullscreen() }
      if (event.data.type === 'starting') {
        setStatus('Memuat ROM dan core dari server maindulu…')
        timeout = setTimeout(() => { setStatus(''); setError('Pemuatan terlalu lama. Periksa ROM/BIOS dan koneksi ke server maindulu, lalu coba lagi.') }, 90000)
      }
      if (event.data.type === 'error') { clearTimeout(timeout); setStatus(''); setError(String(event.data.message || 'Engine tidak dapat dimuat.')) }
      if (event.data.type === 'progress-error') setProgress({ status: 'failed', message: String(event.data.message || 'Layout progres tidak didukung.'), pending: false })
      if (event.data.type === 'display' && typeof event.data.widescreen === 'boolean' && event.data.widescreen !== widescreenValue.current) {
        widescreenValue.current = event.data.widescreen
        setWidescreen(event.data.widescreen)
        widescreenCallback.current(event.data.widescreen)
      }
    }
    window.addEventListener('message', receive)
    document.addEventListener('fullscreenchange', syncFullscreen)
    timeout = setTimeout(() => { setStatus(''); setError('Player belum siap. Periksa koneksi ke server maindulu dan kelengkapan aset engine, lalu buka game kembali.') }, 90000)
    const warn = (e: BeforeUnloadEvent) => { if (started.current) e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => {
      disposed = true; sync?.close(); progressSync.current = null
      clearTimeout(timeout); window.removeEventListener('message', receive); window.removeEventListener('beforeunload', warn); document.removeEventListener('fullscreenchange', syncFullscreen); liveRef.current = false
      for (const request of requests.current.values()) { clearTimeout(request.timer); request.reject(new Error('Sesi player ditutup.')) }
      requests.current.clear()
    }
    // The initial volume is frozen for this session; changing settings affects the next session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, progressRetry])

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
    <div ref={shell} className={`player-shell${widescreen ? ' is-widescreen' : ''}`}>{!terminated && <iframe key={progressRetry} ref={frame} src="/player/index.html" title={`Emulator ${session.game.title}`} allow="autoplay; fullscreen; gamepad" allowFullScreen />}{(error || terminated) && <div className="player-error" role="alert"><Info size={27} /><h2>{terminated ? 'Sesi akun berakhir.' : 'Belum bisa mulai.'}</h2><p>{terminated ? 'Player dibersihkan untuk mencegah pencampuran data akun. Unduh snapshot tertunda di bawah bila tersedia, lalu login dan buka game kembali.' : error}</p>{!terminated && !started.current && progressAvailable && <button className="button secondary" onClick={() => setProgressRetry(v => v + 1)}>Coba ambil progres lagi</button>}<button className="button primary" onClick={onExit}>Kembali dan coba lagi<ArrowLeft size={17} /></button></div>}
      {enabled && !saveOverlay && saveNotice && <div className={`player-save-notice player-save-notice--${saveNotice.kind}`} role="status" aria-live="polite" aria-atomic="true">
        {saveNotice.kind === 'saving' ? <LoaderCircle size={15} className="spin" /> : saveNotice.kind === 'success' ? <Check size={15} /> : <Info size={15} />}
        <span>{saveNotice.message}</span>
      </div>}
      {progressAvailable && enabled && ['failed', 'conflict', 'stopped'].includes(progress.status) && <div className="player-progress-notice" role="alert">Progres belum tersinkron. {progress.message} Gunakan kontrol progres di bawah player; keluar fullscreen bila perlu.</div>}
      {transfer && owner && !terminated && !(account.status === 'authenticated' && account.user?.id !== owner) && metadata && createPortal(<SaveTransfer owner={owner} ownerName={ownerName.current} enabled={enabled} request={transfer}
        target={{ gameId: session.game.id, consoleId: session.consoleInfo.id, core: session.consoleInfo.core, title: session.game.title }}
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
    </div>
    {status && <p className="player-status" role="status"><LoaderCircle size={15} className="spin" />{status}</p>}
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
            if (bytes) downloadGameSave(bytes, session.game.id + '-cadangan')
            else setProgress(v => ({ ...v, message: 'Game belum menghasilkan berkas progres untuk diunduh.' }))
          } catch (e) { setProgress(v => ({ ...v, message: e instanceof Error ? e.message : 'Ekspor progres gagal. Gunakan ekspor native emulator.' })) }
        })()}>Unduh cadangan progres</button></div>
      {session.consoleInfo.core === 'pcsx_rearmed' && <p className="notice">Ekspor dan pemulihan memcard aktif PS1 telah dikonfirmasi manual pada skenario pengguna. Dukungan di luar skenario tersebut masih percobaan. Hanya berkas save aktif core (.srm) yang dicakup; seluruh game/slot/card, varian, dan pergantian disk belum dinyatakan terverifikasi. Ekspor cadangan sebelum keluar.</p>}
      {session.consoleInfo.core === 'fceumm' && metadata?.variant === 'normal' && <p className="notice">Sinkronisasi NES varian normal belum diuji terpisah. Bukti otomatis M6 saat ini menggunakan varian legacy; unduh cadangan progres.</p>}
    </section>}
    {owner && !progressAvailable && <p className="notice">Sinkronisasi save dalam game belum tersedia untuk core/backend ini. Save akun sementara di memori; ekspor cadangan atau simpan state sebelum keluar.</p>}
    {owner && <ServerStates session={session} owner={owner} enabled={enabled} accountChanged={account.status === 'authenticated' && account.user?.id !== owner} metadata={metadata} rpc={rpc} show={saveOverlay && !transfer && !preparingTransfer} onToggle={() => setSaveOverlay(!saveOverlay)} gameActive={gameRunning && !modalOpen} overlayContainer={shell.current} onAutosaveStatus={notifyAutosave} onTransfer={request => void openTransfer(request)} resolution={stateResolution} progressAvailable={progressAvailable} progressConflict={progress.status === 'conflict'} />}
    {!owner && account.status === 'authenticated' && <p className="notice">Sesi ini dimulai sebagai tamu. Buka ulang game untuk memakai save state akun; save browser tidak otomatis diimpor.</p>}
    <button className="controls-toggle" aria-expanded={controls} onClick={() => setControls(!controls)}><Keyboard size={18} />Panduan kontrol & simpan progres<ChevronDown size={17} className={controls ? 'rotated' : ''} /></button>
    {controls && <div className="controls-panel"><p>Klik layar emulator agar input keyboard masuk ke permainan. Buka menu emulator untuk melihat atau memetakan kontrol sesuai console, atau menyalakan <strong>Layar lebar</strong> (Settings → Graphics Settings) bila ingin gambar stretched mengisi layar.</p><div className="key-grid"><span><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> Arah</span><span><kbd>Z</kbd><kbd>X</kbd> Tombol NES A/B</span><span><kbd>Enter</kbd> Start</span><span><kbd>Shift</kbd> Select</span></div><p><strong>Progres:</strong> save dalam game dan save state berbeda. Gunakan menu emulator untuk save/load serta ekspor cadangan. Riwayat maindulu hanya mencatat game yang dimainkan. Data browser dapat hilang saat penyimpanan situs dibersihkan.</p><p>Gamepad mengikuti dukungan browser; kontrol sentuh tersedia pada perangkat mobile. Core dan pemetaan tombol bisa berbeda.</p></div>}
  </div>
}
