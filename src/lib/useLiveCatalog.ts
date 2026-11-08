import { useRef, useState } from 'react'
import { catalogGame, catalogRequest, loadCatalog } from './catalog.ts'
import type { Game } from './domain'
import { useVisiblePolling } from './useVisiblePolling.ts'

export function refreshSavedMetadata(saved: Game[], fresh: Game[]): Game[] {
  let changed = false
  const byId = new Map(fresh.map(g => [g.id, g]))
  const result = saved.map(game => {
    const next = game.source === 'server' ? byId.get(game.id) : undefined
    if (!next || next.consoleId !== game.consoleId) return game
    const updated = { ...game, title: next.title, description: next.description, cover: next.cover,
      coverRevision: next.coverRevision, metadataStatus: next.metadataStatus, metadataRevision: next.metadataRevision,
      releaseDate: next.releaseDate, releasePrecision: next.releasePrecision, regionLanguage: next.regionLanguage,
      license: next.license, genre: next.genre, developer: next.developer, publisher: next.publisher, players: next.players }
    if (JSON.stringify(updated) === JSON.stringify(game)) return game
    changed = true; return updated
  })
  return changed ? result : saved
}

export function useLiveCatalog(enabled: boolean, onRefresh: (games: Game[]) => void) {
  const [games, setGames] = useState<Game[]>([]), [error, setError] = useState(''), [loaded, setLoaded] = useState(false), [notice, setNotice] = useState('')
  const revision = useRef<number | null>(null)
  const force = useRef(false)
  const refresh = useVisiblePolling(enabled, async signal => {
    try {
      const data = await catalogRequest('/api/catalog/revision', signal)
      const next = data && typeof data === 'object' && 'revision' in data && typeof data.revision === 'number' && Number.isSafeInteger(data.revision) ? data.revision : null
      if (next === null) throw new Error('Revision katalog tidak valid.')
      if (revision.current !== next || force.current) {
        const items = (await loadCatalog('games', '', signal)).map(catalogGame)
        if (signal.aborted) return
        if (revision.current !== null) setNotice('Katalog diperbarui. Judul, cover, atau urutan hasil mungkin berubah.')
        revision.current = next; force.current = false; setGames(items); setLoaded(true); onRefresh(items)
      }
      if (!signal.aborted) setError('')
    } catch (e) { if (!signal.aborted) setError(e instanceof Error ? e.message : 'Pembaruan katalog gagal.'); throw e }
  }, 2500)
  return { games, error, loaded, notice, retry: () => { force.current = true; refresh() } }
}
