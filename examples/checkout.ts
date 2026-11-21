/**
 * A realistic shopping flow, written with plain async functions.
 *
 * Each iteration is one shopper: look at a product, add it to a cart, read
 * the cart back, and check out. The cart response is validated with an
 * Effect Schema (any Standard Schema library works the same way), so the
 * demo target's occasional `price: "19.99"` shows up as a SchemaMismatch
 * instead of passing silently.
 *
 *   pnpm --filter @mantix/demo-target start
 *   pnpm mantix run examples/checkout.ts
 */
import { Schema } from 'effect'
import { rate, scenario } from 'mantix'

const Cart = Schema.Struct({
  id: Schema.String,
  items: Schema.Array(
    Schema.Struct({
      sku: Schema.String,
      qty: Schema.Finite,
      price: Schema.Finite,
    }),
  ),
})

const Order = Schema.Struct({ orderId: Schema.String })

const skus = ['A1', 'B2', 'C3', 'D4', 'E5']

export default scenario({
  name: 'checkout',
  baseUrl: 'http://localhost:4200',
  // Warm up for 10 s, hold 40 iterations/s, then cool down.
  load: rate.ramping({
    start: 0,
    stages: [
      { duration: '10s', target: 40 },
      { duration: '40s', target: 40 },
      { duration: '10s', target: 0 },
    ],
  }),
  thresholds: [
    'p99 < 500ms',
    'errors < 5%',
    { endpoint: 'POST /checkout', check: 'p95 < 300ms' },
  ],
  iteration: async ({ http, vu, iteration }) => {
    const sku = skus[(vu + iteration) % skus.length]!
    const cartId = `cart-${vu}-${iteration}`

    await http.get('/products/:sku', { params: { sku } })
    await http.post('/cart/items', { json: { cartId, sku, qty: 1 } })
    // Schema.toStandardSchemaV1 turns an Effect Schema into a Standard
    // Schema, which is what `expect` accepts.
    const cart = await http.get('/cart/:id', {
      params: { id: cartId },
      expect: Schema.toStandardSchemaV1(Cart),
    })
    if (cart.body.items.length === 0) {
      throw new Error('cart is empty after adding an item')
    }
    await http.post('/checkout', {
      json: { cartId },
      expect: Schema.toStandardSchemaV1(Order),
    })
  },
})
