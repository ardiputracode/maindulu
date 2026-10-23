export type ConsoleInfo = {
  id: string; name: string; shortName: string; maker: string; year: string;
  core: string; extensions: string[]; bios: 'none' | 'optional' | 'required';
  biosHint: string; color: string; family: string;
}

export type Game = {
  id: string; title: string; consoleId: string; source: 'server' | 'local';
  fileName?: string; url?: string; cover?: string; description?: string;
  license?: string; lastPlayed?: number;
}

export type Bios = { id: string; name: string; consoleId: string; url: string }
export type Settings = { volume: number; history: boolean; widescreen: boolean }
export const DEFAULT_SETTINGS: Settings = { volume: 50, history: true, widescreen: false }
export const MAX_ROM_SIZE = 768 * 1024 * 1024
export const MAX_BIOS_SIZE = 32 * 1024 * 1024
export const ARCHIVE_EXTENSIONS = ['zip', '7z', 'rar']
export const STORAGE_KEYS = { settings: 'maindulu.settings.v1', favorites: 'maindulu.favorites.v1', history: 'maindulu.history.v1' }

export function extension(name: string): string {
  return name.toLowerCase().split('.').pop() || ''
}

export function detectConsole(name: string, consoles: ConsoleInfo[]): string {
  const matches = consoles.filter(c => c.extensions.includes(extension(name)))
  return matches.length === 1 ? matches[0].id : ''
}

export function validateRom(file: { name: string; size: number }, consoleInfo: ConsoleInfo): string | null {
  if (!file.size) return 'File ROM kosong. Pilih file yang lain.'
  if (file.size > MAX_ROM_SIZE) return 'ROM terlalu besar. Batas saat ini 768 MB.'
  const ext = extension(file.name)
  if (!consoleInfo.extensions.includes(ext) && !ARCHIVE_EXTENSIONS.includes(ext)) {
    return `Format .${ext} tidak cocok dengan ${consoleInfo.name}. Gunakan ${consoleInfo.extensions.map(e => '.' + e).join(', ')} atau arsip ZIP/7z/RAR.`
  }
  return null
}

export function validateBios(file: { name: string; size: number }): string | null {
  if (!file.size) return 'File BIOS kosong.'
  if (file.size > MAX_BIOS_SIZE) return 'BIOS terlalu besar. Batas saat ini 32 MB.'
  if (!['bin', 'rom', 'bios', 'img', 'zip', '7z', 'rar'].includes(extension(file.name))) return 'Gunakan BIOS .bin, .rom, .bios, .img atau arsip ZIP/7z/RAR.'
  return null
}

export function readSettings(value: unknown): Settings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_SETTINGS }
  const s = value as Record<string, unknown>
  return {
    volume: typeof s.volume === 'number' && Number.isFinite(s.volume) ? Math.max(0, Math.min(100, s.volume)) : 50,
    history: typeof s.history === 'boolean' ? s.history : true,
    widescreen: s.widescreen === true,
  }
}

export function isSafeLocalUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !/[\u0000-\u0020]/.test(value)
}

export function readGames(value: unknown): Game[] {
  if (!Array.isArray(value)) return []
  return value.filter((g): g is Game => !!g && typeof g === 'object' &&
    typeof g.id === 'string' && g.id.length < 160 && typeof g.title === 'string' && g.title.length < 200 &&
    typeof g.consoleId === 'string' && (g.source === 'local' || (g.source === 'server' && isSafeLocalUrl(g.url))) &&
    (g.lastPlayed === undefined || (typeof g.lastPlayed === 'number' && Number.isFinite(g.lastPlayed))) &&
    (g.cover === undefined || isSafeLocalUrl(g.cover))).slice(0, 100)
}

export function recordHistory(history: Game[], game: Game, enabled: boolean, now = Date.now()): Game[] {
  if (!enabled) return history
  return [{ ...game, lastPlayed: now }, ...history.filter(g => g.id !== game.id)].slice(0, 50)
}

export function toggleFavorite(favorites: Game[], game: Game): Game[] {
  return favorites.some(g => g.id === game.id) ? favorites.filter(g => g.id !== game.id) : [game, ...favorites].slice(0, 100)
}

export function relativeTime(timestamp?: number): string {
  if (!timestamp) return 'Belum dimainkan'
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000))
  if (minutes < 1) return 'Baru saja'
  if (minutes < 60) return `${minutes} menit lalu`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} jam lalu`
  return new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short' }).format(timestamp)
}
