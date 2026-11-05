import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { observeAssetTransfers } from './browser/helpers/asset-transfers.ts'

test('M5 passive transfer recorder preserves headers, streamed bytes, HEAD and conditional HTTP caching', async () => {
  const server = createServer((req, res) => {
    const status = req.headers['if-none-match'] === '"test"' ? 304 : 200
    res.writeHead(status, ['ETag', '"test"', 'Cache-Control', 'private, no-cache', 'Content-Length', '6'])
    if (req.method === 'HEAD' || status === 304) { res.end(); return }
    res.write(Buffer.from('abc')); res.end('def')
  })
  let phase = 'cold'
  const records = observeAssetTransfers(server, new Set(['/asset']), () => phase)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = `http://127.0.0.1:${server.address().port}`
  async function get(method, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = request(address + '/asset', { method, headers }, res => {
        const chunks = []
        res.on('data', bytes => chunks.push(bytes))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
        res.on('error', reject)
      })
      req.on('error', reject); req.end()
    })
  }
  try {
    assert.equal((await get('GET')).body, 'abcdef')
    assert.equal((await get('HEAD')).body, '')
    phase = 'warm'
    const warm = await get('GET', { 'if-none-match': '"test"' })
    assert.equal(warm.status, 304); assert.equal(warm.body, '')
    assert.equal(warm.headers.etag, '"test"'); assert.equal(warm.headers['cache-control'], 'private, no-cache')
    assert.deepEqual(records.map(({ phase, method, status, bytes, completed }) => ({ phase, method, status, bytes, completed })), [
      { phase: 'cold', method: 'GET', status: 200, bytes: 6, completed: true },
      { phase: 'cold', method: 'HEAD', status: 200, bytes: 0, completed: true },
      { phase: 'warm', method: 'GET', status: 304, bytes: 0, completed: true },
    ])
    assert.equal(records[2].condition, '"test"')
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('M5 transfer recorder labels interrupted writes as incomplete, without counting HEAD bodies', async () => {
  let responseClosed
  const closed = new Promise(resolve => { responseClosed = resolve })
  const server = createServer((_req, res) => { res.once('close', responseClosed); res.write('partial'); res.flushHeaders() })
  const records = observeAssetTransfers(server, new Set(['/asset']), () => 'interrupted')
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    await new Promise((resolve, reject) => {
      const req = request(`http://127.0.0.1:${server.address().port}/asset`, res => {
        res.once('data', () => res.destroy())
        res.once('close', resolve); res.on('error', () => {})
      })
      req.on('error', reject); req.end()
    })
    // Wait for the actual server close event, not merely client-side completion.
    await closed
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  assert.equal(records.length, 1)
  assert.equal(records[0].completed, false)
  assert.equal(records[0].bytes, 7)
})
