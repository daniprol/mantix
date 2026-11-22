import { Layer, Schema } from 'effect'
import { HttpRouter, HttpServer } from 'effect/http'
import { mkdtempSync, rmSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { RunInfo, Second, TestInfo } from '@mantix/api'
import { type TestDefinition, rate, scenario } from '@mantix/core'

import { RunStore } from '../src/RunStore.ts'
import { Runs } from '../src/Runs.ts'
import { ApiRoutes } from '../src/Server.ts'

// A tiny target server for the test run to hit.
let target: Server
let test: TestDefinition
let handler: (request: Request) => Promise<Response>
let dispose: () => Promise<void>

beforeAll(async () => {
  target = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end('{"ok":true}')
  })
  await new Promise<void>(resolve => target.listen(0, resolve))
  const { port } = target.address() as AddressInfo

  test = scenario({
    name: 'tiny',
    baseUrl: `http://localhost:${port}`,
    load: rate.constant(20, { duration: '2s' }),
    thresholds: ['errors < 1%'],
    iteration: async ({ http }) => {
      await http.get('/ok')
    },
  })
  // toWebHandler turns the API layer into a plain fetch-style function, so
  // we can call it without opening a port.
  ;({ handler, dispose } = HttpRouter.toWebHandler(
    ApiRoutes.pipe(
      Layer.provide(Runs.layer(test, 'tiny.ts')),
      Layer.provide(RunStore.memory),
      Layer.provide(HttpServer.layerServices),
    ),
  ))
})

afterAll(async () => {
  await dispose()
  target.close()
})

const call = (path: string, init?: RequestInit) =>
  handler(new Request(`http://mantix.test${path}`, init))

// Decode responses with the same schemas the dashboard uses.
const asRun = async (response: Response) =>
  Schema.decodeUnknownSync(RunInfo)(await response.json())

const post = (path: string, body: unknown = {}) =>
  call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('mantix ui server', () => {
  it('describes the loaded test', async () => {
    const response = await call('/api/test')
    expect(response.status).toBe(200)
    const info = Schema.decodeUnknownSync(TestInfo)(await response.json())
    expect(info.name).toBe('tiny')
    expect(info.thresholds).toEqual(['errors < 1%'])
  })

  it('starts a run, refuses a second one, and streams it live', async () => {
    const started = await post('/api/runs')
    expect(started.status).toBe(200)
    const run = await asRun(started)
    expect(run.status).toBe('running')

    const second = await post('/api/runs')
    expect(second.status).toBe(409)

    // The event stream replays the run and ends when the run ends.
    const events = await call(`/api/runs/${run.id}/events`)
    expect(events.headers.get('content-type')).toContain('text/event-stream')
    const text = await events.text()
    expect(text).toContain('"_tag":"Second"')
    expect(text).toContain('"status":"finished"')

    const list = Schema.decodeUnknownSync(Schema.Array(RunInfo))(
      await (await call('/api/runs')).json(),
    )
    expect(list).toHaveLength(1)
    expect(list[0]!.status).toBe('finished')
    expect(list[0]!.thresholds[0]!.passed).toBe(true)
  }, 15_000)

  it('stops a run early', async () => {
    const run = await asRun(await post('/api/runs', { duration: 30 }))
    const stopped = await asRun(await post(`/api/runs/${run.id}/stop`))
    expect(stopped.status).toBe('stopped')
  }, 15_000)

  it('answers 404 for a run that does not exist', async () => {
    const response = await call('/api/runs/nope')
    expect(response.status).toBe(404)
  })
})

describe('run history', () => {
  /** A server for the tiny test, saving its history to `file`. */
  const startServer = (file: string) => {
    const web = HttpRouter.toWebHandler(
      ApiRoutes.pipe(
        Layer.provide(Runs.layer(test, 'tiny.ts')),
        Layer.provide(RunStore.layer(file)),
        Layer.provide(HttpServer.layerServices),
      ),
    )
    return {
      call: (path: string, init?: RequestInit) =>
        web.handler(new Request(`http://mantix.test${path}`, init)),
      dispose: web.dispose,
    }
  }

  it('keeps runs across a restart and replays them', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'mantix-server-'))
    const file = join(folder, 'history.db')
    try {
      // First server: run the test to the end.
      const first = startServer(file)
      const started = await first.call('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ duration: 1 }),
      })
      const run = await asRun(started)
      await (await first.call(`/api/runs/${run.id}/events`)).text()
      await first.dispose()

      // Second server on the same file: the run is still there.
      const second = startServer(file)
      const list = Schema.decodeUnknownSync(Schema.Array(RunInfo))(
        await (await second.call('/api/runs?limit=5')).json(),
      )
      expect(list.map(r => r.id)).toEqual([run.id])
      expect(list[0]!.status).toBe('finished')

      const seconds = Schema.decodeUnknownSync(Schema.Array(Second))(
        await (await second.call(`/api/runs/${run.id}/seconds`)).json(),
      )
      expect(seconds.length).toBeGreaterThan(0)
      expect(seconds[0]!.endpoints[0]!.endpoint).toBe('GET /ok')

      // The event stream replays a stored run and ends right away.
      const events = await (
        await second.call(`/api/runs/${run.id}/events`)
      ).text()
      expect(events).toContain('"_tag":"Second"')
      expect(events).toContain('"status":"finished"')

      // Stopping a run that is over changes nothing.
      const stopped = await asRun(
        await second.call(`/api/runs/${run.id}/stop`, { method: 'POST' }),
      )
      expect(stopped.status).toBe('finished')
      await second.dispose()
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }, 15_000)
})
