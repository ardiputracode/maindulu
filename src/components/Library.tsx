import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { catalogGame, libraryGames, loadCatalog, mergeCatalog } from '../lib/catalog'
import type { BackendState } from '../lib/backend'
import type { ConsoleInfo, Game } from '../lib/domain'
import Pagination from './Pagination'

// The grid is 5 columns on desktop, 2 at medium widths, and 1 on phones.
// 20 is divisible by all three, so a page never ends with a half-empty row.
const PAGE_SIZE = 20

export default function Library({ builtin, consoles, backend, onBackendRetry, renderCards, live }: {
  builtin: Game[]; consoles: ConsoleInfo[]; backend: BackendState; onBackendRetry: () => void;
  renderCards: (games: Game[]) => React.ReactNode;
  live?: { games: Game[]; error: string; loaded: boolean; notice: string; retry: () => void };
}) {
  const [params, setParams] = useSearchParams()
  const [uploaded, setUploaded] = useState<Game[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const dynamic = backend.status === 'online' && backend.health.capabilities.gameCatalog === true
  const q = (params.get('q') || '').slice(0, 200), consoleId = params.get('console') || ''
  const sort = params.get('sort') === 'title' ? 'title' : 'newest'
  const rawPage = Number(params.get('page') || 1)
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage <= 1000000 ? rawPage : 1
  const query = new URLSearchParams({ ...(q.trim() ? { q: q.trim() } : {}), ...(consoles.some(c => c.id === consoleId) ? { console: consoleId } : {}), sort }).toString()
  useEffect(() => {
    setError(''); setLoading(dynamic && !live)
    if (!dynamic || live) return
    const controller = new AbortController()
    void loadCatalog('games', query, controller.signal).then(items => {
      if (!controller.signal.aborted) setUploaded(items.map(catalogGame).filter(g => consoles.some(c => c.id === g.consoleId)))
    }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Katalog belum dapat dimuat.') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [dynamic, query, consoles, attempt, !!live])
  const retry = () => { if (backend.status === 'unavailable') onBackendRetry(); else if (live) live.retry(); else setAttempt(n => n + 1) }
  const change = (key: string, value: string) => setParams(previous => {
    const next = new URLSearchParams(previous)
    if (value) next.set(key, value); else next.delete(key)
    if (key !== 'page') next.delete('page')
    return next
  }, { replace: key === 'q' })
  const games = libraryGames(mergeCatalog(builtin, dynamic ? (live?.games ?? uploaded).filter(g => consoles.some(c => c.id === g.consoleId)) : []), q, consoleId, sort)
  const pages = Math.max(1, Math.ceil(games.length / PAGE_SIZE))
  const busy = loading || (live && !live.loaded && !live.error) || backend.status === 'checking'
  const toolbar = useRef<HTMLDivElement>(null)
  const previousPage = useRef(page)
  useEffect(() => {
    if (previousPage.current === page) return
    previousPage.current = page
    toolbar.current?.scrollIntoView({ block: 'start' })
    toolbar.current?.focus({ preventScroll: true })
  }, [page])
  const shown = games.length > 0 && page <= pages
  const first = shown ? (page - 1) * PAGE_SIZE + 1 : 0
  const last = shown ? Math.min(page * PAGE_SIZE, games.length) : 0
  const failure = backend.status === 'unavailable' ? 'Backend katalog tidak dapat dihubungi. Mode statis tidak diaktifkan otomatis. Periksa koneksi dan coba lagi.' : live?.error ?? error
  return <section aria-label="Library game">
    <div className="page-heading"><div><span className="eyebrow">KOLEKSI UNTUK JEDA MAINMU</span><h1>Library game.</h1><p>Temukan game server dan demo bawaan. ROM milikmu tetap bisa dibuka langsung dari perangkat.</p></div></div>
    <div className="library-filters">
      <label>Cari game<input type="search" placeholder="Cari game di server…" value={q} maxLength={200} onChange={e => change('q', e.target.value)} /></label>
      <label>Filter console<select value={consoleId} onChange={e => change('console', e.target.value)}><option value="">Semua console</option>{consoles.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>Urutan<select value={sort} onChange={e => change('sort', e.target.value)}><option value="newest">Terbaru</option><option value="title">Judul A–Z</option></select></label>
      <button className="button secondary small" onClick={retry} disabled={busy}><RefreshCw size={16} />Muat ulang katalog</button>
    </div>
    {live?.notice && <p role="status">{live.notice}</p>}
    {failure && live?.loaded && <p role="alert">{failure} Daftar sebelumnya tetap ditampilkan.</p>}
    {busy ? <p role="status">Memuat Library…</p> : failure && !live?.loaded ? <div className="empty-state"><h2>Katalog belum tersedia.</h2><p role="alert">{failure}</p><button className="button primary" onClick={retry}>Coba lagi</button></div> : <>
      <div className="list-toolbar" ref={toolbar} tabIndex={-1}><span aria-live="polite">{games.length ? (shown ? `Menampilkan ${first}–${last} dari ${games.length} permainan · halaman ${page} dari ${pages}` : `${games.length} permainan · halaman ${page} dari ${pages}`) : `0 permainan · halaman ${page} dari ${pages}`}</span></div>
      {games.length && page <= pages ? renderCards(games.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)) : <div className="empty-state"><h2>{page > pages ? 'Halaman ini tidak tersedia.' : 'Belum ketemu judulnya.'}</h2><p>Ubah pencarian/filter atau buka ROM sendiri.</p><button className="button secondary" onClick={() => setParams({})}>Reset filter</button></div>}
      {pages > 1 && page <= pages && <Pagination page={page} pages={pages} label="Halaman Library" onChange={next => change('page', String(next))} />}
    </>}
  </section>
}
