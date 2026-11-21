# @mantix/demo-target

A tiny shop API with planted problems, for trying Mantix against.

```sh
pnpm --filter @mantix/demo-target start   # http://localhost:4200
PORT=5000 pnpm --filter @mantix/demo-target start
```

| Endpoint             | Latency   | Planted problem                                   |
| -------------------- | --------- | ------------------------------------------------- |
| `GET /health`        | instant   |                                                   |
| `GET /products/:sku` | 5–20 ms   |                                                   |
| `GET /cart/:id`      | 10–40 ms  | ~1% of responses send `price` as a string (drift) |
| `POST /cart/items`   | 20–60 ms  |                                                   |
| `POST /checkout`     | 50–150 ms | ~2% answer 503; stalls 1.5 s once every 30 s      |

Shapes:

- `GET /products/:sku` → `{ sku, name, price }`
- `GET /cart/:id` → `{ id, items: [{ sku, qty, price }] }`
- `POST /cart/items` with `{ cartId, sku, qty }` → the cart
- `POST /checkout` with `{ cartId }` → `{ orderId }`

The checkout stall starts 15 s after the server starts and repeats every
30 s. Requests that arrive during it wait until it ends. It is there to show
coordinated omission: an open-model test records every request that arrived
during the stall as slow, so the corrected p99 shows the stall, while the
uncorrected numbers of a closed-model tool would hide it.

Carts live in memory and are cleared when there are more than 50,000.
