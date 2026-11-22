import { Effect } from 'effect'
import { afterAll, beforeAll } from 'vitest'

import { assert, describe, it } from '@effect/vitest'

import { rate } from '../src/Load.ts'
import { probe } from '../src/Probe.ts'
import { scenario } from '../src/Scenario.ts'
import { type TestServer, startServer } from './server.ts'

let server: TestServer
beforeAll(async () => {
  server = await startServer()
})
afterAll(() => server.close())

describe('probe', () => {
  it.live('runs one traced iteration per scenario', () =>
    Effect.gen(function* () {
      let iterations = 0
      const log: Array<string> = []
      const [result] = yield* probe(
        scenario({
          name: 'flow',
          baseUrl: server.url,
          load: rate.constant(100, { duration: '1m' }),
          setup: async () => {
            log.push('setup')
          },
          teardown: async () => {
            log.push('teardown')
          },
          iteration: async ({ http }) => {
            iterations++
            await http.get('/wait')
            await http.get('/status/503').catch(() => {})
          },
        }),
      )
      assert.strictEqual(iterations, 1)
      assert.deepStrictEqual(log, ['setup', 'teardown'])
      assert.deepStrictEqual(
        result!.trace!.spans.map(s => [s.endpoint, s.status]),
        [
          ['GET /wait', 200],
          ['GET /status/503', 503],
        ],
      )
      assert.strictEqual(result!.errors[0]!.kind, 'HttpStatus')
    }),
  )

  it.live('reports a failing setup instead of running', () =>
    Effect.gen(function* () {
      const [result] = yield* probe(
        scenario({
          name: 'broken',
          load: rate.constant(1, { duration: 1 }),
          setup: async (): Promise<string> => {
            throw new Error('no token')
          },
          iteration: async () => {},
        }),
      )
      assert.strictEqual(result!.setupError, 'no token')
      assert.isUndefined(result!.trace)
    }),
  )
})
