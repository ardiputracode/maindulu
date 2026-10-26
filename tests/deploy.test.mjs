import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { readConfig } from '../server/config.mjs'

const text = path => readFile(new URL('../' + path, import.meta.url), 'utf8')

test('release metadata, lockfile and backend image tag agree without changing dependency versions', async () => {
  const pkg = JSON.parse(await text('package.json'))
  const lock = JSON.parse(await text('package-lock.json'))
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[''].version, pkg.version)
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies)
  assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies)
  assert.ok((await text('CHANGELOG.md')).includes(`## ${pkg.version} — `))
  assert.ok((await text('deploy/docker-compose.backend.yml')).includes(`image: maindulu-backend:${pkg.version}`))
})

test('Docker backend has production dependencies, non-root runtime and a volume containing data AND sibling locks', async () => {
  const dockerfile = await text('deploy/Dockerfile.backend')
  assert.match(dockerfile, /FROM node:24-alpine AS build/)
  assert.match(dockerfile, /RUN npm ci --omit=dev/)
  const runtime = dockerfile.split('FROM node:24-alpine AS runtime')[1]
  assert.ok(runtime)
  for (const source of ['COPY server ./server', 'COPY src/lib/game-save-format.ts ./src/lib/game-save-format.ts', 'COPY scripts/reset-account.mjs scripts/set-account-role.mjs scripts/data-backup.mjs ./scripts/', 'COPY deploy/healthcheck.mjs ./deploy/healthcheck.mjs', 'USER node', 'VOLUME ["/var/lib/maindulu"]', 'CMD ["node", "server/index.mjs"]']) assert.ok(runtime.includes(source), source)
  assert.match(runtime, /MAIN_DULU_HOST=0\.0\.0\.0/)
  assert.match(runtime, /MAIN_DULU_DATA_DIR=\/var\/lib\/maindulu\/data/)
  assert.doesNotMatch(runtime, /COPY \. |COPY public|vendor:engine|npm install|USER root/)
  const compose = await text('deploy/docker-compose.backend.yml')
  for (const value of ['storage:/var/lib/maindulu', 'init: true', 'read_only: true', 'no-new-privileges:true', 'stop_grace_period: 30s', 'MAIN_DULU_HOST=0.0.0.0', 'MAIN_DULU_PORT=7777', '${MAIN_DULU_BIND_ADDRESS:-127.0.0.1}:${MAIN_DULU_PORT:-7777}:7777']) assert.ok(compose.includes(value), value)
  assert.match(compose, /^      - MAIN_DULU_PUBLIC_ORIGIN$/m)
  assert.ok(compose.includes('MAIN_DULU_ALLOW_INSECURE_HTTP=${MAIN_DULU_ALLOW_INSECURE_HTTP:-false}'))
  assert.doesNotMatch(compose, /MAIN_DULU_PUBLIC_ORIGIN=|pid: host|privileged: true|container_name:/)
})

test('Docker static deployment remains Nginx-only and its existing ports/healthcheck contract is preserved', async () => {
  const dockerfile = await text('deploy/Dockerfile')
  assert.match(dockerfile, /FROM nginx:1\.29-alpine/)
  assert.match(dockerfile, /COPY --from=build \/app\/dist \/usr\/share\/nginx\/html/)
  assert.doesNotMatch(dockerfile, /COPY server|server\/index\.mjs/)
  const compose = await text('deploy/docker-compose.yml')
  assert.ok(compose.includes('${MAIN_DULU_PORT:-7777}:80'))
  assert.match(compose, /"wget", "-q", "--spider", "http:\/\/127\.0\.0\.1\/"/)
})

test('backend LAN environment example is accepted with explicit HTTP opt-in and a matching browser port', async () => {
  const env = Object.fromEntries((await text('deploy/backend.env.example')).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => {
    const separator = line.indexOf('=')
    assert.ok(separator > 0)
    return [line.slice(0, separator), line.slice(separator + 1)]
  }))
  const config = await readConfig(env)
  assert.equal(config.allowInsecureHttp, true)
  assert.equal(config.publicOrigin, env.MAIN_DULU_PUBLIC_ORIGIN)
  const origin = new URL(config.publicOrigin)
  assert.equal(origin.protocol, 'http:')
  assert.equal(origin.port, env.MAIN_DULU_PORT)
  assert.equal(env.MAIN_DULU_BIND_ADDRESS, '0.0.0.0')
})

test('Docker context is deny-by-default with narrow source exceptions, not a blacklist of known backup names', async () => {
  const rules = (await text('.dockerignore')).split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))
  assert.equal(rules[0], '**')
  const exceptions = rules.filter(s => s.startsWith('!'))
  assert.deepEqual(exceptions, [
    '!package.json', '!package-lock.json', '!index.html', '!vite.config.ts', '!tsconfig.json', '!tsconfig.app.json', '!tsconfig.node.json',
    '!src/', '!src/**', '!public/', '!public/**', '!server/', '!server/*.mjs', '!server/auth/', '!server/auth/*.mjs', '!scripts/', '!scripts/reset-account.mjs', '!scripts/set-account-role.mjs', '!scripts/data-backup.mjs',
    '!deploy/', '!deploy/Dockerfile', '!deploy/Dockerfile.backend', '!deploy/nginx.docker.conf', '!deploy/healthcheck.mjs',
  ])
  // Re-exclude children after admitting a parent directory; otherwise a negated
  // directory rule could accidentally admit every file below that directory.
  for (const dir of ['scripts', 'deploy', 'server', 'server/auth']) assert.equal(rules[rules.indexOf('!' + dir + '/') + 1], dir + '/**')
  for (const rule of ['**/.env', '**/.env.*', '**/*.sqlite', '**/*.sqlite-*', '**/*.maindulu-lock', '**/*.partial-*', '**/node_modules', '**/.git']) assert.ok(rules.indexOf(rule) > rules.lastIndexOf(exceptions.at(-1)), rule)
  // These tests assert configuration contracts, not Docker's actual matcher or
  // image behavior. The daemon build/runtime checklist remains necessary.
})

test('container healthcheck validates backend identity/capabilities and fails safely on HTML, outage or malformed JSON', () => {
  const health = new URL('../deploy/healthcheck.mjs', import.meta.url).href
  const healthy = { service: 'maindulu', apiVersion: 1, status: 'ok', capabilities: { accounts: true, serverSaves: true, gameSaves: true } }
  for (const fixture of [
    { body: JSON.stringify(healthy), status: 200, type: 'application/json', ok: true },
    { body: JSON.stringify(healthy), status: 503, type: 'application/json' },
    { body: '<html>fallback</html>', status: 200, type: 'text/html' },
    { body: 'bad json PRIVATE-RESPONSE', status: 200, type: 'application/json' },
    { body: JSON.stringify({ ...healthy, service: 'other' }), status: 200, type: 'application/json' },
    { body: JSON.stringify({ ...healthy, capabilities: { accounts: true, serverSaves: false } }), status: 200, type: 'application/json' },
    { offline: true },
  ]) {
    const code = `const fixture = ${JSON.stringify(fixture)};
      globalThis.fetch = async (url, options) => {
        if (url !== 'http://127.0.0.1:7777/api/health' || !(options.signal instanceof AbortSignal) || options.redirect !== 'error') throw new Error('invalid health target');
        if (fixture.offline) throw new Error('PRIVATE-RESPONSE');
        return new Response(fixture.body, { status: fixture.status, headers: { 'content-type': fixture.type } });
      };
      await import(${JSON.stringify(health)});`
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10000 })
    assert.equal(r.status, fixture.ok ? 0 : 1, r.stderr)
    assert.equal(r.stdout, '')
    assert.doesNotMatch(r.stderr, /PRIVATE-RESPONSE|\n\s+at /)
    if (!fixture.ok) assert.match(r.stderr, /Backend maindulu belum sehat/)
  }
})
