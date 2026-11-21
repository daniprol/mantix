import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'

import { assert, describe, it } from '@effect/vitest'

import { rate, toPlan } from '../src/Load.ts'
import { Recorder } from '../src/Recorder.ts'
import { arrivalTimes, runOpenModel } from '../src/Scheduler.ts'

/** Monotonic ms from the current Clock (TestClock inside it.effect). */
const nowFrom = Effect.clockWith(clock =>
  Effect.succeed(() => Number(clock.monotonicTimeNanosUnsafe()) / 1e6),
)

/** Count values per whole second. */
const perSecond = (times: Iterable<number>): Array<number> => {
  const counts: Array<number> = []
  for (const t of times) {
    const s = Math.floor(t + 1e-9)
    counts[s] = (counts[s] ?? 0) + 1
  }
  return [...counts].map(c => c ?? 0)
}

describe('arrivalTimes', () => {
  it('spaces a constant rate evenly', () => {
    const times = [...arrivalTimes(toPlan(rate.constant(10, { duration: 3 })))]
    assert.strictEqual(times.length, 30)
    assert.closeTo(times[1]!, 0.1, 1e-9)
    assert.deepStrictEqual(perSecond(times), [10, 10, 10])
  })

  it('integrates a ramp exactly', () => {
    // 0 → 100/s over 10 s: N(t) = 5t², so 500 arrivals, and second s
    // gets 5((s+1)² − s²) = 10s + 5.
    const plan = toPlan(
      rate.ramping({ start: 0, stages: [{ duration: 10, target: 100 }] }),
    )
    const counts = perSecond(arrivalTimes(plan))
    assert.strictEqual(
      counts.reduce((a, b) => a + b, 0),
      500,
    )
    counts.forEach((count, s) => assert.closeTo(count, 10 * s + 5, 1))
  })

  it('handles ramp down and a zero-rate stage', () => {
    const plan = toPlan(
      rate.ramping({
        start: 20,
        stages: [
          { duration: 2, target: 0 },
          { duration: 2, target: 0 },
          { duration: 1, target: 10 },
        ],
      }),
    )
    const times = [...arrivalTimes(plan)]
    // 20 during the ramp down, none while idle, 5 in the last ramp.
    assert.strictEqual(times.filter(t => t < 2).length, 20)
    assert.strictEqual(times.filter(t => t >= 2 && t < 4).length, 0)
    assert.strictEqual(times.filter(t => t >= 4).length, 5)
    assert.isTrue(times.every((t, i) => i === 0 || t >= times[i - 1]!))
  })
})

describe('runOpenModel', () => {
  it.effect('starts iterations at their intended times', () =>
    Effect.gen(function* () {
      const now = yield* nowFrom
      const recorder = new Recorder()
      const starts: Array<number> = []
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          runOpenModel({
            plan: toPlan(rate.constant(5, { duration: 2 })),
            maxVus: 100,
            recorder,
            now,
            iteration: intended =>
              Effect.sync(() => {
                // Each iteration really starts when it was meant to.
                assert.closeTo(now(), intended, 1e-6)
                starts.push(intended)
              }),
          }),
        ),
      )
      // Just before 1 s: the first second's five arrivals have started.
      yield* TestClock.adjust(999)
      assert.strictEqual(starts.length, 5)
      yield* TestClock.adjust(1001)
      yield* Fiber.join(fiber)
      assert.strictEqual(starts.length, 10)
      assert.deepStrictEqual(
        starts.map(t => Math.round(t)),
        [0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800],
      )
      const second = recorder.snapshot(0, { target: 5, vus: 0, loopLagMs: 0 })
      assert.strictEqual(second.offered, 10)
      assert.strictEqual(second.dropped, 0)
    }),
  )

  it.effect('drops arrivals when every VU is busy', () =>
    Effect.gen(function* () {
      const now = yield* nowFrom
      const recorder = new Recorder()
      const vus = new Set<number>()
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          runOpenModel({
            plan: toPlan(rate.constant(10, { duration: 1 })),
            maxVus: 2,
            recorder,
            now,
            // Each iteration takes 1 s, so only two can ever run.
            iteration: (_intended, vu) =>
              Effect.sync(() => vus.add(vu)).pipe(
                Effect.andThen(Effect.sleep(1000)),
              ),
          }),
        ),
      )
      yield* TestClock.adjust(1000)
      yield* Fiber.join(fiber)
      const second = recorder.snapshot(0, { target: 10, vus: 0, loopLagMs: 0 })
      assert.strictEqual(second.offered, 10)
      assert.strictEqual(second.dropped, 8)
      assert.deepStrictEqual([...vus].sort(), [1, 2])
    }),
  )
})
