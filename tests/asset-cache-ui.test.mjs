import test from 'node:test'
import assert from 'node:assert/strict'
import { formatAssetBytes, assetPreparationStatus, assetPersistenceNotice, readBrowserStorage, requestPersistentStorage } from '../src/lib/asset-cache-ui.ts'

test('cache UI uses binary units and separates transfer, verification, commit and ready', () => {
  assert.equal(formatAssetBytes(0), '0 B')
  assert.equal(formatAssetBytes(1024), '1.00 KiB')
  assert.equal(formatAssetBytes(329641708), '314.37 MiB')
  assert.equal(formatAssetBytes(2147483648), '2.00 GiB')
  for (const kind of ['rom', 'bios']) {
    const progress = { kind, receivedBytes: 1048576, totalBytes: 2097152 }
    assert.match(assetPreparationStatus({ ...progress, phase: 'downloading' }), /1.00 \/ 2.00 MiB/)
    assert.match(assetPreparationStatus({ ...progress, phase: 'verifying' }), /Download .* selesai.*Memverifikasi/)
    assert.match(assetPreparationStatus({ ...progress, phase: 'saving' }), /Menyimpan cache/)
    assert.match(assetPreparationStatus({ ...progress, phase: 'ready' }), /siap untuk engine/)
    assert.match(assetPreparationStatus({ ...progress, phase: 'reading-cache' }), /memverifikasi cache/)
  }
})

test('cache notices never turn aborted/quota warnings into a stored claim', () => {
  const outcome = { descriptor: { kind: 'rom' }, warnings: [] }
  assert.equal(assetPersistenceNotice({ ...outcome, persistence: 'stored' }), 'ROM: Tersimpan di perangkat')
  assert.equal(assetPersistenceNotice({ ...outcome, persistence: 'reused' }), 'ROM: Cache perangkat dipakai')
  for (const code of ['aborted', 'quota', 'unavailable', 'budget']) {
    const notice = assetPersistenceNotice({ ...outcome, persistence: 'not-stored', warnings: [{ code, message: code }] })
    assert.match(notice, /Dimainkan tanpa disimpan/)
    assert.ok(notice.includes(code))
    assert.ok(!notice.includes('Tersimpan di perangkat'))
  }
  assert.match(assetPersistenceNotice({ ...outcome, persistence: 'not-stored' }), /tidak berhasil/)
})

test('optional storage APIs absent, rejecting or invalid are nonfatal', async () => {
  for (const api of [{}, { estimate: async () => { throw Error('blocked') }, persisted: async () => { throw Error('blocked') } },
    { estimate: async () => ({ quota: NaN, usage: -1 }), persisted: async () => 'not a boolean' }]) {
    assert.deepEqual(await readBrowserStorage(api), { canPersist: false })
    assert.match(await requestPersistentStorage(api), /tidak tersedia/)
  }
})

test('storage methods retain receiver and persistence approval/denial/throw stay explicit', async () => {
  const api = { estimate: async function () { assert.equal(this, api); return { quota: 100, usage: 20 } },
    persisted: async function () { assert.equal(this, api); return true },
    persist: async function () { assert.equal(this, api); return true } }
  assert.deepEqual(await readBrowserStorage(api), { canPersist: true, quota: 100, usage: 20, persisted: true })
  assert.match(await requestPersistentStorage(api), /^Penyimpanan persisten disetujui/)
  assert.match(await requestPersistentStorage({ persist: async () => false }), /tidak disetujui/)
  assert.match(await requestPersistentStorage({ persist: async () => { throw Error('denied') } }), /gagal/)
})
