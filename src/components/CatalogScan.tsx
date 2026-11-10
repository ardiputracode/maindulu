import { useEffect, useRef, useState } from 'react'
import { adminRequest, adminToken } from '../lib/admin-catalog'
import { metadataReady } from '../lib/metadata'
import { useVisiblePolling } from '../lib/useVisiblePolling'

const platforms = ['nes', 'snes', 'gb', 'gbc', 'gba', 'genesis', 'psx']
const labels: Record<string, string> = { added: 'Ditambahkan', already_registered: 'Sudah terdaftar', duplicate: 'Duplikat', conflict: 'Konflik byte/nama', restore_required: 'Perlu pemulihan ID', busy: 'Sedang dipakai', invalid: 'Tidak valid', unsafe: 'Tidak aman', not_ready: 'Belum siap', failed: 'Gagal', unsupported_multifile: 'Paket PSX tidak didukung', missing: 'Berkas hilang', damaged: 'Berkas berubah/rusak', restored: 'Tersedia kembali' }
const jobLabels: Record<string, string> = { queued: 'Menunggu', running: 'Berjalan', completed: 'Selesai', cancelled: 'Dibatalkan', failed: 'Gagal', interrupted: 'Terhenti' }
type Job = { id: string; status: string; scope: { kind: string; platforms: string[]; scanMetadata: boolean }; discovered: number; processed: number; added: number; skipped: number; problems: number; metadataQueued: number; truncated: boolean; message: string; cancelRequested: boolean; usageWarning: string }
type Results = { items: { ordinal: number; path: string; status: string; message: string; existingId: string | null }[]; total: number; pageSize: number }
function readJob(value: unknown): Job | null {
  if (!value || typeof value !== 'object' || !('job' in value)) throw new Error('Respons scan tidak sesuai.')
  if (value.job === null) return null
  const job = value.job as Job
  if (!job || typeof job.id !== 'string' || !/^[a-f0-9-]{36}$/.test(job.id) || !Object.hasOwn(jobLabels, job.status) || typeof job.message !== 'string' || typeof job.usageWarning !== 'string' || typeof job.truncated !== 'boolean' || typeof job.cancelRequested !== 'boolean' || !['discovered', 'processed', 'added', 'skipped', 'problems', 'metadataQueued'].every(k => Number.isSafeInteger(job[k as keyof Job]) && Number(job[k as keyof Job]) >= 0)) throw new Error('Respons progres scan tidak sesuai.')
  if (!job.scope || !['games', 'bios', 'both'].includes(job.scope.kind) || !Array.isArray(job.scope.platforms) || !job.scope.platforms.length || job.scope.platforms.length > 7 || job.scope.platforms.some(p => !platforms.includes(p)) || typeof job.scope.scanMetadata !== 'boolean') throw new Error('Respons pilihan scan tidak sesuai.')
  return job
}

export default function CatalogScan({ userId, onDenied }: { userId: string; onDenied: (error: unknown) => void }) {
  const [kind, setKind] = useState('both'), [selected, setSelected] = useState(platforms)
  const [scanMetadata, setMetadata] = useState(false), [ready, setReady] = useState(false)
  const [job, setJob] = useState<Job | null>(null), [results, setResults] = useState<Results | null>(null)
  const [status, setStatus] = useState(''), [q, setQ] = useState(''), [page, setPage] = useState(1)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false)
  const [sources, setSources] = useState<{ games: string; bios: string } | null>(null)
  const generation = useRef(0)
  const [remembered, setRemembered] = useState(() => {
    try { const value = sessionStorage.getItem('maindulu-catalog-scan'); return value && /^[a-f0-9-]{36}$/.test(value) ? value : null } catch { return null }
  })
  const active = !!job && ['queued', 'running'].includes(job.status)
  const fail = (e: unknown) => { setError(e instanceof Error ? e.message : 'Permintaan scan gagal.'); onDenied(e) }
  useVisiblePolling(true, async signal => {
    if (busy) return
    const version = generation.current
    try { const value = await metadataReady(signal); if (!signal.aborted) setReady(value) } catch { if (!signal.aborted) setReady(false) }
    try {
      const sourceData = await adminRequest('/api/admin/catalog-scans/sources', { signal }) as { sources: Record<string, { mode: string }> }
      if (!sourceData.sources || !['games', 'bios'].every(k => ['external', 'shared', 'managed'].includes(sourceData.sources[k]?.mode))) throw new Error('Respons sumber scan tidak sesuai.')
      if (!signal.aborted) setSources({ games: sourceData.sources.games.mode, bios: sourceData.sources.bios.mode })
      let next = readJob(await adminRequest(job ? `/api/admin/catalog-scans/${job.id}` : '/api/admin/catalog-scans/active', { signal }))
      if (!next && remembered) {
        try { next = readJob(await adminRequest(`/api/admin/catalog-scans/${remembered}`, { signal })) }
        catch (e) { if (!signal.aborted) setRemembered(null); throw e }
      }
      if (!signal.aborted && version === generation.current) { setJob(next); setLoaded(true) }
    } catch (e) { if (!signal.aborted) fail(e); throw e }
  }, 2000)
  const query = new URLSearchParams({ page: String(page), status, q }).toString()
  useEffect(() => {
    if (!job) return
    const controller = new AbortController()
    void adminRequest(`/api/admin/catalog-scans/${job.id}/results?${query}`, { signal: controller.signal }).then(value => {
      const data = value as Results
      if (!Array.isArray(data.items) || data.items.length > 50 || !Number.isSafeInteger(data.total) || data.total < 0 || data.items.some(item => !item || typeof item.path !== 'string' || typeof item.message !== 'string' || !Object.hasOwn(labels, item.status) || !Number.isSafeInteger(item.ordinal) || !(item.existingId === null || typeof item.existingId === 'string'))) throw new Error('Respons hasil scan tidak sesuai.')
      if (!controller.signal.aborted) setResults(data)
    }).catch(e => { if (!controller.signal.aborted) fail(e) })
    return () => controller.abort()
    // A processed-count change refreshes details, without polling while hidden.
  }, [job?.id, job?.processed, query])
  async function mutate(cancel = false) {
    if (busy) return
    generation.current++
    setBusy(true); setError('')
    const signal = AbortSignal.timeout(15000)
    try {
      const token = await adminToken(userId, signal)
      const next = readJob(await adminRequest(cancel ? `/api/admin/catalog-scans/${job?.id}/cancel` : '/api/admin/catalog-scans', { method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify(cancel ? {} : { kind, platforms: selected, scanMetadata: kind !== 'bios' && scanMetadata }) }))
      setJob(next)
      if (!cancel) { setResults(null); setPage(1) }
      if (!cancel && next) { try { sessionStorage.setItem('maindulu-catalog-scan', next.id) } catch { /* optional storage */ } }
    } catch (e) {
      fail(e)
      // Recover a competing job or an accepted start whose response was lost.
      try { setJob(readJob(await adminRequest('/api/admin/catalog-scans/active', { signal: AbortSignal.timeout(10000) }))) } catch { /* keep actionable error */ }
    } finally { setBusy(false) }
  }
  return <div className="account-form">
    <h2>Scan Koleksi</h2>
    <p>Sumber ROM: {sources ? sources.games === 'shared' ? 'folder bersama baca/tulis' : sources.games === 'external' ? 'eksternal hanya-baca' : 'folder roms pada data server' : 'memeriksa…'}. Sumber BIOS: {sources ? sources.bios === 'shared' ? 'folder bersama baca/tulis' : sources.bios === 'external' ? 'eksternal hanya-baca' : 'folder bios pada data server' : 'memeriksa…'}. Setiap sumber memakai subfolder &lt;platform&gt; yang dipilih di bawah; subfolder bertingkat tidak diikuti.</p>
    <p>Berkas valid otomatis masuk katalog. Hanya tamu yang sudah lewat pintu masuk yang bisa mengunduhnya. Tidak ada tahap konfirmasi impor. Pada mode folder bersama, upload admin memakai folder yang sama dengan scan. Pada mode eksternal hanya-baca, upload tetap internal.</p>
    <p className="notice">Tunggu minimal 10 detik setelah perubahan terakhir. Scan tidak menyalin atau mengubah sumber. Pada folder bersama, Hapus ikut menghapus file fisik yang dipakai RomM. Pada sumber hanya-baca Hapus tetap dinonaktifkan. Jangan overwrite berkas terdaftar; perubahan byte dilaporkan sebagai konflik. Berkas hilang tidak menghapus ID/save. Daftar RomM dan maindulu perlu scan/refresh masing-masing. Validasi bukan jaminan playable/autentik.</p>
    <p>Setelah scan selesai, berkas hilang, berubah/rusak, atau tidak aman pada folder yang berhasil diperiksa disembunyikan dari Library. Kembalikan byte asli dan scan ulang untuk menampilkannya kembali dengan ID, metadata, dan save lama. Muat ulang Library setelah scan. Folder gagal diakses serta scan gagal/dibatalkan tidak menerapkan perubahan status ketersediaan.</p>
    <form onSubmit={e => { e.preventDefault(); void mutate() }}>
      <fieldset disabled={active || busy || !loaded}>
        <label>Jenis berkas<select value={kind} onChange={e => { setKind(e.target.value); if (e.target.value === 'bios') setMetadata(false) }}><option value="both">Keduanya</option><option value="games">ROM</option><option value="bios">BIOS</option></select></label>
        <fieldset><legend>Platform folder</legend><label className="account-check"><input type="checkbox" checked={selected.length === platforms.length} onChange={e => setSelected(e.target.checked ? platforms : [])} />Semua platform</label>
          <div className="account-actions">{platforms.map(p => <label className="account-check" key={p}><input type="checkbox" checked={selected.includes(p)} onChange={e => setSelected(old => e.target.checked ? [...old, p] : old.filter(x => x !== p))} />{p}</label>)}</div>
        </fieldset>
        <label className="account-check"><input type="checkbox" disabled={(!ready && !scanMetadata) || kind === 'bios'} checked={kind !== 'bios' && scanMetadata} onChange={e => setMetadata(e.target.checked)} />Cari metadata dan cover untuk game baru</label>
        <p>{!ready ? 'Metadata tidak tersedia: ScreenScraper belum siap atau layanan tidak dapat dihubungi. Periksa konfigurasi provider.' : kind === 'bios' ? 'Metadata hanya tersedia untuk ROM baru.' : 'Nama berkas, ukuran, hash, dan sistem ROM dapat dikirim ke ScreenScraper; untuk CHD serial disc juga dapat dikirim. Byte ROM/BIOS tidak dikirim. Metadata/cover disimpan lokal; hasil ambigu memakai Review metadata. Entri existing dan BIOS tidak dipindai ulang.'}</p>
        <button className="button primary" disabled={!selected.length} type="submit">Mulai Scan</button>
      </fieldset>
    </form>
    {error && <p role="alert" className="error-message">{error}</p>}
    {!loaded && <p role="status">Memeriksa scan aktif…</p>}
    {job && <>
      <p>Scope scan ini: {job.scope.kind === 'games' ? 'ROM' : job.scope.kind === 'bios' ? 'BIOS' : 'ROM dan BIOS'} · folder {job.scope.platforms.join(', ')} · metadata {job.scope.scanMetadata ? 'diminta untuk game baru' : 'tidak diminta'}. Form di atas mengatur scan berikutnya.</p>
      {job.usageWarning && <p className="notice" role="status">{job.usageWarning}</p>}
      <div role="status" aria-live="polite"><h3>Scan {jobLabels[job.status]}</h3><p>{job.discovered} ditemukan · {job.processed} diproses{active ? ' · enumerasi masih berjalan, total belum diketahui' : ''}</p><p>{job.added} ditambahkan · {job.skipped} sudah terdaftar/duplikat · {job.problems} bermasalah</p><p>{job.metadataQueued} game baru masuk antrean metadata. Scan folder selesai tidak berarti metadata selesai.</p>{job.message && <p>{job.message}</p>}</div>
      {active && <button className="button secondary" disabled={busy || job.cancelRequested} onClick={() => void mutate(true)}>{job.cancelRequested ? 'Menunggu pembatalan…' : 'Batalkan scan'}</button>}
      <p>Menutup tab tidak membatalkan scan. Pembatalan tidak menghapus entri sukses atau membatalkan metadata yang sudah diantrekan. Perubahan status ketersediaan lama hanya diterapkan saat scan selesai; pemulihan status tercantum di detail hasil.</p>
      <div className="admin-filters"><label>Status hasil<select value={status} onChange={e => { setStatus(e.target.value); setPage(1) }}><option value="">Semua status</option>{Object.entries(labels).map(([key, value]) => <option value={key} key={key}>{value}</option>)}</select></label><label>Cari nama/path hasil<input type="search" maxLength={200} value={q} onChange={e => { setQ(e.target.value); setPage(1) }} /></label></div>
      <p>Filter hanya mengubah tampilan, bukan pendaftaran yang telah terjadi. Counter disimpan 7 hari; maksimum 10.000 detail per scan untuk 20 scan terbaru.</p>
      {job.truncated && <p className="notice">Detail dipangkas; counter keseluruhan tetap mencakup semua berkas.</p>}
      <div className="admin-list">{results?.items.map(item => <article className="admin-panel" key={item.ordinal}><h3 style={{ overflowWrap: 'anywhere' }}>{item.path}</h3><p>{labels[item.status]} — {item.message}</p>{item.existingId && <p className="admin-hash">ID katalog: {item.existingId}</p>}</article>)}</div>
      <nav className="admin-pagination" aria-label="Halaman hasil scan"><button className="button secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Sebelumnya</button><span>Halaman {page}</span><button className="button secondary" disabled={!results || page * 50 >= results.total} onClick={() => setPage(p => p + 1)}>Berikutnya</button></nav>
    </>}
  </div>
}
