import { useEffect, useRef, useState } from 'react'

// One flight, bounded backoff, and an abort on hidden/offline/unmount. No ROM I/O.
export function useVisiblePolling(enabled: boolean, task: (signal: AbortSignal) => Promise<void>, interval = 5000) {
  const latest = useRef(task)
  const [attempt, setAttempt] = useState(0)
  latest.current = task
  useEffect(() => {
    if (!enabled) return
    let disposed = false, flight: AbortController | null = null, delay = interval
    let timer: ReturnType<typeof setTimeout> | undefined
    const visible = () => document.visibilityState === 'visible' && navigator.onLine
    async function run() {
      if (disposed || flight || !visible()) return
      const controller = new AbortController()
      flight = controller
      try { await latest.current(AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])); delay = interval }
      catch { delay = Math.min(delay * 2, 60000) }
      finally {
        flight = null
        if (!disposed && visible()) timer = setTimeout(() => void run(), delay)
      }
    }
    function wake() {
      clearTimeout(timer)
      if (!visible()) { flight?.abort(); return }
      if (!flight) void run()
    }
    void run()
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    window.addEventListener('online', wake)
    window.addEventListener('offline', wake)
    return () => {
      disposed = true; clearTimeout(timer); flight?.abort()
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('focus', wake); window.removeEventListener('online', wake); window.removeEventListener('offline', wake)
    }
  }, [enabled, interval, attempt])
  return () => setAttempt(previous => previous + 1)
}
