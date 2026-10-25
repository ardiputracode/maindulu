import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

export async function launchDemo(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Mainkan Jalan Pulang', exact: true }).click()
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  return startPlayer(page)
}

export async function startPlayer(page: Page) {
  await page.bringToFront()
  const player = page.frameLocator('iframe')
  await player.getByRole('button', { name: 'Mulai bermain', exact: true }).press('Enter')
  await expect(player.locator('canvas')).toBeVisible({ timeout: 60000 })
  await expect(page.locator('.player-status')).toHaveCount(0, { timeout: 60000 })
  return player
}
