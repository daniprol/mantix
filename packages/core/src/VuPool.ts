/**
 * The closed model (vus.*): a pool of virtual users.
 *
 * Each VU is a fiber that runs iterations back to back. Every tick the pool
 * compares how many VUs are alive with what the load wants right now and
 * starts or interrupts VUs to match.
 *
 * While the run is paused the pool keeps its VUs but they wait before
 * starting their next iteration, so the iterations already running finish
 * normally instead of being cancelled.
 *
 * The VUs live in a FiberMap keyed by VU id (1..n). Removing a key
 * interrupts that fiber, and interruption in Effect is safe: the VU's
 * finalizers still run, so nothing is left half done.
 */

import { Effect, FiberMap } from 'effect'

import type { LoadSource } from './Scheduler.ts'

/** How often the pool is resized to follow the plan, in ms. */
const TICK_MS = 100

export interface ClosedModelOptions {
  readonly load: LoadSource
  /** Monotonic ms, from Effect's Clock. */
  readonly now: () => number
  /** One iteration for VU `vu`. Must not fail. */
  readonly iteration: (vu: number) => Effect.Effect<void>
  /** Called whenever the number of live VUs changes. */
  readonly onVus?: (vus: number) => void
  /** Second 0 of `load`, in `now` ms. Default: now. */
  readonly start?: number
}

/** Run the load to its end, then interrupt every VU. */
export const runClosedModel = Effect.fn('runClosedModel')(function* (
  options: ClosedModelOptions,
) {
  const { load, now, iteration } = options
  const start = options.start ?? now()
  const second = (): number => (now() - start) / 1000

  // While paused, wait a tick at a time before the next iteration.
  const waitWhilePaused = Effect.whileLoop({
    while: () => load.paused(second()),
    body: () => Effect.sleep(TICK_MS),
    step: () => {},
  })

  const pool = yield* FiberMap.make<number>()
  // A VU loops forever; it only stops when the pool interrupts it.
  // `yieldNow` lets other fibers run even if an iteration finishes
  // instantly (say it throws straight away).
  const vuLoop = (vu: number) =>
    Effect.forever(
      waitWhilePaused.pipe(
        Effect.andThen(iteration(vu)),
        Effect.andThen(Effect.yieldNow),
      ),
    )

  let alive = 0
  while (!load.ended(second())) {
    // Paused: keep the VUs we have (they are waiting at the gate above).
    const target = load.paused(second())
      ? alive
      : Math.round(load.target(second()))
    // Scale up: VU ids stay 1..n, so new VUs take the next ids.
    while (alive < target) {
      alive++
      yield* FiberMap.run(pool, alive, vuLoop(alive))
    }
    // Scale down: interrupt the newest VUs first.
    while (alive > target) {
      yield* FiberMap.remove(pool, alive)
      alive--
    }
    options.onVus?.(alive)
    yield* Effect.sleep(TICK_MS)
  }

  // The load is over: stop every VU.
  yield* FiberMap.clear(pool)
  options.onVus?.(0)
})
