import { defineConfig } from 'vitest/config'

// One Vitest run for the whole repo. Each package is a "project" with its
// own environment: Node for the engine and server, happy-dom for the web app.
// A package joins the run by having a vitest.config.ts.
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'],
  },
})
