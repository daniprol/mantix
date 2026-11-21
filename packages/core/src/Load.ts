/**
 * Load models: how much work Mantix generates over time.
 *
 * - `rate.*` is the open model (the default). Iterations arrive on a
 *   schedule, whether or not earlier ones have finished, the way real
 *   users arrive at a website. Latency is measured from when each
 *   iteration *should* have started, so a stalled server cannot hide its
 *   own slowness (coordinated omission).
 * - `vus.*` is the closed model: a fixed number of virtual users, each
 *   running iterations back to back. Use it for connection pools,
 *   WebSockets, or when you want "N concurrent clients".
 */
import type { LoadPlan } from '@mantix/api'

import { type DurationInput, toSeconds } from './Duration.ts'

/** Move linearly to `target` over `duration`. */
export interface Stage {
  readonly duration: DurationInput
  readonly target: number
}

export interface RateModel {
  readonly _tag: 'Rate'
  /** Iterations per second at time 0. */
  readonly start: number
  readonly stages: ReadonlyArray<Stage>
  /**
   * The most iterations that may run at once. When all are busy, new
   * arrivals are counted as dropped instead of piling up. Default 1000.
   */
  readonly maxVus: number
}

export interface VusModel {
  readonly _tag: 'Vus'
  /** Virtual users at time 0. */
  readonly start: number
  readonly stages: ReadonlyArray<Stage>
}

export type LoadModel = RateModel | VusModel

interface RateOptions {
  readonly maxVus?: number
}

const DEFAULT_MAX_VUS = 1000

/** Open model: iterations arrive at a rate, per second. */
export const rate = {
  /** The same rate for the whole run, e.g. `rate.constant(50, { duration: "1m" })`. */
  constant: (
    perSecond: number,
    options: { readonly duration: DurationInput } & RateOptions,
  ): RateModel => ({
    _tag: 'Rate',
    start: perSecond,
    stages: [{ duration: options.duration, target: perSecond }],
    maxVus: options.maxVus ?? DEFAULT_MAX_VUS,
  }),
  /**
   * A rate that changes in stages, e.g. warm up, hold, then cool down:
   * `rate.ramping({ start: 0, stages: [{ duration: "30s", target: 100 }, { duration: "2m", target: 100 }] })`
   */
  ramping: (
    options: {
      readonly start?: number
      readonly stages: ReadonlyArray<Stage>
    } & RateOptions,
  ): RateModel => ({
    _tag: 'Rate',
    start: options.start ?? 0,
    stages: options.stages,
    maxVus: options.maxVus ?? DEFAULT_MAX_VUS,
  }),
}

/** Closed model: a number of virtual users looping over the iteration. */
export const vus = {
  /** The same number of users for the whole run. */
  constant: (
    count: number,
    options: { readonly duration: DurationInput },
  ): VusModel => ({
    _tag: 'Vus',
    start: count,
    stages: [{ duration: options.duration, target: count }],
  }),
  /** Users that ramp up and down in stages, like Locust's spawn rate. */
  ramping: (options: {
    readonly start?: number
    readonly stages: ReadonlyArray<Stage>
  }): VusModel => ({
    _tag: 'Vus',
    start: options.start ?? 0,
    stages: options.stages,
  }),
}

/** The plan as plain numbers (seconds), for the dashboard and engine. */
export const toPlan = (model: LoadModel): LoadPlan => ({
  model: model._tag === 'Rate' ? 'rate' : 'vus',
  start: model.start,
  stages: model.stages.map(stage => ({
    duration: toSeconds(stage.duration),
    target: stage.target,
  })),
})

/** Total planned duration in seconds. */
export const planDuration = (plan: LoadPlan): number =>
  plan.stages.reduce((total, stage) => total + stage.duration, 0)

/**
 * The planned target (rate or VUs) at `t` seconds into the plan. Between
 * stage boundaries the value moves in a straight line. After the plan ends
 * it returns 0.
 */
export const targetAt = (plan: LoadPlan, t: number): number => {
  let from = plan.start
  let elapsed = 0
  for (const stage of plan.stages) {
    if (t < elapsed + stage.duration) {
      const progress = stage.duration === 0 ? 1 : (t - elapsed) / stage.duration
      return from + (stage.target - from) * progress
    }
    elapsed += stage.duration
    from = stage.target
  }
  return 0
}
