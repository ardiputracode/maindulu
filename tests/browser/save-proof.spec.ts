import { test, expect } from '@playwright/test'
import type { FrameLocator, Page } from '@playwright/test'
import { buildNesBatteryFixture } from '../fixtures/nes-battery.mjs'
import { launchDemo, startPlayer } from './helpers/player'

// Test-only access to the real engine. No production save protocol or backend
// is introduced in M1; these operations define the contract for later work.
type EngineWindow = {
  EJS_emulator: {
    pause: () => void;
    play: () => void;
    on: (event: string, callback: (data: unknown) => void) => void;
    getBaseFileName: () => string;
    gameManager: {
      getState: () => Uint8Array;
      loadState: (data: Uint8Array) => void;
      supportsStates: () => boolean;
      getSaveFile: (flush?: boolean) => Uint8Array | null;
      getSaveFilePath: () => string;
      loadSaveFiles: () => void;
      writeFile: (path: string, data: Uint8Array) => void;
      simulateInput: (player: number, index: number, value: number) => void;
    };
  };
}

async function launchBattery(page: Page, save?: { path: string; bytes: number[] }) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Buka ROM', exact: true }).click()
  await page.locator('input[type=file]').first().setInputFiles({ name: 'maindulu-battery.nes', mimeType: 'application/octet-stream', buffer: buildNesBatteryFixture() })
  await page.getByRole('button', { name: 'Main sekarang', exact: true }).click()
  const player = page.frameLocator('iframe')
  await expect(player.getByRole('button', { name: 'Mulai bermain', exact: true })).toBeVisible()
  if (save) {
    // Register before the start click. The callback runs after mountFileSystems
    // and before callMain; the engine does not await async callbacks here.
    await player.locator('body').evaluate((_body, { path, bytes }) => {
      const e = (window as unknown as EngineWindow).EJS_emulator
      e.on('saveDatabaseLoaded', () => {
        // The exported path includes a core-specific subdirectory (FCEUmm).
        // writeFile creates those directories; guessing /data/saves/<id>.srm
        // silently fails to populate the core's actual SRAM file.
        e.gameManager.writeFile(path, new Uint8Array(bytes))
      })
    }, save)
  }
  return startPlayer(page)
}

async function readBattery(player: FrameLocator) {
  return player.locator('body').evaluate(() => Array.from((window as unknown as EngineWindow).EJS_emulator.gameManager.getSaveFile() || []))
}

async function pressA(player: FrameLocator, expected: number) {
  await player.locator('body').evaluate(() => (window as unknown as EngineWindow).EJS_emulator.gameManager.simulateInput(0, 8, 1))
  try {
    await expect.poll(async () => (await readBattery(player))[2]).toBe(expected)
  } finally {
    await player.locator('body').evaluate(() => (window as unknown as EngineWindow).EJS_emulator.gameManager.simulateInput(0, 8, 0))
  }
  // Wait for the emulated CPU to see the released edge before another press.
  // The fixture stores the previous A bit in CPU RAM $00, separate from SRAM.
  await expect.poll(async () => nesRam(await readState(player))[0]).toBe(0)
}

function nesRam(state: number[]) {
  // Fixture-specific assertion, NOT a production parser: the pinned fceumm
  // core serializes tagged RAM in its FCS payload inside a RASTATE container.
  const bytes = Buffer.from(state)
  expect(bytes.subarray(0, 7).toString()).toBe('RASTATE')
  const tag = bytes.indexOf(Buffer.from('RAM\0'))
  expect(tag).toBeGreaterThan(0)
  expect(bytes.readUInt32LE(tag + 4)).toBe(2048)
  const ram = bytes.subarray(tag + 8, tag + 8 + 2048)
  expect(ram.length).toBe(2048)
  return ram
}

function demoProgress(state: number[]) {
  // Jalan Pulang keeps player X at $00 and sprite X at OAM shadow RAM $0203.
  const ram = nesRam(state)
  return { playerX: ram[0], spriteX: ram[0x203] }
}

async function readState(player: FrameLocator) {
  return player.locator('body').evaluate(() => Array.from((window as unknown as EngineWindow).EJS_emulator.gameManager.getState()))
}

test('M1: a NES state deserializes into a fresh emulator without browser state storage', async ({ browser, baseURL }) => {
  const first = await browser.newContext({ baseURL })
  const second = await browser.newContext({ baseURL })
  try {
    const page = await first.newPage()
    const player = await launchDemo(page)
    await player.locator('canvas').click()
    await page.keyboard.down('ArrowRight')
    await expect.poll(async () => demoProgress(await readState(player)).playerX).toBeGreaterThan(0xa0)
    await page.keyboard.up('ArrowRight')
    const saved = await player.locator('body').evaluate(() => {
      const e = (window as unknown as EngineWindow).EJS_emulator
      e.pause()
      return { supported: e.gameManager.supportsStates(), state: Array.from(e.gameManager.getState()), name: e.getBaseFileName() }
    })
    expect(saved.supported).toBe(true)
    expect(saved.state.length).toBeGreaterThan(1000)
    const progress = demoProgress(saved.state)
    expect(progress.playerX).toBeGreaterThan(0x78)
    await first.close()

    const freshPage = await second.newPage()
    const fresh = await launchDemo(freshPage)
    const restored = await fresh.locator('body').evaluate((_body, state) => {
      const e = (window as unknown as EngineWindow).EJS_emulator
      e.pause()
      const before = Array.from(e.gameManager.getState())
      e.gameManager.loadState(new Uint8Array(state))
      // Resume after loading so the restored game also updates its sprites.
      e.play()
      return { before, name: e.getBaseFileName() }
    }, saved.state)
    expect(restored.name).toBe(saved.name)
    expect(demoProgress(restored.before).playerX).toBe(0x78)
    // Verify actual game progress after deserialization, not merely a copied
    // /game.state file or byte-identical whole states with changing timers.
    await expect.poll(async () => demoProgress(await readState(fresh))).toEqual(progress)
    await expect(freshPage.getByRole('alert')).toHaveCount(0)
  } finally {
    await first.close()
    await second.close()
  }
})

test('M1: CPU-written NES battery RAM is restored before boot in an isolated browser', async ({ browser, baseURL }) => {
  const first = await browser.newContext({ baseURL })
  const second = await browser.newContext({ baseURL })
  try {
    const page = await first.newPage()
    const player = await launchBattery(page)
    await expect.poll(async () => (await readBattery(player)).slice(0, 3)).toEqual([0x4d, 0x44, 0])
    // The emulated CPU, not FS.writeFile, writes the progress byte on A input.
    await pressA(player, 1)
    const saved = await readBattery(player)
    expect(saved.length).toBe(8192)
    const path = await player.locator('body').evaluate(() => (window as unknown as EngineWindow).EJS_emulator.gameManager.getSaveFilePath())
    expect(path).toMatch(/^\/data\/saves\/.+\.srm$/)
    await first.close()

    const freshPage = await second.newPage()
    const fresh = await launchBattery(freshPage, { path, bytes: saved })
    expect(await fresh.locator('body').evaluate(() => (window as unknown as EngineWindow).EJS_emulator.gameManager.getSaveFilePath())).toBe(path)
    await expect.poll(async () => (await readBattery(fresh)).slice(0, 3)).toEqual([0x4d, 0x44, 1])
    // Increment after boot proves the core read the imported RAM. If only the
    // virtual FS held the bytes, the core's next flush/input would lose them.
    await pressA(fresh, 2)
    await expect(freshPage.getByRole('alert')).toHaveCount(0)
  } finally {
    await first.close()
    await second.close()
  }
})

test('M1: the save event exports CPU progress and loadSaveFiles refreshes a running core', async ({ page }) => {
  const player = await launchBattery(page)
  await expect.poll(async () => (await readBattery(player)).slice(0, 3)).toEqual([0x4d, 0x44, 0])
  await pressA(player, 1)
  const exported = await player.locator('body').evaluate(() => {
    const e = (window as unknown as EngineWindow).EJS_emulator
    const events: number[][] = []
    e.on('saveSaveFiles', data => events.push(Array.from(data instanceof Uint8Array ? data : [])))
    const bytes = Array.from(e.gameManager.getSaveFile() || [])
    return { bytes, event: events[0], count: events.length }
  })
  expect(exported.count).toBe(1)
  expect(exported.event).toEqual(exported.bytes)
  expect(exported.bytes.slice(0, 3)).toEqual([0x4d, 0x44, 1])
  await pressA(player, 2)
  await player.locator('body').evaluate((_body, bytes) => {
    const gm = (window as unknown as EngineWindow).EJS_emulator.gameManager
    gm.writeFile(gm.getSaveFilePath(), new Uint8Array(bytes))
    gm.loadSaveFiles()
  }, exported.bytes)
  // getSaveFile flushes the core again: merely replacing the FS file without
  // loadSaveFiles would leave the in-core counter at 2 and fail this assertion.
  await expect.poll(async () => (await readBattery(player))[2]).toBe(1)
  await pressA(player, 2)
  await expect(page.getByRole('alert')).toHaveCount(0)
})
