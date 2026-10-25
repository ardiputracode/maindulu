import { useEffect, useState } from 'react'
import Dialog from './Dialog'
import type { useAccount } from '../lib/useAccount'
import { readRecoveryResult } from '../lib/account'
import SaveLibrary from './SaveLibrary'
import GameSaveLibrary from './GameSaveLibrary'

export default function AccountDialog({ account, onClose }: { account: ReturnType<typeof useAccount>; onClose: () => void }) {
  const { state } = account
  const [mode, setMode] = useState<'login' | 'register' | 'password' | 'recover' | 'recovery-code'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [suppliedCode, setSuppliedCode] = useState('')
  const [recovery, setRecovery] = useState<{ code: string; username: string } | null>(null)
  const code = recovery?.code ?? ''
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [progressOpen, setProgressOpen] = useState(false)
  useEffect(() => {
    if (!code || saved) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [code, saved])
  function switchMode(next: typeof mode) { setMode(next); setError(''); setMessage(''); setPassword(''); setNewPassword(''); setConfirmation(''); setSuppliedCode('') }
  async function submit(action: typeof mode | 'logout') {
    setBusy(true); setError(''); setMessage('')
    try {
      let body: Record<string, string>
      if (action === 'logout') body = {}
      else if (action === 'recovery-code') body = { currentPassword: password }
      else if (action === 'recover') body = { username, recoveryCode: suppliedCode, newPassword, passwordConfirmation: confirmation }
      else if (action === 'password') body = { currentPassword: password, newPassword, passwordConfirmation: confirmation }
      else body = { username, password, ...(action === 'register' ? { passwordConfirmation: confirmation } : {}) }
      const result = await account.perform(action, body)
      setPassword(''); setNewPassword(''); setConfirmation(''); setSuppliedCode('')
      if (action === 'register' || action === 'recover' || action === 'recovery-code') {
        const recovered = readRecoveryResult(result)
        if (!recovered) throw new Error('Tindakan berhasil, tetapi kode baru tidak dapat ditampilkan. Masuk menggunakan password terbaru lalu terbitkan ulang kode, atau hubungi pengelola.')
        setRecovery(recovered); setSaved(false)
        if (action === 'recover') setMessage('Password berhasil direset. Semua sesi lama dicabut. Simpan kode baru, lalu masuk menggunakan password baru.')
        if (action === 'recovery-code') setMessage('Kode sebelumnya sudah dibatalkan. Password dan sesi login tidak berubah.')
      } else if (action === 'password') {
        setMode('login'); setMessage('Password berhasil diganti. Semua sesi lama dicabut. Silakan masuk lagi.')
      } else onClose()
    } catch (e) { setError(e instanceof Error ? e.message : 'Permintaan akun gagal.') }
    finally { setBusy(false) }
  }
  const authenticated = state.status === 'authenticated'
  const title = code ? 'Simpan kode pemulihanmu.' : authenticated ? mode === 'password' ? 'Ganti password.' : mode === 'recovery-code' ? 'Terbitkan ulang kode.' : 'Akunku.' : mode === 'register' ? 'Buat akun lokal.' : mode === 'recover' ? 'Pulihkan akun.' : 'Masuk ke maindulu.'
  if (libraryOpen && authenticated && state.user && !code) return <SaveLibrary key={state.user.id} userId={state.user.id} onClose={() => setLibraryOpen(false)} />
  if (progressOpen && authenticated && state.user && !code) return <GameSaveLibrary key={state.user.id} userId={state.user.id} onClose={() => setProgressOpen(false)} />
  return <Dialog title={title} onClose={onClose} busy={busy || !!code}>
    {error && <p className="notice" role="alert">{error}</p>}
    {message && <p className="notice" role="status">{message}</p>}
    {code ? <div className="account-form">
      <p>Kode ini hanya ditampilkan sekali. Simpan di tempat aman di luar browser. Siapa pun yang memilikinya dapat memulihkan akunmu.</p>
      <p>Untuk akun <strong>{recovery?.username}</strong>.</p>
      <label htmlFor="recovery-code">Kode pemulihan</label><textarea id="recovery-code" readOnly value={code} rows={3} onFocus={e => e.currentTarget.select()} />
      <button className="button secondary" onClick={() => {
        const url = URL.createObjectURL(new Blob([`Kode pemulihan maindulu\nUsername: ${recovery?.username}\n${code}\n\nSimpan secara privat. Jangan bagikan kode ini.\n`], { type: 'text/plain' }))
        const link = document.createElement('a'); link.href = url; link.download = 'maindulu-kode-pemulihan.txt'; link.click(); URL.revokeObjectURL(url)
      }}>Unduh kode pemulihan</button>
      <label className="account-check"><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} />Kode sudah kusimpan.</label>
      <button className="button primary" disabled={!saved} onClick={onClose}>Selesai</button>
      <p>Kode hanya berlaku sekali untuk pemulihan akun. Kode lama tidak berlaku setelah reset atau penerbitan ulang.</p>
    </div> : state.status === 'unavailable' ? <div className="account-form"><p role="alert">Informasi akun belum dapat dimuat. {state.error} Kamu tetap bisa bermain sebagai tamu.</p><button className="button secondary" onClick={() => void account.refresh()}>Periksa akun lagi</button></div> : state.status === 'checking' ? <p role="status">Memeriksa sesi akun…</p> : <>
      {authenticated && <div className="account-form"><p>Masuk sebagai <strong>{state.user?.username}</strong>. Save state server tersedia secara manual. Progres dalam game NES tersinkron otomatis; memcard PS1 masih percobaan. Periksa dukungan dan status pada player.</p><div className="account-actions"><button className="button secondary small" disabled={busy} onClick={() => setLibraryOpen(true)}>Kelola simpanan server</button><button className="button secondary small" disabled={busy} onClick={() => setProgressOpen(true)}>Kelola progres game</button><button className="button secondary small" disabled={busy} onClick={() => switchMode(mode === 'password' ? 'login' : 'password')}>{mode === 'password' ? 'Batal ganti password' : 'Ganti password'}</button><button className="button secondary small" disabled={busy} onClick={() => switchMode(mode === 'recovery-code' ? 'login' : 'recovery-code')}>{mode === 'recovery-code' ? 'Batal terbitkan kode' : 'Terbitkan ulang kode'}</button><button className="button secondary small" disabled={busy} onClick={() => void submit('logout')}>Keluar akun</button></div></div>}
      {(!authenticated || mode === 'password' || mode === 'recovery-code') && <form className="account-form" onSubmit={e => { e.preventDefault(); void submit(authenticated ? mode === 'recovery-code' ? 'recovery-code' : 'password' : mode === 'register' ? 'register' : mode === 'recover' ? 'recover' : 'login') }}>
        {!authenticated && <><label htmlFor="account-username">Username</label><input id="account-username" autoComplete="username" autoCapitalize="none" spellCheck={false} required disabled={busy} value={username} onChange={e => setUsername(e.target.value)} /><p>3–24 karakter: huruf a–z, angka, atau garis bawah. Huruf besar dianggap sama dengan huruf kecil.</p></>}
        {mode === 'recover' && !authenticated ? <><label htmlFor="account-recovery">Kode pemulihan</label><input id="account-recovery" autoComplete="off" autoCapitalize="none" spellCheck={false} required disabled={busy} value={suppliedCode} onChange={e => setSuppliedCode(e.target.value)} /></> : <><label htmlFor="account-password">{authenticated ? 'Password saat ini' : 'Password'}</label><input id="account-password" type="password" autoComplete={mode === 'register' && !authenticated ? 'new-password' : 'current-password'} required disabled={busy} value={password} onChange={e => setPassword(e.target.value)} /></>}
        {(authenticated && mode === 'password' || mode === 'recover') && <><label htmlFor="account-new-password">Password baru</label><input id="account-new-password" type="password" autoComplete="new-password" required disabled={busy} value={newPassword} onChange={e => setNewPassword(e.target.value)} /></>}
        {(mode === 'password' && authenticated || mode === 'register' || mode === 'recover') && <><label htmlFor="account-confirm">Konfirmasi password{authenticated || mode === 'recover' ? ' baru' : ''}</label><input id="account-confirm" type="password" autoComplete="new-password" required disabled={busy} value={confirmation} onChange={e => setConfirmation(e.target.value)} /><p>Password 6–128 karakter. Tidak perlu email atau akun pihak ketiga.</p></>}
        {mode === 'recovery-code' && <p>Kode sebelumnya langsung dibatalkan. Simpan kode baru setelah berhasil. Jika respons terputus, periksa sesi lalu terbitkan ulang lagi.</p>}
        {mode === 'recover' && <p>Jika respons terputus setelah reset, coba masuk memakai password baru lalu terbitkan ulang kode. Jika kode hilang, hubungi pemilik/pengelola komputer server untuk verifikasi akun dan bantuan reset lokal.</p>}
        <button className="button primary" disabled={busy || mode === 'register' && !state.registrationOpen}>{busy ? 'Memproses…' : authenticated ? mode === 'recovery-code' ? 'Buat kode baru' : 'Simpan password baru' : mode === 'register' ? 'Daftar akun' : mode === 'recover' ? 'Reset password' : 'Masuk'}</button>
        {!authenticated && <>{state.registrationOpen && <button type="button" className="text-link" disabled={busy} onClick={() => switchMode(mode === 'register' ? 'login' : 'register')}>{mode === 'register' ? 'Sudah punya akun? Masuk' : 'Belum punya akun? Daftar'}</button>}{!state.registrationOpen && <p>Pendaftaran sedang ditutup oleh pengelola.</p>}<button type="button" className="text-link" disabled={busy} onClick={() => switchMode(mode === 'recover' ? 'login' : 'recover')}>{mode === 'recover' ? 'Kembali ke masuk' : 'Lupa password?'}</button><p>Login opsional. Kamu tetap bisa bermain tanpa akun.</p></>}
      </form>}
    </>}
  </Dialog>
}
