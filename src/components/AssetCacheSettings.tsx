import { useEffect, useRef, useState } from 'react'
import { HardDrive, RefreshCw, Trash2 } from 'lucide-react'
import { ASSET_CACHE_DATABASE, openAssetCache } from '../lib/asset-cache'
import type { AssetCache, AssetCacheEntry, AssetCacheStats } from '../lib/asset-cache'
import { subscribeAssetCacheChanges } from '../lib/asset-cache-events'
import { formatAssetBytes, readBrowserStorage, requestPersistentStorage } from '../lib/asset-cache-ui'
import type { BrowserStorageInfo } from '../lib/asset-cache-ui'
import { ASSET_CACHE_DISABLED, ASSET_CACHE_DISABLED_NOTICE } from '../lib/asset-cache-rollout'
import Dialog from './Dialog'

type Confirmation = { type: 'entry'; entry: AssetCacheEntry } | { type: 'clear' } | { type: 'budget'; budget: number }
const budgets = [256, 512, 1024, 2048, 4096, 8192].map(value => value * 1048576)

export default function AssetCacheSettings() {
  const [stats, setStats] = useState<AssetCacheStats | null>(null)
  const [storage, setStorage] = useState<BrowserStorageInfo>({ canPersist: false })
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const lifecycle = useRef<AbortController | null>(null)
  const locked = useRef(false)
  const refresh = useRef<() => void>(() => {})
  const refreshButton = useRef<HTMLButtonElement>(null)
  const focusAfterMutation = useRef(false)

  useEffect(() => {
    // Run after Dialog's focus restoration: the original per-entry trigger may
    // still exist at close, then disappear when the metadata refresh settles.
    if (!confirmation && focusAfterMutation.current) {
      focusAfterMutation.current = false
      refreshButton.current?.focus()
    }
  }, [confirmation])

  useEffect(() => {
    const controller = new AbortController(), signal = controller.signal
    lifecycle.current = controller
    let reading = false, queued = false
    async function load() {
      if (signal.aborted) return
      if (reading) { queued = true; return }
      reading = true
      let cache: AssetCache | undefined
      try {
        cache = await openAssetCache()
        const next = await cache.stats(signal)
        if (!signal.aborted) { setStats(next); setLoadError('') }
      } catch (e) {
        if (!signal.aborted) { setStats(null); setLoadError(e instanceof Error ? e.message : 'Cache perangkat tidak tersedia.') }
      } finally {
        cache?.close(); reading = false
        if (queued && !signal.aborted) { queued = false; void load() }
      }
    }
    function update() {
      void load()
      void readBrowserStorage().then(info => { if (!signal.aborted) setStorage(info) })
    }
    refresh.current = update
    update()
    const unsubscribe = subscribeAssetCacheChanges(ASSET_CACHE_DATABASE, () => { void load() })
    const visible = () => { if (!document.hidden) update() }
    window.addEventListener('focus', visible)
    document.addEventListener('visibilitychange', visible)
    // Also covers unavailable BroadcastChannel and staging progress, without
    // broadcasting a message for every downloaded chunk.
    const timer = setInterval(() => { if (!document.hidden) void load() }, 5000)
    return () => {
      controller.abort(); unsubscribe(); clearInterval(timer)
      window.removeEventListener('focus', visible)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [])

  async function mutate(operation: (cache: AssetCache, signal: AbortSignal) => Promise<void>, message: string) {
    const signal = lifecycle.current?.signal
    if (!signal || signal.aborted || locked.current) return
    locked.current = true; setBusy(true); setError(''); setNotice('')
    let cache: AssetCache | undefined
    try {
      cache = await openAssetCache()
      signal.throwIfAborted()
      await operation(cache, signal)
      if (!signal.aborted) { focusAfterMutation.current = !!confirmation; setConfirmation(null); setNotice(message) }
    } catch (e) {
      if (!signal.aborted) setError(e instanceof Error ? e.message : 'Perubahan cache gagal. Coba lagi.')
    } finally {
      cache?.close(); locked.current = false
      if (!signal.aborted) { setBusy(false); refresh.current() }
    }
  }

  function changeBudget(budget: number) {
    if (!stats || budget === stats.settings.budget) return
    if (budget < stats.settings.budget) setConfirmation({ type: 'budget', budget })
    else void saveBudget(budget)
  }
  function saveBudget(budget: number) {
    return mutate(async (cache, signal) => cache.setSettings({ ...(await cache.settings(signal)), budget }, signal), 'Budget cache diperbarui.')
  }
  function confirm() {
    if (!confirmation) return
    if (confirmation.type === 'budget') { void saveBudget(confirmation.budget); return }
    const entry = confirmation.type === 'entry' ? confirmation.entry : null
    void mutate((cache, signal) => entry ? cache.delete(entry.kind, entry.catalogId, entry.sha256, signal) : cache.clear(signal),
      entry ? 'Aset cache dihapus. Save/progres tetap utuh.' : 'Seluruh cache ROM/BIOS dihapus. Save/progres tetap utuh.')
  }
  async function persist() {
    const signal = lifecycle.current?.signal
    if (!signal || signal.aborted || locked.current) return
    locked.current = true; setBusy(true)
    const message = await requestPersistentStorage()
    locked.current = false
    if (!signal.aborted) { setBusy(false); setNotice(message); refresh.current() }
  }

  return <section className="settings-panel asset-cache-settings" aria-label="Cache ROM dan BIOS backend" aria-busy={busy}>
    <div className="setting-row"><div className="setting-symbol"><HardDrive size={22} /></div><div className="setting-description"><h2>Cache ROM/BIOS perangkat</h2><p>Simpan aset upload katalog backend agar tidak perlu diunduh ulang. Server tetap diperiksa setiap peluncuran; ini bukan mode offline.</p><p>Fitur belum aktif secara default selama pengujian rilis. File ROM/BIOS lokal dan game demo tidak ikut disimpan.</p></div>
      <button className={`toggle ${!ASSET_CACHE_DISABLED && stats?.settings.enabled ? 'on' : ''}`} role="switch" aria-checked={!ASSET_CACHE_DISABLED && (stats?.settings.enabled ?? false)} aria-label="Gunakan cache ROM/BIOS backend" disabled={ASSET_CACHE_DISABLED || busy || !stats} onClick={() => void mutate(async (cache, signal) => {
        const current = await cache.settings(signal)
        await cache.setSettings({ ...current, enabled: !current.enabled }, signal)
      }, 'Pengaturan cache diperbarui. Berlaku untuk peluncuran berikutnya.')}><span /></button>
    </div>
    <div className="asset-cache-body">
      {ASSET_CACHE_DISABLED && <p role="status">{ASSET_CACHE_DISABLED_NOTICE} Pilihan penggunaan sebelumnya tetap disimpan. Pengelolaan dan penghapusan cache tetap tersedia.</p>}
      <p>Cache dibagikan semua akun pada origin <code>{location.origin}</code> di profil browser ini, tidak terenkripsi, dan tidak dihapus saat logout. Mematikan cache tidak menghapus data lama. Kuota, eviction browser, atau penghapusan data situs dapat menghilangkannya.</p>
      <div className="asset-cache-toolbar"><label htmlFor="asset-cache-budget">Budget cache aplikasi<select id="asset-cache-budget" disabled={busy || !stats} value={stats?.settings.budget ?? 2147483648} onChange={e => changeBudget(Number(e.target.value))}>
        {[...new Set([...budgets, ...(stats ? [stats.settings.budget] : [])])].sort((a, b) => a - b).map(budget => <option key={budget} value={budget}>{formatAssetBytes(budget)}</option>)}
      </select></label><button ref={refreshButton} className="button secondary small" aria-disabled={busy} onClick={() => { if (!busy) refresh.current() }}><RefreshCw size={15} />Perbarui cache</button></div>
      <p>Budget bukan jaminan ruang tersedia. Jika perlu, cache paling lama dipakai akan dihapus untuk memberi ruang; aset yang sedang dirakit dilindungi. Penurunan budget saat cache aktif dapat langsung menghapus aset lama.</p>
      {stats ? <><dl className="asset-cache-stats"><div><dt>Cache terkomit</dt><dd>{formatAssetBytes(stats.committedBytes)} · {stats.count} aset</dd></div><div><dt>Aktivitas sementara</dt><dd>{stats.stagingCount} persiapan · {formatAssetBytes(stats.stagingBytes)} ditulis · {formatAssetBytes(stats.reservedBytes)} direservasi</dd></div></dl>
        <div className="asset-cache-toolbar"><h3>Aset tersimpan</h3><button className="button secondary small" disabled={busy || (!stats.count && !stats.stagingCount)} onClick={() => setConfirmation({ type: 'clear' })}><Trash2 size={15} />Hapus semua cache</button></div>
        {stats.count ? <ul className="asset-cache-list">{[...stats.entries].sort((a, b) => b.lastUsedAt - a.lastUsedAt).map(entry => <li key={JSON.stringify(entry.key)}><div><h4>{entry.label}</h4><p>{entry.kind.toUpperCase()} · {entry.consoleId} · {entry.fileName}</p><p>{formatAssetBytes(entry.size)} · Terakhir dipakai <time dateTime={new Date(entry.lastUsedAt).toISOString()}>{new Date(entry.lastUsedAt).toLocaleString('id-ID')}</time></p><span>Tersimpan · diverifikasi ulang saat dipakai</span></div><button className="button secondary small" disabled={busy} aria-label={`Hapus cache ${entry.kind.toUpperCase()} ${entry.label}`} onClick={() => setConfirmation({ type: 'entry', entry })}>Hapus</button></li>)}</ul> : <p>Belum ada ROM/BIOS yang tersimpan di cache perangkat.</p>}
      </> : !loadError && <p role="status">Membaca metadata cache…</p>}
      <div className="asset-cache-storage"><h3>Penyimpanan browser</h3><p>{storage.quota !== undefined ? `Estimasi seluruh origin: ${formatAssetBytes(storage.usage!)} terpakai dari ${formatAssetBytes(storage.quota)}. Termasuk data selain cache ROM/BIOS.` : 'Estimasi ruang browser tidak tersedia. Budget aplikasi dan hasil transaksi tetap digunakan.'}</p><p>{storage.persisted === true ? 'Penyimpanan persisten disetujui browser; bukan jaminan permanen.' : storage.persisted === false ? 'Penyimpanan belum persisten; browser dapat menghapus data otomatis.' : 'Status penyimpanan persisten tidak tersedia di browser/origin ini.'}</p>
        {storage.canPersist ? <button className="button secondary small" disabled={busy || storage.persisted === true} onClick={() => void persist()}>Minta penyimpanan persisten</button> : <p>Permintaan penyimpanan persisten tidak tersedia. IndexedDB tetap dapat digunakan jika didukung.</p>}
      </div>
      {notice && <p role="status">{notice}</p>}{(error || loadError) && !confirmation && <p className="notice" role="alert">{error || loadError}</p>}
    </div>
    {confirmation && <Dialog title={confirmation.type === 'budget' ? 'Kurangi budget cache?' : confirmation.type === 'clear' ? 'Hapus semua cache ROM/BIOS?' : 'Hapus aset cache?'} eyebrow="HANYA CACHE PERANGKAT" busy={busy} onClose={() => setConfirmation(null)}>
      <p className="asset-cache-confirm">{confirmation.type === 'budget' ? `Budget menjadi ${formatAssetBytes(confirmation.budget)}. Jika cache aktif, aset lama dapat langsung dihapus untuk menyesuaikan budget.` : confirmation.type === 'entry' ? `${confirmation.entry.label} (${confirmation.entry.fileName}) akan dihapus dari cache. Jika sedang disiapkan, penyimpanannya juga dibatalkan.` : 'Seluruh cache ROM/BIOS dan penyimpanan yang sedang berlangsung akan dibersihkan.'} Save state, SRAM, progres, akun, favorit, dan riwayat tidak dihapus. Sesi yang sudah memuat aset tetap berjalan. Aset yang dihapus perlu diunduh kembali.</p>
      {(error || loadError) && <p className="notice" role="alert">{error || loadError}</p>}
      <div className="account-actions"><button className="button secondary" disabled={busy} onClick={() => setConfirmation(null)}>Batal</button><button className="button primary" disabled={busy} onClick={confirm}>{busy ? 'Memproses…' : confirmation.type === 'budget' ? 'Kurangi budget' : 'Ya, hapus cache'}</button></div>
    </Dialog>}
  </section>
}
