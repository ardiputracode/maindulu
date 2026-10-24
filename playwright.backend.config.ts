import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'
import config from './playwright.config'

export default defineConfig({
  ...config,
  testMatch: ['backend.spec.ts', 'app.spec.ts', 'account.spec.ts'],
  projects: [{ name: 'node-backend' }],
  use: { ...config.use, baseURL: 'http://localhost:4174' },
  webServer: {
    command: 'npm start',
    url: 'http://localhost:4174/api/health',
    reuseExistingServer: false,
    env: { MAIN_DULU_PORT: '4174', MAIN_DULU_HOST: '127.0.0.1', MAIN_DULU_DATA_DIR: resolve('test-results/backend-data') },
  },
})
