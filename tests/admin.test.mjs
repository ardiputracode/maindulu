import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readHiddenPassword } from '../server/auth/terminal.mjs'
import { openDatabase } from '../server/database.mjs'
import { hashPassword, hashRecoveryCode, verifyPassword } from '../server/auth/crypto.mjs'
import { backendFixture } from './helpers/backend-fixture.mjs'

function terminal() {
  const input = new PassThrough()
  const output = new PassThrough()
  input.isTTY = output.isTTY = true
  const modes = []
  input.setRawMode = value => { input.isRaw = value; modes.push(value) }
  let written = ''
  output.on('data', chunk => { written += chunk.toString() })
  return { input, output, modes, written: () => written }
}

test('hidden terminal reads passwords without echo, handles Unicode/backspace and restores terminal state', async () => {
  const tty = terminal()
  const promise = readHiddenPassword('Password: ', tty.input, tty.output)
  tty.input.write('secret🔑x\x7f\r')
  assert.equal(await promise, 'secret🔑')
  assert.equal(tty.written(), 'Password: \n')
  assert.deepEqual(tty.modes, [true, false])
  assert.equal(tty.input.listenerCount('keypress'), 0)
})

test('hidden terminal cancels safely on Ctrl+C, EOF, input error and excessive input', async () => {
  for (const cancel of [tty => tty.input.write('\x03'), tty => tty.input.emit('end'), tty => tty.input.emit('error', new Error('secret')), tty => tty.input.emit('keypress', 'x'.repeat(1025), {})]) {
    const tty = terminal()
    const promise = readHiddenPassword('Password: ', tty.input, tty.output)
    cancel(tty)
    await assert.rejects(promise, /dibatalkan/)
    assert.equal(tty.written(), 'Password: \n')
    assert.equal(tty.input.isRaw, false)
  }
})

test('admin CLI refuses redirected input/output and password arguments without printing secrets', () => {
  const secret = 'NeverPrintThisPassword123'
  for (const args of [['player_one'], ['player_one', secret], []]) {
    const result = spawnSync(process.execPath, ['scripts/reset-account.mjs', ...args], { encoding: 'utf8', input: secret + '\n', timeout: 10000 })
    assert.equal(result.status, 1)
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret))
    assert.match(result.stderr, /terminal interaktif|Gunakan:/)
    assert.equal(result.stdout, '')
  }
  assert.throws(() => readHiddenPassword('Password: ', new PassThrough(), new PassThrough()), /terminal interaktif/)
})

test('actual admin CLI resets an existing database with simulated interactive terminal streams and no password echo', async t => {
  let db
  const root = await backendFixture(t, { beforeCleanup: () => db?.close() })
  const dataDir = join(root, 'data')
  db = await openDatabase(dataDir)
  const oldHash = await hashPassword('Old123')
  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run('stable-owner', 'player_one', oldHash, hashRecoveryCode('AB'.repeat(32)), 123)
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('existing-session', 'stable-owner', 123, Date.now() + 60000)
  db.exec("CREATE TABLE owned_fixture (user_id TEXT REFERENCES users(id), content TEXT); INSERT INTO owned_fixture VALUES ('stable-owner', 'keep-me')")
  const secret = 'NewAdmin🔑234'
  const preload = join(root, 'terminal-fixture.mjs')
  // This preload is test-only; the production CLI has no env/pipe password path.
  await writeFile(preload, `
    for (const stream of [process.stdin, process.stdout, process.stderr]) Object.defineProperty(stream, 'isTTY', { value: true });
    process.stdin.setRawMode = () => {};
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (text, ...rest) => {
      const result = write(text, ...rest);
      if (String(text).includes('(tersembunyi):')) queueMicrotask(() => {
        process.stdin.emit('keypress', ${JSON.stringify(secret)}, {});
        process.stdin.emit('keypress', '\\r', { name: 'return' });
      });
      return result;
    };
  `)
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, 'scripts/reset-account.mjs', ' PLAYER_ONE '], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, MAIN_DULU_DATA_DIR: dataDir },
  })
  assert.equal(result.status, 0, result.stderr)
  const output = result.stdout + result.stderr
  assert.ok(!output.includes(secret))
  const codes = result.stdout.match(/(?:[A-F0-9]{8}-){7}[A-F0-9]{8}/g)
  assert.equal(codes.length, 1)
  const user = db.prepare('SELECT * FROM users').get()
  assert.equal(user.id, 'stable-owner')
  assert.equal(user.created_at, 123)
  assert.equal(await verifyPassword(secret, user.password_hash), true)
  assert.equal(await verifyPassword('Old123', user.password_hash), false)
  assert.equal(user.recovery_code_hash, hashRecoveryCode(codes[0]))
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0)
  assert.equal(db.prepare('SELECT content FROM owned_fixture').get().content, 'keep-me')
})
