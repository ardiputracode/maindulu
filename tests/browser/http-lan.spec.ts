import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import type { Page } from '@playwright/test'

function lanOrigin(baseURL: string): string {
  const address = Object.values(networkInterfaces()).flat().find(value => value?.family === 'IPv4' && !value.internal)
  test.skip(!address, 'An IPv4 LAN interface is required to test a real insecure origin.')
  const url = new URL(baseURL)
  url.hostname = address!.address
  return url.origin
}

async function watchRequests(page: Page, origin: string) {
  const external: string[] = []
  const writes: string[] = []
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url())
  })
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) return route.continue()
    external.push(url.href)
    return route.abort()
  })
  return { external, writes, errors }
}

async function expectInsecureOrigin(page: Page) {
  expect(await page.evaluate(() => ({
    secure: window.isSecureContext,
    digest: typeof globalThis.crypto?.subtle,
    uuid: typeof globalThis.crypto?.randomUUID,
    random: typeof globalThis.crypto?.getRandomValues,
  }))).toEqual({ secure: false, digest: 'undefined', uuid: 'undefined', random: 'function' })
}

test.describe('mobile over HTTP at a real network IP', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('local ROM and BIOS play without HTTPS and retain an existing SHA-256 favorite identity', async ({ page, baseURL }) => {
    const origin = lanOrigin(baseURL!)
    const requests = await watchRequests(page, origin)
    const rom = await readFile('public/games/jalan-pulang.nes')
    const id = `local-nes-${createHash('sha256').update(rom).digest('hex')}`
    await page.addInitScript(({ id }) => {
      if (window === window.top) localStorage.setItem('maindulu.favorites.v1', JSON.stringify([
        { id, title: 'Kenangan LAN', consoleId: 'nes', source: 'local', fileName: 'rom-lama.nes' },
      ]))
    }, { id })
    await page.goto(origin)
    await expectInsecureOrigin(page)
    await page.getByRole('button', { name: 'Buka navigasi' }).click()
    await page.getByRole('link', { name: /Favoritku/ }).click()
    await page.getByRole('button', { name: 'Mainkan Kenangan LAN', exact: true }).click()
    await page.locator('input[type=file]').first().setInputFiles({ name: 'nama-baru.nes', mimeType: 'application/octet-stream', buffer: rom })
    await page.locator('#bios-choice').selectOption('local')
    await page.locator('input[type=file]').nth(1).setInputFiles({ name: 'test-firmware.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(512) })
    await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
    const player = page.frameLocator('iframe')
    await player.getByRole('button', { name: 'Mulai bermain', exact: true }).click()
    await expect(player.locator('canvas')).toBeVisible({ timeout: 60000 })
    await expect(page.locator('.player-status')).toHaveCount(0, { timeout: 60000 })
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Hapus dari favorit', exact: true })).toHaveAttribute('aria-pressed', 'true')
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('maindulu.history.v1') || '[]')[0].id)).toBe(id)
    expect(await player.locator('body').evaluate(() => (window as unknown as { EJS_emulator: { gameManager: { FS: { readdir: (path: string) => string[] } } } }).EJS_emulator.gameManager.FS.readdir('/'))).toContain('test-firmware.bin')
    expect(requests).toEqual({ external: [], writes: [], errors: [] })
  })

  test('server game also launches when crypto.randomUUID is unavailable on HTTP', async ({ page, baseURL }) => {
    const origin = lanOrigin(baseURL!)
    const requests = await watchRequests(page, origin)
    await page.goto(origin)
    await expectInsecureOrigin(page)
    await page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true }).click()
    await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
    const player = page.frameLocator('iframe')
    await player.getByRole('button', { name: 'Mulai bermain', exact: true }).click()
    await expect(player.locator('canvas')).toBeVisible({ timeout: 60000 })
    await expect(page.locator('.player-status')).toHaveCount(0, { timeout: 60000 })
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(requests).toEqual({ external: [], writes: [], errors: [] })
  })
})
