import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { getMetadataJobs, getMetadataService, metadataLabels, metadataPhases } from '../lib/metadata'
import type { MetadataJob, MetadataJobPage, MetadataService } from '../lib/metadata'
import type { ConsoleInfo } from '../lib/domain'
import type { MetadataTasks } from '../lib/useMetadataTasks'
import { useVisiblePolling } from '../lib/useVisiblePolling'
import MetadataReview from './MetadataReview'
import MetadataServiceControls from './MetadataServiceControls'

type Props = { consoles: ConsoleInfo[]; userId: string; tasks: MetadataTasks; onDenied: (error: unknown) => void }
export default function MetadataQueue(props: Props) {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') || '', consoleId = params.get('console') || ''
  const rawStatus = params.get('status') || ''
  const status = Object.hasOwn(metadataLabels, rawStatus) ? rawStatus : ''
  const rawPage = Number(params.get('page') || 1)
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage <= 1000000 ? rawPage : 1
  const query = new URLSearchParams({ q: q.slice(0, 200), console: consoleId, status, page: String(page), pageSize: '12' }).toString()
  function filter(key: string, value: string) {
    setParams(previous => { const next = new URLSearchParams(previous); if (value) next.set(key, value); else next.delete(key); if (key !== 'page') next.delete('page'); return next }, { replace: key === 'q' })
  }
  return <>
    <h2>Antrean Metadata</h2>
    <p>Progres berdasarkan tahapan, bukan persentase. Menampilkan tugas terbaru tiap game aktif, termasuk hasil selesai. Data berasal dari server dan tetap tersedia setelah refresh.</p>
    <QueueResults key={`${props.userId}-${query}`} {...props} consoleId={consoleId} query={query} page={page} onPage={page => filter('page', String(page))} filters={<div className="admin-filters">
      <label>Cari game atau berkas<input type="search" maxLength={200} value={q} onChange={e => filter('q', e.target.value)} /></label>
      <label>Filter console<select value={consoleId} onChange={e => filter('console', e.target.value)}><option value="">Semua console</option>{props.consoles.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>Status metadata<select aria-label="Status metadata" value={status} onChange={e => filter('status', e.target.value)}><option value="">Semua status</option>{Object.entries(metadataLabels).map(([key, label]) => <option key={key} value={key}>{key === 'disabled' ? 'Belum dipindai' : label}</option>)}</select></label>
    </div>} />
  </>
}

function QueueResults({ consoles, userId, tasks, onDenied, query, page, onPage, consoleId, filters }: Props & { query: string; page: number; consoleId: string; filters: ReactNode; onPage: (page: number) => void }) {
  const [data, setData] = useState<MetadataJobPage | null>(null)
  const [service, setService] = useState<MetadataService | null>(null)
  const [error, setError] = useState('')
  const [updated, setUpdated] = useState<number | null>(null)
  const [review, setReview] = useState<MetadataJob | null>(null)
  const refreshButton = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  useEffect(() => {
    if (!review && restoreFocus.current) { restoreFocus.current = false; refreshButton.current?.focus() }
  }, [review])
  const refresh = useVisiblePolling(true, async signal => {
    try {
      const [next, state] = await Promise.all([getMetadataJobs(query, signal), getMetadataService(signal)])
      if (signal.aborted) return
      setData(next); setService(state); setError(''); setUpdated(Date.now())
    } catch (e) {
      if (!signal.aborted) { setError(e instanceof Error ? e.message : 'Antrean belum dapat dimuat.'); onDenied(e) }
      throw e
    }
  }, 2500)
  const date = (value: number) => new Date(value).toLocaleString('id-ID')
  return <>
    {service && data && <MetadataServiceControls service={service} data={data} consoles={consoles} consoleId={consoleId} userId={userId} unavailable={!!error} refresh={refresh} onDenied={onDenied} />}
    {filters}
    <div className="admin-toolbar"><p className="field-hint">Diperbarui otomatis saat halaman aktif.{updated && ` Pembaruan terakhir: ${date(updated)}.`}</p><button ref={refreshButton} className="button secondary small" onClick={refresh}><RefreshCw size={16} />Muat ulang antrean</button></div>
    {error && <p className="error-message" role="alert">{error} {data && 'Data di bawah adalah pembaruan terakhir, bukan status terkini.'}</p>}
    {!data && !error && <p role="status">Memuat antrean metadata…</p>}
    {data && <>
      <div className="metadata-summary" aria-label="Ringkasan seluruh tugas metadata">{Object.entries(metadataLabels).map(([key, label]) => <div className="admin-panel" key={key}><strong>{data.counts[key] ?? 0}</strong><span>{key === 'disabled' ? 'Belum dipindai' : label}</span></div>)}</div>
      <p className="admin-count">Ringkasan seluruh game aktif (tidak mengikuti filter). Hasil filter: {data.total} tugas · halaman {page} dari {Math.max(1, Math.ceil(data.total / data.pageSize))}.</p>
      {!data.items.length && <div className="empty-state"><h3>Tidak ada tugas metadata.</h3><p>Ubah filter atau jalankan scan melalui Manage Game.</p></div>}
      <div className="admin-list">{data.items.map(job => <article className="admin-panel" key={job.id} aria-label={job.title || job.fileName}>
        <div className="admin-item-heading"><h3>{job.title || job.fileName}</h3><span className="slot-badge">{metadataLabels[job.status]}</span></div>
        <p>{consoles.find(c => c.id === job.consoleId)?.name || job.consoleId} · {job.fileName}</p>
        <dl><dt>Tahapan terakhir</dt><dd>{metadataPhases[job.phase || ''] || job.phase || '—'}</dd><dt>Percobaan</dt><dd>{job.attempts}</dd><dt>Dijadwalkan</dt><dd>{date(job.createdAt)}</dd><dt>Diperbarui</dt><dd>{date(job.updatedAt)}</dd>{job.nextAt !== null && <><dt>{job.status === 'queued' ? 'Jadwal proses' : 'Jadwal berikutnya'}</dt><dd>{date(job.nextAt)}</dd></>}{job.reason && <><dt>Alasan / peringatan</dt><dd><code>{job.reason}</code></dd></>}</dl>
        <button className="button secondary small" onClick={() => setReview(job)}>Review / scan metadata</button>
      </article>)}</div>
      <nav className="admin-pagination" aria-label="Halaman antrean metadata"><button className="button secondary small" disabled={page <= 1} onClick={() => onPage(page - 1)}>Sebelumnya</button><span>Halaman {page}</span><button className="button secondary small" disabled={page * data.pageSize >= data.total} onClick={() => onPage(page + 1)}>Berikutnya</button></nav>
    </>}
    {review && <MetadataReview id={review.gameId} title={review.title || review.fileName} userId={userId} ready={service?.ready === true && !error} tasks={tasks} onDenied={onDenied} onClose={() => { restoreFocus.current = true; setReview(null); refresh() }} />}
  </>
}
