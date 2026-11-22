/**
 * Reading threshold expressions such as "p99 < 250ms" or "errors < 1%".
 *
 * The server decides pass or fail. The dashboard only needs to know which
 * figure a threshold talks about and its limit, so it can colour a live
 * figure red and say "p99 was 412 ms, limit 250 ms".
 */
import { Option } from 'effect'

import type { ThresholdResult } from '@mantix/api'

import * as Format from './format.ts'

export type Metric = 'p50' | 'p90' | 'p95' | 'p99' | 'max' | 'errors' | 'rps'
type Operator = '<' | '<=' | '>' | '>='

export type Threshold = Readonly<{
  expression: string
  metric: Metric
  operator: Operator
  /** In ms for latency, % (0..100) for errors, /s for rps. */
  limit: number
}>

const PATTERN =
  /^\s*(p50|p90|p95|p99|max|errors|rps)\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)\s*(ms|s|%|\/s)?\s*$/

const METRICS: ReadonlyArray<Metric> = [
  'p50',
  'p90',
  'p95',
  'p99',
  'max',
  'errors',
  'rps',
]
const OPERATORS: ReadonlyArray<Operator> = ['<', '<=', '>', '>=']

const toMetric = (value: string | undefined): Option.Option<Metric> =>
  Option.fromNullishOr(METRICS.find(metric => metric === value))

const toOperator = (value: string | undefined): Option.Option<Operator> =>
  Option.fromNullishOr(OPERATORS.find(operator => operator === value))

export const parse = (expression: string): Option.Option<Threshold> => {
  const match = PATTERN.exec(expression)
  if (match === null) {
    return Option.none()
  }
  const amount = Number(match[3])
  return Option.all({
    metric: toMetric(match[1]),
    operator: toOperator(match[2]),
  }).pipe(
    Option.map(({ metric, operator }) => ({
      expression: expression.trim(),
      metric,
      operator,
      limit: match[4] === 's' && metric !== 'rps' ? amount * 1000 : amount,
    })),
  )
}

/** Does `actual` (in the threshold's unit) break the threshold? */
export const isBreached = (threshold: Threshold, actual: number): boolean => {
  const { operator, limit } = threshold
  const passes =
    operator === '<'
      ? actual < limit
      : operator === '<='
        ? actual <= limit
        : operator === '>'
          ? actual > limit
          : actual >= limit
  return !passes
}

/** A value in a metric's unit, as text: "412 ms", "2.1%", "96/s". */
const formatValue = (metric: Metric, value: number): string =>
  metric === 'errors'
    ? Format.text(Format.percent(value / 100))
    : metric === 'rps'
      ? Format.text(Format.rate(value))
      : Format.text(Format.latency(value))

const NAMES: Record<Metric, string> = {
  p50: 'p50',
  p90: 'p90',
  p95: 'p95',
  p99: 'p99',
  max: 'max',
  errors: 'errors',
  rps: 'throughput',
}

/** "p99 was 412 ms, limit 250 ms" */
export const describeFailure = (result: ThresholdResult): string =>
  Option.match(parse(result.expression), {
    onNone: () => `${result.expression} did not hold`,
    onSome: threshold => {
      const verb = threshold.metric === 'errors' ? 'were' : 'was'
      const where =
        result.endpoint === undefined ? '' : ` on ${result.endpoint}`
      return `${NAMES[threshold.metric]}${where} ${verb} ${formatValue(threshold.metric, result.actual)}, limit ${formatValue(threshold.metric, threshold.limit)}`
    },
  })

/** "412 ms" for a chip, or nothing when the expression can't be read. */
export const formatActual = (result: ThresholdResult): Option.Option<string> =>
  Option.map(parse(result.expression), threshold =>
    formatValue(threshold.metric, result.actual),
  )
