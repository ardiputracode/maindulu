import { useRef, useState } from 'react'
import { AlertCircle, ArrowRight, Check, FileArchive, HardDrive, LoaderCircle, ShieldCheck, Upload, X } from 'lucide-react'
import Dialog from './Dialog'
import { detectConsole, extension, validateBios, validateRom } from '../lib/domain'
import { createSessionId, hashRom } from '../lib/identity'
import type { Bios, ConsoleInfo, Game } from '../lib/domain'
import type { LaunchSession } from './Player'

export type SetupSelection = { game?: Game; consoleId?: string; file?: File }

export default function SetupDialog({ selection, consoles, biosList, onClose, onLaunch }: {
  selection: SetupSelection; consoles: ConsoleInfo[]; biosList: Bios[];
  onClose: () => void; onLaunch: (session: LaunchSession) => void | boolean | Promise<void | boolean>;
}) {
  const [rom, setRom] = useState<File | undefined>(selection.file)
  const [consoleId, setConsoleId] = useState(selection.game?.consoleId || selection.consoleId || (selection.file ? detectConsole(selection.file.name, consoles) : ''))
  const [bios, setBios] = useState<File>()
  const [biosSource, setBiosSource] = useState('none')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const romInput = useRef<HTMLInputElement>(null)
  const biosInput = useRef<HTMLInputElement>(null)
  const consoleInfo = consoles.find(c => c.id === consoleId)
  const serverGame = selection.game?.source === 'server' && !rom ? selection.game : undefined
  const compatibleBios = biosList.filter(b => b.consoleId === consoleId)
  const biosRequired = consoleInfo?.bios === 'required' || (consoleId === 'nes' && extension(rom?.name || serverGame?.url || '') === 'fds')

  function selectRom(file?: File) {
    if (!file) return
    setError(''); setRom(file)
    const detected = detectConsole(file.name, consoles)
    if (detected && !selection.game) { setConsoleId(detected); setBiosSource('none'); setBios(undefined) }
  }

  async function launch() {
    setError('')
    if (!consoleInfo) return setError('Pilih console yang sesuai dengan ROM kamu.')
    if (!serverGame && !rom) return setError('Pilih file ROM terlebih dahulu.')
    if (rom) { const issue = validateRom(rom, consoleInfo); if (issue) return setError(issue) }
    if (biosSource === 'local' && !bios) return setError('Pilih file BIOS, atau gunakan pilihan tanpa BIOS.')
    if (biosSource === 'local' && bios) { const issue = validateBios(bios); if (issue) return setError(issue) }
    if (biosRequired && biosSource === 'none') return setError('Permainan ini membutuhkan BIOS. Pilih BIOS untuk melanjutkan.')
    const serverBios = compatibleBios.find(b => b.id === biosSource)
    if (!['none', 'local'].includes(biosSource) && !serverBios) return setError('BIOS server tidak lagi tersedia. Pilih sumber lain.')
    setBusy(true)
    try {
      let game: Game
      if (serverGame) game = serverGame
      else {
        const hash = await hashRom(rom!)
        const id = `local-${consoleId}-${hash}`
        if (selection.game?.source === 'local' && selection.game.id !== id) throw new Error('File ini berbeda dari game yang dipilih. Pilih ROM yang sama, atau buka sebagai game baru lewat Buka ROM.')
        game = { id, title: rom!.name.replace(/\.[^.]+$/, '').slice(0, 180), consoleId, source: 'local', fileName: rom!.name }
      }
      const launched = await onLaunch({ id: createSessionId(), game, consoleInfo, rom, bios: biosSource === 'local' ? bios : undefined, biosUrl: serverBios?.url })
      if (launched === false) setBusy(false)
    } catch (e) { setError(e instanceof Error ? e.message : 'File tidak dapat dibaca. Coba pilih ulang file ROM.'); setBusy(false) }
  }

  return <Dialog title={selection.game ? 'Siap main lagi?' : 'Buka kenanganmu.'} onClose={onClose} busy={busy}>
    <input ref={romInput} type="file" hidden disabled={busy} onChange={e => selectRom(e.target.files?.[0])} accept={['nes','fds','unf','unif','sfc','smc','fig','swc','gb','gbc','gba','md','gen','smd','bin','cue','chd','pbp','iso','zip','7z','rar'].map(x => '.' + x).join(',')} />
    <div className={`dropzone ${dragging ? 'dragging' : ''} ${rom || serverGame ? 'has-file' : ''}`} onDragOver={e => { e.preventDefault(); if (!busy) setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); if (!busy) selectRom(e.dataTransfer.files[0]) }}>
      <div className="drop-icon">{rom || serverGame ? <FileArchive size={27} /> : <Upload size={27} />}</div>
      <strong>{rom?.name || serverGame?.title || 'Tarik ROM ke sini'}</strong>
      <span>{serverGame ? 'Game dari koleksi server maindulu' : rom ? `${(rom.size / 1024 / 1024).toFixed(2)} MB · hanya dibaca di perangkatmu` : 'atau pilih file dari perangkatmu · maks. 768 MB'}</span>
      <button className="button small secondary" disabled={busy} onClick={() => romInput.current?.click()}>{rom || serverGame ? 'Pilih ROM lain' : 'Pilih file ROM'}<ArrowRight size={15} /></button>
    </div>
    {selection.game?.source === 'local' && <p className="field-hint">Untuk membuka favorit/riwayat lokal, pilih ROM yang sama. ROM tidak disimpan oleh maindulu.</p>}
    <div className="field"><label htmlFor="console-choice">Console <span>WAJIB</span></label><select id="console-choice" value={consoleId} disabled={busy || !!selection.game} onChange={e => { setConsoleId(e.target.value); setBiosSource('none'); setBios(undefined); setError('') }}><option value="">Pilih console</option>{consoles.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
    {consoleInfo && <div className="field"><label htmlFor="bios-choice">BIOS <span>{biosRequired ? 'WAJIB' : consoleInfo.bios === 'none' ? 'TIDAK DIPERLUKAN' : 'OPSIONAL'}</span></label>
      <select id="bios-choice" value={biosSource} disabled={busy || consoleInfo.bios === 'none'} onChange={e => { setBiosSource(e.target.value); setError('') }}><option value="none">Tanpa BIOS tambahan</option><option value="local">Gunakan BIOS dari perangkat</option>{compatibleBios.map(b => <option value={b.id} key={b.id}>{b.name} · server</option>)}</select>
      <p className="field-hint">{consoleInfo.biosHint}</p>
      {biosSource === 'local' && <><input type="file" hidden ref={biosInput} accept=".bin,.rom,.bios,.img,.zip,.7z,.rar" onChange={e => { const f = e.target.files?.[0]; if (f) { setBios(f); setError(validateBios(f) || '') } }} /><div className="bios-picker"><button disabled={busy} className="button secondary small" onClick={() => biosInput.current?.click()}><HardDrive size={15} />{bios ? bios.name : 'Pilih BIOS lokal'}</button>{bios && <button className="icon-button" aria-label="Hapus pilihan BIOS" disabled={busy} onClick={() => setBios(undefined)}><X size={16} /></button>}</div><p className="field-hint">Pertahankan nama firmware yang diharapkan core. Beberapa BIOS dapat dikemas dalam satu ZIP. Maks. 32 MB.</p></>}
    </div>}
    {(rom && ['zip','7z','rar','cue'].includes(extension(rom.name))) && <p className="notice"><FileArchive size={16} />Arsip harus berisi satu game. Untuk game multi-file, simpan CUE dan seluruh BIN di dalam satu ZIP dengan nama aslinya.</p>}
    {error && <div className="error-message" role="alert"><AlertCircle size={18} /><span>{error}</span></div>}
    <div className="privacy-line"><ShieldCheck size={16} />ROM & BIOS lokal tidak pernah dikirim ke server.</div>
    <button className="button primary launch-button" onClick={launch} disabled={busy}>{busy ? <><LoaderCircle className="spin" size={19} />Menyiapkan identitas ROM…</> : <><Check size={19} />Main sekarang<ArrowRight size={18} /></>}</button>
  </Dialog>
}
