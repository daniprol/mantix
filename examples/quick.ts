/**
 * The smallest useful Mantix test: one endpoint at a steady rate.
 *
 *   pnpm --filter @mantix/demo-target start
 *   pnpm mantix run examples/quick.ts
 */
import { rate, scenario } from 'mantix'

export default scenario({
  name: 'quick',
  baseUrl: 'http://localhost:4200',
  load: rate.constant(50, { duration: '30s' }),
  thresholds: ['p99 < 100ms', 'errors < 1%'],
  iteration: async ({ http }) => {
    await http.get('/products/:sku', { params: { sku: 'A1' } })
  },
})
