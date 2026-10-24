import { useCallback, useEffect, useRef, useState } from 'react'
import { SaveClient } from './saves'
import type { SaveList } from './saves'

export function useSaveLibrary(userId: string, enabled = true) {
  const [client, setClient] = useState<SaveClient | null>(null)
  const [list, setList] = useState<SaveList | null>(null)
  const [error, setError] = useState('')
  const epoch = useRef(0)
  useEffect(() => {
    if (!enabled) { setClient(null); setList(null); return }
    const next = new SaveClient(userId)
    setClient(next)
    return () => { epoch.current++; next.close() }
  }, [userId, enabled])
  const refresh = useCallback(async () => {
    if (!client) return
    const run = ++epoch.current
    setError('')
    try { const next = await client.list(); if (run === epoch.current) setList(next) }
    catch (e) { if (run === epoch.current) { setList(null); setError(e instanceof Error ? e.message : 'Daftar save gagal dimuat.') } }
  }, [client])
  useEffect(() => { setList(null); if (client) void refresh() }, [client, refresh])
  return { client, list, error, refresh }
}
