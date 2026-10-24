import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronDown, Heart, Info, Keyboard, LoaderCircle, ShieldCheck } from 'lucide-react'
import type { ConsoleInfo, Game, Settings } from '../lib/domain'
import type { AccountState } from '../lib/account'
import type { StateMetadata } from '../lib/saves'
import { readStateMetadata } from '../lib/saves'
import { createSessionId } from '../lib/identity'
import ServerStates from './ServerStates'

export type LaunchSession = { id: string; game: Game; consoleInfo: ConsoleInfo; rom?: File; bios?: File; biosUrl?: string; storageOwner?: string | null }

export default function Player({ session, settings, favorite, onFavorite, onStart, onExit, onWidescreen, account }: {
  session: LaunchSession; settings: Settings; favorite: boolean;
  onFavorite: () => void; onStart: () => void; onExit: () => void; onWidescreen: (widescreen: boolean) => void;
  account: AccountState;
}) {
  const frame = useRef<HTMLIFrameElement>(null)
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
  const [gameRunning, setGameRunning] = useState(false)
  const owner = session.storageOwner
  const enabled = !!owner && !terminated && account.status === 'authenticated' && account.user?.id === owner
  const active = useRef(enabled)
  active.current = enabled
  const requests = useRef(new Map<string, { type: 'export-state' | 'import-state'; resolve: (bytes: Uint8Array | null) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>())
  useEffect(() => {
    if (owner && (account.status === 'anonymous' || account.status === 'authenticated' && account.user?.id !== owner)) setTerminated(true)
  }, [owner, account.status, account.user?.id])
  const rpc = useCallback((type: 'export-state' | 'import-state', bytes?: Uint8Array) => new Promise<Uint8Array | null>((resolve, reject) => {
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
    if (!saveOverlay) return
    const win = frame.current?.contentWindow
    if (!win) return
    win.postMessage({ channel: 'maindulu:host', type: 'pause-session', sessionId: session.id }, location.origin)
    return () => { frame.current?.contentWindow?.postMessage({ channel: 'maindulu:host', type: 'resume-session', sessionId: session.id }, location.origin) }
  }, [saveOverlay, session.id])

  useEffect(() => {
    let configured = false
    let timeout: ReturnType<typeof setTimeout>
    function receive(event: MessageEvent) {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow || event.data?.channel !== 'maindulu:player') return
      if (event.data.type === 'ready' && !configured) {
        configured = true
        frame.current?.contentWindow?.postMessage({ channel: 'maindulu:host', type: 'configure', sessionId: session.id, game: session.game, core: session.consoleInfo.core, rom: session.rom, bios: session.bios, biosUrl: session.biosUrl, volume: settings.volume / 100, widescreen: settings.widescreen === true, memorySaves: !!session.storageOwner }, location.origin)
        setStatus('Memuat engine dan core lokal…')
      }
      if (event.data.sessionId !== session.id) return
      // The "Save state server" button lives inside the emulator toolbar; the
      // bridge forwards its click so the overlay can attach above the player.
      if (event.data.type === 'state-server') { clearTimeout(timeout); setStatus(''); setSaveOverlay(true) }
      // Engine patch reports play/pause transitions; drives autosave gating.
      if (event.data.type === 'session-running' && typeof event.data.running === 'boolean') setGameRunning(event.data.running)
      if (event.data.type === 'started') {
        clearTimeout(timeout); setStatus('')
        setGameRunning(true)
        if (session.storageOwner) {
          const value = event.data.supportsStates === true ? readStateMetadata(event.data.metadata) : null
          setMetadata(value)
          if (!value) setStateError('Core tidak mendukung state atau metadata build tidak tersedia. Save server tidak diaktifkan.')
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
        else if (request.type === 'import-state' && event.data.applied === true) request.resolve(null)
        else request.reject(new Error('Respons state player tidak valid.'))
      }
      if (event.data.type === 'loaded') { clearTimeout(timeout); setStatus('Engine siap. Klik “Mulai bermain” di layar.') }
      if (event.data.type === 'starting') {
        setStatus('Memuat ROM dan core dari server maindulu…')
        timeout = setTimeout(() => { setStatus(''); setError('Pemuatan terlalu lama. Periksa ROM/BIOS dan koneksi ke server maindulu, lalu coba lagi.') }, 90000)
      }
      if (event.data.type === 'error') { clearTimeout(timeout); setStatus(''); setError(String(event.data.message || 'Engine tidak dapat dimuat.')) }
      if (event.data.type === 'display' && typeof event.data.widescreen === 'boolean' && event.data.widescreen !== widescreenValue.current) {
        widescreenValue.current = event.data.widescreen
        setWidescreen(event.data.widescreen)
        widescreenCallback.current(event.data.widescreen)
      }
    }
    window.addEventListener('message', receive)
    timeout = setTimeout(() => { setStatus(''); setError('Player belum siap. Periksa koneksi ke server maindulu dan kelengkapan aset engine, lalu buka game kembali.') }, 90000)
    const warn = (e: BeforeUnloadEvent) => { if (started.current) e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => {
      clearTimeout(timeout); window.removeEventListener('message', receive); window.removeEventListener('beforeunload', warn); liveRef.current = false
      for (const request of requests.current.values()) { clearTimeout(request.timer); request.reject(new Error('Sesi player ditutup.')) }
      requests.current.clear()
    }
    // The initial volume is frozen for this session; changing settings affects the next session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  function exit() { onExit() }
  return <div className="player-page">
    <div className="player-heading"><button className="button secondary small" onClick={exit}><ArrowLeft size={17} />Kembali</button><div className="player-title"><h1>{session.game.title}</h1><span>{session.consoleInfo.shortName} <i>·</i> {session.game.source === 'local' ? 'ROM lokal' : 'Koleksi server'}</span></div><button className={`icon-button ${favorite ? 'is-favorite' : ''}`} onClick={onFavorite} aria-label={favorite ? 'Hapus dari favorit' : 'Tambahkan ke favorit'} aria-pressed={favorite}><Heart fill={favorite ? 'currentColor' : 'none'} size={21} /></button></div>
    <div className={`player-shell${widescreen ? ' is-widescreen' : ''}`}>{!terminated && <iframe ref={frame} src="/player/index.html" title={`Emulator ${session.game.title}`} allow="autoplay; fullscreen; gamepad" allowFullScreen />}{(error || terminated) && <div className="player-error" role="alert"><Info size={27} /><h2>{terminated ? 'Sesi akun berakhir.' : 'Belum bisa mulai.'}</h2><p>{terminated ? 'Player dibersihkan untuk mencegah pencampuran data akun. Unduh snapshot tertunda di bawah bila tersedia, lalu login dan buka game kembali.' : error}</p><button className="button primary" onClick={onExit}>Kembali dan coba lagi<ArrowLeft size={17} /></button></div>}</div>
    {status && <p className="player-status" role="status"><LoaderCircle size={15} className="spin" />{status}</p>}
    <div className="player-note"><ShieldCheck size={16} /><span>{session.game.source === 'local' ? 'File tetap di perangkatmu.' : 'Dimuat dari server maindulu.'} Semua core berjalan lokal di browser.</span></div>
    {stateError && <p className="notice" role="alert">{stateError}</p>}
    {owner && <ServerStates session={session} owner={owner} enabled={enabled} accountChanged={account.status === 'authenticated' && account.user?.id !== owner} metadata={metadata} rpc={rpc} show={saveOverlay} onToggle={() => setSaveOverlay(!saveOverlay)} gameActive={gameRunning && !saveOverlay} />}
    {!owner && account.status === 'authenticated' && <p className="notice">Sesi ini dimulai sebagai tamu. Buka ulang game untuk memakai save state akun; save browser tidak otomatis diimpor.</p>}
    <button className="controls-toggle" aria-expanded={controls} onClick={() => setControls(!controls)}><Keyboard size={18} />Panduan kontrol & simpan progres<ChevronDown size={17} className={controls ? 'rotated' : ''} /></button>
    {controls && <div className="controls-panel"><p>Klik layar emulator agar input keyboard masuk ke permainan. Buka menu emulator untuk melihat atau memetakan kontrol sesuai console, atau menyalakan <strong>Layar lebar</strong> (Settings → Graphics Settings) bila ingin gambar stretched mengisi layar.</p><div className="key-grid"><span><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> Arah</span><span><kbd>Z</kbd><kbd>X</kbd> Tombol NES A/B</span><span><kbd>Enter</kbd> Start</span><span><kbd>Shift</kbd> Select</span></div><p><strong>Progres:</strong> save dalam game dan save state berbeda. Gunakan menu emulator untuk save/load serta ekspor cadangan. Riwayat maindulu hanya mencatat game yang dimainkan. Data browser dapat hilang saat penyimpanan situs dibersihkan.</p><p>Gamepad mengikuti dukungan browser; kontrol sentuh tersedia pada perangkat mobile. Core dan pemetaan tombol bisa berbeda.</p></div>}
  </div>
}
