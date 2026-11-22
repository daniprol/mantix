import { Effect, Stream } from 'effect'
import { afterAll, beforeAll } from 'vitest'

import { assert, describe, it } from '@effect/vitest'

import { rate, vus } from '../src/Load.ts'
import { applyOverrides, startRun, testInfo } from '../src/Runner.ts'
import { scenario } from '../src/Scenario.ts'
import { type TestServer, startServer } from './server.ts'

let server: TestServer
beforeAll(async () => {
  server = await startServer()
})
afterAll(() => server.close())

describe('runner', () => {
  // The one real-clock test: about two seconds of real load.
  it.live('runs a scenario, replays its events and checks thresholds', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const log: Array<string> = []
        let iterations = 0
        const test = scenario({
          name: 'smoke',
          baseUrl: server.url,
          load: rate.constant(20, { duration: 2 }),
          thresholds: [
            'errors < 50%',
            { check: 'p99 < 1ms', endpoint: 'GET /wait' },
          ],
          setup: async () => {
            log.push('setup')
            return 42
          },
          teardown: async ({ data }) => {
            log.push(`teardown ${data}`)
          },
          iteration: async ({ http, data }) => {
            assert.strictEqual(data, 42)
            await http.get('/wait')
            // A bug in the test, once: a ScriptError, not a request error.
            if (++iterations === 3) throw new Error('oops in the script')
          },
        })
        const run = yield* startRun(test, { file: 'smoke.ts' })
        const result = yield* run.await
        assert.deepStrictEqual(log, ['setup', 'teardown 42'])
        assert.strictEqual(result.info.status, 'finished')
        assert.isAtLeast(result.seconds.length, 2)

        const requests = result.seconds.flatMap(s => s.endpoints)
        const total = requests.reduce((sum, e) => sum + e.requests, 0)
        assert.strictEqual(total, 40)
        const started = result.seconds.reduce((sum, s) => sum + s.started, 0)
        const failed = result.seconds.reduce((sum, s) => sum + s.failed, 0)
        assert.strictEqual(started, 40)
        assert.strictEqual(failed, 1)
        assert.isTrue(requests.every(e => Object.keys(e.errors).length === 0))
        assert.isTrue(
          result.seconds.some(s =>
            s.errorSamples.some(
              e =>
                e.kind === 'ScriptError' &&
                e.message === 'oops in the script' &&
                // Points at the line in the test file that threw.
                /^Runner\.test\.ts:\d+$/.test(e.location ?? ''),
            ),
          ),
        )

        // The first threshold passes; the second cannot (1 ms vs 50 ms).
        assert.deepStrictEqual(
          result.info.thresholds.map(t => t.passed),
          [true, false],
        )

        // A late subscriber gets the whole run replayed, then the end.
        const events = yield* Stream.runCollect(run.events)
        const tags = Array.from(events, e => e._tag)
        assert.strictEqual(tags[0], 'RunUpdated')
        assert.strictEqual(
          tags.filter(t => t === 'Second').length,
          result.seconds.length,
        )
      }),
    ),
  )

  it.live('runs an Effect scenario in the closed model', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const run = yield* startRun(
          scenario.effect({
            name: 'effect',
            baseUrl: server.url,
            load: vus.constant(2, { duration: 1 }),
            iteration: ({ http }) =>
              Effect.gen(function* () {
                yield* http.get('/wait')
                // A typed failure: recorded as HttpStatus, then caught.
                yield* http
                  .get('/status/503')
                  .pipe(Effect.catchTag('RequestFailed', () => Effect.void))
              }),
          }),
        )
        const result = yield* run.await
        assert.strictEqual(result.info.status, 'finished')
        const parts = result.seconds.flatMap(s => s.endpoints)
        const count = (name: string) =>
          parts
            .filter(e => e.endpoint === name)
            .reduce((sum, e) => sum + e.requests, 0)
        // Two VUs, ~50 ms per iteration, for one second.
        assert.isAtLeast(count('GET /wait'), 20)
        assert.isTrue(parts.some(e => e.errors['HttpStatus'] !== undefined))
        assert.isAtMost(Math.max(...result.seconds.map(s => s.vus)), 2)
      }),
    ),
  )

  it.live('stop ends the run early and still runs teardown', () =>
    Effect.scoped(
      Effect.gen(function* () {
        let tornDown = false
        const run = yield* startRun(
          scenario({
            name: 'long',
            baseUrl: server.url,
            load: rate.constant(10, { duration: 60 }),
            teardown: async () => {
              tornDown = true
            },
            iteration: async ({ http }) => {
              await http.get('/slow')
            },
          }),
        )
        yield* Effect.sleep(200)
        yield* run.stop
        const result = yield* run.await
        assert.strictEqual(result.info.status, 'stopped')
        assert.isTrue(tornDown)
        // In-flight requests were cancelled, not recorded as errors.
        const errors = result.seconds.flatMap(s =>
          s.endpoints.flatMap(e => Object.keys(e.errors)),
        )
        assert.deepStrictEqual(errors, [])
      }),
    ),
  )

  it.effect('rejects bad input before starting', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          startRun(
            scenario({
              name: 'bad',
              load: rate.constant(1, { duration: 1 }),
              thresholds: ['p99 < fast'],
              iteration: async () => {},
            }),
          ),
        )
        assert.strictEqual(error._tag, 'InvalidTest')
        assert.match(error.message, /Cannot read threshold/)
      }),
    ),
  )
})

describe('overrides and test info', () => {
  const plan = {
    model: 'rate' as const,
    start: 0,
    stages: [
      { duration: 10, target: 100 },
      { duration: 20, target: 100 },
    ],
  }

  it('replaces the plan with a constant rate or VU count', () => {
    assert.deepStrictEqual(applyOverrides(plan, { rate: 5 }), {
      model: 'rate',
      start: 5,
      stages: [{ duration: 30, target: 5 }],
    })
    assert.deepStrictEqual(applyOverrides(plan, { vus: 3, duration: 10 }), {
      model: 'vus',
      start: 3,
      stages: [{ duration: 10, target: 3 }],
    })
  })

  it('stretches the plan when only the duration changes', () => {
    assert.deepStrictEqual(
      applyOverrides(plan, { duration: 3 }).stages.map(s => s.duration),
      [1, 2],
    )
  })

  it('describes a test file', () => {
    const info = testInfo(
      [
        scenario({
          name: 'a',
          baseUrl: 'http://x',
          load: rate.constant(1, { duration: '1m' }),
          thresholds: ['p99 < 1s'],
          iteration: async () => {},
        }),
        scenario({
          name: 'b',
          baseUrl: 'http://x',
          startAfter: '30s',
          load: rate.constant(1, { duration: '1m' }),
          iteration: async () => {},
        }),
      ],
      'examples/two.ts',
    )
    assert.strictEqual(info.name, 'two')
    assert.strictEqual(info.baseUrl, 'http://x')
    assert.strictEqual(info.duration, 90)
    assert.deepStrictEqual(info.thresholds, ['p99 < 1s'])
  })
})
