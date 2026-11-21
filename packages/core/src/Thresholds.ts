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
 * Add `abortOnFail: true` to stop the run as soon as the rule fails.
 */
import type { EndpointStats, ThresholdResult } from '@mantix/api'

export type ThresholdInput =
  | string
  | {
      readonly check: string
      readonly endpoint?: string
      readonly abortOnFail?: boolean
    }

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
  return {
    expression: check.trim(),
    endpoint: typeof input === 'string' ? undefined : input.endpoint,
    metric,
    operator,
    value,
    abortOnFail: typeof input === 'string' ? false : input.abortOnFail === true,
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
