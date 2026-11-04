import { defineConfig } from '@playwright/test'
import config from './playwright.config'

// Explicit opt-in: includes a real 500 MiB IndexedDB/restart memory spike.
// Uses an isolated test HTTP server, not Vite or a user's running backend.
export default defineConfig({
  ...config,
  testMatch: ['asset-cache-spike.spec.ts'],
  testIgnore: [],
  projects: [{ name: 'asset-cache-m0' }],
  outputDir: 'test-results/asset-cache-m0',
  workers: 1,
  retries: 0,
  timeout: 300000,
  use: { ...config.use, actionTimeout: 15000 },
  webServer: undefined,
})
