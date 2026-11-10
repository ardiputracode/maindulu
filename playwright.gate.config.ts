import { defineConfig } from '@playwright/test'
import config from './playwright.config'

// Every gate scenario starts its own real backend and private data directory.
// No shared server (or relaxed rate limiter) is needed for this security suite.
export default defineConfig({
  ...config,
  testMatch: ['gate.spec.ts'],
  projects: [{ name: 'node-backend' }],
  outputDir: 'test-results/gate',
  webServer: undefined,
})
