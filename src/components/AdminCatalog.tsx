import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Route, Routes, useSearchParams } from 'react-router-dom'
import { ArrowRight, HardDrive, Plus, RefreshCw, ShieldCheck } from 'lucide-react'
import Dialog from './Dialog'
import { adminRequest, catalogLabel, CatalogClientError, mutateCatalog, readAdminPage } from '../lib/admin-catalog'
import MetadataReview from './MetadataReview'
import MetadataQueue from './MetadataQueue'
import CatalogScan from './CatalogScan'
import { metadataReady } from '../lib/metadata'
import { useVisiblePolling } from '../lib/useVisiblePolling'
import type { AdminEntry, AdminPage, CatalogKind, UploadProgress } from '../lib/admin-catalog'
import type { AccountState } from '../lib/account'
import type { BackendState } from '../lib/backend'
import { validateBios, validateRom } from '../lib/domain'
import type { ConsoleInfo } from '../lib/domain'
import type { MetadataTasks } from '../lib/useMetadataTasks'

type Account = { state: AccountState; refresh: () => Promise<void> }
const message = (error: unknown) => error instanceof Error ? error.message : 'Permintaan gagal. Coba lagi.'
const bytes = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024
  ? `${(size / 1024).toLocaleString('id-ID', { maximumFractionDigits: 2 })} KiB`
  : `${(size / 1024 / 1024).toLocaleString('id-ID', { maximumFractionDigits: 2 })} MiB`
const fileStates: Record<string, string> = { available: 'Tersedia', missing: 'Berkas hilang', damaged: 'Ukuran tidak sesuai', unsafe: 'Berkas tidak aman', none: 'Tidak ada' }

export default function AdminCatalog({ backend, account, consoles, onLogin, onRetry, metadataTasks }: {
  backend: BackendState; account: Account; consoles: ConsoleInfo[]; onLogin: () => void; onRetry: () => void;
  metadataTasks: MetadataTasks;
}) {
  const user = account.state.status === 'authenticated' ? account.state.user : null
  const [access, setAccess] = useState<{ userId?: string; error?: string }>({})
  const [attempt, setAttempt] = useState(0)
  const enabled = backend.status === 'online' && backend.health.capabilities.admin === true
  useEffect(() => {
    setAccess({})
    if (!enabled || user?.role !== 'admin') return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    let disposed = false
    void adminRequest('/api/admin/status', { signal: controller.signal }).then(() => {
      if (!disposed) setAccess({ userId: user.id })
    }).catch(error => {
      if (!disposed) setAccess({ error: controller.signal.aborted ? 'Pemeriksaan akses terlalu lama. Coba lagi.' : message(error) })
    }).finally(() => clearTimeout(timer))
    return () => { disposed = true; clearTimeout(timer); controller.abort() }
  }, [enabled, user?.id, user?.role, account.state.status, attempt])

  const retry = () => { setAccess({}); setAttempt(n => n + 1); void account.refresh(); onRetry() }
  const denied = (error: unknown) => {
    if (error instanceof CatalogClientError && (error.status === 401 || error.status === 403)) {
      setAccess({ error: message(error) }); void account.refresh()
    }
  }
  if (backend.status === 'checking' || (enabled && account.state.status === 'checking')) return <p role="status">Memeriksa sesi dan akses admin…</p>
  if (backend.status === 'unavailable' || account.state.status === 'unavailable') return <AdminNotice title="Sesi admin belum dapat dipastikan." text="Periksa koneksi dan coba kembali. Konten admin disembunyikan sampai akses terkonfirmasi." onRetry={retry} />
  if (!enabled) return <AdminNotice title="Admin tidak tersedia." text="Pengelolaan koleksi memerlukan backend dengan fitur admin. Mode web statis tetap dapat digunakan tanpa admin." />
  if (!user) return <AdminNotice title="Masuk sebagai admin." text="Sesi akun diperlukan untuk mengelola koleksi." onRetry={onLogin} action="Masuk ke akun" />
  if (user.role !== 'admin') return <AdminNotice title="Akses admin diperlukan." text="Akun ini tidak memiliki izin pengelolaan koleksi. Penetapan role hanya melalui terminal server." />
  if (access.error) return <AdminNotice title="Akses admin belum terkonfirmasi." text={access.error} onRetry={retry} />
  if (access.userId !== user.id) return <p role="status">Memeriksa sesi dan akses admin…</p>
  return <section className="admin-area" aria-label="Pengelolaan koleksi">
    <div className="page-heading"><div><span className="eyebrow">RUANG PENGELOLA</span><h1>Kelola koleksi.</h1><p>Game dan BIOS dikelola terpisah. Aset aktif dapat diunduh publik, termasuk oleh tamu.</p></div><ShieldCheck size={30} /></div>
    <nav className="admin-tabs" aria-label="Menu admin"><NavLink to="/admin" end>Ringkasan</NavLink><NavLink to="/admin/games">Manage Game</NavLink><NavLink to="/admin/bios">Manage BIOS</NavLink>{backend.status === 'online' && backend.health.capabilities.catalogScan && <NavLink to="/admin/scan">Scan Koleksi</NavLink>}{backend.health.capabilities.metadata && <NavLink to="/admin/metadata">Antrean Metadata</NavLink>}</nav>
    <p className="notice">Backup menyimpan akun, save/progres, dan metadata katalog; tidak menyertakan berkas ROM, BIOS, atau cover. Jika aset hilang setelah restore, upload ulang berkas yang sama dan konfirmasi ID lama.</p>
    {backend.status === 'online' && backend.health.capabilities.catalogScan && <p><Link to="/admin/scan">Scan Koleksi dari folder server</Link> — daftarkan ROM/BIOS hasil transfer WinSCP tanpa upload ulang.</p>}
    <Routes>
      <Route path="metadata" element={backend.health.capabilities.metadata ? <MetadataQueue consoles={consoles} userId={user.id} tasks={metadataTasks} onDenied={denied} /> : <p>API metadata tidak tersedia pada backend ini.</p>} />
      <Route path="scan" element={backend.status === 'online' && backend.health.capabilities.catalogScan ? <CatalogScan userId={user.id} onDenied={denied} /> : <p>Scan folder tidak tersedia pada backend ini.</p>} />
      <Route index element={<><div className="admin-links">{(['games', 'bios'] as const).map(kind => <Link key={kind} to={`/admin/${kind}`} className="admin-panel"><HardDrive size={24} /><h2>{kind === 'games' ? 'Manage Game' : 'Manage BIOS'}</h2><p>{kind === 'games' ? 'Upload ROM dan cover, edit metadata, atau hapus game.' : 'Upload firmware dan arsip BIOS, edit metadata, atau hapus BIOS.'}</p><span className="text-link">Buka pengelolaan <ArrowRight size={16} /></span></Link>)}</div><p className="page-footnote">Role akun tetap dikelola melalui terminal, bukan halaman ini.</p></>} />
      <Route path="games" element={backend.status === 'online' && backend.health.capabilities.gameCatalog ? <CatalogManager key="games" kind="games" consoles={consoles} userId={user.id} onDenied={denied} metadataEnabled={backend.health.capabilities.metadata === true} metadataTasks={metadataTasks} /> : <p>API katalog game tidak tersedia pada backend ini.</p>} />
      <Route path="bios" element={backend.status === 'online' && backend.health.capabilities.biosCatalog ? <CatalogManager key="bios" kind="bios" consoles={consoles} userId={user.id} onDenied={denied} /> : <p>API katalog BIOS tidak tersedia pada backend ini.</p>} />
      <Route path="*" element={<Link to="/admin">Kembali ke ringkasan admin</Link>} />
    </Routes>
  </section>
}

function AdminNotice({ title, text, onRetry, action = 'Periksa lagi' }: { title: string; text: string; onRetry?: () => void; action?: string }) {
  return <div className="empty-state"><h1>{title}</h1><p>{text}</p>{onRetry && <button className="button primary" onClick={onRetry}>{action}</button>}</div>
}

function CatalogManager({ kind, consoles, userId, onDenied, metadataEnabled = false, metadataTasks }: { kind: CatalogKind; consoles: ConsoleInfo[]; userId: string; onDenied: (error: unknown) => void; metadataEnabled?: boolean; metadataTasks?: MetadataTasks }) {
  const [params, setParams] = useSearchParams()
  const [result, setResult] = useState<AdminPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [retry, setRetry] = useState(0)
  const [editing, setEditing] = useState<AdminEntry | 'new' | null>(null)
  const [deleting, setDeleting] = useState<AdminEntry | null>(null)
  const [review, setReview] = useState<AdminEntry | null>(null)
  const [ready, setReady] = useState(false)
  useVisiblePolling(metadataEnabled && kind === 'games', async signal => {
    try { const next = await metadataReady(signal); if (!signal.aborted) setReady(next) }
    catch (e) { if (!signal.aborted) { setReady(false); onDenied(e) }; throw e }
  })
  const uploadButton = useRef<HTMLButtonElement>(null)
  const focusAfterClose = useRef(false)
  useEffect(() => {
    // Reloading removes list rows (and their dialog triggers). Restore focus to
    // a persistent toolbar control instead of leaving keyboard users on body.
    if (!editing && !deleting && !review && focusAfterClose.current) { focusAfterClose.current = false; uploadButton.current?.focus() }
  }, [editing, deleting, review])
  const q = params.get('q') || '', consoleId = params.get('console') || '', status = params.get('status') || 'active'
  const rawPage = Number(params.get('page') || 1)
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage <= 1000000 ? rawPage : 1
  const query = new URLSearchParams({ page: String(page), pageSize: '12', status, sort: 'newest', ...(q ? { q } : {}), ...(consoleId ? { console: consoleId } : {}) }).toString()
  const deniedRef = useRef(onDenied)
  deniedRef.current = onDenied
  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    const timer = setTimeout(() => controller.abort(), 15000)
    setLoading(true); setError('')
    void adminRequest(`/api/admin/${kind}?${query}`, { signal: controller.signal }).then(data => {
      const parsed = readAdminPage(data, kind)
      if (!parsed) throw new Error('Respons daftar katalog tidak sesuai.')
      if (!disposed) setResult(parsed)
    }).catch(e => { if (!disposed) { setError(controller.signal.aborted ? 'Permintaan terlalu lama. Coba muat ulang daftar.' : message(e)); deniedRef.current(e) } })
      .finally(() => { clearTimeout(timer); if (!disposed) setLoading(false) })
    return () => { disposed = true; clearTimeout(timer); controller.abort() }
  }, [kind, query, retry])
  function filter(key: string, value: string) {
    setParams(previous => { const next = new URLSearchParams(previous); if (value) next.set(key, value); else next.delete(key); if (key !== 'page') next.delete('page'); return next }, { replace: key === 'q' })
  }
  const reload = () => setRetry(n => n + 1)
  useVisiblePolling(metadataEnabled && !editing && !deleting, async signal => {
    try {
      const parsed = readAdminPage(await adminRequest(`/api/admin/${kind}?${query}`, { signal }), kind)
      if (!parsed) throw new Error('Respons daftar katalog tidak sesuai.')
      if (!signal.aborted) setResult(parsed)
    } catch (e) { if (!signal.aborted) deniedRef.current(e); throw e }
  })
  const changed = (text: string) => { focusAfterClose.current = true; setEditing(null); setDeleting(null); setNotice(text); reload() }
  const label = kind === 'games' ? 'game' : 'BIOS'
  return <>
    <div className="admin-toolbar"><h2>{kind === 'games' ? 'Manage Game' : 'Manage BIOS'}</h2><div className="account-actions"><button className="button secondary small" onClick={reload}><RefreshCw size={16} />Muat ulang daftar</button><button ref={uploadButton} className="button primary small" onClick={() => { setNotice(''); setEditing('new') }}><Plus size={16} />Upload {label}</button></div></div>
    <div className="admin-filters"><label>Cari {label}<input type="search" value={q} maxLength={200} onChange={e => filter('q', e.target.value)} /></label><label>Filter console<select value={consoleId} onChange={e => filter('console', e.target.value)}><option value="">Semua console</option>{consoles.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>Status katalog<select value={status} onChange={e => filter('status', e.target.value)}><option value="active">Aktif</option><option value="deleted">Terhapus</option><option value="all">Semua status</option></select></label></div>
    {notice && <p className="server-status server-status--success" role="status">{notice}</p>}
    {loading ? <p role="status">Memuat daftar {label}…</p> : error ? <div className="error-message" role="alert"><p>{error}</p><button className="button secondary small" onClick={reload}>Coba lagi</button><button className="button secondary small" onClick={() => setParams({})}>Reset filter</button></div> : result && <>
      <p className="admin-count">{result.total} {label} · halaman {page} dari {Math.max(1, Math.ceil(result.total / result.pageSize))}</p>
      {!result.items.length && <div className="empty-state"><h3>Belum ada hasil.</h3><p>Upload {label} atau ubah pencarian dan filter.</p></div>}
      <div className="admin-list">{result.items.map(item => <article className="admin-panel" key={item.id} aria-label={catalogLabel(item)}>
        <div className="admin-item-heading"><h3>{catalogLabel(item)}</h3><span className="slot-badge">{item.deletedAt === null ? 'Aktif' : 'Terhapus'}</span></div>
        <p>{consoles.find(c => c.id === item.consoleId)?.name || item.consoleId} · {bytes(item.size)}</p>
        <dl><dt>{kind === 'games' ? 'ROM' : 'Firmware / arsip'}</dt><dd>{item.fileName}</dd><dt>Diunggah</dt><dd>{new Date(item.createdAt).toLocaleString('id-ID')}</dd><dt>Berkas</dt><dd>{fileStates[item.fileStatus]}</dd>{kind === 'games' && <><dt>Cover</dt><dd>{fileStates[item.coverStatus || 'none']}</dd></>}<dt>Pembersihan</dt><dd>{item.cleanupPending ? 'Menunggu / akan dicoba ulang' : 'Tidak ada antrean'}</dd><dt>SHA-256</dt><dd className="admin-hash">{item.sha256}</dd></dl>
        {item.metadataStatus && <p>{item.metadataStatus === 'pending' ? 'Metadata sedang diproses' : item.metadataStatus === 'ready' ? 'Metadata selesai' : item.metadataStatus === 'review' ? 'Metadata perlu ditinjau' : 'Scan nonaktif'}</p>}
        {item.storageMode === 'external' && <p className="notice">Sumber eksternal hanya-baca. Berkas dikelola melalui RomM/server sumber, bukan tombol Hapus. Jika berkas hilang atau dipindah, jalankan Scan Koleksi setelah sumber tersedia; byte identik mempertahankan ID dan save.</p>}
        {item.storageMode === 'shared' && <p className="notice">Folder bersama RomM / maindulu. Upload dan scan memakai lokasi yang sama. Hapus di sini ikut menghapus file fisik yang dipakai RomM; hapus di RomM membuat file di maindulu tidak tersedia. Daftar masing-masing aplikasi perlu scan/refresh.</p>}
        {item.deletedAt === null ? <><div className="account-actions"><button className="button secondary small" onClick={() => setEditing(item)}>Edit metadata</button>{kind === 'games' && metadataEnabled && <button className="button secondary small" onClick={() => setReview(item)}>Review / scan metadata</button>}{item.storageMode !== 'external' && <button className="button secondary small" onClick={() => setDeleting(item)}>Hapus {label}</button>}</div>{item.fileStatus === 'missing' && item.storageMode !== 'external' && <p className="field-hint">Berkas hilang. Gunakan Upload {label} untuk mengirim ulang byte yang sama pada console yang sama, lalu konfirmasi Pulihkan ID lama. Save pengguna tidak perlu dipindahkan. Cover dapat diunggah ulang melalui Edit metadata.</p>}</> : <p className="field-hint">Untuk memulihkan ID dan hubungan save lama, upload ulang berkas yang sama pada console yang sama lalu konfirmasi pemulihan.</p>}
      </article>)}</div>
      <nav className="admin-pagination" aria-label="Halaman katalog admin"><button className="button secondary small" disabled={page <= 1} onClick={() => filter('page', String(page - 1))}>Sebelumnya</button><span>Halaman {page}</span><button className="button secondary small" disabled={page * result.pageSize >= result.total} onClick={() => filter('page', String(page + 1))}>Berikutnya</button></nav>
    </>}
    {review && metadataTasks && <MetadataReview id={review.id} title={catalogLabel(review)} userId={userId} ready={ready} tasks={metadataTasks} onClose={() => { focusAfterClose.current = true; setReview(null); reload() }} onDenied={onDenied} />}
    {editing && <CatalogForm kind={kind} item={editing === 'new' ? undefined : editing} scanReady={ready} consoles={consoles} userId={userId} onClose={() => { focusAfterClose.current = true; setEditing(null); reload() }} onSaved={changed} onDenied={onDenied} onUncertain={reload} />}
    {deleting && <DeleteCatalog kind={kind} item={deleting} userId={userId} onClose={() => setDeleting(null)} onSaved={changed} onDenied={onDenied} onUncertain={reload} />}
  </>
}

function CatalogForm({ kind, item, consoles, userId, onClose, onSaved, onDenied, onUncertain, scanReady = false }: {
  kind: CatalogKind; item?: AdminEntry; consoles: ConsoleInfo[]; userId: string; onClose: () => void;
  onSaved: (text: string) => void; onDenied: (error: unknown) => void; onUncertain: () => void;
  scanReady?: boolean;
}) {
  const game = kind === 'games', label = game ? 'game' : 'BIOS'
  const [title, setTitle] = useState(item ? catalogLabel(item) : '')
  const [consoleId, setConsoleId] = useState(item?.consoleId || '')
  const [description, setDescription] = useState(item?.description || '')
  const [rights, setRights] = useState(item?.license ?? item?.distributionRights ?? '')
  const [file, setFile] = useState<File>()
  const [cover, setCover] = useState<File>()
  const [removeCover, setRemoveCover] = useState(false)
  const [error, setError] = useState('')
  const [restoreId, setRestoreId] = useState<string>()
  const [restoreChecked, setRestoreChecked] = useState(true)
  const [restoreMissing, setRestoreMissing] = useState(false)
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [scan, setScan] = useState(true)
  const operation = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current?.abort() } }, [])
  const busy = !!progress
  function resetRestore() { setRestoreId(undefined); setRestoreChecked(true); setRestoreMissing(false); setError('') }
  async function submit(restoring = false) {
    if (operation.current) return
    if (restoring && (!restoreId || !restoreChecked)) return
    setError('')
    const consoleInfo = consoles.find(c => c.id === consoleId)
    if ((kind !== 'games' || item) && !title.trim()) return setError('Nama atau judul wajib diisi.')
    if (!consoleInfo) return setError('Pilih console yang didukung.')
    if (!item && !file) return setError('Pilih berkas ROM/BIOS terlebih dahulu.')
    if (!item && file) { const issue = game ? validateRom(file, consoleInfo) : validateBios(file); if (issue) return setError(issue) }
    if (cover && (cover.size < 1 || cover.size > 8 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(cover.type))) return setError('Cover harus PNG/JPEG/WebP tidak kosong, maksimum 8 MiB. Dimensi maksimum 4096 × 4096 piksel diperiksa server.')
    const controller = new AbortController()
    operation.current = controller
    setProgress({ phase: 'preparing' })
    try {
      const fields: Record<string, unknown> = { [game ? 'title' : 'name']: title.trim(), description, [game ? 'license' : 'distributionRights']: rights }
      if (item) {
        if (title.trim() === catalogLabel(item)) delete fields[game ? 'title' : 'name']
        if (description === item.description) delete fields.description
        if (rights === (item.license ?? item.distributionRights ?? '')) delete fields[game ? 'license' : 'distributionRights']
        if (game && item.metadataRevision) fields.expectedRevision = item.metadataRevision
      } else if (game) fields.scanMetadata = scanReady && scan
      if (!item) { fields.consoleId = consoleId; if (restoring && restoreId) fields.restoreId = restoreId }
      if (item && game) fields.removeCover = removeCover
      let body: FormData | Record<string, unknown> = fields
      if (!item || cover) {
        body = new FormData()
        for (const [key, value] of Object.entries(fields)) body.append(key, String(value))
        if (!item && file) body.append(game ? 'rom' : 'bios', file)
        if (cover) body.append('cover', cover)
      }
      const response = await mutateCatalog(kind, userId, item ? 'PATCH' : 'POST', item?.id, body, controller.signal, next => { if (mounted.current) setProgress(next) })
      const scheduled = !!response && typeof response === 'object' && 'item' in response && !!response.item && typeof response.item === 'object' && 'metadataStatus' in response.item && response.item.metadataStatus === 'pending'
      if (mounted.current) onSaved(restoring ? 'ID lama berhasil dipulihkan. Metadata lama dipertahankan; scan ulang hanya melalui tindakan eksplisit.' : item ? 'Metadata berhasil diperbarui. ID dan save pengguna tidak berubah.' : game ? `Game berhasil diunggah dan sudah bisa dimainkan. ${scheduled ? 'Metadata sedang menunggu scan.' : 'Scan otomatis tidak dijadwalkan.'}` : 'BIOS berhasil diterbitkan.')
    } catch (e) {
      if (!mounted.current) return
      setError(controller.signal.aborted ? 'Permintaan dibatalkan. Penerbitan mungkin sudah selesai; periksa daftar sebelum mengulang.' : message(e))
      if (!controller.signal.aborted && e instanceof CatalogClientError && e.code === 'CATALOG_RESTORE_REQUIRED' && e.existingId) {
        setRestoreId(e.existingId); setRestoreChecked(true); setRestoreMissing(e.fileMissing); setError('')
      }
      onUncertain(); onDenied(e)
    } finally { operation.current = null; if (mounted.current) setProgress(null) }
  }
  return <Dialog title={item ? `Edit metadata ${label}` : `Upload ${label}`} eyebrow="PENGELOLAAN KOLEKSI" onClose={onClose} busy={busy} className="admin-dialog">
    <form className="account-form" onSubmit={e => { e.preventDefault(); void submit() }}>
      <p>{item ? 'ROM/firmware dan console tidak dapat diganti. Identitas game dan save tetap.' : 'Hanya upload berkas yang berhak kamu distribusikan. Aset aktif bersifat publik.'}</p>
      {!item && <p>Nama dan ekstensi berkas dipertahankan di folder platform. Nama yang sudah dipakai tidak ditimpa; ganti nama berkas sebelum upload jika isinya berbeda. Maksimum 240 karakter dan 255 byte UTF-8.</p>}
      <fieldset disabled={busy}>
        <label htmlFor="admin-title">{game ? 'Judul game' : 'Nama BIOS'}</label><input id="admin-title" required={kind !== 'games' || !!item} maxLength={200} value={title} onChange={e => setTitle(e.target.value)} />
        {game && !item && <><p className="field-hint">Opsional: kosongkan untuk memakai nama berkas sementara. Saat scan otomatis aktif, judul ini dapat diganti hasil scan. Edit metadata setelah upload untuk mengunci judul pilihanmu.</p><label className="account-check"><input type="checkbox" checked={scanReady && scan} disabled={!scanReady} onChange={e => setScan(e.target.checked)} />Scan metadata otomatis</label><p>{scanReady ? 'Setelah upload, metadata dan cover dari kecocokan pasti diterapkan otomatis tanpa konfirmasi. Hasil yang ambigu perlu review. Deskripsi dan cover yang kamu isi sendiri tetap dipertahankan. Nama berkas, ukuran, dan hash dibagikan ke ScreenScraper; untuk CHD PS1, serial disc juga dibagikan dan kecocokan tunggal dapat diterapkan otomatis. Byte ROM tidak dikirim. Metadata dan cover disajikan lokal dengan atribusi ScreenScraper.' : 'Scan tidak tersedia. Upload dan bermain tetap berfungsi.'}</p></>}
        <label htmlFor="admin-console">Console</label><select id="admin-console" required disabled={!!item || busy} value={consoleId} onChange={e => { setConsoleId(e.target.value); resetRestore() }}><option value="">Pilih console</option>{consoles.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        {!item && <><label htmlFor="admin-file">{game ? 'Berkas ROM' : 'Berkas BIOS / arsip'}</label><input id="admin-file" type="file" required accept={game ? undefined : '.bin,.rom,.bios,.img,.zip,.7z,.rar'} onChange={e => { setFile(e.target.files?.[0]); resetRestore() }} /><p>Maksimum {game ? '768 MiB ROM' : '32 MiB BIOS'}. {game ? 'Arsip satu game diperbolehkan. Scan ZIP terbatas satu ROM raw, arsip ≤128 MiB, isi ≤64 MiB, rasio ≤100:1; 7z/RAR memakai review manual. CHD PS1 polos dapat memakai serial disc untuk kecocokan tunggal; CHD di dalam arsip tetap review.' : 'Nama firmware raw hanya huruf ASCII, angka, titik, garis bawah, atau minus. Pertahankan nama firmware yang diharapkan core.'}</p></>}
        {game && <><label htmlFor="admin-cover">Cover opsional</label><input id="admin-cover" type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { setCover(e.target.files?.[0]); setRemoveCover(false) }} /><p>PNG/JPEG/WebP, maksimum 8 MiB dan 4096 × 4096 piksel, tanpa animasi. SVG/HTML ditolak.</p>{item?.cover && <label className="account-check"><input type="checkbox" checked={removeCover} disabled={!!cover} onChange={e => setRemoveCover(e.target.checked)} />Hapus cover saat ini</label>}</>}
        <label htmlFor="admin-description">Deskripsi</label><textarea id="admin-description" maxLength={10000} rows={3} value={description} onChange={e => setDescription(e.target.value)} />
        <label htmlFor="admin-rights">{game ? 'Lisensi / hak distribusi' : 'Keterangan hak distribusi'}</label><textarea id="admin-rights" maxLength={2000} rows={2} value={rights} onChange={e => setRights(e.target.value)} />
      </fieldset>
      {error && <p className="error-message" role="alert">{error}</p>}
      {restoreId && <div className="save-pending"><p>{restoreMissing ? `Berkas ${label} tidak ditemukan. Upload ulang agar bisa ${game ? 'dimainkan' : 'digunakan'} kembali.` : game ? 'Game ini pernah dihapus. Pulihkan agar save lama tetap terhubung.' : 'BIOS ini pernah dihapus. Pulihkan agar bisa digunakan kembali.'}</p><label className="account-check"><input type="checkbox" checked={restoreChecked} disabled={busy} onChange={e => setRestoreChecked(e.target.checked)} />{game ? 'Pulihkan game dan gunakan save lama' : 'Pulihkan BIOS'}</label><p className="field-hint">Metadata lama dipertahankan.{game && ' Save tersedia jika datanya masih ada.'}</p><button type="button" className="button secondary small" disabled={busy || !restoreChecked} onClick={() => void submit(true)}>Pulihkan {label}</button></div>}
      {progress && <div className="admin-progress" role="status"><p>{progress.phase === 'preparing' ? 'Memeriksa sesi admin…' : progress.phase === 'processing' ? item && !cover ? 'Server sedang menyimpan metadata…' : 'Berkas terkirim. Server sedang memvalidasi dan menerbitkan…' : `Mengirim berkas${progress.percent === undefined ? '…' : ` · ${progress.percent}%`}`}</p><progress aria-label="Progress upload" max={100} value={progress.phase === 'sending' ? progress.percent : undefined} /><p>100% pengiriman belum berarti berhasil diterbitkan. Tunggu konfirmasi server.</p></div>}
      <div className="account-actions"><button className="button primary" type="submit" disabled={busy || !!restoreId}>{item ? 'Simpan metadata' : `Upload ${label}`}</button>{busy ? <button type="button" className="button secondary" onClick={() => operation.current?.abort()}>Batalkan permintaan</button> : <button type="button" className="button secondary" onClick={onClose}>Tutup</button>}</div>
    </form>
  </Dialog>
}

function DeleteCatalog({ kind, item, userId, onClose, onSaved, onDenied, onUncertain }: {
  kind: CatalogKind; item: AdminEntry; userId: string; onClose: () => void; onSaved: (text: string) => void; onDenied: (error: unknown) => void; onUncertain: () => void;
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const operation = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current?.abort() } }, [])
  async function remove() {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller; setBusy(true); setError('')
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      await mutateCatalog(kind, userId, 'DELETE', item.id, {}, controller.signal)
      if (mounted.current) onSaved('Entri dihapus dari katalog. Pembersihan berkas dijadwalkan; save pengguna tidak dihapus.')
    } catch (e) {
      if (mounted.current) { setError(controller.signal.aborted ? 'Waktu permintaan berakhir. Periksa daftar untuk memastikan hasil penghapusan.' : message(e)); onUncertain(); onDenied(e) }
    } finally { clearTimeout(timer); operation.current = null; if (mounted.current) setBusy(false) }
  }
  return <Dialog title={`Hapus ${kind === 'games' ? 'game' : 'BIOS'}?`} eyebrow="KONFIRMASI PENGHAPUSAN" busy={busy} onClose={onClose}><div className="account-form"><p><strong>{catalogLabel(item)}</strong> akan dihapus dari katalog dan akses URL baru ditolak. Berkas dibersihkan dengan retry. Byte yang sudah diunduh tidak dapat ditarik kembali.</p>{item.storageMode === 'shared' && <p className="notice">File fisik di folder bersama akan ikut dihapus. RomM juga kehilangan file ini. Ini bukan sekadar menghapus indeks maindulu; cadangkan koleksi sebelum melanjutkan.</p>}<p>Save, progres pengguna, dan akun tidak dihapus.</p>{kind === 'bios' && <p>Game yang membutuhkan firmware ini akan memerlukan pilihan BIOS lain atau berkas lokal untuk sesi berikutnya. Pilihan pengguna tidak diganti otomatis.</p>}{error && <p role="alert" className="error-message">{error}</p>}<div className="account-actions"><button className="button primary" disabled={busy} onClick={() => void remove()}>{busy ? 'Menghapus…' : 'Ya, hapus'}</button><button className="button secondary" disabled={busy} onClick={onClose}>Batal</button></div></div></Dialog>
}
