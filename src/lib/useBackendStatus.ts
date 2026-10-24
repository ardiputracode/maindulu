import { useEffect, useState } from 'react'
import { backendConfigured, readBackendHealth } from './backend'
import type { BackendState } from './backend'

export function useBackendStatus() {
  const [enabled] = useState(() => backendConfigured(document.querySelector('meta[name="maindulu-backend"]')?.getAttribute('content') ?? null, import.meta.env.VITE_BACKEND_ENABLED))
  const [state, setState] = useState<BackendState>({ status: enabled ? 'checking' : 'disabled' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    let disposed = false
    setState({ status: 'checking' })
    async function check() {
      try {
        const response = await fetch('/api/health', { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' })
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Backend tidak tersedia.')
        const health = readBackendHealth(await response.json())
        if (!health) throw new Error('Respons backend tidak sesuai.')
        if (!disposed) setState({ status: 'online', health })
      } catch { if (!disposed) setState({ status: 'unavailable' }) }
      finally { clearTimeout(timeout) }
    }
    void check()
    return () => { disposed = true; clearTimeout(timeout); controller.abort() }
  }, [enabled, attempt])
  return { state, retry: () => setAttempt(n => n + 1) }
}
