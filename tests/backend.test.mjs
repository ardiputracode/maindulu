import test from 'node:test'
import assert from 'node:assert/strict'
import { backendConfigured, readBackendHealth } from '../src/lib/backend.ts'

const health = { service: 'maindulu', apiVersion: 1, status: 'ok', capabilities: { accounts: false, serverSaves: false } }

test('backend discovery requires explicit server marker or opt-in build setting', () => {
  assert.equal(backendConfigured(null, undefined), false)
  assert.equal(backendConfigured(null, 'false'), false)
  assert.equal(backendConfigured('disabled', '1'), false)
  assert.equal(backendConfigured('enabled', undefined), true)
  assert.equal(backendConfigured(null, 'true'), true)
})

test('backend health validates identity, API version, status and real capability booleans', () => {
  assert.deepEqual(readBackendHealth(health), health)
  assert.deepEqual(readBackendHealth({ ...health, ignored: 'extra' }), health)
  assert.equal(readBackendHealth({ ...health, capabilities: { ...health.capabilities, gameSaves: true } }).capabilities.gameSaves, true)
  assert.equal(readBackendHealth({ ...health, capabilities: { ...health.capabilities, gameSaves: 'true' } }), null)
  for (const value of [null, [], '<html>SPA fallback</html>', {}, { ...health, service: 'other' }, { ...health, apiVersion: 2 }, { ...health, status: 'down' }, { ...health, capabilities: null }, { ...health, capabilities: { accounts: 'false', serverSaves: false } }]) assert.equal(readBackendHealth(value), null)
})
