import { Server } from 'lucide-react'
import type { BackendState } from '../lib/backend'

export default function BackendStatus({ state, onRetry }: { state: BackendState; onRetry: () => void }) {
  const title = state.status === 'disabled' ? 'Mode web statis' : state.status === 'checking' ? 'Memeriksa backend…' : state.status === 'online' ? 'Backend lokal terhubung' : 'Backend tidak dapat dihubungi'
  return <section className="privacy-card" aria-label="Status backend">
    <Server size={24} />
    <div><h2>{title}</h2>
      <p role={state.status === 'unavailable' ? 'alert' : 'status'}>{state.status === 'disabled' ? 'Backend tidak aktif. Tanpa backend, pintu masuk dan simpanan server tidak tersedia. Build statis tanpa gerbang tidak boleh dipakai untuk akses privat.' : state.status === 'checking' ? 'Memeriksa backend dan pintu masuk…' : state.status === 'online' ? `${state.health.capabilities.gate ? 'Pintu masuk aktif. Akun main opsional membuka simpanan server.' : 'Backend ini tanpa gerbang. Jangan gunakan untuk akses privat.'} Untuk tamu, progres tetap di browser. ${state.health.capabilities.gameSaves ? 'Progres game NES tersinkron otomatis untuk akun; PS1 masih percobaan.' : ''}` : 'Backend sedang istirahat. Katalog dan data belum bisa dibuka sampai pintu masuk tersedia.'}</p>
      {state.status === 'unavailable' && <button className="button secondary small" onClick={onRetry}>Coba koneksi backend lagi</button>}
    </div>
  </section>
}
