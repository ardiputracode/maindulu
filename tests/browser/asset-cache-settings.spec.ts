import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import type { Page } from '@playwright/test'
import type * as Harness from '../fixtures/asset-cache-settings'

declare global { interface Window { cacheSettingsTest: typeof Harness } }
let bundle: string
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: ['tests/fixtures/asset-cache-settings.ts'], bundle: true, write: false,
    format: 'iife', globalName: 'cacheSettingsTest', target: 'es2022', platform: 'browser' })).outputFiles[0].text
})
async function open(page: Page) {
  await page.goto('/pengaturan')
  await page.addScriptTag({ content: bundle })
  await expect(page.getByRole('switch', { name: 'Gunakan cache ROM/BIOS backend' })).toBeEnabled()
}
const panel = (page: Page) => page.getByRole('region', { name: 'Cache ROM dan BIOS backend' })

test('M4 defaults off; toggle persists, budget is explicit, metadata survives document reload', async ({ page }) => {
  await open(page)
  const toggle = page.getByRole('switch', { name: 'Gunakan cache ROM/BIOS backend' })
  await expect(toggle).not.toBeChecked()
  await toggle.click(); await expect(toggle).toBeChecked()
  await page.evaluate(() => window.cacheSettingsTest.seed())
  await expect(panel(page)).toContainText('3 B · 1 aset')
  await expect(panel(page).getByRole('listitem')).toContainText('test.nes')
  await toggle.click(); await expect(toggle).not.toBeChecked()
  await expect(panel(page).getByRole('listitem')).toHaveCount(1)
  await page.getByLabel('Budget cache aplikasi').selectOption(String(4 * 1073741824))
  await expect(panel(page)).toContainText('Budget cache diperbarui.')
  await page.getByLabel('Budget cache aplikasi').selectOption(String(1073741824))
  const dialog = page.getByRole('dialog', { name: 'Kurangi budget cache?' })
  await expect(dialog).toContainText('Save state, SRAM, progres')
  await dialog.getByRole('button', { name: 'Batal', exact: true }).click()
  await expect(page.getByLabel('Budget cache aplikasi')).toHaveValue(String(4 * 1073741824))
  await page.getByLabel('Budget cache aplikasi').selectOption(String(1073741824))
  await page.getByRole('dialog', { name: 'Kurangi budget cache?' }).getByRole('button', { name: 'Kurangi budget', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByLabel('Budget cache aplikasi')).toHaveValue(String(1073741824))
  await open(page)
  await expect(toggle).not.toBeChecked()
  await expect(panel(page)).toContainText('3 B · 1 aset')
  await expect(page.getByLabel('Budget cache aplikasi')).toHaveValue(String(1073741824))
})

test('M4 per-entry delete, failed clear and clear success report real transactions, leave other storage untouched', async ({ page }) => {
  await open(page)
  await page.evaluate(async () => {
    await window.cacheSettingsTest.seed('ROM satu')
    await window.cacheSettingsTest.seed('Firmware satu', 'bios')
    localStorage.setItem('m4-save-history-account-sentinel', 'keep')
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('EmulatorJS-states', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('states')
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const db = req.result, tx = db.transaction('states', 'readwrite')
        tx.objectStore('states').put(new Uint8Array([4, 5, 6]), 'guest-save')
        tx.oncomplete = () => { db.close(); resolve() }
      }
    })
  })
  await expect(panel(page).getByRole('listitem')).toHaveCount(2)
  await page.getByRole('button', { name: 'Hapus cache ROM ROM satu', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Ya, hapus cache' }).click()
  await expect(panel(page).getByRole('listitem')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Perbarui cache', exact: true })).toBeFocused()
  await page.evaluate(() => window.cacheSettingsTest.abortNextClear())
  await page.getByRole('button', { name: 'Hapus semua cache', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Ya, hapus cache' }).click()
  await expect(panel(page).getByRole('alert')).toContainText('dibatalkan')
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(panel(page).getByRole('listitem')).toHaveCount(1)
  await page.getByRole('dialog').getByRole('button', { name: 'Ya, hapus cache' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(panel(page)).toContainText('0 B · 0 aset')
  expect(await page.evaluate(() => localStorage.getItem('m4-save-history-account-sentinel'))).toBe('keep')
  expect(await page.evaluate(() => new Promise<number[]>(resolve => {
    const req = indexedDB.open('EmulatorJS-states')
    req.onsuccess = () => {
      const db = req.result, tx = db.transaction('states')
      tx.objectStore('states').get('guest-save').onsuccess = e => resolve(Array.from((e.target as IDBRequest).result))
      tx.oncomplete = () => db.close()
    }
  }))).toEqual([4, 5, 6])
})

test('M4 visible second tab follows commit/delete/clear and budget eviction without reload', async ({ page, context }) => {
  await open(page)
  const other = await context.newPage()
  await open(other)
  const descriptor = await other.evaluate(() => window.cacheSettingsTest.seed('Dari tab lain'))
  await expect(panel(page)).toContainText('3 B · 1 aset')
  await other.evaluate(async descriptor => {
    const cache = await window.cacheSettingsTest.openAssetCache()
    try { await cache.delete(descriptor.kind, descriptor.catalogId, descriptor.sha256) } finally { cache.close() }
  }, descriptor)
  await expect(panel(page)).toContainText('0 B · 0 aset')
  await other.evaluate(() => window.cacheSettingsTest.seed('Akan dievict'))
  await expect(panel(page)).toContainText('3 B · 1 aset')
  await other.evaluate(async () => {
    const cache = await window.cacheSettingsTest.openAssetCache()
    try { await cache.setSettings({ enabled: true, budget: 1 }) } finally { cache.close() }
  })
  await expect(panel(page)).toContainText('0 B · 0 aset')
  await expect(page.getByLabel('Budget cache aplikasi')).toHaveValue('1')
  await other.evaluate(async () => {
    const cache = await window.cacheSettingsTest.openAssetCache()
    try { await cache.setSettings({ enabled: true, budget: 1073741824 }) } finally { cache.close() }
    await window.cacheSettingsTest.seed('Akan dibersihkan')
  })
  await expect(panel(page)).toContainText('3 B · 1 aset')
  await other.getByRole('button', { name: 'Hapus semua cache', exact: true }).click()
  await other.getByRole('dialog').getByRole('button', { name: 'Ya, hapus cache' }).click()
  await expect(panel(page)).toContainText('0 B · 0 aset')
  await other.close()
})

test('M4 no BroadcastChannel or storage APIs: polling/focus and IndexedDB still work', async ({ page, context }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'BroadcastChannel', { value: undefined })
    Object.defineProperty(navigator, 'storage', { value: undefined })
  })
  await open(page)
  await expect(panel(page)).toContainText('Estimasi ruang browser tidak tersedia')
  await expect(panel(page)).toContainText('Permintaan penyimpanan persisten tidak tersedia')
  await page.evaluate(() => window.cacheSettingsTest.seed())
  await expect(panel(page)).toContainText('3 B · 1 aset')
  const other = await context.newPage()
  await open(other)
  await other.evaluate(() => window.cacheSettingsTest.seed('Sans notification'))
  await page.bringToFront()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(panel(page)).toContainText('6 B · 2 aset')
  await other.close()
})

test('M4 staging bytes are distinct from stored assets; UI clear fences a pending writer', async ({ page }) => {
  await open(page)
  await page.evaluate(() => window.cacheSettingsTest.stageOnly())
  await expect(panel(page)).toContainText('0 B · 0 aset')
  await expect(panel(page)).toContainText('1 persiapan · 3 B ditulis · 3 B direservasi')
  await expect(panel(page).getByRole('listitem')).toHaveCount(0)
  await page.getByRole('button', { name: 'Hapus semua cache', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Ya, hapus cache' }).click()
  // A click dispatch is not the async clear's transaction-complete boundary.
  // Only try the late commit after the UI has acknowledged successful deletion.
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await page.evaluate(() => window.cacheSettingsTest.finishStage())).toBe('fenced')
  await expect(panel(page)).toContainText('0 persiapan · 0 B ditulis · 0 B direservasi')
})

test('M4 unavailable IndexedDB is visible and never offers a misleading enabled switch', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }))
  await page.goto('/pengaturan')
  await expect(panel(page).getByRole('alert')).toContainText('IndexedDB tidak tersedia')
  await expect(page.getByRole('switch', { name: 'Gunakan cache ROM/BIOS backend' })).toBeDisabled()
})

test('M4 future cache schema is explained without deleting or downgrading it', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('maindulu-asset-cache', 2)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => { req.result.close(); resolve() }
  }))
  await page.goto('/pengaturan')
  await expect(panel(page).getByRole('alert')).toContainText('Versi database cache lebih baru')
  expect(await page.evaluate(() => new Promise<number>(resolve => {
    const req = indexedDB.open('maindulu-asset-cache')
    req.onsuccess = () => { const version = req.result.version; req.result.close(); resolve(version) }
  }))).toBe(2)
})

for (const result of ['denied', 'throw', 'approved'] as const) {
  test(`M4 optional persist ${result} never blocks settings`, async ({ page }) => {
    await page.addInitScript(result => {
      Object.defineProperty(navigator, 'storage', { value: {
        estimate: () => Promise.reject(Error('estimate restricted')),
        persisted: () => Promise.reject(Error('persisted restricted')),
        persist: () => result === 'throw' ? Promise.reject(Error('persist restricted')) : Promise.resolve(result === 'approved'),
      } })
    }, result)
    await open(page)
    await page.getByRole('button', { name: 'Minta penyimpanan persisten' }).click()
    await expect(panel(page)).toContainText(result === 'approved' ? 'Penyimpanan persisten disetujui browser. Data' : result === 'denied' ? 'tidak disetujui browser' : 'Permintaan penyimpanan persisten gagal')
    await expect(page.getByRole('switch', { name: 'Gunakan cache ROM/BIOS backend' })).toBeEnabled()
  })
}

test('M4 mobile dialog traps keyboard focus, Escape cancels and restores trigger focus', async ({ page }, info) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await open(page)
  await page.evaluate(() => window.cacheSettingsTest.seed('Judul sangat panjang '.repeat(9)))
  const trigger = panel(page).getByRole('button', { name: /^Hapus cache ROM / })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Hapus aset cache?' })
  await expect(dialog).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByRole('button', { name: 'Ya, hapus cache' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Tutup dialog' })).toBeFocused()
  await page.screenshot({ path: info.outputPath('cache-delete-mobile.png') })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
