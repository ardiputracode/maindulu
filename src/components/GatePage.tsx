import { useState } from 'react'
import { ArrowRight, Gamepad2, ShieldCheck } from 'lucide-react'

export default function GatePage({ onLogin, expired = false }: { onLogin: (username: string, password: string) => Promise<void>; expired?: boolean }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <main className="gate-page"><section className="gate-card" aria-labelledby="gate-title">
    <a className="brand" href="/" aria-label="maindulu, pintu masuk"><img src="/assets/maindulu.svg" alt="" width="39" height="39" /><span>maindulu<span className="brand-dot">.</span></span></a>
    <div className="gate-mark"><Gamepad2 size={36} strokeWidth={1.4} /></div>
    <span className="eyebrow">PINTU MASUK RUANG MAIN</span>
    <h1 id="gate-title">Sebelum main,<br />buka pintunya dulu.</h1>
    <p>Ruang ini privat. Masukkan username dan password dari pengelola, lalu biarkan jempol yang mengingat.</p>
    {expired && <p className="notice" role="status">Pintunya terkunci lagi. Masuk sekali lagi, ya.</p>}
    {error && <p className="notice" role="alert">{error}</p>}
    <form className="account-form" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('')
      try { await onLogin(username, password) }
      catch (error) { setError(error instanceof Error ? error.message : 'Pintu masuk belum bisa dibuka. Coba lagi, ya.'); setPassword('') }
      finally { setBusy(false) }
    }}>
      <label htmlFor="gate-username">Username</label><input id="gate-username" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={64} required disabled={busy} value={username} onChange={event => setUsername(event.target.value)} aria-describedby="gate-help" />
      <label htmlFor="gate-password">Password</label><input id="gate-password" type="password" autoComplete="current-password" maxLength={256} required disabled={busy} value={password} onChange={event => setPassword(event.target.value)} aria-describedby="gate-help" />
      <p id="gate-help">Dari pengelola, ya.</p>
      <button className="button primary" disabled={busy}>{busy ? 'Membuka pintu…' : 'Buka pintu'}<ArrowRight size={17} /></button>
    </form>
    <p className="gate-footnote"><ShieldCheck size={15} />Satu pintu masuk. Banyak kenangan.</p>
  </section></main>
}
