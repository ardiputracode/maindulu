// Advisory only: every consumer re-reads committed metadata from IndexedDB.
// No ROM bytes, descriptors or account information cross this channel.
const channelName = 'maindulu-asset-cache-changed'

export function notifyAssetCacheChange(database: string): void {
  if (typeof window === 'undefined') return
  try { window.dispatchEvent(new CustomEvent(channelName, { detail: database })) } catch { /* Optional. */ }
  try {
    const channel = new BroadcastChannel(channelName)
    channel.postMessage(database)
    channel.close()
  } catch { /* HTTP LAN / restricted browser: focus and polling remain available. */ }
}

export function subscribeAssetCacheChanges(database: string, refresh: () => void): () => void {
  const local = (event: Event) => { if ((event as CustomEvent).detail === database) refresh() }
  window.addEventListener(channelName, local)
  let channel: BroadcastChannel | undefined
  try {
    channel = new BroadcastChannel(channelName)
    channel.onmessage = event => { if (event.data === database) refresh() }
  } catch { /* Notifications are never required for database correctness. */ }
  return () => { window.removeEventListener(channelName, local); channel?.close() }
}
