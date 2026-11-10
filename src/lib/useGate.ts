import { useCallback, useEffect, useRef, useState } from 'react'
import type { BackendState } from './backend'
import { gateRequest } from './gate'

type GateState = { status: 'checking' | 'authenticated' | 'anonymous' | 'unavailable'; expiresAt?: number; expired?: boolean }

export function useGate(backend: BackendState) {
  const enabled = backend.status === 'online' && backend.health.capabilities.gate === true
  const [state, setState] = useState<GateState>({ status: 'checking' })
  const [attempt, setAttempt] = useState(0)
  const generation = useRef(0)
  const refresh = useCallback(() => setAttempt(n => n + 1), [])
  useEffect(() => {
    if (!enabled) { setState({ status: 'checking' }); return }
    const version = generation.current
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    let disposed = false
    void gateRequest('session', undefined, controller.signal).then(session => {
      if (!disposed && generation.current === version) setState(previous => session.authenticated ? { status: 'authenticated', expiresAt: session.expiresAt } : { status: 'anonymous', expired: previous.status === 'authenticated' || previous.expired })
    }).catch(() => { if (!disposed && generation.current === version) setState({ status: 'unavailable' }) }).finally(() => clearTimeout(timeout))
    return () => { disposed = true; clearTimeout(timeout); controller.abort() }
  }, [enabled, attempt])
  useEffect(() => {
    if (!enabled || state.status !== 'authenticated') return
    // A failed personal-account request must not log out the door. Recheck the
    // door itself, and leave Workspace mounted until that result is known.
    const originalFetch = window.fetch
    let pending = false
    const check = () => { if (!pending) { pending = true; refresh() } }
    window.fetch = async (...args) => {
      const response = await originalFetch(...args)
      const url = new URL(response.url || String(args[0]), location.origin)
      if (response.status === 401 && url.origin === location.origin && !url.pathname.startsWith('/api/gate/')) check()
      return response
    }
    const focus = () => refresh()
    window.addEventListener('focus', focus)
    window.addEventListener('maindulu:gate-check', check)
    const visibility = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', visibility)
    const timer = setTimeout(() => {
      if ((state.expiresAt ?? 0) * 1000 <= Date.now()) setState({ status: 'anonymous', expired: true })
      else refresh()
    }, Math.min(2147483647, Math.max(0, (state.expiresAt ?? 0) * 1000 - Date.now())))
    return () => { window.fetch = originalFetch; window.removeEventListener('focus', focus); window.removeEventListener('maindulu:gate-check', check); document.removeEventListener('visibilitychange', visibility); clearTimeout(timer) }
  }, [enabled, state, refresh])
  const login = async (username: string, password: string) => {
    generation.current++
    const session = await gateRequest('login', { username, password })
    if (!session.authenticated) throw new Error('Pintu masuk belum bisa dibuka.')
    setState({ status: 'authenticated', expiresAt: session.expiresAt }); refresh()
  }
  const logout = async () => {
    generation.current++
    await gateRequest('logout')
    setState({ status: 'anonymous' }); refresh()
  }
  const effective: GateState = backend.status === 'checking' ? { status: 'checking' } : backend.status === 'unavailable' ? { status: 'unavailable' } : !enabled ? { status: 'authenticated' } : state
  return { state: effective, enabled, login, logout, refresh }
}
