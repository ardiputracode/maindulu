import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { launchDemo } from './helpers/player'

async function enableBackend(page: Page) {
  // Simulate the same HTML marker injected by the Node server, without making
  // a static deployment depend on API discovery or modifying the build.
  await page.route(/\/(?:pengaturan)?$/, async route => {
    const response = await route.fetch()
    const html = (await response.text()).replace('</head>', '<meta name="maindulu-backend" content="enabled" /></head>')
    await route.fulfill({ response, body: html })
  })
}

const health = { service: 'maindulu', apiVersion: 1, status: 'ok', capabilities: { accounts: false, serverSaves: false } }

test('deployment mode is explicit; the portable static frontend does not probe an API', async ({ page }, testInfo) => {
  const requests: string[] = []
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.url()) })
  await page.goto('/pengaturan')
  const status = page.getByRole('region', { name: 'Status backend' })
  if (testInfo.project.name === 'node-backend') {
    await expect(status.getByRole('heading')).toHaveText('Backend lokal terhubung')
    expect(requests.length).toBeGreaterThan(0)
    await expect(status).toContainText('progres tetap di browser')
  } else {
    await expect(status.getByRole('heading')).toHaveText('Mode web statis')
    expect(requests).toEqual([])
  }
  await expect(page.getByRole('button', { name: /Login|Daftar akun/ })).toHaveCount(0)
})

test('an enabled but unreachable backend remains unavailable and supports retry', async ({ page }) => {
  await enableBackend(page)
  await page.route('**/api/health', route => route.abort())
  await page.goto('/pengaturan')
  const status = page.getByRole('region', { name: 'Status backend' })
  await expect(status.getByRole('heading')).toHaveText('Backend tidak dapat dihubungi')
  await expect(status.getByRole('alert')).toContainText('Mode tamu tetap bisa digunakan')
  await page.unroute('**/api/health')
  await page.route('**/api/health', route => route.fulfill({ json: health }))
  await status.getByRole('button', { name: 'Coba koneksi backend lagi' }).click()
  await expect(status.getByRole('heading')).toHaveText('Backend lokal terhubung')
})

test('an HTML SPA fallback is not mistaken for a healthy backend', async ({ page }) => {
  await enableBackend(page)
  await page.route('**/api/health', route => route.fulfill({ contentType: 'text/html', body: '<html>Not an API</html>' }))
  await page.goto('/pengaturan')
  await expect(page.getByRole('region', { name: 'Status backend' }).getByRole('heading')).toHaveText('Backend tidak dapat dihubungi')
})

test('a stalled health request times out without blocking the settings page', async ({ page }) => {
  await enableBackend(page)
  await page.route('**/api/health', () => {})
  await page.goto('/pengaturan')
  await expect(page.getByRole('heading', { name: 'Atur jeda mainmu.' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Status backend' }).getByRole('heading')).toHaveText('Backend tidak dapat dihubungi')
})

test('backend failure does not prevent catalog navigation or real guest gameplay', async ({ page }) => {
  await enableBackend(page)
  await page.route('**/api/health', route => route.fulfill({ status: 503, json: { error: 'unavailable' } }))
  await page.goto('/pengaturan')
  await expect(page.getByRole('region', { name: 'Status backend' }).getByRole('heading')).toHaveText('Backend tidak dapat dihubungi')
  await page.getByRole('link', { name: 'Beranda', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true })).toBeVisible()
  const player = await launchDemo(page)
  await expect(player.locator('canvas')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})
