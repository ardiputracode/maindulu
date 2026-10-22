import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  timeout: 90000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    channel: 'msedge',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: { args: ['--enable-unsafe-swiftshader'] },
    trace: 'retain-on-failure',
  },
  webServer: { command: 'npm run dev', url: 'http://localhost:5173', reuseExistingServer: !process.env.CI },
})
