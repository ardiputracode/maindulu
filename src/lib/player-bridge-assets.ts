import { readAssetDescriptor } from './asset-cache-policy.ts'
import type { AssetDescriptor } from './asset-cache-policy.ts'
import { engineAssetFileName } from './engine-assets.ts'
export { engineRomInput, preparedBiosBlob } from './engine-assets.ts'

export type PreparedAssetPayload = { descriptor: AssetDescriptor; file: File }

// Shared by host and iframe. Only backend assets for this exact session may use
// the native adapter; local files, engine/core requests and saves never do.
export function validatePreparedAssets(config: {
  game: { id: string; source?: string; url?: string; sha256?: string; size?: number; consoleId?: string };
  consoleId?: string; rom?: unknown; bios?: unknown; biosUrl?: string; biosSha256?: string;
  preparedRom?: PreparedAssetPayload; preparedBios?: PreparedAssetPayload;
}): void {
  for (const kind of ['rom', 'bios'] as const) {
    const value = kind === 'rom' ? config.preparedRom : config.preparedBios
    if (value === undefined) continue
    const descriptor = readAssetDescriptor(value?.descriptor)
    if (!descriptor || descriptor.kind !== kind || descriptor.consoleId !== config.consoleId ||
      !(value.file instanceof File) || value.file.size !== descriptor.size || value.file.name !== engineAssetFileName(descriptor.url)) {
      throw new Error('Payload aset player tidak valid atau tidak cocok dengan sesi.')
    }
    if (kind === 'rom' ? config.rom !== undefined || config.game.source !== 'server' ||
      descriptor.catalogId !== config.game.id || descriptor.url !== config.game.url || descriptor.sha256 !== config.game.sha256 ||
      descriptor.size !== config.game.size || descriptor.consoleId !== config.game.consoleId
      : config.bios !== undefined || descriptor.url !== config.biosUrl || descriptor.sha256 !== config.biosSha256) {
      throw new Error('Descriptor aset player berbeda dari sumber sesi.')
    }
  }
}
