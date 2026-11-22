# Mantix: notes for coding agents

Mantix is a load-testing tool. Tests are plain TypeScript; the engine is
Effect 4; the dashboard is a Foldkit app. The design is in the proposal
(see README). Dani, the owner, is learning Effect and Foldkit through this
code, so keep it **simple and readable**, with short comments that explain
the _why_ and name the Effect or Foldkit idea being used.

## Layout

- `packages/api` (`@mantix/api`): schemas (Histogram, Second, Run) and the
  HttpApi contract. Browser safe. No Node APIs, no engine code.
- `packages/core` (`@mantix/core`): the engine and the scenario API. Node only.
- `packages/server` (`mantix`): the published CLI and HTTP server. Re-exports
  the scenario API so test files `import { scenario } from 'mantix'`.
- `apps/web`: the Foldkit dashboard. Read `apps/web/FOLDKIT.md` first.
- `apps/docs`: Astro Starlight documentation site.
- `apps/demo-target`: a small HTTP server with planted bugs to test against.
- `examples/`: example test files.
- `e2e/`: Playwright tests of the dashboard against `mantix ui`.

## Rules

- Effect **4.1**, not 3. Most material online is Effect 3. Translate:
  `Context.Tag` → `Context.Service`; `@effect/platform` → `effect/http`,
  `effect/http-api`; `@effect/cli` → `effect/cli`; `Effect.fork` →
  `Effect.forkChild`; `Effect.catchAll` → `Effect.catch`; `Either` →
  `Result`; `TestClock` from `effect/testing`. The source of truth is
  `node_modules/effect/ai-docs/` and the `.d.ts` files.
- Imports between files use the `.ts` extension; Node runs the source
  directly (type stripping), so no enums, namespaces or parameter properties.
- Versions live in the catalog in `pnpm-workspace.yaml`. Packages use
  `"catalog:"`. Never add a version that is not in the catalog.
- Prefer `Effect.gen` and `Effect.fn("name")` over long pipes.
- Numbers in schemas use `Schema.Finite`.
- Never store or average percentiles. Merge histograms, then compute.

## Commands

```sh
pnpm install          # also installs the git hooks (prek)
pnpm check            # format check, lint, typecheck, tests
pnpm test             # Vitest, all packages
pnpm format           # oxfmt
pnpm knip             # unused files, exports and dependencies
pnpm e2e              # Playwright, in e2e/ (build apps/web first)
pnpm build            # builds the web app, then the npm package (packages/server/dist)
```
