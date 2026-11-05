import { openAssetCache } from './asset-cache.ts'
import { createServerAssetResolver } from './server-assets.ts'
import type { AssetPreparationProgress, PreparedServerAsset } from './server-assets.ts'
import { preparedRomFile } from './engine-assets.ts'
import { validatePreparedAssets } from './player-bridge-assets.ts'
import type { PreparedAssetPayload } from './player-bridge-assets.ts'
import type { AssetDescriptor } from './asset-cache-policy.ts'
import { cacheStorageError } from './asset-cache-policy.ts'
import type { Game } from './domain.ts'
import { ASSET_CACHE_DISABLED, ASSET_CACHE_DISABLED_NOTICE } from './asset-cache-rollout.ts'

// One resolver per tab. Subscriber signals own tasks, not this shared instance;
// StrictMode cleanup must never close a resolver used by the next mount.
const resolver = createServerAssetResolver()

export async function preparePlayerAssets(session: {
  game: Game; consoleInfo: { id: string }; rom?: File; bios?: File;
  biosUrl?: string; biosSha256?: string; serverRom?: AssetDescriptor; serverBios?: AssetDescriptor;
}, signal: AbortSignal, onProgress: (value: AssetPreparationProgress) => void) {
  const result: { preparedRom?: PreparedAssetPayload; preparedBios?: PreparedAssetPayload;
    cacheNotice?: string; outcomes: Pick<PreparedServerAsset, 'descriptor' | 'source' | 'persistence' | 'warnings'>[] } = { outcomes: [] }
  signal.throwIfAborted()
  if (!session.serverRom && !session.serverBios) return result
  if (ASSET_CACHE_DISABLED) { result.cacheNotice = ASSET_CACHE_DISABLED_NOTICE; return result }
  // Default cache now enabled for new databases (M6 rollout).
  // Legacy databases keep their user preference (enabled: false).
  let enabled = false
  let cache: Awaited<ReturnType<typeof openAssetCache>> | undefined
  try { cache = await openAssetCache(); enabled = (await cache.settings(signal)).enabled }
  catch (error) {
    signal.throwIfAborted()
    result.cacheNotice = `${cacheStorageError(error).message} ROM/BIOS dimuat melalui jalur biasa tanpa cache perangkat.`
  }
  finally { cache?.close() }
  signal.throwIfAborted()
  if (!enabled) return result
  for (const descriptor of [session.serverRom, session.serverBios]) {
    if (!descriptor) continue
    const prepared = await resolver.resolve(descriptor, { signal, onProgress })
    signal.throwIfAborted()
    const payload = { descriptor: prepared.descriptor, file: preparedRomFile(prepared.blob, prepared.descriptor.url) }
    if (descriptor.kind === 'rom') result.preparedRom = payload
    else result.preparedBios = payload
    result.outcomes.push({ descriptor: prepared.descriptor, source: prepared.source, persistence: prepared.persistence, warnings: prepared.warnings })
  }
  validatePreparedAssets({ ...session, consoleId: session.consoleInfo.id, ...result })
  return result
}
