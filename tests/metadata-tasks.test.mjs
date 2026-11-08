import test from 'node:test'
import assert from 'node:assert/strict'
import { metadataTaskNotice } from '../src/lib/useMetadataTasks.ts'

test('metadata task notifications distinguish completion, review, failed and partial cover outcomes', () => {
  assert.deepEqual(metadataTaskNotice('Contra', { status: 'succeeded', reason: null }), { text: 'Metadata Contra berhasil diperbarui.', tone: 'success' })
  assert.equal(metadataTaskNotice('Contra', { status: 'succeeded', reason: 'COVER_UNAVAILABLE' }).tone, 'warning')
  assert.match(metadataTaskNotice('Contra', { status: 'succeeded', reason: 'COVER_UNAVAILABLE' }).text, /cover belum tersedia/)
  assert.equal(metadataTaskNotice('Contra', { status: 'failed', reason: 'provider_error' }).tone, 'error')
  assert.match(metadataTaskNotice('Contra', { status: 'needs_review', reason: null }).text, /perlu ditinjau/)
  for (const status of ['not_found', 'unsupported', 'paused', 'cancelled', 'disabled']) assert.equal(metadataTaskNotice('Contra', { status, reason: null }).tone, 'warning')
  for (const status of ['queued', 'running', 'retry_wait']) assert.equal(metadataTaskNotice('Contra', { status, reason: null }), null)
})
