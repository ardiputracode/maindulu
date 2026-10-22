import { useCallback, useEffect, useState } from 'react'

export function useStored<T>(key: string, parse: (value: unknown) => T): [T, (next: T | ((previous: T) => T)) => void, boolean] {
  const [blocked, setBlocked] = useState(false)
  const [value, setValue] = useState<T>(() => {
    try { return parse(JSON.parse(localStorage.getItem(key) || 'null')) } catch { return parse(null) }
  })
  const update = useCallback((next: T | ((previous: T) => T)) => {
    setValue(previous => {
      const result = typeof next === 'function' ? (next as (p: T) => T)(previous) : next
      return result
    })
  }, [])
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); setBlocked(false) } catch { setBlocked(true) }
  }, [key, value])
  return [value, update, blocked]
}
