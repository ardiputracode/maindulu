import { useEffect, useRef, useState } from 'react'
import Dialog from './Dialog'
import { downloadState, formatBytes, SaveError } from '../lib/saves'
import type { StateMetadata } from '../lib/saves'
import { downloadGameSave } from '../lib/game-saves'
import { encodeGameSave, gameSaveLayout } from '../lib/game-save-format'
import { createSessionId, hashRom } from '../lib/identity'
import { readBrowserSave, TransferClient, validateImport } from '../lib/save-transfer'
import type { Operation, SaveKind, SaveTarget, TransferSave } from '../lib/save-transfer'

export type TransferRequest = { kind: SaveKind; mode: 'conflict' | 'import'; slot?: number; bytes?: Uint8Array }
export default function SaveTransfer({ owner, ownerName, enabled, request, target, metadata, stateKey, progressPath, capture, onClose, onApplied }: {
  owner: string; ownerName: string; enabled: boolean; request: TransferRequest; target: SaveTarget; metadata: StateMetadata; stateKey: string; progressPath: string | null;
  capture: () => Promise<Uint8Array>; onClose: () => void;
  onApplied: (save: TransferSave | null, bytes: Uint8Array, action: 'replace' | 'preserve') => void;
}) {
  const [client, setClient] = useState<TransferClient | null>(null)
  const [candidate, setCandidate] = useState<Uint8Array | null>(request.bytes ?? null)
  const [checksum, setChecksum] = useState('')
  const [source, setSource] = useState<'file' | 'browser'>('file')
  const [server, setServer] = useState<{ save: TransferSave | null; bytes: Uint8Array | null } | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [slot, setSlot] = useState(request.slot ?? 1)
  // A network failure must retry the SAME immutable operation, not refresh its
  // revision or create a different choice whose first outcome is still unknown.
  const [attempt, setAttempt] = useState<{ operation: Operation; revision: number } | null>(null)
  const live = useRef(true)
  const initialCapture = useRef(capture)
  const actualTarget = { ...target, ...(request.kind === 'state' ? { slot } : {}) }
  useEffect(() => {
    live.current = true
    let current = true
    const next = new TransferClient(owner)
    setClient(next)
    if (request.mode === 'conflict' && !request.bytes) {
      setBusy(true)
      void initialCapture.current().then(v => { if (current) setCandidate(v) }).catch(e => { if (current) setError(e.message) }).finally(() => { if (current) setBusy(false) })
    }
    return () => { current = false; live.current = false; next.close() }
  }, [owner, request])
  async function run(work: () => Promise<void>) {
    if (busy) return
    if (!enabled) { setError('Status akun belum dapat dipastikan. Keputusan ditahan, bukan dialihkan ke akun lain.'); return }
    setBusy(true); setError('')
    try { await work() } catch (e) {
      if (!live.current) return
      setError(e instanceof Error ? e.message : 'Operasi gagal.')
      if (e instanceof SaveError && e.status >= 400 && e.status < 500) setAttempt(null)
      if (e instanceof SaveError && ['REVISION_CONFLICT', 'OPERATION_CONFLICT'].includes(e.code)) { setAttempt(null); setServer(null); setConfirmed(false) }
    } finally { if (live.current) setBusy(false) }
  }
  useEffect(() => {
    let valid = true
    setChecksum('')
    if (candidate) void hashRom(new Blob([new Uint8Array(candidate)])).then(v => { if (valid) setChecksum(v) })
    return () => { valid = false }
  }, [candidate])
  function download(bytes: Uint8Array, suffix: string) {
    if (request.kind === 'progress') downloadGameSave(bytes, target.gameId + suffix)
    else downloadState(bytes, target.gameId + suffix)
  }
  async function select(bytes: Uint8Array, origin: 'file' | 'browser') {
    validateImport(bytes, request.kind, target.core)
    const layout = gameSaveLayout(target.core)
    const packaged = request.kind === 'progress' && layout ? encodeGameSave({ layout, files: [{ key: 'sram', bytes }] }) : bytes
    if (live.current) { setCandidate(packaged); setSource(origin); setServer(null); setConfirmed(false) }
  }
  async function preview() {
    if (!client) return
    const save = await client.current(request.kind, actualTarget)
    const bytes = save && !save.deleted ? await client.bytes(request.kind, save) : null
    if (live.current) { setServer({ save, bytes }); setConfirmed(false) }
  }
  async function apply(action: 'replace' | 'preserve') {
    if (!client || !candidate || !server || !confirmed) return
    const next = attempt ?? { operation: { id: createSessionId(), action, reason: request.mode === 'import' ? 'import' : 'conflict' } as Operation, revision: server.save?.revision ?? 0 }
    setAttempt(next)
    const m = request.mode === 'import' ? { ...metadata, provenance: { source, sourceBuild: 'unknown' as const, confirmedForTarget: true as const } } : metadata
    const result = await client.decide(request.kind, candidate, actualTarget, m, next.revision, next.operation)
    if (live.current) onApplied(result, candidate, next.operation.action)
  }
  return <Dialog title={request.mode === 'conflict' ? 'Tinjau konflik simpanan' : 'Impor save'} onClose={onClose} busy={busy || !!attempt} className="server-state-dialog" backdropClassName="server-overlay">
    <div className="account-form">
      <p><strong>{target.title}</strong> · {target.core} · {request.kind === 'state' ? 'Save state' : 'Progres game / memcard'}</p>
      <p>Akun tujuan: <strong>{ownerName}</strong>. Data tamu pada browser bersama tidak mempunyai kepemilikan akun yang dapat dibuktikan.</p>
      <small className="save-identity">{target.gameId}</small>
      <p>Permainan dijeda. Tidak ada penggabungan biner. Cadangan server memakai kuota dan tidak dihapus otomatis.</p>
      {error && <p className="notice" role="alert">{error}</p>}
      {!enabled && <p className="notice" role="status">Status akun belum dapat dipastikan. Kandidat dan ID retry tetap ditahan di tab ini; unduh kandidat bila diperlukan. Penulisan dihentikan sampai akun yang sama terkonfirmasi.</p>}
      {request.mode === 'import' && <>
        <p>Save browser/file tidak membuktikan game atau versi core asal. Metadata build di sini adalah <strong>tujuan yang kamu konfirmasi</strong>, bukan klaim versi sumber. Gunakan ROM/region/revisi yang sama; sumber tetap utuh.</p>
        {request.kind === 'state' && <label>Slot tujuan<select disabled={!enabled || busy || !!attempt} value={slot} onChange={e => { setSlot(Number(e.target.value)); setServer(null); setConfirmed(false) }}>{[1, 2, 3].map(n => <option key={n} value={n}>Slot {n}</option>)}</select></label>}
        <label>File save<input type="file" accept={request.kind === 'state' ? '.state' : '.srm'} disabled={!enabled || busy || !!attempt} onChange={e => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) { setCandidate(null); setServer(null); setConfirmed(false); void run(async () => {
            if (!file.name.toLowerCase().endsWith(request.kind === 'state' ? '.state' : '.srm') || file.size > (request.kind === 'state' ? 64 : 8) * 1024 * 1024) throw new Error('Ekstensi/ukuran file tidak sesuai.')
            await select(new Uint8Array(await file.arrayBuffer()), 'file')
          }) }
        }} /></label>
        <button className="button secondary small" disabled={!enabled || busy || !!attempt} onClick={() => { setCandidate(null); setServer(null); setConfirmed(false); void run(async () => { await select(await readBrowserSave(request.kind, stateKey, progressPath), 'browser') }) }}>Baca save browser ini</button>
        <small>Hanya origin/profil ini ({location.origin}). Tutup sesi tamu lain dahulu. Jika asal berbeda, ekspor file dari origin lama lalu impor di sini.</small>
      </>}
      {candidate && <article className="save-item"><strong>{request.mode === 'conflict' ? 'Snapshot sesi ini' : `Sumber ${source}`}</strong><p>{formatBytes(candidate.length)} · SHA-256 <span className="save-identity">{checksum}</span></p><button className="button secondary small" disabled={busy} onClick={() => download(candidate, '-kandidat')}>Unduh kandidat</button></article>}
      <button className="button secondary small" disabled={!enabled || busy || !!attempt || !candidate} onClick={() => void run(preview)}>Tinjau versi server</button>
      {server && <article className="save-item"><strong>Versi server</strong><p>{server.save ? `Revisi ${server.save.revision} · ${server.save.deleted ? 'Dihapus (tombstone)' : formatBytes(server.save.size)} · ${new Date(server.save.updatedAt).toLocaleString('id-ID')}` : 'Belum ada save'}</p>{server.save && <p>Engine {server.save.metadata.engineVersion} · {server.save.metadata.variant} · <span className="save-identity">{server.save.checksum}</span></p>}{server.bytes && <button className="button secondary small" disabled={busy} onClick={() => download(server.bytes!, '-server')}>Unduh versi server</button>}</article>}
      {server && candidate && <>
        <label className="account-check"><input type="checkbox" checked={confirmed} disabled={!enabled || busy || !!attempt} onChange={e => setConfirmed(e.target.checked)} />Saya memastikan identitas/kompatibilitas tujuan dan memahami versi yang ditinggalkan akan dicadangkan. {request.kind === 'progress' ? 'Impor/pilihan server membuka ulang player sebelum boot.' : 'State tidak dimuat otomatis; periksa progres setelah memilih Muat.'}</label>
        <div className="account-actions">
          <button className="button primary small" disabled={!enabled || busy || !confirmed || !!attempt && attempt.operation.action !== 'replace'} onClick={() => void run(() => apply('replace'))}>{attempt?.operation.action === 'replace' ? 'Coba keputusan yang sama lagi' : request.mode === 'import' ? 'Konfirmasi impor ke server' : 'Gunakan snapshot sesi ini'}</button>
          {request.mode === 'conflict' && <button className="button secondary small" disabled={!enabled || busy || !confirmed || !!attempt && attempt.operation.action !== 'preserve'} onClick={() => void run(() => apply('preserve'))}>{attempt?.operation.action === 'preserve' ? 'Coba keputusan yang sama lagi' : 'Gunakan versi server'}</button>}
        </div>
      </>}
      {attempt && <p className="notice">Keputusan belum selesai. Retry memakai ID dan revisi yang sama agar cadangan tidak ganda. Jangan tutup tab. Jika kuota penuh, kelola cadangan lewat tab lain lalu retry.</p>}
      {!attempt && <button className="button secondary small" disabled={busy} onClick={onClose}>Batal</button>}
      {request.kind === 'progress' && target.core === 'pcsx_rearmed' && <p className="notice">PS1 hanya native memcard aktif 128 KiB; semua card/slot/format/varian belum terverifikasi. Cadangkan sumber dan periksa Continue/Load pada sesi baru.</p>}
    </div>
  </Dialog>
}
