import { useEffect, useRef, useState } from 'react'
import Dialog from './Dialog'
import { downloadState, formatBytes, SaveError } from '../lib/saves'
import { downloadGameSave } from '../lib/game-saves'
import { TransferClient } from '../lib/save-transfer'
import type { Backup, Operation, TransferSave } from '../lib/save-transfer'
import { createSessionId } from '../lib/identity'

export default function BackupLibrary({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [client, setClient] = useState<TransferClient | null>(null)
  const [list, setList] = useState<Awaited<ReturnType<TransferClient['backups']>> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [restore, setRestore] = useState<{ backup: Backup; bytes: Uint8Array; current: TransferSave | null; operation: Operation } | null>(null)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    const next = new TransferClient(userId)
    setClient(next)
    void next.backups().then(v => { if (live.current) setList(v) }).catch(e => { if (live.current) setError(e.message) })
    return () => { live.current = false; next.close() }
  }, [userId])
  async function run(work: () => Promise<void>) {
    if (busy || !client) return
    setBusy(true); setError(''); setMessage('')
    try { await work() }
    catch (e) {
      if (live.current) {
        setError(e instanceof Error ? e.message : 'Operasi cadangan gagal.')
        if (e instanceof SaveError && e.code === 'REVISION_CONFLICT') setRestore(null)
      }
    } finally { if (live.current) setBusy(false) }
  }
  return <Dialog title="Cadangan konflik dan impor" onClose={onClose} busy={busy} className="server-state-dialog">
    <p>Kuota gabungan state + progres + cadangan. Cadangan tidak dihapus otomatis. Hapus hanya salinan yang tidak diperlukan; ini bukan backup instalasi M8.</p>
    {error && <p className="notice" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {list && <p>{formatBytes(list.usage.usedBytes)} / {formatBytes(list.usage.quotaBytes)}</p>}
    {restore ? <div className="account-form">
      <h3>Pulihkan {restore.backup.title}</h3>
      <p>{restore.backup.kind} · {restore.backup.core} · slot {restore.backup.slot || 'progres'} · {formatBytes(restore.backup.size)}</p>
      <p>Tujuan sekarang: {restore.current ? `revisi ${restore.current.revision}${restore.current.deleted ? ' (dihapus)' : ''}` : 'kosong'}. Versi aktif yang diganti dicadangkan, lalu dibuat revisi baru. Cadangan asal tetap ada. Player di tab lain akan konflik; buka ulang untuk memakai hasil pemulihan.</p>
      <button className="button primary small" disabled={busy} onClick={() => void run(async () => {
        await client!.decide(restore.backup.kind, restore.bytes, restore.backup, restore.backup.metadata, restore.current?.revision ?? 0, restore.operation)
        if (!live.current) return
        setRestore(null); setMessage('Cadangan dipulihkan sebagai revisi server baru. Buka ulang game untuk progres, atau Muat slot untuk state.')
        const v = await client!.backups(); if (live.current) setList(v)
      })}>Konfirmasi pemulihan / retry yang sama</button>
      <button className="button secondary small" disabled={busy} onClick={() => { if (window.confirm('Batalkan peninjauan? Jika respons sebelumnya terputus, pemulihan mungkin sudah tersimpan. Periksa versi aktif sebelum keputusan baru.')) setRestore(null) }}>Batal peninjauan</button>
    </div> : <div className="save-list">{list?.backups.length === 0 && <p>Belum ada cadangan konflik atau impor.</p>}{list?.backups.map(b => <article className="save-item" key={b.id}>
      <strong>{b.title} — {b.kind === 'state' ? `state slot ${b.slot}` : 'progres'}</strong>
      <p>{b.core} · {formatBytes(b.size)} · {b.reason} · revisi asal {b.sourceRevision ?? 'sesi lokal'}</p>
      <p>Engine {b.metadata.engineVersion} · {b.metadata.variant} · build core {b.metadata.coreBuild.slice(0, 12)}. Pemulihan tidak mengonversi versi/layout.</p>
      <p>{new Date(b.createdAt).toLocaleString('id-ID')} · <span className="save-identity">{b.gameId}</span></p>
      {b.metadata.provenance && <p>Asal {b.metadata.provenance.source}; build sumber tidak diketahui, dikonfirmasi untuk build tujuan.</p>}
      <div className="account-actions">
        <button className="button secondary small" disabled={busy} onClick={() => void run(async () => { const bytes = await client!.backupBytes(b); if (b.kind === 'progress') downloadGameSave(bytes, b.gameId + '-cadangan'); else downloadState(bytes, b.gameId + '-cadangan') })}>Unduh cadangan</button>
        <button className="button secondary small" disabled={busy} onClick={() => void run(async () => {
          const current = await client!.current(b.kind, b)
          if (current && !current.deleted) await client!.bytes(b.kind, current)
          const bytes = await client!.backupBytes(b)
          if (live.current) setRestore({ backup: b, bytes, current, operation: { id: createSessionId(), action: 'replace', reason: 'restore' } })
        })}>Tinjau pemulihan</button>
        <button className="button secondary small" disabled={busy} onClick={() => {
          if (window.confirm(`Hapus cadangan ${b.title} ini secara permanen? Save aktif tidak dihapus. Unduh dulu bila diperlukan.`)) void run(async () => { await client!.removeBackup(b); const v = await client!.backups(); if (live.current) setList(v) })
        }}>Hapus cadangan</button>
      </div>
    </article>)}</div>}
    <button className="button secondary small" disabled={busy || !!restore} onClick={() => void run(async () => { const v = await client!.backups(); if (live.current) setList(v) })}>Muat ulang cadangan</button>
  </Dialog>
}
