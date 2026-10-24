import test from 'node:test'
import assert from 'node:assert/strict'
import { readAccountSession, readRecoveryResult } from '../src/lib/account.ts'

test('account session parser exposes only public fields and rejects malformed sessions', () => {
  const user = { id: '00000000-0000-4000-8000-000000000001', username: 'player_one' }
  const csrfToken = 'a'.repeat(64)
  assert.deepEqual(readAccountSession({ user: null, csrfToken: null, registrationOpen: false }), { user: null, csrfToken: null, registrationOpen: false })
  assert.deepEqual(readAccountSession({ user: { ...user, password_hash: 'must not expose' }, csrfToken, registrationOpen: true, recoveryCode: 'unused' }), { user, csrfToken, registrationOpen: true })
  for (const input of [null, {}, { user, csrfToken: null, registrationOpen: true }, { user, csrfToken, registrationOpen: 'true' }, { user: { ...user, username: '<script>' }, csrfToken, registrationOpen: true }]) assert.equal(readAccountSession(input), null)
})

test('one-time recovery responses validate username/code and retain the response identity snapshot', () => {
  const recoveryCode = Array(8).fill('ABCDEF12').join('-')
  const expected = { code: recoveryCode, username: 'player_one' }
  assert.deepEqual(readRecoveryResult({ username: 'player_one', recoveryCode }), expected)
  assert.deepEqual(readRecoveryResult({ user: { username: 'player_one' }, recoveryCode }), expected)
  for (const input of [null, {}, { username: '<script>', recoveryCode }, { username: 'player_one', recoveryCode: 'bad' }, { username: 'player_one', recoveryCode: recoveryCode.toLowerCase() }]) assert.equal(readRecoveryResult(input), null)
})
