<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/mantix-logo-dark.svg">
    <img alt="Mantix" src="assets/logo/mantix-logo-light.svg" height="64">
  </picture>
</h1>

Load tests that tell the truth, written in the TypeScript you already have.

Mantix is a load-testing and benchmarking tool inspired by Locust and k6.
Tests are plain TypeScript (async by default, with an optional Effect API),
the engine is built on [Effect](https://effect.website), and the live
dashboard is a [Foldkit](https://foldkit.dev) app.

```ts
import { rate, scenario } from 'mantix'

export default scenario({
  name: 'browse',
  baseUrl: 'http://localhost:4200',
  load: rate.constant(20, { duration: '30s' }),
  thresholds: ['p99 < 250ms', 'errors < 1%'],
  iteration: async ({ http }) => {
    await http.get('/products/:sku', { params: { sku: 'A1' } })
  },
})
```

> Work in progress: the first working version is being built through pull
> requests.

## Try it

The repo ships a small demo shop with a few planted bugs (a checkout that
stalls every 30 seconds, occasional 503s, and a price that sometimes comes
back as a string). Start it in one terminal:

```sh
pnpm install
pnpm --filter @mantix/demo-target start    # http://localhost:4200
```

Then, in another terminal, either run a test from the command line:

```sh
pnpm mantix run examples/checkout.ts
```

or open the live dashboard and start runs from the browser:

```sh
pnpm --filter @mantix/web build            # build the dashboard once
pnpm mantix ui examples/checkout.ts        # http://localhost:4100
```

## Developing

You need Node 22.19 or newer (the repo pins 24 in `.node-version`) and
pnpm 12.

```sh
pnpm install   # installs dependencies and the git hooks
pnpm check     # format, lint, typecheck and test everything
```

The documentation site lives in `apps/docs` (Astro Starlight) and is
published to https://daniprol.github.io/mantix/ on every push to main:

```sh
pnpm --filter @mantix/docs dev     # http://localhost:4321/mantix/
pnpm --filter @mantix/docs build   # static site in apps/docs/dist
```

See [AGENTS.md](./AGENTS.md) for the layout and conventions.
