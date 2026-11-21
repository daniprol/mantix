/**
 * The open-model scheduler (rate.*), decision D1 in the proposal.
 *
 * Iterations arrive on a timetable computed from the plan, whether or not
 * earlier ones have finished, the way real users arrive at a website. Each
 * iteration is forked into its own fiber and told when it *should* have
 * started, so its latency can be measured from that moment.
 *
 * Time comes from Effect's Clock (`Effect.sleep`), so a test can swap in
 * `TestClock` and run a five-minute ramp in milliseconds.
 */

import { Effect, FiberSet } from 'effect'

import type { LoadPlan } from '@mantix/api'

import { planDuration } from './Load.ts'
import type { Recorder } from './Recorder.ts'

/**
 * The arrival times, in seconds from the start of the plan.
 *
 * We integrate the rate instead of stepping it, so ramps are exact: the
 * number of arrivals before time t is N(t) = ∫ rate, and arrival k (from 0)
 * happens where N(t) = k. Within a stage the rate moves linearly from `a`
 * to `b`, so N is a quadratic and we solve it directly.
 *
 * A generator yields the times one by one, so a long, fast plan never
 * builds a huge array.
 */
export function* arrivalTimes(plan: LoadPlan): Generator<number> {
  let k = 0 // the next arrival to place
  let stageStart = 0 // seconds
  let arrivedBefore = 0 // N at the start of this stage
  let from = plan.start
  for (const stage of plan.stages) {
    const a = Math.max(0, from)
    const b = Math.max(0, stage.target)
    const d = stage.duration
    // Arrivals that fall inside this stage: the area under the rate line.
    const area = ((a + b) / 2) * d
    const arrivedAfter = arrivedBefore + area
    while (d > 0 && k < arrivedAfter - 1e-9) {
      // Solve a·τ + (slope/2)·τ² = Δ for τ. This form of the quadratic
      // formula is stable when the slope is zero or negative.
      const delta = k - arrivedBefore
      const slope = (b - a) / d
      const root = Math.sqrt(Math.max(0, a * a + 2 * slope * delta))
      const tau = delta <= 0 ? 0 : (2 * delta) / (a + root)
      yield stageStart + Math.min(tau, d)
      k++
    }
    stageStart += d
    arrivedBefore = arrivedAfter
    from = stage.target
  }
}

export interface OpenModelOptions {
  readonly plan: LoadPlan
  /** The most iterations that may run at once. */
  readonly maxVus: number
  readonly recorder: Recorder
  /** Monotonic ms, from Effect's Clock. */
  readonly now: () => number
  /**
   * Run one iteration. `intendedStart` is in the same ms as `now`; `vu` is
   * the slot number (1..maxVus) the iteration runs in.
   */
  readonly iteration: (intendedStart: number, vu: number) => Effect.Effect<void>
  /** Called whenever the number of busy slots changes. */
  readonly onBusy?: (busy: number) => void
  /** When the plan starts, in `now` ms. Default: now. */
  readonly start?: number
}

/**
 * Run the plan to its end. Returns when the last arrival has been placed
 * and the plan's duration has passed; iterations still running stay in the
 * returned FiberSet so the caller decides how long to wait for them.
 */
export const runOpenModel = Effect.fn('runOpenModel')(function* (
  options: OpenModelOptions,
) {
  const { plan, maxVus, recorder, now, iteration } = options
  // A FiberSet owns every iteration fiber. When the surrounding Scope
  // closes (the run stops), all of them are interrupted together.
  const fibers = yield* FiberSet.make<void>()

  // Free VU slots, so `vu` in the iteration context is a small stable
  // number instead of an ever-growing counter.
  const free: Array<number> = []
  for (let slot = maxVus; slot >= 1; slot--) free.push(slot)

  const start = options.start ?? now()
  for (const at of arrivalTimes(plan)) {
    const intendedStart = start + at * 1000
    const wait = intendedStart - now()
    if (wait > 0) {
      yield* Effect.sleep(wait)
    }
    recorder.iterationOffered()
    const slot = free.pop()
    if (slot === undefined) {
      // Every slot is busy. Counting a drop (instead of queueing) keeps the
      // schedule honest: the dashboard shows offered vs achieved.
      recorder.iterationDropped()
      continue
    }
    options.onBusy?.(maxVus - free.length)
    yield* FiberSet.run(
      fibers,
      iteration(intendedStart, slot).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            free.push(slot)
            options.onBusy?.(maxVus - free.length)
          }),
        ),
      ),
    )
  }

  // Hold until the plan's end, even if the last arrival came earlier.
  const end = start + planDuration(plan) * 1000
  const remaining = end - now()
  if (remaining > 0) {
    yield* Effect.sleep(remaining)
  }
  return fibers
})
