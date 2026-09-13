import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  testDir: '.',
  testMatch: 'onboard.spec.mjs',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4178', headless: true, launchOptions: { args: ['--disable-dev-shm-usage'] }, viewport: { width: 1280, height: 800 } },
  webServer: {
    command: 'node scripts/serve-webapp-test.mjs',
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    url: 'http://127.0.0.1:4178/',
    reuseExistingServer: false,
  },
})
