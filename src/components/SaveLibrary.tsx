import { useState } from 'react'
import Dialog from './Dialog'
import { downloadState, formatBytes } from '../lib/saves'
import type { SaveClient, SaveList, ServerSave } from '../lib/saves'
import { hashRom } from '../lib/identity'
import { useSaveLibrary } from '../lib/useSaveLibrary'

export function SaveQuota({ list }: { list: SaveList }) {
  const { usedBytes, quotaBytes } = list.usage
  return <div className="save-quota">
    <p>Penyimpanan: <strong>{formatBytes(usedBytes)} / {formatBytes(quotaBytes)}</strong></p>
    <progress aria-label="Penggunaan kuota save" value={Math.min(usedBytes, quotaBytes)} max={quotaBytes} />
    {usedBytes >= quotaBytes * 0.8 && <p className="notice" role="status">Penyimpanan hampir penuh. Pilih sendiri save yang akan dihapus; tidak ada penghapusan otomatis.</p>}
  </div>
}

export function SaveManager({ client, list, onRefresh, onClose }: { client: SaveClient; list: SaveList; onRefresh: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function act(save: ServerSave, remove: boolean) {
    if (remove && !window.confirm(`Hapus ${save.title}, slot ${save.slot}? Unduh cadangan dahulu bila diperlukan. Penghapusan tidak dapat dibatalkan.`)) return
    setBusy(true); setError('')
    try {
      if (remove) { await client.remove(save); await onRefresh() }
      else {
        const bytes = await client.get(save)
        if (await hashRom(new Blob([new Uint8Array(bytes)])) !== save.checksum) throw new Error('Checksum cadangan tidak sesuai.')
        downloadState(bytes, `${save.gameId}-slot-${save.slot}`)
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Operasi save gagal.') }
    finally { setBusy(false) }
  }
  const saves = list.saves.filter(s => !s.deleted)
  return <Dialog title="Kelola simpanan server." onClose={onClose} busy={busy}>
    <SaveQuota list={list} />
    <p>Semua save state akun ini, lintas game. Save dalam game/memcard dikelola terpisah melalui Kelola progres game di dialog akun; kuota akun dipakai bersama.</p>
    {error && <p className="notice" role="alert">{error}</p>}
    <div className="save-list">{saves.length ? saves.map(save => <article className="save-item" key={save.id} aria-label={`${save.title}, ${save.gameId}, slot ${save.slot}`}>
      <strong>{save.title} — slot {save.slot}</strong>
      <p>Identitas game: {save.gameId}</p>
      <p>{save.consoleId} / {save.core} · {formatBytes(save.size)} · revisi {save.revision}</p>
      <p>Engine {save.metadata.engineVersion} · {save.metadata.variant} · build core {save.metadata.coreBuild.slice(0, 12)}</p>
      <time dateTime={new Date(save.updatedAt).toISOString()}>{new Date(save.updatedAt).toLocaleString('id-ID')}</time>
      <div className="account-actions"><button className="button secondary small" disabled={busy} onClick={() => void act(save, false)}>Unduh cadangan {save.title} slot {save.slot}</button><button className="button secondary small" disabled={busy} onClick={() => void act(save, true)}>Hapus {save.title} slot {save.slot}</button></div>
    </article>) : <p>Belum ada save state di server.</p>}</div>
    <button className="button secondary" disabled={busy} onClick={() => void onRefresh()}>Muat ulang daftar</button>
  </Dialog>
}

export default function SaveLibrary({ userId, onClose }: { userId: string; onClose: () => void }) {
  const library = useSaveLibrary(userId)
  if (!library.client || !library.list) return <Dialog title="Kelola simpanan server." onClose={onClose}>{library.error ? <><p role="alert">{library.error}</p><button className="button secondary" onClick={() => void library.refresh()}>Coba muat daftar lagi</button></> : <p role="status">Memuat progres…</p>}</Dialog>
  return <SaveManager client={library.client} list={library.list} onRefresh={library.refresh} onClose={onClose} />
}
