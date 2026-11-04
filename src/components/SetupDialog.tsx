import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowRight, Check, FileArchive, HardDrive, LoaderCircle, ShieldCheck, Upload, X } from 'lucide-react'
import Dialog from './Dialog'
import { detectConsole, extension, saveIdentity, validateBios, validateRom } from '../lib/domain'
import { createSessionId, hashRom } from '../lib/identity'
import type { Bios, ConsoleInfo, Game } from '../lib/domain'
import type { LaunchSession } from './Player'
import type { BackendState } from '../lib/backend'
import { catalogBios, catalogGame, catalogId, latestCatalogEntry, loadCatalog, mergeCatalog } from '../lib/catalog'

export type SetupSelection = { game?: Game; consoleId?: string; file?: File }

export default function SetupDialog({ selection, consoles, builtinGames, biosList, backend, onBackendRetry, onClose, onLaunch }: {
  selection: SetupSelection; consoles: ConsoleInfo[]; builtinGames: Game[]; biosList: Bios[];
  backend: BackendState; onBackendRetry: () => void;
  onClose: () => void; onLaunch: (session: LaunchSession) => void | boolean | Promise<void | boolean>;
}) {
  const [rom, setRom] = useState<File | undefined>(selection.file)
  const [consoleId, setConsoleId] = useState(selection.game?.consoleId || selection.consoleId || (selection.file ? detectConsole(selection.file.name, consoles) : ''))
  const [bios, setBios] = useState<File>()
  const [biosSource, setBiosSource] = useState('none')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [uploadedBios, setUploadedBios] = useState<Bios[]>([])
  const [biosLoading, setBiosLoading] = useState(false)
  const [biosError, setBiosError] = useState('')
  const [biosAttempt, setBiosAttempt] = useState(0)
  const [currentGame, setCurrentGame] = useState<Game>()
  const [gameLoading, setGameLoading] = useState(false)
  const [gameError, setGameError] = useState('')
  const [gameAttempt, setGameAttempt] = useState(0)
  const operation = useRef<AbortController | null>(null)
  const romInput = useRef<HTMLInputElement>(null)
  const biosInput = useRef<HTMLInputElement>(null)
  const consoleInfo = consoles.find(c => c.id === consoleId)
  const originalGame = selection.game?.source === 'server' && !rom ? builtinGames.find(g => g.id === selection.game?.id) || selection.game : undefined
  const uploadGameId = originalGame && !builtinGames.some(g => g.id === originalGame.id) && catalogId.test(originalGame.id) ? originalGame.id : ''
  const serverGame = currentGame?.id === originalGame?.id ? currentGame : originalGame
  const dynamicGames = backend.status === 'online' && backend.health.capabilities.gameCatalog === true
  const dynamicBios = backend.status === 'online' && backend.health.capabilities.biosCatalog === true
  const compatibleBios = mergeCatalog(biosList, uploadedBios).filter(b => b.consoleId === consoleId)
  const selectedBios = compatibleBios.find(b => b.id === biosSource)
  const biosRequired = consoleInfo?.bios === 'required' || (consoleId === 'nes' && extension(rom?.name || serverGame?.url || '') === 'fds')
  const biosFailure = backend.status === 'unavailable' ? 'Daftar BIOS server belum dapat diperiksa karena backend tidak terhubung. BIOS lokal tetap dapat dipilih.' : biosError
  const retryBios = () => { if (backend.status === 'unavailable') onBackendRetry(); else setBiosAttempt(n => n + 1) }
  useEffect(() => () => operation.current?.abort(), [])
  useEffect(() => {
    setCurrentGame(undefined); setGameError(''); setGameLoading(false)
    if (!uploadGameId) return
    if (!dynamicGames) {
      if (backend.status === 'checking') setGameLoading(true)
      else setGameError('Metadata game belum dapat diperiksa. Periksa backend dan coba lagi; jangan gunakan URL lama dari favorit/riwayat.')
      return
    }
    const controller = new AbortController()
    setGameLoading(true)
    void latestCatalogEntry('games', uploadGameId, controller.signal).then(item => {
      if (item.consoleId !== consoleId) throw new Error('Console game berubah. Buka ulang game dari Library.')
      if (!controller.signal.aborted) setCurrentGame(catalogGame(item))
    }).catch(e => { if (!controller.signal.aborted) setGameError(e instanceof Error ? e.message : 'Metadata game belum dapat dimuat.') })
      .finally(() => { if (!controller.signal.aborted) setGameLoading(false) })
    return () => controller.abort()
  }, [uploadGameId, dynamicGames, backend.status, consoleId, gameAttempt])
  useEffect(() => {
    setUploadedBios([]); setBiosError(''); setBiosLoading(dynamicBios && !!consoleId)
    if (!dynamicBios || !consoleId) return
    const controller = new AbortController()
    void loadCatalog('bios', new URLSearchParams({ console: consoleId, sort: 'title' }).toString(), controller.signal).then(items => {
      if (!controller.signal.aborted) setUploadedBios(items.map(catalogBios))
    }).catch(e => { if (!controller.signal.aborted) setBiosError(e instanceof Error ? e.message : 'Daftar BIOS belum dapat dimuat.') })
      .finally(() => { if (!controller.signal.aborted) setBiosLoading(false) })
    return () => controller.abort()
  }, [dynamicBios, consoleId, biosAttempt])

  function selectRom(file?: File) {
    if (!file) return
    setError(''); setRom(file)
    const detected = detectConsole(file.name, consoles)
    if (detected && !selection.game) { setConsoleId(detected); setBiosSource('none'); setBios(undefined) }
  }

  async function launch() {
    if (operation.current) return
    setError('')
    if (!consoleInfo) return setError('Pilih console yang sesuai dengan ROM kamu.')
    if (!serverGame && !rom) return setError('Pilih file ROM terlebih dahulu.')
    if (rom) { const issue = validateRom(rom, consoleInfo); if (issue) return setError(issue) }
    if (biosSource === 'local' && !bios) return setError('Pilih file BIOS, atau gunakan pilihan tanpa BIOS.')
    if (biosSource === 'local' && bios) { const issue = validateBios(bios); if (issue) return setError(issue) }
    if (biosRequired && biosSource === 'none') return setError('Permainan ini membutuhkan BIOS. Pilih BIOS untuk melanjutkan.')
    const serverBios = selectedBios
    if (!['none', 'local'].includes(biosSource) && !serverBios) return setError('BIOS server tidak lagi tersedia. Pilih sumber lain.')
    setBusy(true)
    const controller = new AbortController()
    operation.current = controller
    try {
      let game: Game
      if (serverGame) {
        if (!builtinGames.some(g => g.id === serverGame.id) && catalogId.test(serverGame.id)) {
          if (backend.status !== 'online' || !backend.health.capabilities.gameCatalog) throw new Error('Katalog game server belum dapat diperiksa. Periksa koneksi backend dan coba lagi.')
          game = catalogGame(await latestCatalogEntry('games', serverGame.id, controller.signal))
          if (game.consoleId !== consoleId) throw new Error('Console game berubah. Buka ulang game dari Library.')
        } else game = serverGame
      }
      else {
        const hash = await hashRom(rom!)
        const id = `local-${consoleId}-${hash}`
        if (selection.game?.source === 'local' && selection.game.id !== id) throw new Error('File ini berbeda dari game yang dipilih. Pilih ROM yang sama, atau buka sebagai game baru lewat Buka ROM.')
        game = { id, title: rom!.name.replace(/\.[^.]+$/, '').slice(0, 180), consoleId, source: 'local', fileName: rom!.name, sha256: hash }
      }
      let firmware = serverBios
      if (serverBios && !biosList.some(b => b.id === serverBios.id) && catalogId.test(serverBios.id)) {
        if (!dynamicBios) throw new Error('Katalog BIOS belum dapat diperiksa. Pilih BIOS lokal atau periksa backend.')
        firmware = catalogBios(await latestCatalogEntry('bios', serverBios.id, controller.signal))
        if (firmware.consoleId !== consoleId) throw new Error('BIOS server tidak cocok dengan console yang dipilih.')
      }
      controller.signal.throwIfAborted()
      const launched = await onLaunch({ id: createSessionId(), game, consoleInfo, rom, bios: biosSource === 'local' ? bios : undefined, biosUrl: firmware?.url, biosSha256: firmware?.sha256, saveId: saveIdentity(game, consoleInfo.core) })
      if (launched === false) setBusy(false)
    } catch (e) { if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : 'File tidak dapat dibaca. Coba pilih ulang file ROM.'); setBusy(false) } }
    finally { if (operation.current === controller) operation.current = null }
  }

  return <Dialog title={selection.game ? 'Siap main lagi?' : 'Buka kenanganmu.'} onClose={onClose} busy={busy}>
    <input ref={romInput} type="file" hidden disabled={busy} onChange={e => selectRom(e.target.files?.[0])} />
    <div className={`dropzone ${dragging ? 'dragging' : ''} ${rom || serverGame ? 'has-file' : ''}`} onDragOver={e => { e.preventDefault(); if (!busy) setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); if (!busy) selectRom(e.dataTransfer.files[0]) }}>
      <div className="drop-icon">{rom || serverGame ? <FileArchive size={27} /> : <Upload size={27} />}</div>
      <strong>{rom?.name || serverGame?.title || 'Tarik ROM ke sini'}</strong>
      <span>{serverGame ? 'Game dari koleksi server maindulu' : rom ? `${(rom.size / 1024 / 1024).toFixed(2)} MB · hanya dibaca di perangkatmu` : 'atau pilih file dari perangkatmu · maks. 768 MB'}</span>
      <button className="button small secondary" disabled={busy} onClick={() => romInput.current?.click()}>{rom || serverGame ? 'Pilih ROM lain' : 'Pilih file ROM'}<ArrowRight size={15} /></button>
    </div>
    {selection.game?.source === 'local' && <p className="field-hint">Untuk membuka favorit/riwayat lokal, pilih ROM yang sama. ROM tidak disimpan oleh maindulu.</p>}
    {serverGame && <div className="setup-metadata"><p>{serverGame.description}</p><p>Lisensi / hak distribusi: {serverGame.license || 'Belum dicantumkan. Pastikan kamu berhak menggunakan game ini.'}</p><p>Metadata dan ketersediaan upload diperiksa ulang sebelum bermain. Hash bukan jaminan kompatibilitas ROM atau save.</p></div>}
    {serverGame && gameLoading && <p role="status" className="field-hint">Memeriksa metadata game terbaru…</p>}
    {serverGame && gameError && !error && <div className="setup-metadata"><p role="alert">{gameError}</p><button className="button secondary small" disabled={busy} onClick={() => { setGameAttempt(n => n + 1); if (backend.status === 'unavailable') onBackendRetry() }}>Coba lagi game server</button></div>}
    <div className="field"><label htmlFor="console-choice">Console <span>WAJIB</span></label><select id="console-choice" value={consoleId} disabled={busy || !!selection.game} onChange={e => { setConsoleId(e.target.value); setBiosSource('none'); setBios(undefined); setError('') }}><option value="">Pilih console</option>{consoles.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
    {consoleInfo && <div className="field"><label htmlFor="bios-choice">BIOS <span>{biosRequired ? 'WAJIB' : consoleInfo.bios === 'none' ? 'TIDAK DIPERLUKAN' : 'OPSIONAL'}</span></label>
      <select id="bios-choice" value={biosSource} disabled={busy || consoleInfo.bios === 'none'} onChange={e => { setBiosSource(e.target.value); setError('') }}><option value="none">Tanpa BIOS tambahan</option><option value="local">Gunakan BIOS dari perangkat</option>{compatibleBios.map(b => <option value={b.id} key={b.id}>{b.name} · server</option>)}</select>
      <p className="field-hint">{consoleInfo.biosHint}</p>
      {(biosLoading || backend.status === 'checking') && <p role="status" className="field-hint">Memeriksa pilihan BIOS server…</p>}
      {biosFailure && <div className="setup-metadata"><p role="alert">{biosFailure}</p><button disabled={busy} className="button secondary small" onClick={retryBios}>Coba lagi BIOS server</button></div>}
      {selectedBios && <div className="setup-metadata"><p>{selectedBios.fileName || selectedBios.name}</p><p>{selectedBios.description}</p><p>{selectedBios.distributionRights || 'Pastikan hak penggunaan firmware. BIOS satu console belum tentu saling kompatibel.'}</p>{selectedBios.sha256 && <p>SHA-256 server: <code>{selectedBios.sha256}</code></p>}</div>}
      {biosSource === 'local' && <><input type="file" hidden ref={biosInput} accept=".bin,.rom,.bios,.img,.zip,.7z,.rar" onChange={e => { const f = e.target.files?.[0]; if (f) { setBios(f); setError(validateBios(f) || '') } }} /><div className="bios-picker"><button disabled={busy} className="button secondary small" onClick={() => biosInput.current?.click()}><HardDrive size={15} />{bios ? bios.name : 'Pilih BIOS lokal'}</button>{bios && <button className="icon-button" aria-label="Hapus pilihan BIOS" disabled={busy} onClick={() => setBios(undefined)}><X size={16} /></button>}</div><p className="field-hint">Pertahankan nama firmware yang diharapkan core. Beberapa BIOS dapat dikemas dalam satu ZIP. Maks. 32 MB.</p></>}
    </div>}
    {(rom && ['zip','7z','rar','cue'].includes(extension(rom.name))) && <p className="notice"><FileArchive size={16} />Arsip harus berisi satu game. Untuk game multi-file, simpan CUE dan seluruh BIN di dalam satu ZIP dengan nama aslinya.</p>}
    {error && <div className="error-message" role="alert"><AlertCircle size={18} /><span>{error}</span></div>}
    <div className="privacy-line"><ShieldCheck size={16} />ROM & BIOS lokal tidak pernah dikirim ke server.</div>
    <button className="button primary launch-button" onClick={launch} disabled={busy || (!!serverGame && gameLoading)}>{busy ? <><LoaderCircle className="spin" size={19} />{serverGame ? 'Memeriksa aset server…' : 'Menyiapkan identitas ROM…'}</> : <><Check size={19} />Main sekarang<ArrowRight size={18} /></>}</button>
  </Dialog>
}
