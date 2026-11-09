// Folder Name column, RomM 5.4.0 supported-platforms (not IGDB URL slugs).
// https://docs.romm.app/5.4.0/platforms/supported-platforms/#platform-slugs-coverage
export const platformSlugs = Object.freeze(['nes', 'snes', 'gb', 'gbc', 'gba', 'genesis', 'psx'])
const consoles = Object.freeze({ nes: 'nes', snes: 'snes', gb: 'gb', gba: 'gba', megadrive: 'genesis', psx: 'psx' })
export const platformConsole = slug => slug === 'gbc' ? 'gb' : Object.keys(consoles).find(id => consoles[id] === slug)

export function safeStorageName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 240 && Buffer.byteLength(name, 'utf8') <= 255
    && name === name.trim() && !/[/\\:*?"<>|\x00-\x1f\x7f\u2028\u2029]/.test(name)
    && !/[. ]$/.test(name) && name !== '.' && name !== '..'
    && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)
}

export function storagePlatform(consoleId, name, kind = 'games') {
  if (!Object.hasOwn(consoles, consoleId) || !safeStorageName(name)) throw new Error('Platform atau nama berkas storage tidak valid.')
  return consoleId === 'gb' && kind === 'games' && /\.gbc$/i.test(name) ? 'gbc' : consoles[consoleId]
}

// Conservative portable collision policy, independent of host case sensitivity.
export const storageNameIdentity = name => name.normalize('NFC').toLowerCase()
