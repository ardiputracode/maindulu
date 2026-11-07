import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  ScreenScraperClient,
  createScreenScraperClient,
  readScreenScraperConfig,
  computeRomHashes,
  cleanRomName,
  resolveScreenScraperSystem,
  classifyHttpStatus,
} from '../server/metadata/screenscraper.mjs'

test('M2 config defaults to disabled and reports missing credentials when enabled', () => {
  const disabled = readScreenScraperConfig({})
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.configured, true)
  const enabled = readScreenScraperConfig({ MAIN_DULU_SCREENSCRAPER_ENABLED: 'true' })
  assert.equal(enabled.enabled, true)
  assert.equal(enabled.configured, false)
  assert.ok(enabled.missing.includes('MAIN_DULU_SCREENSCRAPER_DEV_ID'))
})

test('M2 client does not call provider when disabled', async () => {
  let called = false
  const client = new ScreenScraperClient(readScreenScraperConfig({}), { fetch: async () => { called = true; return new Response('{}') } })
  assert.equal(client.isEnabled(), false)
  await assert.rejects(() => client.searchByHash({ consoleId: 'gb', fileName: 'a.gb', size: 3, md5: 'x', sha1: 'y' }), /nonaktif/i)
  assert.equal(called, false)
})

test('M2 hash search normalizes response and redacts errors', async () => {
  const md5 = createHash('md5').update('abc').digest('hex')
  const sha1 = createHash('sha1').update('abc').digest('hex')
  const fetchImpl = async (url) => {
    assert.match(String(url), /jeuInfos\.php/)
    assert.match(String(url), /rommd5=/)
    return new Response(JSON.stringify({ response: { jeu: { id: '1', systeme: { id: '9' }, notgame: 'false', rom: { id: '2', romsize: '3', rommd5: md5, romsha1: sha1, romtotalsupport: '1' }, noms: [{ texte: 'T' }] } } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const config = readScreenScraperConfig({ MAIN_DULU_SCREENSCRAPER_ENABLED: 'true', MAIN_DULU_SCREENSCRAPER_DEV_ID: 'd', MAIN_DULU_SCREENSCRAPER_DEV_PASSWORD: 'dp', MAIN_DULU_SCREENSCRAPER_USER: 'u', MAIN_DULU_SCREENSCRAPER_PASSWORD: 'p' })
  const client = createScreenScraperClient(config, { fetch: fetchImpl })
  const result = await client.searchByHash({ consoleId: 'gb', fileName: 'a.gb', size: 3, md5, sha1 })
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].metadata.title, 'T')
})

test('M2 classifies HTTP statuses including 430', () => {
  assert.equal(classifyHttpStatus(430), 'quota_exhausted')
  assert.equal(classifyHttpStatus(404), 'not_found')
  assert.equal(classifyHttpStatus(429), 'rate_limited')
})

test('M2 computes md5 and sha1 streaming and verifies sha256', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm2-'))
  try {
    const file = join(dir, 'rom.bin')
    await writeFile(file, 'abc')
    const expectedSha256 = createHash('sha256').update('abc').digest('hex')
    const result = await computeRomHashes(file, { sha256: expectedSha256 })
    assert.equal(result.size, 3)
    assert.equal(result.md5, createHash('md5').update('abc').digest('hex'))
    assert.equal(result.sha1, createHash('sha1').update('abc').digest('hex'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('M2 cleans rom names and resolves GB/GBC systems', () => {
  assert.equal(cleanRomName('My_Game.gb'), 'My Game')
  assert.equal(resolveScreenScraperSystem('gb', 'x.gbc').systemId, '10')
})
