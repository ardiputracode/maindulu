import test from 'node:test'
import assert from 'node:assert/strict'
import { readAccountSession } from '../src/lib/account.ts'

test('account session parser exposes only public fields and rejects malformed sessions', () => {
  const user = { id: '00000000-0000-4000-8000-000000000001', username: 'player_one' }
  const csrfToken = 'a'.repeat(64)
  assert.deepEqual(readAccountSession({ user: null, csrfToken: null, registrationOpen: false }), { user: null, csrfToken: null, registrationOpen: false })
  assert.deepEqual(readAccountSession({ user: { ...user, password_hash: 'must not expose' }, csrfToken, registrationOpen: true, recoveryCode: 'unused' }), { user, csrfToken, registrationOpen: true })
  for (const input of [null, {}, { user, csrfToken: null, registrationOpen: true }, { user, csrfToken, registrationOpen: 'true' }, { user: { ...user, username: '<script>' }, csrfToken, registrationOpen: true }]) assert.equal(readAccountSession(input), null)
})
