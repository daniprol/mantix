/** A local HTTP server on a random port, for client and runner tests. */
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface TestServer {
  readonly url: string
  readonly close: () => Promise<void>
}

export const startServer = async (): Promise<TestServer> => {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname.startsWith('/items/')) {
      return json(200, {
        id: url.pathname.slice('/items/'.length),
        q: url.searchParams.get('q'),
        auth: req.headers['authorization'] ?? null,
        price: url.searchParams.get('drift') === '1' ? '1.00' : 1,
      })
    }
    if (url.pathname === '/status/503') return json(503, { error: 'down' })
    if (url.pathname === '/slow') {
      const timer = setTimeout(() => json(200, { ok: true }), 2000)
      res.on('close', () => clearTimeout(timer))
      return
    }
    if (url.pathname === '/echo' && req.method === 'POST') {
      let body = ''
      req.on('data', chunk => (body += chunk))
      req.on('end', () =>
        json(200, { contentType: req.headers['content-type'], body }),
      )
      return
    }
    if (url.pathname === '/wait') {
      setTimeout(() => json(200, { ok: true }), 50)
      return
    }
    json(404, { error: 'not found' })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
