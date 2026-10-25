import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LaunchSession } from './Player.tsx'
import type { StateMetadata } from '../lib/saves'
import { compatibleState, downloadState, formatBytes, SaveError } from '../lib/saves'
import { hashRom } from '../lib/identity'
import { useSaveLibrary } from '../lib/useSaveLibrary'
import { SaveManager, SaveQuota } from './SaveLibrary'
import Dialog from './Dialog'
import type { TransferRequest } from './SaveTransfer'

export type StateRpc = (type: 'export-state' | 'import-state', bytes?: Uint8Array) => Promise<Uint8Array | null>
export type AutosaveStatus = 'saving' | 'saved' | 'error'
type Pending = { bytes: Uint8Array; checksum: string; slot: number; revision: number; metadata: StateMetadata }

// Slot 99 is reserved for the automatic "Autosave" state; 1-3 stay manual.
const AUTOSAVE_SLOT = 99

export default function ServerStates({ session, owner, enabled, accountChanged, metadata, rpc, show, onToggle, gameActive, overlayContainer, onAutosaveStatus, onTransfer, resolution, progressAvailable, progressConflict }: {
  session: LaunchSession; owner: string; enabled: boolean; accountChanged: boolean; metadata: StateMetadata | null; rpc: StateRpc;
  show: boolean; onToggle: () => void; gameActive: boolean;
  overlayContainer: HTMLElement | null; onAutosaveStatus: (status: AutosaveStatus) => void;
  onTransfer: (request: TransferRequest) => void; resolution: number;
  progressAvailable: boolean; progressConflict: boolean;
}) {
  const library = useSaveLibrary(owner, enabled)
  const [pendingState, setPendingState] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [manager, setManager] = useState(false)
  const [conflict, setConflict] = useState(false)
  const live = useRef(true)
  // Autosave is off by default; the interval value must be picked explicitly.
  const [autosave, setAutosave] = useState({ active: false, intervalMs: 0 })
  const changed = useRef(accountChanged)
  changed.current = accountChanged
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => {
    if (resolution) { setPendingState(null); setConflict(false); setErr(''); setMsg('Keputusan server dikonfirmasi. State tidak dimuat otomatis.'); void library.refresh() }
  }, [resolution])
  useEffect(() => {
    if (accountChanged) { setPendingState(null); setMsg(''); setErr('Akun berganti. Snapshot akun sebelumnya dibersihkan dan tidak diteruskan ke akun baru.') }
  }, [accountChanged])
  const slotInfo = (slot: number) => library.list?.saves.find(s => s.gameId === session.game.id && s.consoleId === session.consoleInfo.id && s.core === session.consoleInfo.core && s.slot === slot)
  const ready = enabled && !!metadata && !!library.client && !!library.list
  const unsupportedCore = session.consoleInfo.core !== 'fceumm' || metadata?.variant === 'normal'
  const intervalReady = autosave.active && autosave.intervalMs > 0
  const pendingSlotName = (slot: number) => slot === AUTOSAVE_SLOT ? 'Autosave' : `slot ${slot}`
  async function run(work: () => Promise<unknown>) {
    if (busy) return
    setBusy(true); setErr(''); setMsg('')
    try { await work() }
    catch (e) { if (live.current && !changed.current) { setMsg(''); setErr(e instanceof Error ? e.message : 'Operasi save gagal.'); if (e instanceof SaveError && e.code === 'REVISION_CONFLICT') setConflict(true) } }
    finally { if (live.current) setBusy(false) }
  }
  async function upload(snapshot: Pending) {
    if (conflict) throw new SaveError('Ada konflik simpanan. Tinjau konflik dahulu; retry tidak boleh menimpa revisi baru.', 409, 'REVISION_CONFLICT')
    if (!ready || !library.client) throw new SaveError('Sesi/daftar save belum siap. Jangan tutup tab sebelum mengunduh cadangan.')
    if (snapshot.bytes.length > library.list!.usage.maxStateBytes) throw new SaveError(`State ${formatBytes(snapshot.bytes.length)} melebihi batas ${formatBytes(library.list!.usage.maxStateBytes)}. Unduh cadangan atau hubungi pengelola.`)
    setMsg('Menyimpan…')
    await library.client.put(snapshot.bytes, { gameId: session.game.id, title: session.game.title, consoleId: session.consoleInfo.id, core: session.consoleInfo.core, slot: snapshot.slot, expectedRevision: snapshot.revision, checksum: snapshot.checksum, metadata: snapshot.metadata })
    if (!live.current || changed.current) return
    setPendingState(null); setMsg('Tersimpan di server')
    if (snapshot.slot === AUTOSAVE_SLOT) onAutosaveStatus('saved')
    await library.refresh()
  }
  async function capture(slot: number) {
    if (!metadata || !ready) return
    if (pendingState && !window.confirm('Ganti snapshot yang belum tersimpan dengan kondisi terbaru? Unduh cadangan terlebih dahulu bila diperlukan.')) return
    const target = slotInfo(slot)
    if (slot !== AUTOSAVE_SLOT && target && !target.deleted && !window.confirm(`Ganti save server slot ${slot}? Unduh versi lama melalui Kelola simpanan bila ingin mempertahankannya.`)) return
    const bytes = await rpc('export-state')
    if (!bytes || !live.current || changed.current) return
    const checksum = await hashRom(new Blob([new Uint8Array(bytes)]))
    if (!live.current || changed.current) return
    const snapshot: Pending = { bytes, checksum, slot, revision: target?.revision ?? 0, metadata: metadata }
    setPendingState(snapshot)
    await upload(snapshot)
  }
  async function load(slot: number) {
    const target = slotInfo(slot)
    if (!target || target.deleted || !library.client || !metadata) return
    if (!compatibleState(target.metadata, metadata) && !window.confirm('Versi engine/core/format save berbeda. State mungkin tidak kompatibel. Tetap coba memuat?')) return
    if (!window.confirm(`Muat state server ${pendingSlotName(slot)} dan ganti kondisi permainan saat ini? State lama dapat ikut mengembalikan SRAM/memcard lama lalu disinkronkan sebagai progres terbaru. Unduh cadangan progres terlebih dahulu.`)) return
    setMsg('Memuat progres…')
    const bytes = await library.client.get(target)
    if (await hashRom(new Blob([new Uint8Array(bytes)])) !== target.checksum) throw new SaveError('Checksum state tidak sesuai. State tidak dimuat.')
    await rpc('import-state', bytes)
    if (live.current) setMsg('Perintah muat dikirim ke core. Periksa progres permainan; engine tidak memberikan konfirmasi deserialisasi.')
  }
  // Autosave overwrites slot 99 on its interval, never a manual slot. It runs
  // only while the game is actually playing: skipped while the overlay opens,
  // while an upload is still in flight, when the state is not confirmed, and
  // when the tab is hidden. Opening a game never touches autosave silently.
  useEffect(() => {
    if (!intervalReady || !enabled || changed.current) return
    let capturing = false
    const timer = setInterval(async () => {
      if (capturing || pendingState || busy || !metadata || !library.list) return
      if (!gameActive || document.hidden) return
      capturing = true
      onAutosaveStatus('saving')
      try {
        const bytes = await rpc('export-state')
        if (!bytes || !live.current || changed.current) return
        const checksum = await hashRom(new Blob([new Uint8Array(bytes)]))
        if (!live.current || changed.current) return
        const snapshot: Pending = { bytes, checksum, slot: AUTOSAVE_SLOT, revision: slotInfo(AUTOSAVE_SLOT)?.revision ?? 0, metadata: metadata }
        setPendingState(snapshot)
        await upload(snapshot)
      } catch (e) {
        if (live.current && !changed.current) { setMsg(''); setErr(e instanceof Error ? e.message : 'Autosave gagal.'); if (e instanceof SaveError && e.code === 'REVISION_CONFLICT') setConflict(true); onAutosaveStatus('error') }
      } finally { capturing = false }
    }, autosave.intervalMs)
    return () => clearInterval(timer)
  }, [intervalReady, enabled, autosave.intervalMs, metadata, pendingState, busy, library.list, gameActive, changed.current, onAutosaveStatus])
  const slots = [1, 2, 3].map(slot => ({ slot, info: slotInfo(slot) }))
  const autosaveSlot = slotInfo(AUTOSAVE_SLOT)
  return <>
    {show && createPortal(<><Dialog title="Save state server" eyebrow="PROGRES PERMAINAN" onClose={onToggle} busy={busy} className="server-state-dialog" backdropClassName="server-overlay">
      <div className="server-state-content">
      <p className="server-state-intro"><strong>{session.game.title}</strong><span>Permainan dijeda selama panel ini terbuka. Pilih slot untuk menyimpan atau melanjutkan progres.</span></p>
      {!enabled && <p className="notice" role="alert">Sesi akun tidak tersedia atau berubah. Sinkronisasi dihentikan; tidak dialihkan ke save tamu. Masuk kembali lalu buka ulang permainan.</p>}
      {!metadata && <p role="status">Mulai permainan untuk memeriksa dukungan state dan identitas build core.</p>}
      {unsupportedCore && <p className="notice">Kombinasi core/varian ini belum diverifikasi pada server. Dukungan otomatis M5 hanya NES varian legacy; kombinasi lain bersifat percobaan.</p>}
      {library.list && <SaveQuota list={library.list} />}
      {library.error && <p className="server-status server-status--error" role="alert">{library.error}</p>}
      {err && <p className="server-status server-status--error" role="alert">{err}</p>}
      {msg && <p className={`server-status ${msg === 'Tersimpan di server' ? 'server-status--success' : 'server-status--info'}`} role="status">{msg}</p>}
      <div className="autosave-panel"><h3>Autosave state</h3>
        <label><input type="checkbox" checked={autosave.active} disabled={busy || !metadata || !enabled} onChange={() => setAutosave(prev => ({ ...prev, active: !prev.active }))} /> Aktifkan autosave state</label>
        <div className="interval-select"><label htmlFor="autosave-interval">Interval</label>
          <select id="autosave-interval" disabled={busy || !metadata || !enabled} value={String(autosave.intervalMs)} onChange={e => setAutosave(prev => ({ ...prev, intervalMs: Number(e.target.value) }))}>
            <option value="0">Nonaktif</option>
            <option value="30000">30 detik</option>
            <option value="60000">1 menit</option>
            <option value="120000">2 menit</option>
            <option value="300000">5 menit</option>
            <option value="600000">10 menit</option>
            <option value="900000">15 menit</option>
          </select>
        </div>
        {autosave.active && autosave.intervalMs === 0 && <p className="notice" role="status">Pilih interval agar autosave mulai menulis slot Autosave.</p>}
        {autosave.intervalMs === 30000 && autosave.active && <p className="notice">Interval 30 detik menambah beban perangkat dan jaringan, terutama untuk state besar. Setiap penulisan menunggu konfirmasi server.</p>}
        {intervalReady && <p className="notice">Autosave hanya berjalan saat permainan aktif: berhenti saat dijeda, saat overlay ini terbuka, atau tab tersembunyi. Hanya satu unggahan dalam satu waktu; interval berikutnya dilewati bila unggahan masih berjalan.</p>}
      </div>
      <div className="slots-panel">
        <div className="server-slot-group">
          <h3 className="server-slot-group-label">Slot manual</h3>
          {slots.map(({ slot, info }) => <article key={slot} className="server-slot">
            <div>
              <strong>Slot {slot}</strong>
              <div className={info && !info.deleted ? 'server-slot-info' : 'server-slot-empty'}>{info && !info.deleted ? `${formatBytes(info.size)} · revisi ${info.revision}` : 'Kosong'}</div>
            </div>
            <span className="slot-actions">
              <button className="button secondary small" disabled={busy || conflict || !ready || !info || info.deleted} onClick={() => void run(() => load(slot))}>Muat</button>
              <button className="button secondary small" disabled={busy || conflict || !ready || !metadata} onClick={() => void run(() => capture(slot))}>Ganti</button>
            </span>
          </article>)}
        </div>
        <div className="server-slot-group">
          <h3 className="server-slot-group-label">Slot Autosave <span className="slot-badge">Otomatis</span></h3>
          <article className="server-slot autosave-slot">
            <div>
              <strong>Autosave</strong>
              <div className={autosaveSlot && !autosaveSlot.deleted ? 'server-slot-info' : 'server-slot-empty'}>{autosaveSlot && !autosaveSlot.deleted ? `${formatBytes(autosaveSlot.size)} · revisi ${autosaveSlot.revision}` : 'Kosong'}</div>
            </div>
            <span className="slot-actions">
              <button className="button secondary small" disabled={busy || !ready || !autosaveSlot || autosaveSlot.deleted} onClick={() => void run(() => load(AUTOSAVE_SLOT))}>Muat</button>
            </span>
          </article>
        </div>
        <p className="autosave-hint">Slot Autosave ditimpa otomatis saat autosave aktif; tiga slot manual hanya berubah saat kamu menekan Ganti.</p>
      </div>
      {pendingState && <div className="save-pending"><p>State {pendingSlotName(pendingState.slot)} belum dikonfirmasi server ({formatBytes(pendingState.bytes.length)}). {library.list && `Ruang tersisa ${formatBytes(Math.max(0, library.list.usage.quotaBytes - library.list.usage.usedBytes))}; penggantian slot hanya dihitung selisih ukurannya.`} Menutup tab dapat menghilangkan snapshot ini.</p><div className="account-actions"><button className="button secondary small" disabled={busy} onClick={() => downloadState(pendingState.bytes, `${session.game.id}-${pendingSlotName(pendingState.slot).replace(' ', '-')}-cadangan`)}>Unduh cadangan state terbaru</button><button className="button secondary small" disabled={!ready || busy} onClick={() => void run(() => upload(pendingState))}>Coba simpan lagi</button><button className="button secondary small" disabled={busy} onClick={() => { if (window.confirm('Abaikan snapshot yang belum tersimpan? Pastikan cadangan sudah diunduh.')) setPendingState(null) }}>Abaikan state tertunda</button></div></div>}
       <div className="account-actions">
         {progressAvailable && <button className="button secondary small" disabled={busy || !ready} onClick={() => onTransfer({ mode: progressConflict ? 'conflict' : 'import', kind: 'progress' })}>{progressConflict ? 'Tinjau konflik progres' : 'Impor progres'}</button>}
         <button className="button secondary small" disabled={busy || !ready || !!pendingState} onClick={() => onTransfer({ mode: 'import', kind: 'state' })}>Impor state</button>
         {conflict && pendingState && <button className="button primary small" disabled={busy || !ready} onClick={() => onTransfer({ mode: 'conflict', kind: 'state', slot: pendingState.slot, bytes: pendingState.bytes })}>Tinjau konflik state</button>}
        <button className="button primary small" disabled={busy || !library.client || !library.list} onClick={() => setManager(true)}>Kelola simpanan</button>
        <button className="button secondary small" disabled={busy || !enabled} onClick={() => void library.refresh()}>Muat ulang daftar save</button>
        <button className="text-link" disabled={!metadata || busy || !enabled} onClick={() => void run(async () => { const bytes = await rpc('export-state'); if (bytes) downloadState(bytes, `${session.game.id}-cadangan`) })}>Unduh state saat ini</button>
      </div>
      <details className="server-state-help"><summary>Tentang penyimpanan progres</summary><p>State tidak dimuat otomatis dan save browser tamu tidak diimpor otomatis. Gunakan Impor state/progres untuk meninjau sumber dan tujuan secara eksplisit. Sinkronisasi progres game terpisah dari Autosave state; cadangan konflik/impor memakai kuota akun tanpa penghapusan otomatis.</p><p>Periksa status sinkronisasi progres di halaman player. NES tersedia, memcard PS1 masih percobaan; core lain tetap memerlukan ekspor cadangan. Memuat state lama dapat ikut mengembalikan save dalam game lama.</p></details>
      </div>
    </Dialog>
    {manager && library.client && library.list && <div className="server-save-manager"><SaveManager client={library.client} list={library.list} onRefresh={library.refresh} onClose={() => setManager(false)} /></div>}
    </>, overlayContainer ?? document.body)}
    {!show && pendingState && <div className="save-pending inline"><p>State {pendingSlotName(pendingState.slot)} belum dikonfirmasi server ({formatBytes(pendingState.bytes.length)}). Buka “Save state server” di toolbar emulator untuk mencoba simpan lagi atau mengunduh cadangan. Menutup tab dapat menghilangkan snapshot ini.</p></div>}
  </>
}
