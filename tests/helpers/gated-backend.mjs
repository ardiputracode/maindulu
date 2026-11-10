import { createApp as createRealApp } from '../../server/app.mjs'
import { readConfig as readRealConfig } from '../../server/config.mjs'

// Legacy regression scenarios run INSIDE the door, without bypassing the real
// guard. Gate-specific tests import the production app/config directly.
export const gateEnv = { MAIN_DULU_GATE_USERNAME: 'test_gate', MAIN_DULU_GATE_PASSWORD: 'Gate-test-123!' }
export const readConfig = (env = {}, root) => readRealConfig({ ...gateEnv, ...env }, root)
export async function createApp(options = {}) {
  const app = await createRealApp({ ...options, env: { ...gateEnv, ...options.env } })
  const inject = app.inject.bind(app)
  const origin = new URL(app.appConfig.publicOrigin ?? 'http://localhost:7777')
  const login = await inject({ method: 'POST', url: '/api/gate/login', headers: { host: origin.host, origin: origin.origin }, payload: { username: gateEnv.MAIN_DULU_GATE_USERNAME, password: gateEnv.MAIN_DULU_GATE_PASSWORD } })
  if (login.statusCode !== 200) { await app.close(); throw new Error(login.body) }
  const cookie = login.headers['set-cookie'].split(';')[0]
  app.testGateCookie = cookie
  app.inject = input => {
    const request = typeof input === 'string' ? { url: input } : input
    return inject({ ...request, headers: { ...request.headers, cookie: [request.headers?.cookie, cookie].filter(Boolean).join('; ') } })
  }
  return app
}
