import { useCallback, useEffect, useRef, useState } from 'react'
import { CatalogClientError } from './admin-catalog.ts'
import { getMetadata, metadataAction } from './metadata.ts'
import type { MetadataDetail } from './metadata.ts'
import { useVisiblePolling } from './useVisiblePolling.ts'

type Task = { id: string; title: string; generation: number }
type Notification = { key: string; text: string; tone: 'success' | 'warning' | 'error' }
export type MetadataTasks = {
  run: (id: string, title: string, action: 'scan' | 'search' | 'apply', body: Record<string, unknown>) => Promise<void>
  watch: (id: string, title: string, detail: MetadataDetail) => void
}

const pending = new Set(['queued', 'running', 'retry_wait'])
export function metadataTaskNotice(title: string, detail: Pick<MetadataDetail, 'status' | 'reason'>): Omit<Notification, 'key'> | null {
  switch (detail.status) {
    case 'succeeded': return detail.reason?.startsWith('COVER_')
      ? { text: `Metadata ${title} diperbarui, tetapi cover belum tersedia. Buka Review metadata untuk detail.`, tone: 'warning' }
      : { text: `Metadata ${title} berhasil diperbarui.`, tone: 'success' }
    case 'needs_review': return { text: `Hasil scan ${title} perlu ditinjau. Buka Review metadata.`, tone: 'warning' }
    case 'not_found': return { text: `Metadata ${title} tidak ditemukan. Buka Review metadata untuk detail.`, tone: 'warning' }
    case 'unsupported': return { text: `Format ${title} belum mendukung scan otomatis. Buka Review metadata.`, tone: 'warning' }
    case 'paused': return { text: `Scan ${title} dijeda. Buka Review metadata untuk detail.`, tone: 'warning' }
    case 'failed': return { text: `Scan ${title} gagal. Buka Review metadata untuk mencoba lagi.`, tone: 'error' }
    case 'cancelled': return { text: `Scan ${title} dibatalkan.`, tone: 'warning' }
    case 'disabled': return { text: `Scan ${title} nonaktif.`, tone: 'warning' }
    default: return null
  }
}

// Task ownership belongs to App, not the review dialog. Only logout/account
// changes or leaving the app abort client requests; queued server jobs persist.
export function useMetadataTasks(userId: string | null, enabled: boolean) {
  const owner = useRef(userId)
  const tasks = useRef(new Map<string, Task>())
  const completed = useRef(new Map<string, number>())
  const requests = useRef(new Set<AbortController>())
  const [count, setCount] = useState(0)
  const [notifications, setNotifications] = useState<Notification[]>([])
  useEffect(() => {
    owner.current = userId
    tasks.current.clear(); completed.current.clear(); setCount(0); setNotifications([])
    return () => {
      owner.current = null
      for (const request of requests.current) request.abort()
      requests.current.clear()
    }
  }, [userId])

  const track = useCallback((id: string, title: string, generation: number) => {
    if (!userId || owner.current !== userId || (completed.current.get(id) ?? -1) >= generation || (tasks.current.get(id)?.generation ?? -1) >= generation) return
    tasks.current.set(id, { id, title, generation }); setCount(tasks.current.size)
  }, [userId])
  const watch = useCallback((id: string, title: string, detail: MetadataDetail) => {
    if (detail.gameId === id && detail.generation !== null && pending.has(detail.status)) track(id, title, detail.generation)
  }, [track])
  const run = useCallback(async (id: string, title: string, action: 'scan' | 'search' | 'apply', body: Record<string, unknown>) => {
    if (!userId || owner.current !== userId || !enabled) throw new Error('Sesi admin metadata tidak tersedia.')
    const controller = new AbortController()
    requests.current.add(controller)
    try {
      const result = await metadataAction(id, userId, action, body, controller.signal)
      if (controller.signal.aborted || owner.current !== userId) return
      if (!result || typeof result !== 'object' || !('gameId' in result) || result.gameId !== id || !('generation' in result) || !Number.isSafeInteger(result.generation) || Number(result.generation) < 1) throw new Error('Respons tugas metadata tidak sesuai.')
      track(id, title, result.generation as number)
    } catch (error) {
      if (!controller.signal.aborted && owner.current === userId && !(error instanceof CatalogClientError && [401, 403].includes(error.status))) {
        setNotifications(previous => [...previous, { key: `${id}-request-${Date.now()}`, text: `Permintaan metadata ${title} belum terkonfirmasi. Buka Review metadata untuk memeriksa status sebelum mengulang.`, tone: 'warning' }])
      }
      throw error
    } finally { requests.current.delete(controller) }
  }, [userId, enabled, track])

  useVisiblePolling(enabled && !!userId && count > 0, async signal => {
    const results = await Promise.allSettled(Array.from(tasks.current.values()).map(async task => {
      try {
        const detail = await getMetadata(task.id, signal)
        if (signal.aborted || owner.current !== userId || tasks.current.get(task.id) !== task || detail.generation === null || detail.generation < task.generation) return
        const notice = metadataTaskNotice(task.title, detail)
        if (!notice) return
        tasks.current.delete(task.id); setCount(tasks.current.size)
        if ((completed.current.get(task.id) ?? -1) >= detail.generation) return
        completed.current.set(task.id, detail.generation)
        setNotifications(previous => [...previous, { key: `${task.id}-${detail.generation}`, ...notice }])
      } catch (error) {
        if (!signal.aborted && owner.current === userId && error instanceof CatalogClientError && [401, 403, 404].includes(error.status)) {
          tasks.current.delete(task.id); setCount(tasks.current.size)
        } else throw error // Connection failures are not scan failures; retry later.
      }
    }))
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }, 2500)
  const dismiss = useCallback(() => setNotifications(previous => previous.slice(1)), [])
  const notification = notifications[0]
  useEffect(() => {
    if (!notification) return
    const timer = setTimeout(dismiss, 8000)
    return () => clearTimeout(timer)
  }, [notification, dismiss])
  return { run, watch, notification: userId && owner.current === userId ? notification : undefined, dismiss }
}
