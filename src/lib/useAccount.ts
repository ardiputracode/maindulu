import { useCallback, useEffect, useRef, useState } from 'react'
import { AccountError, readAccountSession } from './account'
import type { AccountState } from './account'

export function useAccount(enabled: boolean) {
  const [state, setState] = useState<AccountState>({ status: enabled ? 'checking' : 'disabled', user: null, registrationOpen: false })
  const epoch = useRef(0)
  const mutating = useRef(false)
  const controllers = useRef(new Set<AbortController>())
  const request = useCallback(async (path: string, init: RequestInit = {}) => {
    const controller = new AbortController()
    controllers.current.add(controller)
    const timer = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await fetch('/api/auth/' + path, { ...init, signal: controller.signal, cache: 'no-store', credentials: 'same-origin' })
      if (!response.headers.get('content-type')?.includes('application/json')) throw new AccountError('Respons akun tidak sesuai. Coba lagi.')
      const data = await response.json()
      if (!response.ok) throw new AccountError(typeof data.error === 'string' ? data.error : 'Permintaan akun gagal.', response.status)
      return data as unknown
    } catch (error) {
      if (error instanceof AccountError) throw error
      throw new AccountError('Koneksi akun terputus atau terlalu lama. Periksa koneksi dan coba lagi.')
    } finally { clearTimeout(timer); controllers.current.delete(controller) }
  }, [])
  const applySession = useCallback((data: unknown) => {
    const session = readAccountSession(data)
    if (!session) throw new AccountError('Respons sesi tidak sesuai. Muat ulang halaman.')
    setState({ status: session.user ? 'authenticated' : 'anonymous', user: session.user, registrationOpen: session.registrationOpen })
    return session
  }, [])
  const refresh = useCallback(async () => {
    if (!enabled || mutating.current) return
    const run = ++epoch.current
    try {
      const data = await request('session')
      if (run === epoch.current) applySession(data)
    } catch (error) { if (run === epoch.current) setState({ status: 'unavailable', user: null, registrationOpen: false, error: error instanceof Error ? error.message : 'Informasi akun belum tersedia.' }) }
  }, [enabled, request, applySession])
  useEffect(() => {
    if (!enabled) setState({ status: 'disabled', user: null, registrationOpen: false })
    else { setState(s => ({ ...s, status: 'checking' })); void refresh() }
    const focus = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', focus)
    const timer = enabled ? setInterval(focus, 60000) : undefined
    const active = controllers.current
    return () => { epoch.current++; clearInterval(timer); window.removeEventListener('focus', focus); for (const controller of active) controller.abort() }
  }, [enabled, refresh])
  const perform = async (action: 'register' | 'login' | 'logout' | 'password', body: Record<string, string>) => {
    if (!enabled || mutating.current) throw new AccountError('Fitur akun belum siap. Coba lagi sebentar.')
    mutating.current = true
    const run = ++epoch.current
    try {
      const bootstrap = readAccountSession(await request('csrf'))
      if (!bootstrap?.csrfToken) throw new AccountError('Sesi keamanan tidak tersedia. Coba lagi.')
      if (action === 'password' && bootstrap.user?.id !== state.user?.id) throw new AccountError('Akun berubah atau sesi berakhir. Muat ulang informasi akun.', 401)
      const data = await request(action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': bootstrap.csrfToken }, body: JSON.stringify(body) })
      if (run !== epoch.current) throw new AccountError('Status akun berubah. Muat ulang halaman untuk memeriksa hasilnya.')
      if (action === 'login' || action === 'register') applySession(data)
      else setState({ status: 'anonymous', user: null, registrationOpen: bootstrap.registrationOpen })
      return data
    } catch (error) {
      if (run === epoch.current) {
        // A failed password check must not log out a still-valid session; an
        // actual revocation/expiry must not leave the UI claiming authentication.
        try { const data = await request('session'); if (run === epoch.current) applySession(data) }
        catch { if (run === epoch.current) setState({ status: 'unavailable', user: null, registrationOpen: false, error: 'Koneksi akun terputus. Periksa koneksi dan coba lagi.' }) }
      }
      throw error
    } finally { mutating.current = false }
  }
  return { state, refresh, perform }
}
