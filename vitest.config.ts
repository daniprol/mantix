import { defineConfig } from 'vitest/config'

// One Vitest run for the whole repo. Each package is a "project" with its
// own environment: Node for the engine and server, happy-dom for the web app.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
  },
})
