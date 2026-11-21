import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'

import { assert, describe, it } from '@effect/vitest'

import { toPlan, vus } from '../src/Load.ts'
import { runClosedModel } from '../src/VuPool.ts'

describe('runClosedModel', () => {
  it.effect('scales the VU pool up and down with the plan', () =>
    Effect.gen(function* () {
      const now = yield* Effect.clockWith(clock =>
        Effect.succeed(() => Number(clock.monotonicTimeNanosUnsafe()) / 1e6),
      )
      const live = new Set<number>()
      let maxSeen = 0
      let alive = 0
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          runClosedModel({
            // 0 → 10 VUs over 10 s, then back to 0 over 10 s.
            plan: toPlan(
              vus.ramping({
                start: 0,
                stages: [
                  { duration: 10, target: 10 },
                  { duration: 10, target: 0 },
                ],
              }),
            ),
            now,
            // An iteration takes 250 ms; we track which VUs are running.
            iteration: vu =>
              Effect.sync(() => live.add(vu)).pipe(
                Effect.andThen(Effect.sleep(250)),
              ),
            onVus: n => {
              alive = n
              maxSeen = Math.max(maxSeen, n)
            },
          }),
        ),
      )
      yield* TestClock.adjust(5000)
      assert.strictEqual(alive, 5)
      assert.deepStrictEqual(
        [...live].sort((a, b) => a - b),
        [1, 2, 3, 4, 5],
      )
      yield* TestClock.adjust(5000)
      assert.strictEqual(alive, 10)
      yield* TestClock.adjust(7000)
      assert.strictEqual(alive, 3)
      yield* TestClock.adjust(3000)
      yield* Fiber.join(fiber)
      assert.strictEqual(alive, 0)
      assert.strictEqual(maxSeen, 10)
    }),
  )

  it.effect('loops iterations back to back', () =>
    Effect.gen(function* () {
      const now = yield* Effect.clockWith(clock =>
        Effect.succeed(() => Number(clock.monotonicTimeNanosUnsafe()) / 1e6),
      )
      const counts = new Map<number, number>()
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          runClosedModel({
            plan: toPlan(vus.constant(2, { duration: 1 })),
            now,
            iteration: vu =>
              Effect.sleep(100).pipe(
                Effect.andThen(
                  Effect.sync(() => counts.set(vu, (counts.get(vu) ?? 0) + 1)),
                ),
              ),
          }),
        ),
      )
      yield* TestClock.adjust(1000)
      yield* Fiber.join(fiber)
      // Two VUs, 100 ms each, for 1 s: about ten iterations each.
      assert.closeTo(counts.get(1)!, 10, 1)
      assert.closeTo(counts.get(2)!, 10, 1)
    }),
  )
})
