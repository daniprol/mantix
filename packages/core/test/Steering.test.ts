/**
 * Steering a running run: the controls change the load straight away and
 * end up in the journal. TestClock runs a minute of load in milliseconds.
 */
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'

import { assert, describe, it } from '@effect/vitest'

import { rate, vus } from '../src/Load.ts'
import { startRun } from '../src/Runner.ts'
import { scenario } from '../src/Scenario.ts'

/** A scenario whose iterations do nothing, so only the schedule matters. */
const idle = (load: Parameters<typeof scenario>[0]['load']) =>
  scenario({ name: 'idle', load, iteration: async () => {} })

describe('steering', () => {
  it.effect('changes the rate, spikes it, and pins a moment', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const run = yield* startRun(idle(rate.constant(10, { duration: 10 })))
        const waiting = yield* Effect.forkChild(run.await)
        yield* TestClock.adjust(2000)
        yield* run.control({ _tag: 'Rate', target: 40 })
        yield* TestClock.adjust(2000)
        const pin = yield* run.control({ _tag: 'Pin', note: 'deploy started' })
        assert.strictEqual(pin.seq, 2)
        assert.strictEqual(pin.at, 4)
        yield* TestClock.adjust(6000)
        const result = yield* Fiber.join(waiting)

        assert.strictEqual(result.info.status, 'finished')
        const started = result.seconds.map(s => s.started)
        assert.deepStrictEqual(started.slice(0, 2), [10, 10])
        assert.deepStrictEqual(started.slice(2, 10), Array(8).fill(40))
        // Second.target shows the steered load, not the original plan.
        assert.strictEqual(result.seconds[5]!.target, 40)
        assert.deepStrictEqual(
          result.info.journal.map(e => e.control._tag),
          ['Rate', 'Pin'],
        )
      }),
    ),
  )

  it.effect('pauses without a catch-up burst and ends later', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const run = yield* startRun(idle(rate.constant(10, { duration: 4 })))
        const waiting = yield* Effect.forkChild(run.await)
        // 1.95 s: between two arrivals (a control lands within one 25 ms
        // scheduling slice, so exactly on an arrival is a coin toss).
        yield* TestClock.adjust(1950)
        yield* run.control({ _tag: 'Pause' })
        yield* TestClock.adjust(3000)
        yield* run.control({ _tag: 'Resume' })
        yield* TestClock.adjust(3000)
        const result = yield* Fiber.join(waiting)

        assert.strictEqual(result.info.status, 'finished')
        // Two seconds of load, three paused, then the last two seconds.
        assert.deepStrictEqual(
          result.seconds.map(s => s.started),
          [10, 10, 0, 0, 0, 10, 10],
        )
        const total = result.seconds.reduce((sum, s) => sum + s.started, 0)
        assert.strictEqual(total, 40)
      }),
    ),
  )

  it.effect('holds closed-model VUs at the gate while paused', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const run = yield* startRun(
          scenario.effect({
            name: 'users',
            load: vus.constant(2, { duration: 2 }),
            iteration: () => Effect.sleep(100),
          }),
        )
        const waiting = yield* Effect.forkChild(run.await)
        yield* TestClock.adjust(1000)
        yield* run.control({ _tag: 'Pause' })
        yield* TestClock.adjust(2000)
        yield* run.control({ _tag: 'Resume' })
        yield* TestClock.adjust(1500)
        const result = yield* Fiber.join(waiting)
        const started = result.seconds.map(s => s.started)
        // About 10 iterations per VU-second while running, none paused.
        assert.isAtLeast(started[0]!, 18)
        assert.strictEqual(started[2], 0)
        assert.isAtLeast(started[3]!, 18)
      }),
    ),
  )

  it.effect('rejects controls that make no sense, and after the end', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const run = yield* startRun(idle(rate.constant(1, { duration: 1 })))
        const resume = yield* Effect.flip(run.control({ _tag: 'Resume' }))
        assert.strictEqual(resume._tag, 'InvalidControl')
        assert.match(resume.message, /not paused/)
        const waiting = yield* Effect.forkChild(run.await)
        yield* TestClock.adjust(2000)
        yield* Fiber.join(waiting)
        const late = yield* Effect.flip(
          run.control({ _tag: 'Pin', note: 'too late' }),
        )
        assert.match(late.message, /already ended/)
      }),
    ),
  )
})
