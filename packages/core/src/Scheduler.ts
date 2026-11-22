/**
 * The open-model scheduler (rate.*), decision D1 in the proposal.
 *
 * Iterations arrive on a timetable computed from the load, whether or not
 * earlier ones have finished, the way real users arrive at a website. Each
 * iteration is forked into its own fiber and told when it *should* have
 * started, so its latency can be measured from that moment.
 *
 * The load can change at any moment (the rate dial, a spike, a pause), so
 * the timetable is not computed up front. The scheduler walks time in
 * short slices, asks the load for the rate at each slice, and places the
 * arrivals that fall inside it. A change takes effect within one slice.
 *
 * Time comes from Effect's Clock (`Effect.sleep`), so a test can swap in
 * `TestClock` and run a five-minute ramp in milliseconds.
 */
import { Effect, FiberSet } from 'effect'

import { type LoadPlan, planDuration, targetAt } from '@mantix/api'

import type { Recorder } from './Recorder.ts'

/**
 * The load a scenario should generate over time, in seconds since the
 * run started. The runner builds one from the plan and the run journal
 * (see Steering.ts in @mantix/api); tests build one from a plan.
 */
export interface LoadSource {
  /** The target at second `s`: iterations/s (open) or VUs (closed). */
  readonly target: (s: number) => number
  /** True once the load is over for good. */
  readonly ended: (s: number) => boolean
  /** True while the run is paused: start no new iterations. */
  readonly paused: (s: number) => boolean
}

/** A load that just follows a plan, starting at second 0. */
export const planLoad = (plan: LoadPlan): LoadSource => ({
  target: s => targetAt(plan, s),
  ended: s => s >= planDuration(plan),
  paused: () => false,
})

/** How long one scheduling slice lasts, in seconds. */
export const SLICE_SECONDS = 0.025

/** A moment in the timetable: an arrival, or the end of a slice. */
export interface Tick {
  /** Seconds since the load's second 0. */
  readonly at: number
  readonly arrival: boolean
}

/**
 * The timetable: every arrival, plus the end of every slice, from second
 * `from` until the load ends.
 *
 * We integrate the rate instead of stepping it, so ramps are exact: the
 * number of arrivals before time t is N(t) = ∫ rate, and arrival k (from 0)
 * happens where N(t) = k. Inside one slice the rate is taken to move in a
 * straight line from `a` to `b`, so N is a quadratic and we solve it
 * directly.
 *
 * It is a generator, so the next slice is only computed when the
 * scheduler asks for it. That is what lets a live change take effect: the
 * rate is read just before each slice, never far ahead.
 */
export function* schedule(
  load: Pick<LoadSource, 'target' | 'ended'>,
  from = 0,
): Generator<Tick> {
  let next = 0 // the next arrival to place, as a value of N
  let arrived = 0 // N at the start of the current slice
  const d = SLICE_SECONDS
  // Slice j starts at from + j·d. Counting slices (instead of adding d
  // again and again) keeps floating point error from piling up.
  for (let j = 0; ; j++) {
    const s = from + j * d
    if (load.ended(s)) return
    // The rate at the start of the slice and just before its end, so a
    // plan that ends at the slice boundary still counts its last slice.
    const a = Math.max(0, load.target(s))
    const b = Math.max(0, load.target(s + d - 1e-9))
    const area = ((a + b) / 2) * d
    // The small margin absorbs floating point error summed over slices.
    while (next < arrived + area - 1e-6) {
      // Solve a·τ + (slope/2)·τ² = Δ for τ. This form of the quadratic
      // formula is stable when the slope is zero or negative.
      const delta = next - arrived
      const slope = (b - a) / d
      const root = Math.sqrt(Math.max(0, a * a + 2 * slope * delta))
      const tau = delta <= 0 ? 0 : (2 * delta) / (a + root)
      yield { at: s + Math.min(tau, d), arrival: true }
      next++
    }
    arrived += area
    yield { at: from + (j + 1) * d, arrival: false }
  }
}

/** Arrival times for a fixed plan, in seconds. Handy in tests. */
export function* arrivalTimes(plan: LoadPlan): Generator<number> {
  for (const tick of schedule(planLoad(plan))) {
    if (tick.arrival) yield tick.at
  }
}

export interface OpenModelOptions {
  readonly load: LoadSource
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
  /**
   * Second 0 of `load`, in `now` ms. Default: now. Scheduling begins at
   * the current moment, so if we start late (a slow setup) the overdue
   * part is skipped instead of being fired as one burst.
   */
  readonly start?: number
}

/**
 * Run the load to its end. Returns when the load says it has ended;
 * iterations still running stay in the returned FiberSet so the caller
 * decides how long to wait for them.
 */
export const runOpenModel = Effect.fn('runOpenModel')(function* (
  options: OpenModelOptions,
) {
  const { load, maxVus, recorder, now, iteration } = options
  // A FiberSet owns every iteration fiber. When the surrounding Scope
  // closes (the run stops), all of them are interrupted together.
  const fibers = yield* FiberSet.make<void>()

  // Free VU slots, so `vu` in the iteration context is a small stable
  // number instead of an ever-growing counter.
  const free: Array<number> = []
  for (let slot = maxVus; slot >= 1; slot--) free.push(slot)

  const start = options.start ?? now()
  const from = Math.max(0, (now() - start) / 1000)
  for (const tick of schedule(load, from)) {
    const intendedStart = start + tick.at * 1000
    const wait = intendedStart - now()
    if (wait > 0) {
      yield* Effect.sleep(wait)
    }
    // A slice boundary: nothing to start, but sleeping until it means we
    // never read the rate further ahead than one slice.
    if (!tick.arrival) continue
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

  return fibers
})
