import { defineConfig } from 'vite'

import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss(), foldkit()],
  optimizeDeps: {
    entries: ['src/entry.ts'],
  },
  server: {
    // The dashboard talks to the Mantix server (or `pnpm mock`) on 4100.
    proxy: { '/api': 'http://localhost:4100' },
  },
})
