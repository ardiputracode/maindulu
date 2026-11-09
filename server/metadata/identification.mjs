import { Worker } from 'node:worker_threads'
import { computeRomHashes, resolveScreenScraperSystem, ScreenScraperError } from './screenscraper.mjs'
import { readChdSerial } from './rom-converto.mjs'

export const archiveIdentificationLimits = Object.freeze({
  inputBytes: 128 * 1024 * 1024,
  outputBytes: 64 * 1024 * 1024,
  entries: 64,
  ratio: 100,
  pathLength: 240,
  pathDepth: 8,
  timeoutMs: 30_000,
})

export function isIdentifiableZip(consoleId, fileName) {
  const target = resolveScreenScraperSystem(consoleId, fileName)
  return consoleId !== 'psx' && target.reason === 'archive_requires_review' && /\.zip$/i.test(fileName)
}

// Only a plain CHD on the PS1 catalog may use the serial probe. CHD inside an
// archive, other consoles and other disc extensions remain review-only.
export function isIdentifiableChd(consoleId, fileName) {
  if (consoleId !== 'psx' || typeof fileName !== 'string' || !/\.chd$/i.test(fileName)) return false
  const target = resolveScreenScraperSystem(consoleId, fileName)
  return target.systemId === '57' && target.reason === 'format_requires_review'
}

// Only server-produced, asset-bound candidate payloads use this descriptor.
// The provider and the apply API cannot choose an archive member or a system.
export function candidateTarget(consoleId, fileName, identification) {
  if (!isIdentifiableZip(consoleId, fileName)) return resolveScreenScraperSystem(consoleId, fileName)
  if (!identification) return resolveScreenScraperSystem(consoleId, fileName) // Name fallback on an already-known platform.
  if (identification?.kind !== 'zip-member' || identification.version !== 1) return { systemId: null }
  const target = resolveScreenScraperSystem(consoleId, identification.fileName)
  return target.hashLookup ? target : { systemId: null }
}

// The caller owns the safe, already-open storage handle. It must remain open
// until this promise settles, INCLUDING worker exit after abort/timeout.
export async function identifyCatalogRom(file, { consoleId, fileName, size, sha256, signal, timeoutMs = archiveIdentificationLimits.timeoutMs,
  filePath, chdBinary, readSerial = readChdSerial }) {
  signal?.throwIfAborted()
  if (isIdentifiableChd(consoleId, fileName)) {
    if (!filePath) throw new ScreenScraperError('invalid_target')
    const probe = await readSerial({ filePath, signal, timeoutMs, binary: chdBinary })
    return { fileName, hashes: {}, serial: probe.serial, identification: { kind: 'chd-serial', version: 1 } }
  }
  if (!isIdentifiableZip(consoleId, fileName)) {
    if (!resolveScreenScraperSystem(consoleId, fileName).hashLookup) throw new ScreenScraperError('unsupported_format')
    const hashes = await computeRomHashes(file.createReadStream({ autoClose: false, start: 0 }), { size, sha256, signal })
    return { fileName, hashes, identification: { kind: 'raw', version: 1 } }
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > archiveIdentificationLimits.inputBytes) throw new ScreenScraperError('archive_limits')
  const worker = new Worker(new URL('./zip-identification-worker.mjs', import.meta.url), {
    workerData: { fd: file.fd, consoleId, size, sha256 },
    resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 },
  })
  let result, failure, timer
  const fail = code => { failure ??= new ScreenScraperError(code); void worker.terminate() }
  const abort = () => fail('disabled')
  try {
    return await new Promise((resolve, reject) => {
      worker.on('message', message => {
        if (message.error) fail(message.error)
        else result = message.result
      })
      worker.on('error', () => { failure ??= new ScreenScraperError('archive_limits') })
      worker.on('exit', code => {
        if (failure) reject(failure)
        else if (code !== 0 || !result) reject(new ScreenScraperError('archive_invalid'))
        else resolve(result)
      })
      timer = setTimeout(() => fail('identification_timeout'), Math.min(timeoutMs, archiveIdentificationLimits.timeoutMs))
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
