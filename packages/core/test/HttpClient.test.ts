import { Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  type ClientConfig,
  RequestCancelled,
  makeAgent,
  makeHttp,
  makeTiming,
  send,
} from '../src/HttpClient.ts'
import { Recorder } from '../src/Recorder.ts'
import { RequestFailed } from '../src/Scenario.ts'
import { type TestServer, startServer } from './server.ts'

let server: TestServer
let config: ClientConfig
let recorder: Recorder
const agent = makeAgent()
const now = () => performance.now()

beforeAll(async () => {
  server = await startServer()
})
afterAll(async () => {
  await agent.destroy()
  await server.close()
})

const fresh = (overrides: Partial<ClientConfig> = {}): ClientConfig => {
  recorder = new Recorder()
  config = {
    agent,
    recorder,
    now,
    baseUrl: server.url,
    headers: { authorization: 'Bearer secret-token' },
    timeoutMs: 1000,
    ...overrides,
  }
  return config
}

const second = () => recorder.snapshot(0, { target: 0, vus: 0, loopLagMs: 0 })

/** Await a promise that must reject, and return the error. */
const rejection = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => expect.fail('expected the request to fail'),
    (error: unknown) => error,
  )

describe('http client', () => {
  it('fills params and query, keeps the template as the endpoint name', async () => {
    const http = makeHttp(fresh(), makeTiming(), undefined)
    const response = await http.get<{ id: string; q: string; auth: string }>(
      '/items/:id',
      { params: { id: 'a b' }, query: { q: 'x' } },
    )
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ id: 'a%20b', q: 'x' })
    // Scenario headers are sent...
    expect(response.body.auth).toBe('Bearer secret-token')
    const [endpoint] = second().endpoints
    expect(endpoint).toMatchObject({
      endpoint: 'GET /items/:id',
      requests: 1,
      statuses: { '200': 1 },
      errors: {},
    })
  })

  it('sends JSON bodies and honours a custom name', async () => {
    const http = makeHttp(fresh(), makeTiming(), undefined)
    const response = await http.post<{ contentType: string; body: string }>(
      '/echo',
      { json: { a: 1 }, name: 'echo' },
    )
    expect(response.body).toEqual({
      contentType: 'application/json',
      body: '{"a":1}',
    })
    expect(second().endpoints[0]!.endpoint).toBe('echo')
  })

  it('records a status outside okStatus as HttpStatus', async () => {
    const http = makeHttp(fresh(), makeTiming(), undefined)
    const error = await rejection(http.get('/status/503'))
    expect(error).toBeInstanceOf(RequestFailed)
    expect(error).toMatchObject({ kind: 'HttpStatus', status: 503 })
    const s = second()
    expect(s.endpoints[0]).toMatchObject({
      statuses: { '503': 1 },
      errors: { HttpStatus: 1 },
    })
    expect(s.errorSamples[0]).toEqual({
      endpoint: 'GET /status/503',
      kind: 'HttpStatus',
      message: '503 Service Unavailable',
    })
    // A custom okStatus accepts it.
    const ok = await http.get('/status/503', { okStatus: s => s === 503 })
    expect(ok.status).toBe(503)
  })

  it('records a Timeout', async () => {
    const http = makeHttp(fresh(), makeTiming(), undefined)
    const error = await rejection(http.get('/slow', { timeout: '100ms' }))
    expect(error).toMatchObject({ kind: 'Timeout' })
    const [endpoint] = second().endpoints
    expect(endpoint!.errors).toEqual({ Timeout: 1 })
    expect(endpoint!.statuses).toEqual({})
  })

  it('records a Transport error when nothing listens', async () => {
    const http = makeHttp(
      fresh({ baseUrl: 'http://127.0.0.1:1' }),
      makeTiming(),
      undefined,
    )
    const error = await rejection(http.get('/x'))
    expect(error).toMatchObject({ kind: 'Transport' })
  })

  it('validates with a Standard Schema and records SchemaMismatch', async () => {
    const Item = Schema.toStandardSchemaV1(
      Schema.Struct({ id: Schema.String, price: Schema.Finite }),
    )
    const http = makeHttp(fresh(), makeTiming(), undefined)
    const ok = await http.get('/items/:id', {
      params: { id: '1' },
      expect: Item,
    })
    expect(ok.body.price).toBe(1)
    const error = await rejection(
      http.get('/items/:id', {
        params: { id: '1' },
        query: { drift: 1 },
        expect: Item,
      }),
    )
    expect(error).toMatchObject({ kind: 'SchemaMismatch' })
    const s = second()
    expect(s.endpoints[0]!.errors).toEqual({ SchemaMismatch: 1 })
    expect(s.errorSamples[0]!.message).toMatch(/^\$\.price: /)
    // Never leaks header values into samples.
    expect(JSON.stringify(s)).not.toContain('secret-token')
    // validateSample: 0 skips validation.
    const skipped = await http.get('/items/:id', {
      params: { id: '1' },
      query: { drift: 1 },
      expect: Item,
      validateSample: 0,
    })
    expect(skipped.status).toBe(200)
  })

  it('cancels without recording when the signal aborts', async () => {
    const http = makeHttp(fresh(), makeTiming(), AbortSignal.timeout(50))
    const error = await rejection(http.get('/slow'))
    expect(error).toBeInstanceOf(RequestCancelled)
    expect(second().endpoints).toEqual([])
  })

  it('corrects the first request of a late iteration only', async () => {
    fresh()
    // The schedule wanted this iteration 500 ms ago (a stalled generator).
    const timing = makeTiming(now() - 500)
    await send(config, timing, 'GET', '/wait', { name: 'first' }, undefined)
    await send(config, timing, 'GET', '/wait', { name: 'second' }, undefined)
    const [first, later] = second().endpoints
    // ~50 ms of real latency, plus the 500 ms the iteration started late.
    expect(first!.uncorrected.max / 1000).toBeLessThan(400)
    expect(first!.latency.max / 1000).toBeGreaterThanOrEqual(500)
    expect(first!.latency.max - first!.uncorrected.max).toBeGreaterThanOrEqual(
      490_000,
    )
    // The second request was not delayed by the schedule.
    expect(later!.latency.max).toBe(later!.uncorrected.max)
  })

  it('throws a plain Error (a ScriptError) for a path with no host', async () => {
    const http = makeHttp(
      fresh({ baseUrl: undefined }),
      makeTiming(),
      undefined,
    )
    const error = await rejection(http.get('/x'))
    expect(error).not.toBeInstanceOf(RequestFailed)
    expect(second().endpoints).toEqual([])
  })
})
