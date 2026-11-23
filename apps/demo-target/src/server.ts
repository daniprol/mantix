/**
 * The demo target: a tiny shop API with planted problems, so there is
 * something interesting to point Mantix at.
 *
 *   GET  /health          always fast
 *   GET  /products/:sku   5–20 ms, plus EXTRA_PRODUCT_MS (a planted
 *                         slowdown, to try mantix compare)
 *   GET  /cart/:id        10–40 ms; ~1% of responses send `price` as a
 *                         string (schema drift, caught by `expect`)
 *   POST /cart/items      20–60 ms; body { cartId, sku, qty }
 *   POST /checkout        50–150 ms; body { cartId }; ~2% answer 503, and
 *                         once every 30 s it stalls for 1.5 s (the
 *                         coordinated-omission demo)
 *
 * Plain node:http, no dependencies. Node runs this TypeScript directly.
 */
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from 'node:http'

const port = Number(process.env['PORT'] ?? 4200)
/**
 * A slowdown to plant on purpose, to try `mantix compare`: every product
 * page takes this many extra milliseconds.
 */
const extraProductMs = Number(process.env['EXTRA_PRODUCT_MS'] ?? 0)
const startedAt = Date.now()

/** Each 30 s cycle, checkout stalls during this window (ms into the cycle). */
const STALL_CYCLE_MS = 30_000
const STALL_FROM_MS = 15_000
const STALL_MS = 1_500

interface CartItem {
  sku: string
  qty: number
  price: number
}

const carts = new Map<string, Array<CartItem>>()

const between = (min: number, max: number): number =>
  min + Math.random() * (max - min)

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

/** A stable fake price per SKU, in whole cents turned into a number. */
const priceOf = (sku: string): number => {
  let hash = 0
  for (const char of sku) hash = (hash * 31 + char.charCodeAt(0)) % 10_000
  return Math.round(500 + hash) / 100
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

const readJson = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Array<Buffer> = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text.length === 0 ? {} : JSON.parse(text)
}

/** How long a checkout arriving now must wait for the current stall. */
const stallRemaining = (): number => {
  const phase = (Date.now() - startedAt) % STALL_CYCLE_MS
  const into = phase - STALL_FROM_MS
  return into >= 0 && into < STALL_MS ? STALL_MS - into : 0
}

const cartView = (id: string) => {
  const items = carts.get(id) ?? []
  // The planted bug: now and then a price is serialised as a string.
  const drift = Math.random() < 0.01
  return {
    id,
    items: items.map(item =>
      drift ? { ...item, price: item.price.toFixed(2) } : item,
    ),
  }
}

const handle = async (
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const parts = url.pathname.split('/').filter(part => part.length > 0)
  const route = `${req.method} /${parts[0] ?? ''}`

  if (route === 'GET /health' && parts.length === 1) {
    return send(res, 200, { ok: true })
  }

  if (route === 'GET /products' && parts.length === 2) {
    await sleep(between(5, 20) + extraProductMs)
    const sku = parts[1]!
    return send(res, 200, { sku, name: `Product ${sku}`, price: priceOf(sku) })
  }

  if (route === 'GET /cart' && parts.length === 2) {
    await sleep(between(10, 40))
    return send(res, 200, cartView(parts[1]!))
  }

  if (route === 'POST /cart' && parts[1] === 'items' && parts.length === 2) {
    const body = (await readJson(req)) as {
      cartId?: unknown
      sku?: unknown
      qty?: unknown
    }
    if (typeof body.cartId !== 'string' || typeof body.sku !== 'string') {
      return send(res, 400, { error: 'cartId and sku are required' })
    }
    await sleep(between(20, 60))
    const items = carts.get(body.cartId) ?? []
    items.push({
      sku: body.sku,
      qty: typeof body.qty === 'number' ? body.qty : 1,
      price: priceOf(body.sku),
    })
    // Keep memory bounded during long tests.
    if (carts.size > 50_000) carts.clear()
    carts.set(body.cartId, items)
    return send(res, 200, cartView(body.cartId))
  }

  if (route === 'POST /checkout' && parts.length === 1) {
    const body = (await readJson(req)) as { cartId?: unknown }
    if (typeof body.cartId !== 'string') {
      return send(res, 400, { error: 'cartId is required' })
    }
    await sleep(stallRemaining() + between(50, 150))
    if (Math.random() < 0.02) {
      return send(res, 503, { error: 'payment service unavailable' })
    }
    carts.delete(body.cartId)
    return send(res, 200, {
      orderId: `order-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    })
  }

  return send(res, 404, { error: `no route for ${req.method} ${url.pathname}` })
}

const server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    send(res, 400, {
      error: error instanceof Error ? error.message : 'bad request',
    })
  })
})

// Keep connections open between requests, like a real API behind a proxy.
server.keepAliveTimeout = 30_000

server.listen(port, () => {
  console.log(`demo target listening on http://localhost:${port}`)
})
