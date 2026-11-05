// Test-only controls for the REAL application cache, never shipped in public/.
import { openAssetCache } from '../../src/lib/asset-cache.ts'
import { DEFAULT_ASSET_BUDGET } from '../../src/lib/asset-cache-policy.ts'
export async function setCache(enabled: boolean, budget = DEFAULT_ASSET_BUDGET) {
  const cache = await openAssetCache()
  try { await cache.setSettings({ enabled, budget }) } finally { cache.close() }
}
export async function stats() {
  const cache = await openAssetCache()
  try { return await cache.stats() } finally { cache.close() }
}
