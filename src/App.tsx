import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useBlocker, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowDown, ArrowRight, ArrowUpRight, Check, ChevronRight, CircleHelp, Clock3, Gamepad2, HardDrive, Heart, House, Keyboard, Leaf, Menu, Monitor, Search, Settings2, ShieldCheck, Sparkles, Upload, Volume2, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import ConsoleArt from './components/ConsoleArt'
import GameCard from './components/GameCard'
import SetupDialog from './components/SetupDialog'
import type { SetupSelection } from './components/SetupDialog'
import Player from './components/Player'
import type { LaunchSession } from './components/Player'
import { DEFAULT_SETTINGS, STORAGE_KEYS, isSafeLocalUrl, readGames, readSettings, recordHistory, toggleFavorite } from './lib/domain'
import type { Bios, ConsoleInfo, Game } from './lib/domain'
import { useStored } from './lib/storage'
import { useBackendStatus } from './lib/useBackendStatus'
import BackendStatus from './components/BackendStatus'
import { useAccount } from './lib/useAccount'
import AccountDialog from './components/AccountDialog'

const navigation: { path: string; title: string; icon: LucideIcon }[] = [
  { path: '/', title: 'Beranda', icon: House },
  { path: '/console', title: 'Jelajahi console', icon: Gamepad2 },
  { path: '/riwayat', title: 'Terakhir dimainkan', icon: Clock3 },
  { path: '/favorit', title: 'Favoritku', icon: Heart },
  { path: '/cara-bermain', title: 'Cara bermain', icon: CircleHelp },
  { path: '/pengaturan', title: 'Pengaturan', icon: Settings2 },
]

function PageHeading({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: React.ReactNode }) {
  return <div className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{children}</div>
}

function EmptyState({ icon: Icon = Gamepad2, title, text, action, onClick }: { icon?: LucideIcon; title: string; text: string; action?: string; onClick?: () => void }) {
  return <div className="empty-state"><div className="empty-icon"><Icon size={29} strokeWidth={1.4} /></div><h2>{title}</h2><p>{text}</p>{action && <button className="button primary" onClick={onClick}>{action}<ArrowRight size={17} /></button>}</div>
}

export default function App() {
  const backend = useBackendStatus()
  const accountsEnabled = backend.state.status === 'online' && backend.state.health.capabilities.accounts
  const account = useAccount(accountsEnabled)
  const [accountOpen, setAccountOpen] = useState(false)
  const [consoles, setConsoles] = useState<ConsoleInfo[]>([])
  const [games, setGames] = useState<Game[]>([])
  const [biosList, setBiosList] = useState<Bios[]>([])
  const [loading, setLoading] = useState(true)
  const [catalogError, setCatalogError] = useState('')
  const [catalogRetry, setCatalogRetry] = useState(0)
  const [settings, setSettings, settingsBlocked] = useStored(STORAGE_KEYS.settings, readSettings)
  const [favorites, setFavorites, favoritesBlocked] = useStored(STORAGE_KEYS.favorites, readGames)
  const [history, setHistory, historyBlocked] = useStored(STORAGE_KEYS.history, readGames)
  const [selection, setSelection] = useState<SetupSelection | null>(null)
  const [session, setSession] = useState<LaunchSession | null>(null)
  const [gameStarted, setGameStarted] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [mobile, setMobile] = useState(() => matchMedia('(max-width: 760px)').matches)
  const [toast, setToast] = useState('')
  const main = useRef<HTMLElement>(null)
  const sidebar = useRef<HTMLElement>(null)
  const location = useLocation()
  const navigate = useNavigate()
  const exitGuard = useRef<(() => Promise<boolean>) | null>(null)
  const checkingExit = useRef(false)
  const registerExitGuard = useCallback((guard: (() => Promise<boolean>) | null) => { exitGuard.current = guard }, [])
  const blocker = useBlocker(({ currentLocation, nextLocation }) => gameStarted && !!session && currentLocation.pathname === '/main' && nextLocation.pathname !== '/main')

  useEffect(() => {
    if (blocker.state !== 'blocked' || checkingExit.current) return
    checkingExit.current = true
    void (async () => {
      try {
        if (!window.confirm('Keluar dari permainan? Save state dan progres dalam game berbeda. Pastikan snapshot state yang belum terkonfirmasi sudah dicadangkan.')) { blocker.reset(); return }
        if (exitGuard.current && !await exitGuard.current()) { blocker.reset(); return }
        blocker.proceed()
      } catch { blocker.reset(); setToast('Progres belum dapat diperiksa. Cadangkan sebelum keluar.') }
      finally { checkingExit.current = false }
    })()
  }, [blocker])
  useEffect(() => { if (location.pathname !== '/main') { setSession(null); setGameStarted(false) } }, [location.pathname])

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      setLoading(true); setCatalogError('')
      try {
        const response = await Promise.all(['consoles', 'games', 'bios'].map(async name => {
          const r = await fetch(`/catalog/${name}.json`, { signal: controller.signal })
          if (!r.ok) throw new Error('Katalog belum dapat dimuat. Periksa koneksi ke server maindulu.')
          return r.json()
        }))
        const c: ConsoleInfo[] = Array.isArray(response[0]) ? response[0].filter((v: ConsoleInfo) => v && typeof v.id === 'string' && typeof v.name === 'string' && typeof v.core === 'string' && Array.isArray(v.extensions) && typeof v.shortName === 'string' && typeof v.family === 'string') : []
        if (!c.length) throw new Error('Manifest console kosong atau tidak valid.')
        setConsoles(c)
        setGames(readGames(response[1]).filter(g => c.some(console => console.id === g.consoleId)))
        setBiosList(Array.isArray(response[2]) ? response[2].filter((v: Bios) => v && typeof v.id === 'string' && typeof v.name === 'string' && c.some(console => console.id === v.consoleId) && isSafeLocalUrl(v.url)) : [])
      } catch (e) { if (!controller.signal.aborted) setCatalogError(e instanceof Error ? e.message : 'Katalog gagal dimuat.') }
      finally { if (!controller.signal.aborted) setLoading(false) }
    }
    void load()
    return () => controller.abort()
  }, [catalogRetry])

  useEffect(() => { setDrawer(false); main.current?.focus(); window.scrollTo({ top: 0 }); document.title = `${navigation.find(n => n.path === location.pathname)?.title || 'Ruang bermain'} — maindulu` }, [location.pathname])
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3200); return () => clearTimeout(timer) }, [toast])
  useEffect(() => {
    const media = matchMedia('(max-width: 760px)')
    const change = () => { setMobile(media.matches); if (!media.matches) setDrawer(false) }
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  useEffect(() => {
    if (!drawer || !mobile) return
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    sidebar.current?.querySelector<HTMLElement>('a')?.focus()
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer(false)
      if (e.key !== 'Tab') return
      const items = sidebar.current?.querySelectorAll<HTMLElement>('a[href],button')
      if (!items?.length) return
      const first = items[0], last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', close)
    return () => { document.body.style.overflow = overflow; window.removeEventListener('keydown', close); previous?.focus() }
  }, [drawer, mobile])

  function open(selection: SetupSelection = {}) {
    if (session && gameStarted && !window.confirm('Buka permainan lain? Sesi sekarang akan berakhir saat game baru dimulai. Cadangkan save terlebih dahulu.')) return
    setSelection(selection)
  }
  function favorite(game: Game) { const exists = favorites.some(g => g.id === game.id); setFavorites(previous => toggleFavorite(previous, game)); setToast(exists ? 'Game dihapus dari Favoritku.' : 'Satu kenangan masuk Favoritku.') }
  async function launch(next: LaunchSession) {

    if (session && gameStarted && exitGuard.current && !await exitGuard.current()) return false
    if ((account.state.status === 'checking' || account.state.status === 'unavailable') && !window.confirm('Sesi akun belum dapat dipastikan. Mulai sebagai tamu dengan save browser? Untuk save server, batalkan dan periksa akun dahulu.')) return false
    setSelection(null); setGameStarted(false); setSession({ ...next, storageOwner: account.state.status === 'authenticated' && backend.state.status === 'online' && backend.state.health.capabilities.serverSaves ? account.state.user!.id : null, gameSaves: backend.state.status === 'online' && backend.state.health.capabilities.gameSaves === true }); navigate('/main')
    return true
  }
  function leave() { navigate('/') }
  function cards(list: Game[], showTime = false) {
    return <div className="game-grid">{list.map(game => <GameCard key={game.id} game={game} consoleInfo={consoles.find(c => c.id === game.consoleId)} favorite={favorites.some(g => g.id === game.id)} onFavorite={() => favorite(game)} onOpen={() => open({ game })} showTime={showTime} />)}</div>
  }

  const headerTitle = navigation.find(n => n.path === location.pathname)?.title || 'Ruang bermain'
  return <div className="app-shell">
    <a className="skip-link" href="#konten">Lewati ke konten</a>
    {drawer && <button className="drawer-scrim" aria-label="Tutup navigasi" onClick={() => setDrawer(false)} />}
    <aside ref={sidebar} className={`sidebar ${drawer ? 'is-open' : ''}`} aria-label="Navigasi utama" inert={mobile && !drawer}>
      <button className="drawer-close icon-button" aria-label="Tutup navigasi" onClick={() => setDrawer(false)}><X size={19} /></button>
      <Link to="/" className="brand" aria-label="maindulu, beranda"><img src="/assets/maindulu.svg" alt="" width="39" height="39" /><span>maindulu<span className="brand-dot">.</span></span></Link>
      <span className="sidebar-caption">RUANG NOSTALGIAMU</span>
      <nav>{navigation.map(({ path, title, icon: Icon }, i) => <NavLink key={path} to={path} end={path === '/'} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''} ${i === 4 ? 'nav-separated' : ''}`}><Icon size={19} strokeWidth={1.7} /><span>{title}</span>{path === '/favorit' && favorites.length > 0 && <span className="nav-count">{favorites.length}</span>}</NavLink>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><div className="note-icon"><Leaf size={19} /></div><strong>Rehat itu perlu.</strong><p>Lima menit juga cukup<br />buat jadi anak kecil lagi.</p><span>TAKE A LITTLE PLAY BREAK <ArrowUpRight size={12} /></span></div><div className="engine-status"><span className="status-dot" /><span>Engine lokal <b>v4.2.3</b></span><ShieldCheck size={14} /></div></div>
    </aside>
    <div className="workspace" inert={mobile && drawer}>
      <header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" aria-label="Buka navigasi" aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>{drawer ? <X size={21} /> : <Menu size={21} />}</button><span className="breadcrumb">Ruang mainmu <ChevronRight size={13} /><strong>{headerTitle}</strong></span></div><div className="topbar-actions"><span className="private-badge"><ShieldCheck size={14} />{session?.storageOwner ? 'Save state akun · manual' : 'Progres di browsermu'}</span>{accountsEnabled && <button className="button secondary small account-trigger" disabled={account.state.status === 'checking' || !!selection || !!session} title={session ? 'Keluar dari permainan sebelum mengelola akun.' : undefined} aria-label={account.state.status === 'authenticated' ? `Akun ${account.state.user?.username}` : 'Masuk ke akun'} onClick={() => setAccountOpen(true)}>{account.state.status === 'authenticated' ? account.state.user?.username : 'Masuk'}</button>}<button className="button secondary small upload-top" onClick={() => open()} disabled={loading || !!catalogError}><Upload size={15} />Buka ROM</button></div></header>
      <main id="konten" ref={main} tabIndex={-1} className={location.pathname === '/main' ? 'main-content playing' : 'main-content'}>
        {(settingsBlocked || favoritesBlocked || historyBlocked) && <p className="notice" role="alert"><InfoIcon />Penyimpanan browser dibatasi. Perubahan hanya berlaku selama tab ini terbuka.</p>}
        {loading ? <div className="catalog-loading" role="status"><div className="loading-mark"><Gamepad2 size={29} /></div>Menyiapkan ruang nostalgiamu…</div> : catalogError ? <EmptyState title="Koneksi sedang istirahat." text={catalogError} action="Coba lagi" onClick={() => setCatalogRetry(n => n + 1)} /> : <Routes>
          <Route path="/" element={<>
            <section className="hero" aria-labelledby="hero-title"><img className="hero-art" src="/assets/retro-world.svg" alt="Ilustrasi dunia retro hijau dengan controller, gunung pixel, dan pulau melayang" fetchPriority="high" /><div className="hero-content"><span className="hero-eyebrow"><span className="status-dot" />REHAT SEBENTAR. MAIN DULU.</span><h1 id="hero-title">Dulu pulang sekolah.<br /><span>Sekarang pulang kerja.</span></h1><p className="hero-copy"><strong>Waktunya main lagi.</strong> Game lama, kenangan yang nggak pernah usang. Keseruannya masih sama. Buka game favoritmu, dan biarkan jempol yang mengingat.</p><div className="hero-buttons"><Link className="button primary" to="/console">Jelajahi console<ArrowRight size={18} /></Link><button className="button hero-secondary" onClick={() => open()}><Upload size={17} />Buka ROM sendiri</button></div><div className="hero-footnote"><span className="tiny-pad"><Gamepad2 size={16} /></span>Masih ingat tombolnya? Jempolmu pasti ingat.</div></div><span className="hero-sticker"><Sparkles size={16} />PLAYER 1<br /><strong>KAMU, LAGI.</strong></span><span className="hero-coordinate">EST. IN YOUR CHILDHOOD ↗</span></section>
            <div className="benefits"><span><Monitor size={17} /><strong>Langsung di browser</strong><i>Tanpa instal aplikasi</i></span><span><HardDrive size={17} /><strong>ROM milikmu sendiri</strong><i>Atau coba koleksi kami</i></span><span><ShieldCheck size={17} /><strong>Privat dari awal</strong><i>File lokal tidak di-upload</i></span></div>
            <section className="section"><div className="section-heading"><div><span className="eyebrow">PILIH MESIN WAKTUMU</span><h2>Console lama, cerita yang sama.</h2></div><Link className="text-link" to="/console">Lihat semua<ArrowRight size={16} /></Link></div><div className="console-grid">{consoles.map(c => <Link to={`/console?console=${c.id}`} className="console-card" key={c.id} style={{ '--console-color': c.color } as React.CSSProperties}><span className="console-year">{c.year}</span><ConsoleArt family={c.family} /><strong>{c.shortName}</strong><span className="console-maker">{c.maker}<ArrowUpRight size={13} /></span></Link>)}</div></section>
            <section className="section"><div className="section-heading"><div><span className="eyebrow">SEBELUM MEMBUKA KOLEKSIMU</span><h2>Satu permainan kecil, dulu.</h2><p>Homebrew orisinal kami. Siap dimainkan, tanpa mencari ROM.</p></div><span className="outline-badge"><span className="status-dot" />TERSEDIA DI SERVER</span></div><div className="home-game-layout">{cards(games)}<button className="bring-rom-card" onClick={() => open()}><div className="bring-icon"><Upload size={24} strokeWidth={1.5} /><span>+</span></div><span className="eyebrow">PUNYA KOLEKSI SENDIRI?</span><strong>Kenanganmu.<br />Game-mu. Giliranmu.</strong><p>Buka ROM dari perangkatmu.<br />Nggak perlu upload, nggak perlu akun.</p><span className="text-link">Buka ROM sendiri<ArrowUpRight size={17} /></span></button></div></section>
            {history.length > 0 && <section className="section"><div className="section-heading"><div><span className="eyebrow">MASIH ADA WAKTU?</span><h2>Terakhir kamu mainkan.</h2></div><Link className="text-link" to="/riwayat">Semua riwayat<ArrowRight size={16} /></Link></div>{cards(history.slice(0, 3), true)}</section>}
            <div className="slow-banner"><span className="slow-icon"><Leaf size={28} strokeWidth={1.2} /></span><div><strong>Nggak harus tamat hari ini.</strong><p>Yang penting, sempat senang sebentar.</p></div><Link to="/cara-bermain" className="text-link">Baru pertama main?<ArrowRight size={16} /></Link></div>
          </>} />
          <Route path="/console" element={<Explore consoles={consoles} games={games} renderCards={cards} onOpen={open} />} />
          <Route path="/riwayat" element={<><PageHeading eyebrow="KENANGAN YANG BARU DIBUKA" title="Terakhir dimainkan." description="Bukan daftar pekerjaan. Ini daftar kesenanganmu." /><div className="list-toolbar"><span><Clock3 size={16} />{history.length} permainan {!settings.history && '· pencatatan dijeda'}</span>{history.length > 0 && <button className="text-link muted" onClick={() => { if (window.confirm('Hapus semua riwayat bermain? Favorit dan save game tidak akan dihapus.')) { setHistory([]); setToast('Riwayat bermain sudah dibersihkan.') } }}>Bersihkan riwayat</button>}</div>{history.length ? <>{cards(history, true)}<p className="page-footnote">Riwayat bukan save state. Game lokal akan meminta file ROM yang sama saat dibuka kembali.</p></> : <EmptyState icon={Clock3} title="Belum ada jejak jempol." text={settings.history ? 'Mulai satu permainan. Kenangan yang baru dibuka akan muncul di sini.' : 'Pencatatan riwayat sedang dimatikan. Kamu tetap bisa bermain tanpa meninggalkan daftar.'} action="Cari permainan" onClick={() => navigate('/console')} />}</>} />
          <Route path="/favorit" element={<><PageHeading eyebrow="SELALU PUNYA TEMPAT" title="Favoritku." description="Beberapa game memang nggak pernah benar-benar kita tinggalkan." /><div className="list-toolbar"><span><Heart size={16} />{favorites.length} permainan favorit</span></div>{favorites.length ? cards(favorites) : <EmptyState icon={Heart} title="Tempat untuk yang paling berkesan." text="Tekan ikon hati di kartu game untuk menyimpannya di sini. Favorit lokal menyimpan nama game, bukan file ROM-nya." action="Temukan favoritmu" onClick={() => navigate('/console')} />}</>} />
          <Route path="/cara-bermain" element={<Guide onOpen={() => open()} />} />
          <Route path="/pengaturan" element={<><PageHeading eyebrow="BIAR MAKIN NYAMAN" title="Atur jeda mainmu." description="Sedikit pengaturan. Lebih banyak waktu untuk bermain." /><div className="settings-panel"><div className="setting-row"><div className="setting-symbol"><Volume2 size={22} /></div><div className="setting-description"><h2>Volume awal</h2><p>Volume saat permainan baru dimulai. Suara selama bermain bisa diatur di menu emulator.</p><div className="volume-control"><Volume2 size={16} /><input type="range" min="0" max="100" value={settings.volume} aria-label="Volume awal" onChange={e => setSettings(s => ({ ...s, volume: Number(e.target.value) }))} style={{ '--volume': `${settings.volume}%` } as React.CSSProperties} /><output>{settings.volume}%</output></div></div></div><div className="setting-row"><div className="setting-symbol"><Clock3 size={22} /></div><div className="setting-description"><h2>Simpan riwayat bermain</h2><p>Ingat permainan yang pernah kamu buka, hanya di browser ini. Mematikannya tidak menghapus riwayat lama atau save game.</p></div><button className={`toggle ${settings.history ? 'on' : ''}`} role="switch" aria-checked={settings.history} aria-label="Simpan riwayat bermain" onClick={() => setSettings(s => ({ ...s, history: !s.history }))}><span /></button></div><div className="settings-saved"><Check size={15} />Tersimpan otomatis di perangkat ini.<button className="text-link muted" onClick={() => { setSettings({ ...DEFAULT_SETTINGS }); setToast('Pengaturan dikembalikan ke awal.') }}>Kembalikan default</button></div></div>
            <div className="privacy-card"><ShieldCheck size={24} /><div><h2>Ruang mainmu, tetap milikmu.</h2><p>Login opsional hanya tersedia bila backend akun diaktifkan. ROM/BIOS lokal tidak diunggah. Favorit, pengaturan, dan riwayat tetap di browser. Save state akun dapat disimpan manual ke server; save tamu tetap di browser. Progres dalam game NES tersinkron otomatis; memcard PS1 masih percobaan. Periksa status pada player dan ekspor cadangan jika sinkronisasi gagal atau core belum didukung.</p></div></div><p className="page-footnote">maindulu v{__APP_VERSION__} · engine EmulatorJS 4.2.3 lokal, tanpa CDN.</p></>} />
          <Route path="/main" element={session ? <Player key={session.id} session={session} settings={settings} favorite={favorites.some(g => g.id === session.game.id)} onFavorite={() => favorite(session.game)} onStart={() => { setGameStarted(true); setHistory(previous => recordHistory(previous, session.game, settings.history)) }} onExit={leave} onWidescreen={next => setSettings(s => ({ ...s, widescreen: next }))} account={account.state} registerExitGuard={registerExitGuard} /> : <EmptyState title="Ruang mainnya masih kosong." text="Sesi file lokal tidak bertahan setelah refresh. Pilih kembali game dan BIOS untuk mulai bermain." action="Pilih permainan" onClick={() => navigate('/console')} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>}
        {!loading && !catalogError && location.pathname === '/pengaturan' && <BackendStatus state={backend.state} onRetry={backend.retry} />}
        <footer className="footer"><span><img src="/assets/maindulu.svg" alt="" width="19" height="19" />maindulu<span className="footer-dot">·</span><span className="footer-motto">Jeda kecil. Kenangan besar.</span></span><span>Powered by EmulatorJS <b>4.2.3</b><span className="footer-dot">·</span><a href="/vendor/emulatorjs/4.2.3/LICENSE" target="_blank" rel="noreferrer">Lisensi</a><span className="footer-dot">·</span><Link to="/cara-bermain">Bantuan & privasi<ArrowUpRight size={12} /></Link></span><span className="footer-dot">·</span><span>catatan kecil: maindulu dirakit oleh <a href="https://github.com/ardiputracode/maindulu" target="_blank" rel="noopener noreferrer">ArdiputraCode</a> dengan bantuan AI penuh. Engine emulator (EmulatorJS) dan core-nya milik pembuat aslinya.</span></footer>
      </main>
    </div>
    {selection && <SetupDialog selection={selection} consoles={consoles} biosList={biosList} onClose={() => setSelection(null)} onLaunch={launch} />}
    {accountOpen && accountsEnabled && <AccountDialog account={account} onClose={() => setAccountOpen(false)} />}
    {toast && <div className="toast" role="status"><Check size={17} />{toast}</div>}
  </div>
}

function InfoIcon() { return <ShieldCheck size={17} /> }

function Explore({ consoles, games, renderCards, onOpen }: { consoles: ConsoleInfo[]; games: Game[]; renderCards: (games: Game[]) => React.ReactNode; onOpen: (selection?: SetupSelection) => void }) {
  const [params, setParams] = useSearchParams()
  const [search, setSearch] = useState('')
  const selected = params.get('console') || 'all'
  const current = consoles.find(c => c.id === selected)
  const visible = games.filter(g => (selected === 'all' || g.consoleId === selected) && g.title.toLocaleLowerCase('id').includes(search.toLocaleLowerCase('id')))
  return <><PageHeading eyebrow="PINTU KE MASA ITU" title="Mau main yang mana?" description="Pilih console favoritmu. Kita urus mesin waktunya."><button className="button primary" onClick={() => onOpen({ consoleId: current?.id })}><Upload size={17} />Buka ROM sendiri</button></PageHeading><div className="console-grid explore-consoles">{consoles.map(c => <button className={`console-card ${selected === c.id ? 'selected' : ''}`} key={c.id} onClick={() => setParams({ console: c.id })} style={{ '--console-color': c.color } as React.CSSProperties} aria-pressed={selected === c.id}><span className="console-year">{c.year}</span><ConsoleArt family={c.family} /><strong>{c.shortName}</strong><span className="console-maker">{c.maker}{selected === c.id ? <Check size={14} /> : <ArrowDown size={13} />}</span></button>)}</div><div className="explore-toolbar"><div className="filter-pills"><button className={`filter-pill ${selected === 'all' ? 'active' : ''}`} onClick={() => setParams({})}>Semua console<span>{games.length}</span></button>{current && <span className="selected-console">{current.shortName}<button aria-label="Hapus filter console" className="icon-button" onClick={() => setParams({})}><X size={14} /></button></span>}</div><label className="search-box"><Search size={17} /><input type="search" placeholder="Cari game di server…" value={search} onChange={e => setSearch(e.target.value)} aria-label="Cari game di server" /></label></div><div className="section-heading compact"><h2>{current ? `Koleksi ${current.shortName}` : 'Koleksi server'}</h2><span className="result-count">{visible.length} permainan</span></div>{visible.length ? renderCards(visible) : <EmptyState title={search ? 'Belum ketemu judulnya.' : 'Console siap. Tinggal ROM-mu.'} text={search ? 'Coba kata kunci lain atau buka ROM yang sudah kamu punya.' : `Belum ada game ${current?.shortName || ''} di server. Core console sudah tersimpan lokal, jadi kamu bisa langsung membuka ROM sendiri.`} action="Buka ROM sendiri" onClick={() => onOpen({ consoleId: current?.id })} />}<p className="page-footnote"><ShieldCheck size={14} />Koleksi server hanya berisi game berizin. ROM dan BIOS lokal tidak dikirim ke server.</p></>
}

function Guide({ onOpen }: { onOpen: () => void }) {
  return <>
    <PageHeading eyebrow="JEMPOL BOLEH PEMANASAN DULU" title="Gampang. Seperti dulu." description="Tanpa instal aplikasi. Tanpa akun. Tinggal pilih, lalu main." />
    <div className="guide-steps">{[{ n: '01', icon: Gamepad2, title: 'Pilih mesin waktumu', text: 'Jelajahi console dan mainkan homebrew yang ada di server, atau buka file ROM milikmu sendiri.' }, { n: '02', icon: HardDrive, title: 'Siapkan ROM & BIOS', text: 'Pilih console yang cocok. BIOS lokal atau server dapat ditambahkan sesuai kebutuhan core. File lokal tidak di-upload.' }, { n: '03', icon: Sparkles, title: 'Biar jempol mengingat', text: 'Klik Mulai bermain pada layar emulator. Pakai keyboard, gamepad, atau kontrol sentuh di ponsel.' }].map(({ n, icon: Icon, title, text }) => <div className="guide-step" key={n}><span className="step-number">{n}</span><Icon size={27} strokeWidth={1.4} /><h2>{title}</h2><p>{text}</p></div>)}</div>
    <div className="guide-bottom"><section className="guide-panel"><div className="panel-heading"><Keyboard size={21} /><h2>Sedikit pemanasan.</h2></div><p>Pemetaan bergantung pada console. Untuk demo NES:</p><div className="guide-keys"><div><span>Arah</span><span><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd></span></div><div><span>Tombol A / B</span><span><kbd>Z</kbd><kbd>X</kbd></span></div><div><span>Start / Select</span><span><kbd>Enter</kbd><kbd>Shift</kbd></span></div></div><p>Klik layar game untuk memfokuskan keyboard. Buka menu kontrol emulator untuk melihat atau mengubah pemetaan. Di mobile, kontrol sentuh muncul pada layar.</p></section>
      <section className="guide-panel"><div className="panel-heading"><ShieldCheck size={21} /><h2>Biar nggak ada yang hilang.</h2></div><p><strong>Riwayat bukan progres.</strong> Riwayat/favorit hanya menyimpan metadata. Untuk game lokal, pilih ulang ROM yang sama saat sesi berakhir.</p><p><strong>Tamu:</strong> gunakan save/load dan ekspor di menu emulator. Save browser dapat hilang jika data situs dibersihkan.</p><p><strong>Akun:</strong> mulai game setelah login. Save state server menyediakan tiga slot manual dan Autosave opsional. Progres asli game NES disinkronkan otomatis setiap 10 detik saat aktif; PS1 masih percobaan. Save server dipasang sebelum game berjalan. Periksa status, gunakan Sinkronkan progres sekarang, dan unduh cadangan jika gagal. Core lain belum didukung; progres akun masih di memori. Impor progres browser/file ke akun belum tersedia.</p><p><strong>Multi-file & BIOS.</strong> Kemas CUE dan BIN satu game dalam satu ZIP. Pertahankan nama file BIOS yang diminta core; arsip BIOS boleh berisi beberapa firmware. Ekstensi saja tidak menjamin kecocokan.</p></section></div>
    <section className="guide-panel legal-panel"><span className="eyebrow">DI BALIK MESIN WAKTU</span><h2>Mandiri, bukan bergantung CDN.</h2><p>Engine EmulatorJS v4.2.3, core, kompresi, gambar, dan ikon dilayani dari proyek ini. Tidak ada permintaan runtime wajib ke layanan EmulatorJS. Server maindulu tetap perlu tersedia; ini belum merupakan PWA offline.</p><p>ROM/BIOS lokal tidak disimpan permanen atau dikirim ke server. Favorit, riwayat, dan pengaturan hanya tersimpan di perangkat. Akun lokal opsional menyimpan hash kredensial, save state manual/Autosave opsional, serta progres dalam game yang disinkronkan otomatis pada core yang didukung ke backend privat. Tidak ada analitik. Gunakan ROM/BIOS yang berhak kamu gunakan; file server bersifat publik.</p><p>EmulatorJS berlisensi GPL-3.0-or-later; core memiliki lisensi masing-masing pada menu About. Sumber dan patch yang dapat direproduksi tersedia melalui <code>third_party/emulatorjs</code> dan <code>scripts/vendor-engine.mjs</code>.</p><div className="legal-links"><a className="text-link" href="/vendor/emulatorjs/4.2.3/LICENSE" target="_blank" rel="noreferrer">Lisensi engine<ArrowUpRight size={14} /></a><a className="text-link" href="/vendor/emulatorjs/4.2.3/data/src/emulator.js" target="_blank" rel="noreferrer">Sumber engine lokal<ArrowUpRight size={14} /></a><a className="text-link" href="/games/LICENSE.txt" target="_blank" rel="noreferrer">Lisensi demo homebrew<ArrowUpRight size={14} /></a></div></section>
    <div className="guide-cta"><span>Sudah siap membuka kenangan?</span><button className="button primary" onClick={onOpen}>Buka ROM sendiri<ArrowRight size={17} /></button></div>
  </>
}
