/**
 * Playwright runs the dashboard in a real browser against a real server.
 *
 * Before the tests, `webServer` starts two processes and waits for each URL
 * to answer: the demo target (the shop we load test) and `mantix ui` for
 * examples/quick.ts, which serves the built dashboard from apps/web/dist.
 * Build it first: `pnpm --filter @mantix/web build`.
 */
import { defineConfig, devices } from '@playwright/test'

// examples/quick.ts sends its requests to localhost:4200, so the demo
// target must be there. The dashboard gets its own port, away from the
// default 4100 that `pnpm dev` and `pnpm mock` use.
const TARGET_PORT = 4200
const DASHBOARD_PORT = 4180

const isCI = process.env['CI'] !== undefined

export default defineConfig({
  testDir: '.',
  // One run at a time: every test shares the same `mantix ui` server.
  workers: 1,
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${DASHBOARD_PORT}`,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node apps/demo-target/src/server.ts',
      cwd: '..',
      env: { PORT: String(TARGET_PORT) },
      url: `http://localhost:${TARGET_PORT}/health`,
      reuseExistingServer: !isCI,
    },
    {
      command: `node packages/server/src/bin.ts ui examples/quick.ts --port ${DASHBOARD_PORT}`,
      cwd: '..',
      url: `http://localhost:${DASHBOARD_PORT}`,
      reuseExistingServer: !isCI,
    },
  ],
})
