/**
 * Thresholds: pass/fail rules for a run, written as short expressions.
 *
 *   "p99 < 250ms"    latency percentile (p50, p90, p95, p99) or max
 *   "max < 2s"       units: ms (default) or s
 *   "errors < 1%"    share of failed requests
 *   "rps > 100"      completed requests per second
 *
 * Operators: <, <=, >, >=. A threshold applies to all endpoints together,
 * or to one endpoint with the object form:
 *
 *   { endpoint: "POST /checkout", check: "p99 < 500ms" }
 *
 * Add `abortOnFail: true` to stop the run when the rule fails. It is only
 * checked once the scenario has run for a grace period (5 s by default),
 * so a few noisy first seconds can't end a run. Set your own delay with
 * the object form (like k6's `delayAbortEval`):
 *
 *   { check: "errors < 5%", abortOnFail: { delay: "30s" } }
 */
import type { EndpointStats, ThresholdResult } from '@mantix/api'

import { type DurationInput, toSeconds } from './Duration.ts'

export type ThresholdInput =
  | string
  | {
      readonly check: string
      readonly endpoint?: string
      /**
       * Stop the run when this threshold fails. `true` waits the default
       * grace period first; `{ delay }` sets it, counted from when the
       * scenario starts (after `startAfter`). `{ delay: 0 }` aborts at the
       * first failing second.
       */
      readonly abortOnFail?: boolean | { readonly delay: DurationInput }
    }

/**
 * The default grace period before `abortOnFail` is checked, in seconds.
 * The first seconds of a run are the noisiest: connections are still being
 * opened, the server's caches and JIT are cold, and a percentile over a
 * few dozen requests jumps around. Five seconds is enough for that to
 * settle at typical rates, yet a server that is really falling over still
 * stops the run quickly.
 */
export const DEFAULT_ABORT_DELAY = 5

export type Metric = 'p50' | 'p90' | 'p95' | 'p99' | 'max' | 'errors' | 'rps'
export type Operator = '<' | '<=' | '>' | '>='

/** A threshold after parsing. Values are in ms, % (0..100) or /s. */
export interface Threshold {
  readonly expression: string
  readonly endpoint: string | undefined
  readonly metric: Metric
  readonly operator: Operator
  readonly value: number
  readonly abortOnFail: boolean
  /** Seconds after the scenario starts before `abortOnFail` applies. */
  readonly abortDelay: number
}

const PATTERN =
  /^\s*(p50|p90|p95|p99|max|errors|rps)\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)\s*(ms|s|%|\/s)?\s*$/

/** Parse one threshold. Throws with a helpful message on bad input. */
export const parseThreshold = (input: ThresholdInput): Threshold => {
  const check = typeof input === 'string' ? input : input.check
  const match = PATTERN.exec(check)
  if (match === null) {
    throw new Error(
      `Cannot read threshold "${check}". Examples: "p99 < 250ms", "errors < 1%", "rps > 100".`,
    )
  }
  const [, metric, operator, amount, unit] = match as unknown as [
    string,
    Metric,
    Operator,
    string,
    string | undefined,
  ]
  let value = Number(amount)
  if (metric === 'errors' && unit !== '%') {
    throw new Error(
      `Threshold "${check}": write error limits as a percentage, e.g. "errors < 1%".`,
    )
  }
  if (unit === 's' && metric !== 'rps') {
    value *= 1000
  }
  const abort = typeof input === 'string' ? undefined : input.abortOnFail
  const abortDelay =
    typeof abort === 'object' ? toSeconds(abort.delay) : DEFAULT_ABORT_DELAY
  if (!(abortDelay >= 0)) {
    throw new Error(`Threshold "${check}": the abort delay must be 0 or more.`)
  }
  return {
    expression: check.trim(),
    endpoint: typeof input === 'string' ? undefined : input.endpoint,
    metric,
    operator,
    value,
    // `{ delay }` turns abortOnFail on too; only `true` or an object do.
    abortOnFail: abort === true || typeof abort === 'object',
    abortDelay,
  }
}

/** The measured value for a metric, in the threshold's unit. */
const measure = (metric: Metric, stats: EndpointStats): number => {
  switch (metric) {
    case 'errors':
      return stats.errorRate * 100
    case 'rps':
      return stats.rps
    default:
      return stats.latency[metric]
  }
}

const compare = (
  actual: number,
  operator: Operator,
  limit: number,
): boolean => {
  switch (operator) {
    case '<':
      return actual < limit
    case '<=':
      return actual <= limit
    case '>':
      return actual > limit
    case '>=':
      return actual >= limit
  }
}

/**
 * Check a threshold against stats for the whole run so far. `total` covers
 * all endpoints; `endpoints` is used for endpoint-specific thresholds.
 * An endpoint that has no requests yet passes.
 */
export const evaluate = (
  threshold: Threshold,
  total: EndpointStats,
  endpoints: ReadonlyArray<EndpointStats>,
): ThresholdResult => {
  const stats =
    threshold.endpoint === undefined
      ? total
      : endpoints.find(e => e.endpoint === threshold.endpoint)
  const base = {
    expression: threshold.expression,
    ...(threshold.endpoint === undefined
      ? {}
      : { endpoint: threshold.endpoint }),
  }
  if (stats === undefined || stats.requests === 0) {
    return { ...base, actual: 0, passed: true }
  }
  const actual = measure(threshold.metric, stats)
  return {
    ...base,
    actual,
    passed: compare(actual, threshold.operator, threshold.value),
  }
}
