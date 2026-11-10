import test from 'node:test'
import assert from 'node:assert/strict'
import { gateRequest } from '../src/lib/gate.ts'

test('gate client sends only same-origin, no-store requests and validates sessions before opening Workspace', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  let result = { authenticated: true, expiresAt: 2000000000 }
  const calls = []
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return Response.json(result) }
  const credentials = { username: 'door_user', password: 'Private-123!' }
  assert.deepEqual(await gateRequest('login', credentials), result)
  assert.equal(calls[0].url, '/api/gate/login')
  assert.deepEqual(calls[0].options, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: undefined, headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials) })
  await gateRequest('session')
  assert.equal(calls[1].options.method, 'GET')
  assert.equal(calls[1].options.body, undefined)
  result = { authenticated: false }
  assert.deepEqual(await gateRequest('logout'), result)
  assert.equal(calls[2].options.body, '{}')
  for (const invalid of [null, {}, '<html>fallback</html>', { authenticated: 'true' }, { authenticated: true }, { authenticated: true, expiresAt: '2000000000' }, { authenticated: true, expiresAt: -1 }]) {
    result = invalid
    await assert.rejects(gateRequest('session'))
  }
})

test('gate client uses calm bounded errors instead of echoing response bodies or secrets', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  for (const [status, message] of [[401, 'Username atau password belum cocok'], [429, 'Terlalu banyak percobaan'], [403, 'Pintu masuk belum bisa dibuka'], [503, 'Pintu masuk belum bisa dibuka']]) {
    globalThis.fetch = async () => Response.json({ error: 'PRIVATE-TOKEN' }, { status })
    await assert.rejects(gateRequest('login', { username: 'door', password: 'Private-123!' }), error => error.message.includes(message) && !error.message.includes('PRIVATE-TOKEN'))
  }
  globalThis.fetch = async () => { throw new TypeError('PRIVATE-NETWORK-ERROR') }
  await assert.rejects(gateRequest('login'), /Pintu masuk belum bisa dibuka/)
  globalThis.fetch = async () => new Response('<html>PRIVATE-RESPONSE</html>')
  await assert.rejects(gateRequest('session'), /Pintu masuk belum bisa diperiksa/)
})
