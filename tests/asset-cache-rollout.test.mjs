import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { ASSET_CACHE_DISABLED } from '../src/lib/asset-cache-rollout.ts'

test('unconfigured rollout brake is off, not an override of stored preferences', () => {
  assert.equal(ASSET_CACHE_DISABLED, false)
})

for (const disabled of [false, true]) test(`build-time cache brake ${disabled} preserves legacy/local paths without IDB`, async () => {
  const bundle = await build({ entryPoints: ['src/lib/player-assets.ts'], bundle: true, write: false,
    format: 'esm', platform: 'node', target: 'es2022', define: { __ASSET_CACHE_DISABLED__: String(disabled) } })
  const { preparePlayerAssets } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
  const controller = new AbortController()
  const local = { game: { id: 'local', source: 'local' }, consoleInfo: { id: 'nes' } }
  assert.deepEqual(await preparePlayerAssets(local, controller.signal, () => assert.fail('unexpected preparation')), { outcomes: [] })
  if (disabled) {
    // A descriptor forces the server branch. Opening IDB must not be attempted,
    // even if the user's stored choice was enabled before this rollback build.
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, get() { assert.fail('kill switch opened IDB') } })
    try {
      const result = await preparePlayerAssets({ ...local, serverRom: {} }, controller.signal, () => assert.fail('unexpected preparation'))
      assert.deepEqual(result.outcomes, [])
      assert.equal(result.preparedRom, undefined)
      assert.match(result.cacheNotice, /dinonaktifkan oleh build/)
    } finally {
      if (previous) Object.defineProperty(globalThis, 'indexedDB', previous)
      else delete globalThis.indexedDB
    }
  }
  controller.abort()
  await assert.rejects(preparePlayerAssets(local, controller.signal, () => {}), { name: 'AbortError' })
})
