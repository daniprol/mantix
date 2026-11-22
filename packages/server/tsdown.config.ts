/**
 * How the published `mantix` package is built (`pnpm --filter mantix build`).
 *
 * In this repo nothing is built: Node runs the TypeScript sources directly.
 * For npm, tsdown bundles the CLI and the public API into dist/:
 *
 * - @mantix/api and @mantix/core are private workspace packages, so their
 *   code is bundled in. effect, @effect/platform-node and undici stay real
 *   dependencies that npm installs.
 * - The two entries share chunks, so a test file that imports `mantix`
 *   and the CLI that runs it use the same engine code.
 * - The built dashboard (apps/web/dist) is copied to dist/web, where the
 *   server looks for it (see findWebRoot in Server.ts). @mantix/web is a
 *   devDependency so `pnpm -r build` always builds it first.
 */
import { existsSync } from 'node:fs'
import { defineConfig } from 'tsdown'

const webDist = '../../apps/web/dist'

if (!existsSync(`${webDist}/index.html`)) {
  throw new Error(
    'The dashboard is not built. Run `pnpm --filter @mantix/web build` first, or `pnpm build` from the repo root.',
  )
}

export default defineConfig({
  entry: { index: 'src/index.ts', bin: 'src/bin.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22.19',
  // Type declarations for `import { scenario } from 'mantix'`. A separate
  // tsconfig, because the declarations cover the bundled workspace code.
  dts: { tsconfig: 'tsconfig.build.json' },
  // Bundle our own workspace packages; every other import stays external.
  deps: { alwaysBundle: [/^@mantix\//] },
  copy: [{ from: webDist, to: 'dist', rename: 'web' }],
})
