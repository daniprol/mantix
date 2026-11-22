# mantix

Load tests that tell the truth, written in the TypeScript you already have.

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

```sh
npx mantix run checkout.ts   # headless, prints a summary, exits 99 on failed thresholds
npx mantix ui checkout.ts    # live dashboard at http://localhost:4100
```

Needs Node 22.19 or later, which runs `.ts` test files directly.

Documentation and source: https://github.com/daniprol/mantix
