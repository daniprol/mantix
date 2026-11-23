import { type Plugin, defineConfig } from 'vite'

import { foldkit } from '@foldkit/vite-plugin'
import { REPORT_PLACEHOLDER, reportSlot } from '@mantix/api'
import tailwindcss from '@tailwindcss/vite'

/**
 * Inline code must not end its own <script> early: `</script` and `<!--`
 * inside a string would. Escaped like this they mean the same in JS.
 */
const safeInScript = (code: string): string =>
  code.replaceAll('</script', '<\\/script').replaceAll('<!--', '<\\!--')

/**
 * `vite build --mode report` writes dist/report.html: the whole dashboard
 * in one file, plus an empty slot that `mantix report` fills with runs.
 *
 * Why one file: a page opened from disk (file://) is not allowed to load
 * module scripts from other files, and one file is easy to attach or
 * upload. So the JS and CSS go inline, and the fonts inline as data URLs.
 */
const singleFileReport = (): Plugin => ({
  name: 'mantix:single-file-report',
  apply: 'build',
  enforce: 'post',
  generateBundle(_options, bundle) {
    const page = bundle['index.html']
    const chunks = Object.values(bundle).filter(file => file.type === 'chunk')
    if (page?.type !== 'asset' || chunks.length !== 1) {
      throw new Error('The report expects one page and one JS chunk.')
    }
    let html = String(page.source)
    for (const file of Object.values(bundle)) {
      // A replacer function, so a `$` in the code is never read as a
      // replacement pattern.
      if (file.type === 'chunk') {
        html = html.replace(
          /<script type="module"[^>]*><\/script>/,
          () => `<script type="module">${safeInScript(file.code)}</script>`,
        )
      } else if (file.fileName.endsWith('.css')) {
        html = html.replace(
          /<link rel="stylesheet"[^>]*>/,
          () => `<style>${safeInScript(String(file.source))}</style>`,
        )
      }
      // Everything is in the page now; fonts that were not inlined are
      // the rarely used subsets, which fall back to a system font.
      if (file !== page) {
        delete bundle[file.fileName]
      }
    }
    page.fileName = 'report.html'
    page.source = html.replace(
      '</body>',
      () => `${reportSlot(REPORT_PLACEHOLDER)}\n  </body>`,
    )
  },
})

export default defineConfig(({ mode }) =>
  mode === 'report'
    ? {
        plugins: [tailwindcss(), foldkit(), singleFileReport()],
        build: {
          // The dashboard's own build is already in dist: keep it.
          emptyOutDir: false,
          // Only the Latin fonts go in, to keep the file small.
          assetsInlineLimit: (file: string) =>
            /-latin-wght-/.test(file) ? true : !file.endsWith('.woff2'),
        },
      }
    : {
        plugins: [tailwindcss(), foldkit()],
        optimizeDeps: {
          entries: ['src/entry.ts'],
        },
        server: {
          // The dashboard talks to the Mantix server (or `pnpm mock`) on 4100.
          proxy: { '/api': 'http://localhost:4100' },
        },
      },
)
