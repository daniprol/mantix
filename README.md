# Mantix

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

## Developing

You need Node 22.19 or newer (the repo pins 24 in `.node-version`) and
pnpm 12.

```sh
pnpm install   # installs dependencies and the git hooks
pnpm check     # format, lint, typecheck and test everything
```

See [AGENTS.md](./AGENTS.md) for the layout and conventions.
