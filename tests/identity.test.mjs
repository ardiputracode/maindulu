import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createSessionId, hashRom } from '../src/lib/identity.ts'

test('fallback SHA-256 matches standard empty and abc vectors without Web Crypto', async () => {
  assert.equal(await hashRom(new Blob([]), {}), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(await hashRom(new Blob(['abc']), {}), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('native and fallback hashing preserve the existing ROM identity', async () => {
  const rom = await readFile(new URL('../public/games/jalan-pulang.nes', import.meta.url))
  const expected = createHash('sha256').update(rom).digest('hex')
  assert.equal(await hashRom(new Blob([rom]), webcrypto), expected)
  assert.equal(await hashRom(new Blob([rom]), {}), expected)
})

test('fallback reads large ROMs in bounded chunks, not one full-file buffer', async () => {
  const data = Buffer.alloc(2 * 1024 * 1024 + 73, 0xa9)
  const file = new Blob([data])
  file.arrayBuffer = () => { throw new Error('Whole-file allocation is not allowed in the fallback') }
  assert.equal(await hashRom(file, {}), createHash('sha256').update(data).digest('hex'))
})

test('hashing recovers when an exposed Web Crypto digest rejects', async () => {
  const provider = { subtle: { digest: async () => { throw new Error('API unavailable') } } }
  assert.equal(await hashRom(new Blob(['abc']), provider), await hashRom(new Blob(['abc']), {}))
})

test('fallback propagates file-read errors instead of assigning an incorrect identity', async () => {
  const file = { size: 3, slice: () => ({ arrayBuffer: async () => { throw new Error('File cannot be read') } }) }
  await assert.rejects(hashRom(file, {}), /File cannot be read/)
})

test('session IDs use native randomUUID when available', () => {
  assert.equal(createSessionId({ randomUUID: () => 'native-session-id' }), 'native-session-id')
})

test('HTTP fallback generates distinct RFC 4122 version 4 IDs with secure randomness', () => {
  const provider = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }
  const ids = Array.from({ length: 100 }, () => createSessionId(provider))
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('session ID generation recovers when randomUUID rejects', () => {
  const id = createSessionId({ randomUUID: () => { throw new Error('Not allowed') }, getRandomValues: webcrypto.getRandomValues.bind(webcrypto) })
  assert.match(id, /^[0-9a-f-]{36}$/)
})

test('missing secure randomness produces an explicit browser-support error', () => {
  assert.throws(() => createSessionId({}), /generator ID sesi yang aman/)
})
