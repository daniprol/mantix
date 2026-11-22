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

## Install

Mantix needs Node 22.19 or newer, which runs `.ts` test files directly.

```sh
npm install --save-dev mantix
pnpm add --save-dev mantix
bun add --dev mantix
```

## Write a test

```ts
// checkout.ts
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

## Run it

```sh
npx mantix run checkout.ts   # in the terminal; exits 99 if a threshold fails
npx mantix ui checkout.ts    # live dashboard at http://localhost:4100
```

With pnpm use `pnpm mantix …`, and with Bun `bunx mantix …`. Mantix itself
runs on Node, so Node must be installed even when you use Bun.

The [Quick start](https://daniprol.github.io/mantix/start/quick-start/)
walks through a first test against a small demo server.

## Try it from this repository

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

See [AGENTS.md](./AGENTS.md) for the layout and conventions.

## License

[MIT](./LICENSE)
