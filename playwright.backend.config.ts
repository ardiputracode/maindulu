import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'
import config from './playwright.config'

export default defineConfig({
  ...config,
  testMatch: ['backend.spec.ts', 'app.spec.ts', 'account.spec.ts', 'server-saves.spec.ts', 'server-game-saves.spec.ts', 'catalog-api.spec.ts', 'catalog-cache.spec.ts', 'asset-cache-storage.spec.ts', 'server-assets.spec.ts', 'catalog-indexeddb-cache.spec.ts', 'catalog-indexeddb-restart.spec.ts', 'catalog-indexeddb-deployment.spec.ts', 'asset-cache-settings.spec.ts', 'admin-catalog.spec.ts', 'library.spec.ts', 'metadata.spec.ts', 'catalog-scans.spec.ts'],
  projects: [{ name: 'node-backend' }],
  use: { ...config.use, baseURL: 'http://localhost:4174' },
  webServer: {
    // Never load an operator's .env or enable real provider traffic in regression.
    command: 'node server/index.mjs',
    url: 'http://localhost:4174/api/health',
    reuseExistingServer: false,
    env: { MAIN_DULU_PORT: '4174', MAIN_DULU_HOST: '127.0.0.1', MAIN_DULU_DATA_DIR: resolve('test-results/backend-data'), MAIN_DULU_SCREENSCRAPER_ENABLED: 'false' },
  },
})
