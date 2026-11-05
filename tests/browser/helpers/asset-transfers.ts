import type { Server, OutgoingHttpHeaders } from 'node:http'

export type AssetTransfer = {
  phase: string; url: string; method: string; condition?: string; status: number;
  bytes: number; etag?: string | number | string[]; cache?: string | number | string[];
  completed: boolean;
}

// Observe outgoing Node writes without routing requests, transforming streams,
// or changing headers/backpressure. HEAD/304 never carry an asset body.
export function observeAssetTransfers(server: Server, watched: Set<string>, phase: () => string) {
  const transfers: AssetTransfer[] = []
  server.prependListener('request', (request, response) => {
    if (!watched.has(request.url!)) return
    const requestPhase = phase()
    let bytes = 0, recorded = false
    let sentHeaders: OutgoingHttpHeaders = {}
    function count(chunk: unknown, encoding: unknown) {
      if (request.method === 'HEAD' || response.statusCode === 304) return
      if (typeof chunk === 'string') bytes += Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : undefined)
      else if (chunk instanceof Uint8Array) bytes += chunk.byteLength
    }
    const write = response.write, end = response.end, writeHead = response.writeHead
    response.writeHead = function (...args: unknown[]) {
      sentHeaders = { ...this.getHeaders() }
      const headers = typeof args[1] === 'string' ? args[2] : args[1]
      if (Array.isArray(headers)) {
        for (let i = 0; i < headers.length; i += 2) sentHeaders[String(headers[i]).toLowerCase()] = headers[i + 1]
      } else if (headers && typeof headers === 'object') {
        for (const [name, value] of Object.entries(headers)) sentHeaders[name.toLowerCase()] = value
      }
      return Reflect.apply(writeHead, this, args)
    }
    response.write = function (...args: unknown[]) { count(args[0], args[1]); return Reflect.apply(write, this, args) }
    response.end = function (...args: unknown[]) { count(args[0], args[1]); return Reflect.apply(end, this, args) }
    function record(completed: boolean) {
      if (recorded) return
      recorded = true
      transfers.push({ phase: requestPhase, url: request.url!, method: request.method!, condition: request.headers['if-none-match'],
        status: response.statusCode, bytes, etag: sentHeaders.etag, cache: sentHeaders['cache-control'], completed })
    }
    response.once('finish', () => record(true))
    response.once('close', () => record(response.writableFinished))
  })
  return transfers
}
