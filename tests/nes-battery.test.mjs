import test from 'node:test'
import assert from 'node:assert/strict'
import { buildNesBatteryFixture } from './fixtures/nes-battery.mjs'

test('original battery fixture is deterministic NROM-128 with battery-backed PRG RAM', () => {
  const rom = buildNesBatteryFixture()
  assert.deepEqual(rom, buildNesBatteryFixture())
  assert.equal(rom.length, 16 + 16384 + 8192)
  assert.equal(rom.subarray(0, 4).toString('hex'), '4e45531a')
  assert.equal(rom[4], 1)
  assert.equal(rom[5], 1)
  assert.equal(rom[6], 2)
  assert.equal(rom[7], 0)
  assert.equal(rom[8], 1)
  for (const offset of [0x3ffa, 0x3ffc, 0x3ffe]) {
    assert.ok(rom.readUInt16LE(16 + offset) >= 0x8000)
    assert.ok(rom.readUInt16LE(16 + offset) < 0xc000)
  }
})
