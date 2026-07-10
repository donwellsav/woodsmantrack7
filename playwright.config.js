import { defineConfig } from '@playwright/test'

const baseURL = 'http://localhost:4173'

export default defineConfig({
  testDir: './tests',
  testMatch: 'smoke.spec.js',
  timeout: 30_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'npm run build && npm run preview -- --host localhost --port 4173',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
