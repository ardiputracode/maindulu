import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { readFile } from 'node:fs/promises'
import { resolve, sep, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { buildNesBatteryFixture } from '../../fixtures/nes-battery.mjs'
import { preparedBiosBlob } from '../../../src/lib/engine-assets'

export const CHUNK_SIZE = 4 * 1024 * 1024
export const ROM_URL = '/spike/assets/battery%20test.nes'
export const BIOS_URL = '/spike/assets/firmware%20test.bin'
export const ZIP_URL = '/spike/assets/battery.zip'
export const BIOS_ZIP_URL = '/spike/assets/firmware.zip'
export type SpikeTransfer = { method: string; url: string; status: number; bytes: number; completed: boolean }

export function syntheticChunk(index: number, size: number): Buffer {
  const bytes = Buffer.allocUnsafe(size)
  for (let n = 0; n < size; n++) bytes[n] = (n * 31 + index * 17 + 7) & 255
  return bytes
}
export function syntheticHash(size: number): string {
  const hash = createHash('sha256')
  for (let offset = 0, index = 0; offset < size; offset += CHUNK_SIZE, index++) hash.update(syntheticChunk(index, Math.min(CHUNK_SIZE, size - offset)))
  return hash.digest('hex')
}

export async function startSpikeServer() {
  const bundle = async (entry: string) => (await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' })).outputFiles[0].text
  const tools = (await build({ stdin: { contents: "export * from './src/lib/engine-assets.ts'; export { sha256 } from '@noble/hashes/sha2.js'; export * from './tests/fixtures/asset-cache-chunks.ts'", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' })).outputFiles[0].text
  const harness = await bundle('tests/fixtures/asset-cache-engine.ts')
  const rom = buildNesBatteryFixture(), bios = Buffer.alloc(512, 0x5a)
  const zipped = async (bytes: Buffer, name: string) => Buffer.from(await (await preparedBiosBlob(new Blob([new Uint8Array(bytes)]), '/spike/assets/' + name)).arrayBuffer())
  const assets = new Map([
    [ROM_URL, rom], [BIOS_URL, bios],
    [ZIP_URL, await zipped(rom, 'inside-game.nes')], [BIOS_ZIP_URL, await zipped(bios, 'firmware%20test.bin')],
    ['/spike/assets/demo.nes', await readFile('public/games/jalan-pulang.nes')],
  ])
  const transfers: SpikeTransfer[] = []
  const server = createServer(async (request, response) => {
    const url = request.url ?? '/'
    let bytes = 0
    const write = response.write, end = response.end
    response.write = function (this: ServerResponse, ...args: Parameters<typeof write>) {
      if (request.method !== 'HEAD' && args[0]) bytes += Buffer.byteLength(args[0])
      return Reflect.apply(write, this, args)
    } as typeof write
    response.end = function (this: ServerResponse, ...args: Parameters<typeof end>) {
      if (request.method !== 'HEAD' && args[0] && typeof args[0] !== 'function') bytes += Buffer.byteLength(args[0])
      return Reflect.apply(end, this, args)
    } as typeof end
    response.once('close', () => { if (url.startsWith('/spike/assets/') || url.startsWith('/spike/large/')) transfers.push({ method: request.method!, url, status: response.statusCode, bytes, completed: response.writableFinished }) })
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    function send(body: string | Buffer, type: string) {
      response.setHeader('Content-Type', type)
      response.setHeader('Content-Length', Buffer.byteLength(body))
      response.end(request.method === 'HEAD' ? undefined : body)
    }
    try {
      if (url === '/spike/host') return send('<!doctype html><html><body><iframe style="width:1200px;height:800px" src="/spike/frame"></iframe><script>window.spikeMessages=[];addEventListener("message",e=>{if(e.origin===location.origin&&e.source===document.querySelector("iframe").contentWindow)spikeMessages.push(e.data)})</script></body></html>', 'text/html')
      if (url === '/spike/frame') return send('<!doctype html><html><head><style>html,body,#game{margin:0;width:100%;height:100%;overflow:hidden}</style></head><body><div id="game"></div><script type="module" src="/spike/harness.js"></script></body></html>', 'text/html')
      if (url === '/spike/blank') return send('<!doctype html><html><body>Isolated M0 cache spike</body></html>', 'text/html')
      if (url === '/spike/tools.js') return send(tools, 'application/javascript')
      if (url === '/spike/harness.js') return send(harness, 'application/javascript')
      if (assets.has(url)) return send(assets.get(url)!, 'application/octet-stream')
      const large = /^\/spike\/large\/(\d+)\.chd$/.exec(url)
      if (large) {
        const size = Number(large[1])
        if (!Number.isSafeInteger(size) || size < 1 || size > 500 * 1024 * 1024) throw new Error('Invalid fixture size')
        response.setHeader('Content-Type', 'application/octet-stream')
        response.setHeader('Content-Length', size)
        if (request.method === 'HEAD') return response.end()
        const stream = Readable.from((async function* () {
          for (let offset = 0, index = 0; offset < size; offset += CHUNK_SIZE, index++) yield syntheticChunk(index, Math.min(CHUNK_SIZE, size - offset))
        })())
        response.once('close', () => stream.destroy())
        stream.on('error', error => response.destroy(error))
        stream.pipe(response)
        return
      }
      if (url.startsWith('/vendor/') || url === '/player/builds.json') {
        const file = resolve('public', '.' + decodeURIComponent(url.split('?')[0]))
        if (!file.startsWith(resolve('public') + sep)) throw new Error('Unsafe fixture path')
        const type = ({ '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream'
        return send(await readFile(file), type)
      }
      response.statusCode = 404; response.end()
    } catch (error) {
      response.statusCode = 500; response.end(String(error))
    }
  })
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', () => { server.off('error', reject); accept() }) })
  const port = (server.address() as { port: number }).port
  return { address: `http://127.0.0.1:${port}`, port, transfers, rom,
    assetHash: (url: string) => createHash('sha256').update(assets.get(url)!).digest('hex'),
    close: () => new Promise<void>((accept, reject) => { server.close(error => error ? reject(error) : accept()); server.closeIdleConnections() }) }
}
