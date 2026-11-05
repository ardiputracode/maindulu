import { defineConfig } from '@playwright/test'
import config from './playwright.config'

// Production resolver + real Node backend/IDB; not the M0 storage prototype.
// Explicit opt-in, sequential, no automatic retry of hundreds-of-MiB downloads.
export default defineConfig({
  ...config,
  testMatch: ['catalog-indexeddb-large.spec.ts'],
  testIgnore: [],
  projects: [{ name: 'asset-cache-m5-large' }],
  outputDir: 'test-results/asset-cache-m5-large',
  workers: 1,
  retries: 0,
  timeout: 600000,
  use: { ...config.use, trace: 'off' }, // Do not duplicate huge bodies in traces.
  webServer: undefined,
})
