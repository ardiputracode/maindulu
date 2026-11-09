import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSerial } from './screenscraper-policy.mjs'
import { ScreenScraperError } from './screenscraper.mjs'

export const ROM_CONVERTO_VERSION = '0.24.0'
export const ROM_CONVERTO_LIMITS = Object.freeze({
  defaultTimeoutMs: 30_000,
  minTimeoutMs: 5_000,
  maxTimeoutMs: 120_000,
  maxOutputBytes: 2 * 1024 * 1024,
})

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const executableName = platform => platform === 'win32' ? 'rom-converto.exe' : 'rom-converto'

// Alpine ships musl; the glibc asset is not a safe fallback there, so prefer the
// musl vendor directory when both happen to exist.
function vendorDirectories(platform, arch) {
  const directory = `${platform}-${arch}`
  if (platform === 'linux' && arch === 'x64') return ['linux-x64-musl', 'linux-x64']
  if (platform === 'linux' && arch === 'arm') return ['linux-arm7']
  return [directory]
}

function pathCandidates(env, platform) {
  const name = executableName(platform)
  const result = []
  for (const directory of String(env?.PATH ?? '').split(delimiter)) {
    if (directory) result.push(join(directory, name))
  }
  return result
}

// Resolution order is deliberate: explicit operator override, then the pinned
// vendor layout, then PATH. The client never supplies any part of this path.
export function resolveRomConvertoBinary({ env = process.env, root = projectRoot, platform = process.platform,
  arch = process.arch, exists = existsSync } = {}) {
  const override = typeof env?.MAIN_DULU_ROM_CONVERTO_PATH === 'string' ? env.MAIN_DULU_ROM_CONVERTO_PATH.trim() : ''
  if (override) {
    if (!isAbsolute(override)) throw new Error('MAIN_DULU_ROM_CONVERTO_PATH harus path absolut.')
    return exists(override) ? override : null
  }
  for (const directory of vendorDirectories(platform, arch)) {
    const candidate = join(root, 'vendor', 'rom-converto', directory, executableName(platform))
    if (exists(candidate)) return candidate
  }
  for (const candidate of pathCandidates(env, platform)) if (exists(candidate)) return candidate
  return null
}

function childEnvironment({ env = process.env, platform = process.platform } = {}) {
  const allowed = platform === 'win32' ? ['PATH', 'SystemRoot', 'TEMP', 'TMP'] : ['PATH', 'HOME']
  const result = {}
  const entries = Object.entries(env ?? {})
  for (const key of allowed) {
    const match = entries.find(([name]) => platform === 'win32' ? name.toLowerCase() === key.toLowerCase() : name === key)
    if (typeof match?.[1] === 'string') result[key] = match[1]
  }
  return result
}

function outputBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  return Buffer.alloc(0)
}

function decodeOutput(value) {
  const bytes = outputBuffer(value)
  if (bytes.byteLength > ROM_CONVERTO_LIMITS.maxOutputBytes) throw new ScreenScraperError('chd_invalid')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new ScreenScraperError('chd_invalid') }
}

function runProcess(binary, args, { timeoutMs, signal, env, platform, execFileImpl = execFile, maxBytes = ROM_CONVERTO_LIMITS.maxOutputBytes }) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new ScreenScraperError('disabled'))
    let child, settled = false
    const finish = (error, stdout) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      if (error) {
        if (signal?.aborted) return reject(new ScreenScraperError('disabled'))
        if (error.killed || error.signal === 'SIGKILL' || error.code === 'ETIMEDOUT') return reject(new ScreenScraperError('identification_timeout'))
        if (error.code === 'ENOENT' || error.code === 'EACCES') return reject(new ScreenScraperError('chd_tool_unavailable'))
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new ScreenScraperError('chd_invalid'))
        return reject(new ScreenScraperError('chd_invalid'))
      }
      try {
        if (outputBuffer(stdout).byteLength > maxBytes) throw new ScreenScraperError('chd_invalid')
        return resolvePromise(stdout)
      } catch (failure) { reject(failure) }
    }
    const abort = () => {
      if (settled) return
      try { child?.kill('SIGKILL') } catch { /* already gone */ }
      settled = true
      signal?.removeEventListener('abort', abort)
      reject(new ScreenScraperError('disabled'))
    }
    try {
      child = execFileImpl(binary, args, {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: maxBytes,
        killSignal: 'SIGKILL',
        encoding: 'buffer',
        env: childEnvironment({ env, platform }),
      }, (error, stdout) => finish(error, stdout))
    } catch {
      settled = true
      signal?.removeEventListener('abort', abort)
      return reject(new ScreenScraperError('chd_tool_unavailable'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

const probeCache = new Map()

export async function probeRomConverto(binary, options = {}) {
  if (!binary) throw new ScreenScraperError('chd_tool_unavailable')
  if (probeCache.has(binary)) return probeCache.get(binary)
  const output = await runProcess(binary, ['--version'], {
    timeoutMs: Math.min(options.timeoutMs ?? ROM_CONVERTO_LIMITS.minTimeoutMs, ROM_CONVERTO_LIMITS.minTimeoutMs),
    signal: options.signal,
    env: options.env,
    platform: options.platform,
    execFileImpl: options.execFileImpl,
    maxBytes: 64 * 1024,
  })
  const version = decodeOutput(output).trim().split(/\r?\n/, 1)[0].slice(0, 128)
  probeCache.set(binary, version)
  return version
}

function serialFromInfo(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ScreenScraperError('chd_invalid')
  const content = json.content && typeof json.content === 'object' && !Array.isArray(json.content) ? json.content : null
  const disc = json.disc && typeof json.disc === 'object' && !Array.isArray(json.disc) ? json.disc : null
  const metadata = json.metadata && typeof json.metadata === 'object' && !Array.isArray(json.metadata) ? json.metadata : null
  // `content.title_id` is the field emitted by rom-converto 0.24.0 for PS1
  // images; the other paths are documented/defensive fallbacks.
  const raw = [json.serial, disc?.serial, metadata?.serial, content?.title_id, content?.serial]
    .filter(value => typeof value === 'string' && value.trim())
  if (!raw.length) throw new ScreenScraperError('chd_serial_missing')
  let serial = null
  for (const value of raw) { serial = normalizeSerial(value); if (serial) break }
  if (!serial) throw new ScreenScraperError('chd_invalid')
  const text = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null
  return { serial, title: text(content?.title ?? json.title), console: text(content?.console ?? json.console) }
}

export async function readChdSerial({ filePath, signal, timeoutMs, binary, env = process.env, platform = process.platform,
  root = projectRoot, execFileImpl = execFile } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new ScreenScraperError('invalid_target')
  if (signal?.aborted) throw new ScreenScraperError('disabled')
  const resolved = binary || resolveRomConvertoBinary({ env, root, platform })
  if (!resolved) throw new ScreenScraperError('chd_tool_unavailable')
  const bounded = Number.isSafeInteger(timeoutMs)
    ? Math.min(ROM_CONVERTO_LIMITS.maxTimeoutMs, Math.max(ROM_CONVERTO_LIMITS.minTimeoutMs, timeoutMs))
    : ROM_CONVERTO_LIMITS.defaultTimeoutMs
  const output = await runProcess(resolved, ['info', filePath, '--json'], {
    timeoutMs: bounded,
    signal,
    env,
    platform,
    execFileImpl,
  })
  let json
  try { json = JSON.parse(decodeOutput(output)) }
  catch (error) { throw error instanceof ScreenScraperError ? error : new ScreenScraperError('chd_invalid') }
  return Object.freeze(serialFromInfo(json))
}

export const __test = Object.freeze({ serialFromInfo, childEnvironment })
