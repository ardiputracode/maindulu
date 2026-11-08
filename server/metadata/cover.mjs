import https from 'node:https'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { screenScraperLimits, screenScraperPreferences } from './screenscraper-policy.mjs'
import { SCREENSCRAPER_BASE_URL, SCREENSCRAPER_ENDPOINTS } from './screenscraper.mjs'

const host = 'api.screenscraper.fr'
const id = /^[1-9][0-9]{0,19}$/
const mimeFormats = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' }

export class CoverError extends Error {
  constructor(code, httpStatus = null, retryAfterMs = 0) { super(code); this.name = 'CoverError'; this.code = code; this.httpStatus = httpStatus; this.retryAfterMs = retryAfterMs }
}

// Use IPv4 only: no IPv6 (including IPv4-mapped) destination can be connected.
// Deny all non-global IPv4 ranges; in particular never connect to RFC1918,
// loopback, carrier NAT, documentation, link-local or multicast addresses.
export function publicMediaAddress(address) {
  if (isIP(address) !== 4) return false
  const [a, b, c] = address.split('.').map(Number)
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
    || a === 100 && b >= 64 && b <= 127 || a === 172 && b >= 16 && b <= 31
    || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99)
    || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
    || a === 203 && b === 0 && c === 113)
}

export function selectScreenScraperCover(candidate) {
  const media = candidate?.metadata?.media
  if (!Array.isArray(media) || media.length > screenScraperLimits.maxMediaEntries) return null
  for (const region of screenScraperPreferences.regions) {
    const matches = media.filter(item => item && item.type === 'box-2D' && item.region === region)
    if (matches.length > 1) return null
    if (matches.length === 1) return region
  }
  return null
}

// No media URL from provider, browser, or candidate is ever accepted. DNS is
// resolved once, checked, then pinned to the *actual* TLS socket via lookup.
export async function downloadScreenScraperCover(config, { gameId, systemId, region, signal }, deps = {}) {
  const controller = new AbortController()
  let rejectAbort
  const cancelled = new Promise((_, reject) => { rejectAbort = reject })
  const cancel = () => { controller.abort(); rejectAbort(new CoverError('COVER_CANCELLED')) }
  const timer = setTimeout(() => { controller.abort(); rejectAbort(new CoverError('COVER_TIMEOUT')) }, deps.timeoutMs ?? screenScraperLimits.requestTimeoutMs)
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  try { return await Promise.race([downloadCover(config, { gameId, systemId, region, signal: controller.signal }, deps), cancelled]) }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
}

async function downloadCover(config, { gameId, systemId, region, signal }, deps) {
  if (!id.test(gameId) || !id.test(systemId) || !screenScraperPreferences.regions.includes(region)) throw new CoverError('COVER_TARGET')
  if (signal?.aborted) throw new CoverError('COVER_CANCELLED')
  const url = new URL(`${SCREENSCRAPER_BASE_URL}/${SCREENSCRAPER_ENDPOINTS.media}`)
  for (const [key, value] of Object.entries({ devid: config.devId, devpassword: config.devPassword, softname: config.softname,
    ssid: config.user, sspassword: config.password, systemeid: systemId, jeuid: gameId, media: `box-2D(${region})` })) {
    url.searchParams.set(key, value)
  }
  const resolve = deps.lookup || dnsLookup
  let addresses
  try { addresses = await resolve(host, { family: 4, all: true }) }
  catch { throw new CoverError('COVER_DNS') }
  if (signal?.aborted) throw new CoverError('COVER_CANCELLED')
  // Fail closed when DNS contains a private answer, even if the first is public.
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(entry => !publicMediaAddress(entry.address))) throw new CoverError('COVER_DNS')
  const address = addresses[0].address
  const request = deps.request || https.request
  return new Promise((resolvePromise, reject) => {
    let settled = false, response
    const timeout = setTimeout(() => abort('COVER_TIMEOUT'), screenScraperLimits.requestTimeoutMs)
    const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort', onAbort) }
    const finish = (error, value) => {
      if (settled) return
      settled = true; cleanup()
      if (error) reject(error); else resolvePromise(value)
    }
    const onAbort = () => abort('COVER_CANCELLED')
    function abort(code) {
      response?.destroy()
      req?.destroy()
      finish(new CoverError(code))
    }
    let req
    try {
      req = request(url, { method: 'GET', agent: false, family: 4, autoSelectFamily: false, timeout: screenScraperLimits.requestTimeoutMs,
        headers: { Accept: 'image/png, image/jpeg, image/webp', 'Accept-Encoding': 'identity' },
        lookup: (_hostname, _options, callback) => callback(null, address, 4) }, res => {
        response = res
        if (signal?.aborted) return abort('COVER_CANCELLED')
        if (res.statusCode === 404) { res.destroy(); return finish(null, null) }
        if (res.statusCode !== 200) {
          const retry = res.headers['retry-after']
          const ms = typeof retry === 'string' && /^\d+$/.test(retry) ? Number(retry) * 1000 : typeof retry === 'string' ? Date.parse(retry) - Date.now() : 0
          res.destroy(); return finish(new CoverError('COVER_HTTP', res.statusCode, Math.max(0, Math.min(ms || 0, 7 * 86400000))))
        }
        const type = res.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
        if (!Object.hasOwn(mimeFormats, type) || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
          res.destroy(); return finish(new CoverError('COVER_TYPE'))
        }
        const chunks = []; let length = 0
        res.on('data', chunk => {
          length += chunk.length
          if (length > screenScraperLimits.coverBytes) return abort('COVER_SIZE')
          chunks.push(chunk)
        })
        res.on('end', () => finish(null, { bytes: Buffer.concat(chunks), type }))
        res.on('error', () => finish(new CoverError('COVER_TRANSPORT')))
      })
      req.on('error', () => finish(new CoverError('COVER_TRANSPORT')))
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) abort('COVER_CANCELLED')
      else req.end()
    } catch { finish(new CoverError('COVER_TRANSPORT')) }
  })
}
