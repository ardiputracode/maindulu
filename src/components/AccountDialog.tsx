import { useEffect, useState } from 'react'
import Dialog from './Dialog'
import type { useAccount } from '../lib/useAccount'
import { readAccountSession } from '../lib/account'

export default function AccountDialog({ account, onClose }: { account: ReturnType<typeof useAccount>; onClose: () => void }) {
  const { state } = account
  const [mode, setMode] = useState<'login' | 'register' | 'password'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [recovery, setRecovery] = useState<{ code: string; username: string } | null>(null)
  const code = recovery?.code ?? ''
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => {
    if (!code || saved) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [code, saved])
  function switchMode(next: typeof mode) { setMode(next); setError(''); setMessage(''); setPassword(''); setNewPassword(''); setConfirmation('') }
  async function submit(action: 'login' | 'register' | 'password' | 'logout') {
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await account.perform(action, action === 'logout' ? {} : action === 'password' ? { currentPassword: password, newPassword, passwordConfirmation: confirmation } : { username, password, ...(action === 'register' ? { passwordConfirmation: confirmation } : {}) })
      setPassword(''); setNewPassword(''); setConfirmation('')
      if (action === 'register') {
        const recovery = (result as { recoveryCode?: unknown }).recoveryCode
        const created = readAccountSession(result)
        if (!created?.user || typeof recovery !== 'string' || !/^(?:[A-F0-9]{8}-){7}[A-F0-9]{8}$/.test(recovery)) throw new Error('Akun dibuat, tetapi kode pemulihan tidak dapat ditampilkan. Jangan gunakan akun ini sebelum menghubungi pengelola.')
        setRecovery({ code: recovery, username: created.user.username })
      } else if (action === 'password') {
        setMode('login'); setMessage('Password berhasil diganti. Semua sesi lama dicabut. Silakan masuk lagi.')
      } else onClose()
    } catch (e) { setError(e instanceof Error ? e.message : 'Permintaan akun gagal.') }
    finally { setBusy(false) }
  }
  const authenticated = state.status === 'authenticated'
  const title = code ? 'Simpan kode pemulihanmu.' : authenticated ? mode === 'password' ? 'Ganti password.' : 'Akunku.' : mode === 'register' ? 'Buat akun lokal.' : 'Masuk ke maindulu.'
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
      <p>Pemulihan menggunakan kode belum tersedia pada tahap ini. Simpan kodenya untuk fitur pemulihan berikutnya.</p>
    </div> : state.status === 'unavailable' ? <div className="account-form"><p role="alert">Informasi akun belum dapat dimuat. {state.error} Kamu tetap bisa bermain sebagai tamu.</p><button className="button secondary" onClick={() => void account.refresh()}>Periksa akun lagi</button></div> : state.status === 'checking' ? <p role="status">Memeriksa sesi akun…</p> : <>
      {authenticated && <div className="account-form"><p>Masuk sebagai <strong>{state.user?.username}</strong>. Progres masih di browser; login belum mengaktifkan cloud save.</p><div className="account-actions"><button className="button secondary small" disabled={busy} onClick={() => switchMode(mode === 'password' ? 'login' : 'password')}>{mode === 'password' ? 'Batal ganti password' : 'Ganti password'}</button><button className="button secondary small" disabled={busy} onClick={() => void submit('logout')}>Keluar akun</button></div></div>}
      {(!authenticated || mode === 'password') && <form className="account-form" onSubmit={e => { e.preventDefault(); void submit(authenticated ? 'password' : mode === 'register' ? 'register' : 'login') }}>
        {!authenticated && <><label htmlFor="account-username">Username</label><input id="account-username" autoComplete="username" autoCapitalize="none" spellCheck={false} required disabled={busy} value={username} onChange={e => setUsername(e.target.value)} /><p>3–24 karakter: huruf a–z, angka, atau garis bawah. Huruf besar dianggap sama dengan huruf kecil.</p></>}
        <label htmlFor="account-password">{authenticated ? 'Password saat ini' : 'Password'}</label><input id="account-password" type="password" autoComplete={mode === 'register' && !authenticated ? 'new-password' : 'current-password'} required disabled={busy} value={password} onChange={e => setPassword(e.target.value)} />
        {authenticated && <><label htmlFor="account-new-password">Password baru</label><input id="account-new-password" type="password" autoComplete="new-password" required disabled={busy} value={newPassword} onChange={e => setNewPassword(e.target.value)} /></>}
        {(authenticated || mode === 'register') && <><label htmlFor="account-confirm">Konfirmasi password{authenticated ? ' baru' : ''}</label><input id="account-confirm" type="password" autoComplete="new-password" required disabled={busy} value={confirmation} onChange={e => setConfirmation(e.target.value)} /><p>Password 6–128 karakter. Tidak perlu email atau akun pihak ketiga.</p></>}
        <button className="button primary" disabled={busy || mode === 'register' && !state.registrationOpen}>{busy ? 'Memproses…' : authenticated ? 'Simpan password baru' : mode === 'register' ? 'Daftar akun' : 'Masuk'}</button>
        {!authenticated && <>{state.registrationOpen && <button type="button" className="text-link" disabled={busy} onClick={() => switchMode(mode === 'register' ? 'login' : 'register')}>{mode === 'register' ? 'Sudah punya akun? Masuk' : 'Belum punya akun? Daftar'}</button>}{!state.registrationOpen && <p>Pendaftaran sedang ditutup oleh pengelola.</p>}<p>Login opsional. Kamu tetap bisa bermain tanpa akun. Pemulihan password belum tersedia pada tahap ini.</p></>}
      </form>}
    </>}
  </Dialog>
}
