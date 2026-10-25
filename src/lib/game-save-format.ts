// Shared bounded envelope. Keys are logical save components, never filesystem paths.
export const MAX_GAME_SAVE_BYTES = 8 * 1024 * 1024
export type GameSaveLayout = 'nes-sram-v1' | 'ps1-active-memcard-v1'
export type GameSaveBundle = { layout: GameSaveLayout; files: { key: 'sram'; bytes: Uint8Array }[] }
const magic = new TextEncoder().encode('MDGSAVE1')
export function gameSaveLayout(core: string): GameSaveLayout | null {
  return core === 'fceumm' ? 'nes-sram-v1' : core === 'pcsx_rearmed' ? 'ps1-active-memcard-v1' : null
}
export function encodeGameSave(bundle: GameSaveBundle): Uint8Array {
  if (!['nes-sram-v1', 'ps1-active-memcard-v1'].includes(bundle.layout) || bundle.files.length !== 1 || bundle.files[0].key !== 'sram' || !(bundle.files[0].bytes instanceof Uint8Array) || !bundle.files[0].bytes.length) throw new Error('Komponen progres tidak valid.')
  const header = new TextEncoder().encode(JSON.stringify({ formatVersion: 1, layout: bundle.layout, files: bundle.files.map(f => ({ key: f.key, size: f.bytes.length })) }))
  const length = 12 + header.length + bundle.files[0].bytes.length
  if (length > MAX_GAME_SAVE_BYTES) throw new Error('Paket progres melebihi 8 MiB.')
  const bytes = new Uint8Array(length)
  bytes.set(magic); new DataView(bytes.buffer).setUint32(8, header.length, true)
  bytes.set(header, 12); bytes.set(bundle.files[0].bytes, 12 + header.length)
  return bytes
}
export function decodeGameSave(bytes: Uint8Array): GameSaveBundle {
  if (!(bytes instanceof Uint8Array) || bytes.length < 13 || bytes.length > MAX_GAME_SAVE_BYTES || !magic.every((b, i) => bytes[i] === b)) throw new Error('Format paket progres tidak valid.')
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true)
  if (length < 1 || length > 4096 || 12 + length >= bytes.length) throw new Error('Header progres tidak valid.')
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(12, 12 + length)))
  if (!value || value.formatVersion !== 1 || !['nes-sram-v1', 'ps1-active-memcard-v1'].includes(value.layout) || !Array.isArray(value.files) || value.files.length !== 1 || value.files[0]?.key !== 'sram' || !Number.isSafeInteger(value.files[0].size) || value.files[0].size < 1 || value.files[0].size !== bytes.length - 12 - length) throw new Error('Manifest progres tidak valid.')
  return { layout: value.layout, files: [{ key: 'sram', bytes: bytes.slice(12 + length) }] }
}
