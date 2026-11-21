/**
 * The same shopping flow as checkout.ts, written with Effect.
 *
 * `scenario.effect` has the same shape, but `http` returns Effects. That
 * buys things plain async can't do as neatly. Here: the checkout is retried
 * when the payment service answers 503, with a Schedule, in one line. A
 * retry is a new request, so every attempt is still recorded honestly.
 *
 *   pnpm --filter @mantix/demo-target start
 *   pnpm mantix run examples/checkout.effect.ts
 */
import { Effect, Schedule, Schema } from 'effect'
import { rate, scenario } from 'mantix'

const Cart = Schema.toStandardSchemaV1(
  Schema.Struct({
    id: Schema.String,
    items: Schema.Array(
      Schema.Struct({
        sku: Schema.String,
        qty: Schema.Finite,
        price: Schema.Finite,
      }),
    ),
  }),
)

const Order = Schema.toStandardSchemaV1(
  Schema.Struct({ orderId: Schema.String }),
)

const skus = ['A1', 'B2', 'C3', 'D4', 'E5']

export default scenario.effect({
  name: 'checkout (effect)',
  baseUrl: 'http://localhost:4200',
  load: rate.ramping({
    start: 0,
    stages: [
      { duration: '10s', target: 40 },
      { duration: '40s', target: 40 },
      { duration: '10s', target: 0 },
    ],
  }),
  thresholds: ['p99 < 500ms', 'errors < 5%'],
  iteration: ({ http, vu, iteration }) =>
    Effect.gen(function* () {
      const sku = skus[(vu + iteration) % skus.length]!
      const cartId = `cart-${vu}-${iteration}`

      yield* http.get('/products/:sku', { params: { sku } })
      yield* http.post('/cart/items', { json: { cartId, sku, qty: 1 } })
      yield* http.get('/cart/:id', { params: { id: cartId }, expect: Cart })

      // Retry only 503s, at most twice, 50 ms apart. Any other failure
      // (a timeout, a schema mismatch) ends the iteration straight away.
      yield* http.post('/checkout', { json: { cartId }, expect: Order }).pipe(
        Effect.retry({
          schedule: Schedule.spaced('50 millis'),
          times: 2,
          while: error => error.status === 503,
        }),
      )
    }),
})
