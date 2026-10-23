import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronDown, Heart, Info, Keyboard, LoaderCircle, ShieldCheck } from 'lucide-react'
import type { ConsoleInfo, Game, Settings } from '../lib/domain'

export type LaunchSession = { id: string; game: Game; consoleInfo: ConsoleInfo; rom?: File; bios?: File; biosUrl?: string }

export default function Player({ session, settings, favorite, onFavorite, onStart, onExit, onWidescreen }: {
  session: LaunchSession; settings: Settings; favorite: boolean;
  onFavorite: () => void; onStart: () => void; onExit: () => void; onWidescreen: (widescreen: boolean) => void;
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

  useEffect(() => {
    let configured = false
    let timeout: ReturnType<typeof setTimeout>
    function receive(event: MessageEvent) {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow || event.data?.channel !== 'maindulu:player') return
      if (event.data.type === 'ready' && !configured) {
        configured = true
        frame.current?.contentWindow?.postMessage({ channel: 'maindulu:host', type: 'configure', sessionId: session.id, game: session.game, core: session.consoleInfo.core, rom: session.rom, bios: session.bios, biosUrl: session.biosUrl, volume: settings.volume / 100, widescreen: settings.widescreen === true }, location.origin)
        setStatus('Memuat engine dan core lokal…')
      }
      if (event.data.sessionId !== session.id) return
      if (event.data.type === 'started') { clearTimeout(timeout); setStatus(''); if (!started.current) { started.current = true; startCallback.current() } }
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
    return () => { clearTimeout(timeout); window.removeEventListener('message', receive); window.removeEventListener('beforeunload', warn) }
    // The initial volume is frozen for this session; changing settings affects the next session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  function exit() { onExit() }
  return <div className="player-page">
    <div className="player-heading"><button className="button secondary small" onClick={exit}><ArrowLeft size={17} />Kembali</button><div className="player-title"><h1>{session.game.title}</h1><span>{session.consoleInfo.shortName} <i>·</i> {session.game.source === 'local' ? 'ROM lokal' : 'Koleksi server'}</span></div><button className={`icon-button ${favorite ? 'is-favorite' : ''}`} onClick={onFavorite} aria-label={favorite ? 'Hapus dari favorit' : 'Tambahkan ke favorit'} aria-pressed={favorite}><Heart fill={favorite ? 'currentColor' : 'none'} size={21} /></button></div>
    <div className={`player-shell${widescreen ? ' is-widescreen' : ''}`}><iframe ref={frame} src="/player/index.html" title={`Emulator ${session.game.title}`} allow="autoplay; fullscreen; gamepad" allowFullScreen />{error && <div className="player-error" role="alert"><Info size={27} /><h2>Belum bisa mulai.</h2><p>{error}</p><button className="button primary" onClick={onExit}>Kembali dan coba lagi<ArrowLeft size={17} /></button></div>}</div>
    {status && <p className="player-status" role="status"><LoaderCircle size={15} className="spin" />{status}</p>}
    <div className="player-note"><ShieldCheck size={16} /><span>{session.game.source === 'local' ? 'File tetap di perangkatmu.' : 'Dimuat dari server maindulu.'} Semua core berjalan lokal di browser.</span></div>
    <button className="controls-toggle" aria-expanded={controls} onClick={() => setControls(!controls)}><Keyboard size={18} />Panduan kontrol & simpan progres<ChevronDown size={17} className={controls ? 'rotated' : ''} /></button>
    {controls && <div className="controls-panel"><p>Klik layar emulator agar input keyboard masuk ke permainan. Buka menu emulator untuk melihat atau memetakan kontrol sesuai console, atau menyalakan <strong>Layar lebar</strong> (Settings → Graphics Settings) bila ingin gambar stretched mengisi layar.</p><div className="key-grid"><span><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> Arah</span><span><kbd>Z</kbd><kbd>X</kbd> Tombol NES A/B</span><span><kbd>Enter</kbd> Start</span><span><kbd>Shift</kbd> Select</span></div><p><strong>Progres:</strong> save dalam game dan save state berbeda. Gunakan menu emulator untuk save/load serta ekspor cadangan. Riwayat maindulu hanya mencatat game yang dimainkan. Data browser dapat hilang saat penyimpanan situs dibersihkan.</p><p>Gamepad mengikuti dukungan browser; kontrol sentuh tersedia pada perangkat mobile. Core dan pemetaan tombol bisa berbeda.</p></div>}
  </div>
}
