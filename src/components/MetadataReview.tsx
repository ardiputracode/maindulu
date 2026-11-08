import { useEffect, useRef, useState } from 'react'
import Dialog from './Dialog'
import { fieldLabels, getMetadata, metadataAction, metadataLabels } from '../lib/metadata'
import type { MetadataDetail } from '../lib/metadata'
import { useVisiblePolling } from '../lib/useVisiblePolling'
import type { MetadataTasks } from '../lib/useMetadataTasks'

export default function MetadataReview({ id, title, userId, ready, tasks, onClose, onDenied }: { id: string; title: string; userId: string; ready: boolean; tasks: MetadataTasks; onClose: () => void; onDenied: (error: unknown) => void }) {
  const [data, setData] = useState<MetadataDetail | null>(null)
  const [candidateId, setCandidateId] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [replaceLocked, setReplaceLocked] = useState(true)
  const [query, setQuery] = useState('')
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [unlocking, setUnlocking] = useState(false)
  const operation = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current?.abort() } }, [])
  function accept(next: MetadataDetail) {
    if (data && (next.preview.revision < data.preview.revision || (next.generation ?? 0) < (data.generation ?? 0))) return
    if (data?.preview.revision !== next.preview.revision || data?.generation !== next.generation) setSelected([])
    setData(next)
    tasks.watch(id, title, next)
  }
  useVisiblePolling(true, async signal => {
    if (operation.current) return
    try { const next = await getMetadata(id, signal); if (!signal.aborted) accept(next) }
    catch (e) { if (!signal.aborted) { setError(e instanceof Error ? e.message : 'Status belum tersedia.'); onDenied(e) }; throw e }
  }, 2500)
  const candidate = data?.candidates.find(c => c.id === candidateId) ?? data?.candidates[0]
  const view = candidate?.preview ?? data?.preview
  const active = !!data && ['queued', 'running', 'retry_wait'].includes(data.status)
  const cooldown = !!data?.nextAt && data.nextAt > Date.now() && ['retry_wait', 'failed', 'not_found'].includes(data.status)
  const globalCooldown = (data?.cooldownUntil ?? 0) > Date.now()
  const reviewable = !!data && ['needs_review', 'succeeded'].includes(data.status)
  async function act(action: 'scan' | 'search' | 'apply' | 'unlock', field?: string) {
    if (operation.current || !data) return
    const controller = new AbortController(); operation.current = controller; setBusy(true); setError(''); setNotice('')
    setUnlocking(action === 'unlock')
    try {
      const body = action === 'search' ? { query } : action === 'apply' ? { candidateId: candidate?.id, generation: data.generation, expectedRevision: view?.revision, fields: selected }
        : action === 'unlock' ? { field: ({ releaseDate: 'release_date', regionLanguage: 'region_language' } as Record<string, string>)[field!] ?? field, expectedRevision: data.preview.revision } : { replaceLocked }
      if (action === 'unlock') await metadataAction(id, userId, action, body, controller.signal)
      else await tasks.run(id, title, action, body)
      if (!mounted.current) return
      const next = await getMetadata(id, controller.signal)
      if (mounted.current) { accept(next); setSelected([]); setNotice(action === 'unlock' ? 'Kunci field dibuka. Nilai belum diubah.' : 'Tugas dijadwalkan. Scan tetap berjalan di latar belakang meskipun dialog ditutup.') }
    } catch (e) {
      if (mounted.current) { setError(e instanceof Error ? e.message : 'Permintaan gagal.'); onDenied(e) }
    } finally { operation.current = null; if (mounted.current) { setBusy(false); setUnlocking(false) } }
  }
  const value = (v: string | boolean | null) => v === true ? 'Cover tersedia' : v === false || v === null || v === '' ? '—' : v
  return <Dialog title={`Review metadata: ${title}`} eyebrow="METADATA OTOMATIS" onClose={onClose} busy={busy} allowCloseWhileBusy={!unlocking} className="admin-dialog">
    <div className="account-form">
      {!ready && <p className="notice">Scan nonaktif atau konfigurasi belum siap. Game tetap dapat dimainkan.</p>}
      {(busy && !unlocking || active) && <p className="notice">Scan tetap berjalan di latar belakang. Kamu boleh menutup dialog atau pindah halaman; hasilnya akan muncul melalui notifikasi.</p>}
      {data ? <><p role="status"><strong>{metadataLabels[data.status]}</strong></p>
        {data.reason && <p className="field-hint">{data.reason.startsWith('COVER_') ? 'Metadata teks selesai, tetapi cover belum tersedia. Cover sebelumnya dipertahankan.' : 'Hasil belum lengkap atau memerlukan tindakan admin.'} <code>{data.reason}</code></p>}
        {data.nextAt && <p>Percobaan berikutnya: {new Date(data.nextAt).toLocaleString('id-ID')}</p>}
        <p>ZIP satu ROM raw mendukung pencocokan hash anggota (stored/deflate, maksimum 64 MiB dan rasio 100:1). ZIP multi-berkas, 7z/RAR dan disc PS1 tetap review manual. Pencarian nama memerlukan konfirmasi; console dan identitas save tidak diubah.</p>
        {globalCooldown && <p>Layanan dibatasi sampai {new Date(data.cooldownUntil!).toLocaleString('id-ID')}.</p>}
        <label className="account-check"><input type="checkbox" checked={replaceLocked} disabled={busy || active} onChange={e => setReplaceLocked(e.target.checked)} />Ganti juga metadata yang terkunci saat scan ulang</label>
        <p className="field-hint">Hasil kecocokan pasti langsung diterapkan tanpa konfirmasi. Hilangkan centang untuk mempertahankan field terkunci. Usulan kosong tidak menghapus data lama; hasil ambigu tetap perlu review.</p>
        <button type="button" className="button secondary small" disabled={busy || !ready || active || cooldown || globalCooldown} onClick={() => void act('scan')}>{data.status === 'failed' || data.status === 'paused' ? 'Coba scan lagi' : 'Scan ulang'}</button>
        <label htmlFor="metadata-search">Nama pencarian manual</label><input id="metadata-search" type="search" maxLength={200} value={query} onChange={e => setQuery(e.target.value)} />
        <button type="button" className="button secondary small" disabled={busy || !ready || active || globalCooldown || (cooldown && data.status !== 'not_found') || !query.trim()} onClick={() => void act('search')}>Cari kandidat</button>
        {data.candidates.length > 0 && <><label htmlFor="metadata-candidate">Kandidat tersimpan</label><select id="metadata-candidate" value={candidate?.id ?? ''} onChange={e => { setCandidateId(e.target.value); setSelected([]) }}>{data.candidates.map(c => <option key={c.id} value={c.id}>{c.title} · {c.id}</option>)}</select></>}
        <p>Hasil scan dengan kecocokan pasti diterapkan otomatis sesuai pilihan scan ulang di atas. Gunakan pilihan di bawah hanya untuk review manual. Penerapan manual mengunci field terpilih.</p>
        <div className="metadata-fields">{view && Object.entries(view.fields).map(([field, info]) => <div className="metadata-field" key={field}>
          <label className="account-check"><input type="checkbox" aria-label={`Terapkan ${fieldLabels[field]}`} checked={selected.includes(field)} disabled={busy || active || !reviewable || !info.proposed} onChange={e => setSelected(old => e.target.checked ? [...old, field] : old.filter(f => f !== field))} />{fieldLabels[field]}</label>
          <p>Sekarang: <span>{value(info.current)}</span></p><p>Usulan: <span>{value(info.proposed)}</span></p>
          <p className="field-hint">Sumber: {info.source === 'manual' ? 'Admin' : info.source === 'filename' ? 'Nama berkas' : 'ScreenScraper'} · {info.locked ? 'Terkunci' : 'Terbuka'}</p>
          {info.locked && <button type="button" className="button secondary small" disabled={busy || active} onClick={() => void act('unlock', field)}>Buka kunci {fieldLabels[field]}</button>}
        </div>)}</div>
        <button type="button" className="button primary" disabled={busy || !ready || active || globalCooldown || !reviewable || !selected.length} onClick={() => void act('apply')}>Terapkan field terpilih</button>
      </> : <p role="status">Memuat metadata…</p>}
      {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="error-message">{error}</p>}
      <button type="button" className="button secondary" disabled={unlocking} onClick={onClose}>Tutup</button>
    </div>
  </Dialog>
}
