import { Server } from 'lucide-react'
import type { BackendState } from '../lib/backend'

export default function BackendStatus({ state, onRetry }: { state: BackendState; onRetry: () => void }) {
  const title = state.status === 'disabled' ? 'Mode web statis' : state.status === 'checking' ? 'Memeriksa backend…' : state.status === 'online' ? 'Backend lokal terhubung' : 'Backend tidak dapat dihubungi'
  return <section className="privacy-card" aria-label="Status backend">
    <Server size={24} />
    <div><h2>{title}</h2>
      <p role={state.status === 'unavailable' ? 'alert' : 'status'}>{state.status === 'disabled' ? 'Backend tidak diaktifkan. Main sebagai tamu dan simpan progres di browser seperti biasa.' : state.status === 'checking' ? 'Memeriksa koneksi ke server maindulu. Kamu tetap bisa bermain sebagai tamu.' : state.status === 'online' ? 'Web dan API tersedia dari server yang sama. Login dan penyimpanan progres server belum tersedia pada tahap ini; progres tetap di browser.' : 'Backend sudah diaktifkan, tetapi koneksinya sedang bermasalah atau responsnya tidak sesuai. Mode tamu tetap bisa digunakan; progres belum disimpan di server.'}</p>
      {state.status === 'unavailable' && <button className="button secondary small" onClick={onRetry}>Coba koneksi backend lagi</button>}
    </div>
  </section>
}
