import { useEffect, useRef, useState } from 'react'
import { getMetadataJobs, metadataControl, pausedReasonLabels } from '../lib/metadata'
import type { MetadataJobPage, MetadataService } from '../lib/metadata'
import type { ConsoleInfo } from '../lib/domain'
import Dialog from './Dialog'

const groups = { disabled: 'Belum pernah dipindai', not_found: 'Tidak ditemukan', failed: 'Gagal', paused: 'Dijeda', cancelled: 'Dibatalkan', unsupported: 'Format belum didukung' }
type Props = { service: MetadataService; data: MetadataJobPage; consoles: ConsoleInfo[]; consoleId: string; userId: string; unavailable: boolean; refresh: () => void; onDenied: (e: unknown) => void }
export default function MetadataServiceControls({ service, data, consoles, consoleId, userId, unavailable, refresh, onDenied }: Props) {
  const [dialog, setDialog] = useState<'backfill' | 'cancel' | null>(null)
  const [statuses, setStatuses] = useState(['disabled'])
  const [scope, setScope] = useState(consoleId)
  const [replaceLocked, setReplaceLocked] = useState(false)
  const [estimate, setEstimate] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const backfillButton = useRef<HTMLButtonElement>(null)
  const restoreAfterStop = useRef(false)
  const requests = useRef(new Set<AbortController>())
  useEffect(() => () => { for (const controller of requests.current) controller.abort() }, [userId])
  useEffect(() => {
    if (!dialog && restoreAfterStop.current) { restoreAfterStop.current = false; backfillButton.current?.focus() }
  }, [dialog])
  const selection = statuses.join(',')
  useEffect(() => {
    if (dialog !== 'backfill') return
    const controller = new AbortController()
    setEstimate(null)
    Promise.all(selection.split(',').filter(Boolean).map(status => getMetadataJobs(new URLSearchParams({ status, console: scope, pageSize: '1' }).toString(), controller.signal)))
      .then(pages => { if (!controller.signal.aborted) setEstimate(pages.reduce((sum, page) => sum + page.total, 0)) })
      .catch(e => { if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : 'Estimasi tidak tersedia.'); onDenied(e) } })
    return () => controller.abort()
  }, [dialog, selection, scope, onDenied])
  const date = (value: number) => new Date(value).toLocaleString('id-ID')
  const cooldown = service.cooldownUntil > Date.now()
  const blocker = unavailable ? 'Status terkini belum tersedia. Muat ulang antrean.' : !service.ready ? 'Perbaiki konfigurasi ScreenScraper di server, lalu muat ulang.' : cooldown ? `Tunggu cooldown berakhir: ${date(service.cooldownUntil)}.` : ''
  const backfillBlocker = blocker || (service.pausedReason ? 'Lanjutkan layanan terlebih dahulu.' : '')
  const count = (status: string) => data.counts[status] ?? 0
  const waiting = count('queued') + count('retry_wait') + count('paused')
  const total = waiting + count('running')
  const cancelling = service.queue?.cancelling ?? 0
  const capacity = service.queue?.capacity ?? Math.max(0, 1000 - count('queued') - count('retry_wait') - count('running'))
  const amount = Math.min(estimate ?? 0, capacity, 1000)
  const state = service.pausedReason ? 'Dijeda' : !service.ready ? 'Belum siap' : cooldown ? `Dibatasi sampai ${date(service.cooldownUntil)}` : !service.worker.running || !service.worker.enabled ? 'Worker berhenti' : 'Siap'
  async function run(action: 'resume' | 'cancel' | 'backfill') {
    if (busy) return
    const controller = new AbortController()
    requests.current.add(controller); setBusy(true); setError(''); setMessage('')
    try {
      const result = await metadataControl(userId, action, action === 'backfill' ? { statuses, ...(scope ? { consoleId: scope } : {}), replaceLocked } : {}, controller.signal)
      if (controller.signal.aborted) return
      setMessage('queued' in result ? `${result.queued} scan diantrekan · ${result.skipped} dilewati (batas antrean).` : 'cancelled' in result ? result.cancelling ? `${result.cancelled} dihentikan · ${result.cancelling} sedang dihentikan.` : `${result.cancelled} scan dihentikan.` : 'Layanan dilanjutkan.')
      if (action === 'cancel') restoreAfterStop.current = true
      setDialog(null)
    } catch (e) {
      if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : 'Aksi belum terkonfirmasi. Muat ulang sebelum mengulang.'); onDenied(e) }
    } finally {
      requests.current.delete(controller)
      if (!controller.signal.aborted) { setBusy(false); refresh() }
    }
  }
  return <>
    <section className="admin-panel metadata-controls" aria-label="Kontrol layanan">
      <h3>Kontrol layanan</h3>
      <div className="admin-toolbar">
        <div>
          <strong className={`metadata-service-state ${state === 'Siap' ? 'ready' : 'warning'}`}>● {state}</strong>
          {service.pausedReason && <p>{pausedReasonLabels[service.pausedReason] || 'Layanan dijeda oleh provider.'} <small><code>{service.pausedReason}</code></small></p>}
          {service.pausedReason && cooldown && <p>Dibatasi sampai {date(service.cooldownUntil)}.</p>}
          {!service.ready && <p>Perbaiki konfigurasi ScreenScraper di server, lalu muat ulang.</p>}
          {service.ready && !service.worker.running && <p>Worker metadata belum berjalan. Periksa proses server.</p>}
          <p>Antre {count('queued') + count('retry_wait')} · Jalan {count('running')} · Perlu review {count('needs_review')} · Masalah {count('failed') + count('paused')} · Belum dipindai {count('disabled')}</p>
        </div>
        <div className="admin-toolbar">
          {service.pausedReason && <button className="button" disabled={busy || !!blocker} onClick={() => void run('resume')}>Lanjutkan layanan</button>}
          <button ref={backfillButton} className="button secondary" disabled={busy} onClick={() => { setStatuses(['disabled']); setScope(consoleId); setReplaceLocked(false); setError(''); setDialog('backfill') }}>Scan game tanpa metadata</button>
          {total > 0 && <button className="button danger-outline" disabled={busy || cancelling > 0 || unavailable} onClick={() => { setError(''); setDialog('cancel') }}>{cancelling || busy && dialog === 'cancel' ? `Menghentikan… ${cancelling || total} tersisa` : 'Hentikan semua scan'}</button>}
        </div>
      </div>
      {service.pausedReason && blocker && <p className="field-hint">{blocker}</p>}
      <p role="status" aria-live="polite">{message}</p>
      {error && !dialog && <p className="error-message" role="alert">{error}</p>}
    </section>
    {dialog && <Dialog className="admin-dialog" title={dialog === 'cancel' ? `Hentikan ${total} scan?` : 'Scan game tanpa metadata'} eyebrow="KONTROL METADATA" busy={busy} onClose={() => setDialog(null)}>
      {dialog === 'cancel' ? <p>{waiting} menunggu dan {count('running')} sedang berjalan akan dihentikan. Metadata yang sudah diterapkan tidak dihapus. Scan yang berjalan berhenti pada titik pemeriksaan berikutnya.</p> : <>
        <fieldset disabled={busy}><legend>Kelompok yang disertakan</legend>{Object.entries(groups).map(([key, label]) => <label className="metadata-check" key={key}><input type="checkbox" checked={statuses.includes(key)} onChange={e => setStatuses(previous => e.target.checked ? [...previous, key] : previous.filter(s => s !== key))} />{label}</label>)}</fieldset>
        <label>Scope console<select disabled={busy} value={scope} onChange={e => setScope(e.target.value)}><option value="">Semua console</option>{consoles.map(c => <option value={c.id} key={c.id}>Console: {c.name}</option>)}</select></label>
        <label className="metadata-check"><input type="checkbox" disabled={busy} checked={replaceLocked} onChange={e => setReplaceLocked(e.target.checked)} />Ganti juga metadata yang terkunci</label>
        <p role="status">{estimate === null ? 'Menghitung game…' : `≈ ${estimate} game akan diantrekan · ${capacity} slot antrean tersisa.`}</p>
        {estimate !== null && estimate > amount && <p className="notice">Hanya {amount} yang diantrekan; sisanya dapat dijalankan lagi nanti.</p>}
        {backfillBlocker && <p className="notice">{backfillBlocker}</p>}
      </>}
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="admin-toolbar">
        <button className="button secondary" disabled={busy} onClick={() => setDialog(null)}>Batalkan</button>
        <button className={`button ${dialog === 'cancel' ? 'danger-outline' : ''}`} disabled={busy || (dialog === 'backfill' ? !!backfillBlocker || !amount || estimate === null : unavailable || total === 0)} onClick={() => void run(dialog)}>{busy ? 'Memproses…' : dialog === 'cancel' ? `Hentikan ${total} scan` : `Antrekan ${amount} scan`}</button>
      </div>
    </Dialog>}
  </>
}
