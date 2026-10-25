import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { acquireDataLock } from '../server/data-lock.mjs'
import { backendFixture } from './helpers/backend-fixture.mjs'

test('data locks record a process namespace and shared connections still exclude exclusive maintenance', async t => {
  const root = await backendFixture(t)
  const data = join(root, 'data')
  const first = await acquireDataLock(data)
  const second = await acquireDataLock(data)
  try {
    const folder = join(root, '.data.maindulu-lock')
    const files = await readdir(folder)
    assert.equal(files.length, 2)
    const lease = JSON.parse(await readFile(join(folder, files[0]), 'utf8'))
    assert.equal(lease.pid, process.pid)
    assert.equal(typeof lease.namespace, 'string')
    assert.ok(lease.namespace.length > 0)
    await assert.rejects(acquireDataLock(data, true), /Data sedang dipakai/)
  } finally { second(); first() }
  const exclusive = await acquireDataLock(data, true)
  try { await assert.rejects(acquireDataLock(data), /Data sedang dipakai/) }
  finally { exclusive() }
})

test('foreign container/host leases are never reaped based on a PID from our namespace', async t => {
  const root = await backendFixture(t)
  const data = join(root, 'data')
  const release = await acquireDataLock(data)
  const folder = join(root, '.data.maindulu-lock')
  const path = join(folder, (await readdir(folder))[0])
  const lease = JSON.parse(await readFile(path, 'utf8'))
  // Includes an impossible/dead PID locally: namespace mismatch must be checked
  // BEFORE kill(pid, 0), or maintenance could erase a live container's lease.
  await writeFile(path, JSON.stringify({ ...lease, namespace: 'foreign-host:pid:[other]', pid: 2147483647 }))
  try {
    for (const exclusive of [false, true]) await assert.rejects(acquireDataLock(data, exclusive), /namespace lain/)
    assert.equal((await readdir(folder)).length, 1)
    assert.equal(JSON.parse(await readFile(path, 'utf8')).namespace, 'foreign-host:pid:[other]')
  } finally { release() }
})

test('legacy leases without namespaces fail closed on Linux and retain non-Linux compatibility', async t => {
  const root = await backendFixture(t)
  const data = join(root, 'data')
  const release = await acquireDataLock(data)
  const folder = join(root, '.data.maindulu-lock')
  const path = join(folder, (await readdir(folder))[0])
  const lease = JSON.parse(await readFile(path, 'utf8'))
  delete lease.namespace
  await writeFile(path, JSON.stringify(lease))
  try {
    if (process.platform === 'linux') await assert.rejects(acquireDataLock(data), /namespace lain/)
    else { const shared = await acquireDataLock(data); shared() }
    await assert.rejects(acquireDataLock(data, true), /Data sedang dipakai|namespace lain/)
  } finally { release() }
})
