import { useEffect, useState } from 'react'
import Dialog from './Dialog'
import { downloadGameSave, GameSaveClient } from '../lib/game-saves'
import type { GameSaveList } from '../lib/game-saves'
import { formatBytes } from '../lib/saves'

export default function GameSaveLibrary({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [client, setClient] = useState<GameSaveClient | null>(null)
  const [list, setList] = useState<GameSaveList | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let live = true
    const next = new GameSaveClient(userId)
    setClient(next); setList(null); setError('')
    void next.listProgress().then(value => { if (live) setList(value) }).catch(e => { if (live) setError(e instanceof Error ? e.message : 'Daftar progres gagal dimuat.') })
    return () => { live = false; next.close() }
  }, [userId, retry])
  async function run(work: () => Promise<unknown>) {
    if (busy) return
    setBusy(true); setError('')
    try { await work() } catch (e) { setError(e instanceof Error ? e.message : 'Operasi progres gagal.') }
    finally { setBusy(false) }
  }
  return <Dialog title="Kelola progres game" onClose={onClose} busy={busy} className="server-state-dialog">
    <p>Save dalam game/SRAM dan memcard, bukan slot save state. Unduh cadangan sebelum menghapus. Tidak ada impor otomatis dari browser.</p>
    {error && <p className="notice" role="alert">{error}</p>}
    {list ? <><p>Kuota gabungan state + progres + cadangan: {formatBytes(list.usage.usedBytes)} / {formatBytes(list.usage.quotaBytes)}</p>
      {!list.saves.some(s => !s.deleted) && <p>Belum ada progres game di server.</p>}
      {list.saves.filter(s => !s.deleted).map(save => <article className="server-slot" key={save.id}>
        <div><strong>{save.title}</strong><p>{save.core} · {formatBytes(save.size)} · revisi {save.revision}</p><p>Engine {save.metadata.engineVersion} · {save.metadata.variant} · core {save.metadata.coreBuild.slice(0, 12)} · {new Date(save.updatedAt).toLocaleString('id-ID')}</p><small>{save.gameId}</small>{save.metadata.provenance && <p>Impor {save.metadata.provenance.source}: build sumber tidak diketahui; dikonfirmasi untuk build tujuan.</p>}</div>
        <span className="slot-actions"><button className="button secondary small" disabled={!client || busy} onClick={() => void run(async () => { const bytes = await client!.getProgress(save); downloadGameSave(bytes, save.gameId + '-server') })}>Unduh progres</button>
          <button className="button secondary small" disabled={!client || busy} onClick={() => {
            if (window.confirm(`Hapus progres ${save.title}? Seluruh save aktif dalam paket ini dihapus. Pastikan game ini tidak sedang terbuka di tab/perangkat lain; upload lama akan ditolak.`)) void run(async () => { await client!.removeProgress(save); setRetry(n => n + 1) })
          }}>Hapus progres</button></span>
      </article>)}</> : !error && <p role="status">Memuat progres…</p>}
    <button className="button secondary small" disabled={busy} onClick={() => setRetry(n => n + 1)}>Muat ulang progres</button>
  </Dialog>
}
