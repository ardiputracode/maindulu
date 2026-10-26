import { test, expect } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { APIRequestContext } from '@playwright/test'
import { createApp } from '../../server/app.mjs'
import { setAccountRoleByAdmin } from '../../server/auth/mutations.mjs'
import { startPlayer } from './helpers/player'

test.beforeEach(({}, info) => { test.skip(info.project.name !== 'node-backend', 'API katalog membutuhkan backend nyata.') })

async function setupAdmin(request: APIRequestContext, address: string, db: DatabaseSync) {
  const bootstrap = await (await request.get(address + '/api/auth/csrf')).json()
  const username = 'catalog_' + randomUUID().replaceAll('-', '').slice(0, 12)
  const registered = await request.post(address + '/api/auth/register', {
    headers: { origin: address, 'x-csrf-token': bootstrap.csrfToken },
    data: { username, password: 'Catalog123', passwordConfirmation: 'Catalog123' },
  })
  expect(registered.status()).toBe(201)
  setAccountRoleByAdmin(db, username, 'admin')
  return { origin: address, 'x-csrf-token': (await registered.json()).csrfToken }
}

test('uploaded ROM and raw BIOS stream into the real guest engine with firmware filename intact; delete blocks fresh requests', async ({ browser }) => {
  const parent = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir()
  const folder = await mkdtemp(join(parent, 'catalog-browser-'))
  const app = await createApp({ env: { MAIN_DULU_DATA_DIR: join(folder, 'data') } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const admin = await browser.newContext({ baseURL: address })
  const guest = await browser.newContext({ baseURL: address })
  try {
    const headers = await setupAdmin(admin.request, address, app.database)
    const rom = await readFile('public/games/jalan-pulang.nes')
    const uploaded = await admin.request.post('/api/admin/games', { headers, multipart: {
      title: 'Game upload uji', consoleId: 'nes', license: 'CC0; homebrew Jalan Pulang',
      rom: { name: 'jalan-pulang-upload.nes', mimeType: 'application/octet-stream', buffer: rom },
    } })
    expect(uploaded.status()).toBe(201)
    const game = (await uploaded.json()).item
    expect(game.sha256).toBe(createHash('sha256').update(rom).digest('hex'))
    const firmware = await admin.request.post('/api/admin/bios', { headers, multipart: {
      name: 'Firmware sintetis', consoleId: 'nes', distributionRights: 'Synthetic bytes, plumbing test only',
      bios: { name: 'test-firmware.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(512) },
    } })
    expect(firmware.status()).toBe(201)
    const bios = (await firmware.json()).item
    const page = await guest.newPage()
    // M3 does not include Library integration. Adapt only the old manifest input
    // in this test; catalog CRUD, ROM/BIOS HTTP and the engine are all real.
    await page.route('**/catalog/games.json', route => route.fulfill({ json: [game] }))
    await page.route('**/catalog/bios.json', route => route.fulfill({ json: [bios] }))
    await page.addInitScript(() => {
      Object.defineProperty(crypto.subtle, 'digest', { value: () => { throw new Error('Server assets must not be hashed in this browser smoke test') } })
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Mainkan Game upload uji', exact: true }).click()
    await page.locator('#bios-choice').selectOption(bios.id)
    await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
    const player = await startPlayer(page)
    const files = await player.locator('body').evaluate(() => (window as unknown as {
      EJS_emulator: { gameManager: { FS: { readdir: (path: string) => string[] } } }
    }).EJS_emulator.gameManager.FS.readdir('/'))
    expect(files).toContain('test-firmware.bin')
    expect(files).toContain('jalan-pulang-upload.nes')
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect((await guest.request.head(game.url)).status()).toBe(200)
    expect((await guest.request.head(bios.url)).headers()['content-length']).toBe('512')
    for (const [kind, value] of [['bios', bios], ['games', game]] as const) {
      expect((await admin.request.delete(`/api/admin/${kind}/${value.id}`, { headers, data: {} })).status()).toBe(200)
      expect((await guest.request.get(`/api/${kind}/${value.id}`)).status()).toBe(404)
      const old = await guest.request.get(value.url)
      expect(old.status()).toBe(404)
      expect(old.headers()['cache-control']).toBe('no-store')
    }
    // Bytes already loaded cannot be revoked; deleting does not stop this engine.
    await expect(player.locator('canvas')).toBeVisible()
  } finally {
    await guest.close(); await admin.close(); await app.close()
    await rm(folder, { recursive: true, force: true })
  }
})

test('deleting a BIOS between selection and download produces the existing player preflight error', async ({ browser }) => {
  const parent = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir()
  const folder = await mkdtemp(join(parent, 'catalog-deleted-bios-'))
  const app = await createApp({ env: { MAIN_DULU_DATA_DIR: join(folder, 'data') } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const admin = await browser.newContext({ baseURL: address })
  const guest = await browser.newContext({ baseURL: address })
  try {
    const headers = await setupAdmin(admin.request, address, app.database)
    const firmware = await admin.request.post('/api/admin/bios', { headers, multipart: {
      name: 'Firmware akan dihapus', consoleId: 'nes', bios: { name: 'test-firmware.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(512) },
    } })
    expect(firmware.status()).toBe(201)
    const bios = (await firmware.json()).item
    const page = await guest.newPage()
    await page.route('**/catalog/bios.json', route => route.fulfill({ json: [bios] }))
    await page.goto('/')
    await page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true }).click()
    await page.locator('#bios-choice').selectOption(bios.id)
    expect((await admin.request.delete(`/api/admin/bios/${bios.id}`, { headers, data: {} })).status()).toBe(200)
    await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('BIOS server tidak ditemukan')
    await expect(page.getByRole('alert')).toContainText('HTTP 404')
  } finally {
    await guest.close(); await admin.close(); await app.close()
    await rm(folder, { recursive: true, force: true })
  }
})
