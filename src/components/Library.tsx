import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { catalogGame, libraryGames, loadCatalog, mergeCatalog } from '../lib/catalog'
import type { BackendState } from '../lib/backend'
import type { ConsoleInfo, Game } from '../lib/domain'

export default function Library({ builtin, consoles, backend, onBackendRetry, renderCards }: {
  builtin: Game[]; consoles: ConsoleInfo[]; backend: BackendState; onBackendRetry: () => void;
  renderCards: (games: Game[]) => React.ReactNode;
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
    setUploaded([]); setError(''); setLoading(dynamic)
    if (!dynamic) return
    const controller = new AbortController()
    void loadCatalog('games', query, controller.signal).then(items => {
      if (!controller.signal.aborted) setUploaded(items.map(catalogGame).filter(g => consoles.some(c => c.id === g.consoleId)))
    }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Katalog belum dapat dimuat.') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [dynamic, query, consoles, attempt])
  const retry = () => { if (backend.status === 'unavailable') onBackendRetry(); else setAttempt(n => n + 1) }
  const change = (key: string, value: string) => setParams(previous => {
    const next = new URLSearchParams(previous)
    if (value) next.set(key, value); else next.delete(key)
    if (key !== 'page') next.delete('page')
    return next
  }, { replace: key === 'q' })
  const games = libraryGames(mergeCatalog(builtin, uploaded), q, consoleId, sort)
  const pages = Math.max(1, Math.ceil(games.length / 12))
  const busy = loading || backend.status === 'checking'
  const failure = backend.status === 'unavailable' ? 'Backend katalog tidak dapat dihubungi. Mode statis tidak diaktifkan otomatis. Periksa koneksi dan coba lagi.' : error
  return <section aria-label="Library game">
    <div className="page-heading"><div><span className="eyebrow">KOLEKSI UNTUK JEDA MAINMU</span><h1>Library game.</h1><p>Temukan game server dan demo bawaan. ROM milikmu tetap bisa dibuka langsung dari perangkat.</p></div></div>
    <div className="library-filters">
      <label>Cari game<input type="search" placeholder="Cari game di server…" value={q} maxLength={200} onChange={e => change('q', e.target.value)} /></label>
      <label>Filter console<select value={consoleId} onChange={e => change('console', e.target.value)}><option value="">Semua console</option>{consoles.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>Urutan<select value={sort} onChange={e => change('sort', e.target.value)}><option value="newest">Terbaru</option><option value="title">Judul A–Z</option></select></label>
      <button className="button secondary small" onClick={retry} disabled={busy}><RefreshCw size={16} />Muat ulang katalog</button>
    </div>
    {busy ? <p role="status">Memuat Library…</p> : failure ? <div className="empty-state"><h2>Katalog belum tersedia.</h2><p role="alert">{failure}</p><button className="button primary" onClick={retry}>Coba lagi</button></div> : <>
      <div className="list-toolbar"><span>{games.length} permainan · halaman {page} dari {pages}</span></div>
      {games.length && page <= pages ? renderCards(games.slice((page - 1) * 12, page * 12)) : <div className="empty-state"><h2>{page > pages ? 'Halaman ini tidak tersedia.' : 'Belum ketemu judulnya.'}</h2><p>Ubah pencarian/filter atau buka ROM sendiri.</p><button className="button secondary" onClick={() => setParams({})}>Reset filter</button></div>}
      <nav className="admin-pagination" aria-label="Halaman Library"><button className="button secondary small" disabled={page <= 1} onClick={() => change('page', String(page - 1))}>Sebelumnya</button><span>Halaman {page}</span><button className="button secondary small" disabled={page >= pages} onClick={() => change('page', String(page + 1))}>Berikutnya</button></nav>
    </>}
  </section>
}
