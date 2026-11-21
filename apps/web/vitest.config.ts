import { defineProject } from 'vitest/config'

// One project in the root Vitest run. Foldkit's packages ship untranspiled
// pieces Vitest must process itself, hence `inline`.
export default defineProject({
  test: {
    name: 'web',
    include: ['src/**/*.test.ts'],
    environment: 'happy-dom',
    setupFiles: ['./src/vitest-setup.ts'],
    server: {
      deps: {
        inline: ['foldkit', '@foldkit/ui', '@foldkit/devtools'],
      },
    },
  },
})
