/**
 * Turning Seconds into the columns the timeline draws. Pure functions: the
 * chart code only paints what this returns.
 *
 * The x axis is "seconds since start". Second `t` covers [t, t+1), so its
 * point sits at x = t + 1 and the planned line starts at x = 0.
 */
import { Array, Option, pipe } from 'effect'

import {
  Histogram,
  type RunInfo,
  type Second,
  countRequestErrors,
} from '@mantix/api'

import { plannedTotalAt } from '../domain/plan.ts'
import { LAG_LIMIT_MS } from '../domain/stats.ts'
import * as Threshold from '../domain/threshold.ts'
import type { TimelineData } from './store.ts'

/** One second, boiled down to what the charts need. */
export type SecondColumn = Readonly<{
  p50: number | null
  p99: number | null
  requests: number
  /** Iterations started this second (the open model's load). */
  started: number
  /** Virtual users alive at the end of the second (the closed model's load). */
  vus: number
  errors: number
  lagged: boolean
  /** Latency distribution as [ms, count] pairs, for the heatmap. */
  cells: ReadonlyArray<readonly [number, number]>
}>

export type LatencyLimit = Readonly<{ ms: number; failed: boolean }>

export type TimelineSeries = Readonly<{
  x: Array<number>
  /** Index i holds second t = i - 1; index 0 is the start (no data). */
  columns: ReadonlyArray<Option.Option<SecondColumn>>
  p50: Array<number | null>
  p99: Array<number | null>
  /** The load lane compares like with like: planned against achieved
   *  iterations/s for the open model, or virtual users for the closed one. */
  isRate: boolean
  target: Array<number | null>
  achieved: Array<number | null>
  maybeLiveEdge: Option.Option<number>
  maybeLimit: Option.Option<LatencyLimit>
  latencyRange: readonly [number, number]
}>

const toColumn = (second: Second): SecondColumn => {
  const merged = Histogram.mergeAll(
    second.endpoints.map(endpoint => endpoint.latency),
  )
  const requests = second.endpoints.reduce((sum, e) => sum + e.requests, 0)
  // Same rule as the summary: a ScriptError is not a failed request.
  const errors = second.endpoints.reduce(
    (sum, e) => sum + countRequestErrors(e.errors),
    0,
  )
  const cells = merged.buckets.map(([index, count]) => {
    const [lower, upper] = Histogram.bucketBounds(index)
    return [(lower + upper) / 2 / 1000, count] as const
  })
  return {
    p50: merged.count === 0 ? null : Histogram.percentile(merged, 0.5) / 1000,
    p99: merged.count === 0 ? null : Histogram.percentile(merged, 0.99) / 1000,
    requests,
    started: second.started,
    vus: second.vus,
    errors,
    lagged: second.loopLagMs > LAG_LIMIT_MS,
    cells,
  }
}

/** The first latency threshold of the run, to draw as a limit line. */
const latencyLimit = (run: RunInfo): Option.Option<LatencyLimit> =>
  pipe(
    run.thresholds,
    Array.filter(result => result.endpoint === undefined),
    Array.findFirst(result =>
      pipe(
        Threshold.parse(result.expression),
        Option.filter(t => t.metric !== 'errors' && t.metric !== 'rps'),
        Option.map(t => ({ ms: t.limit, failed: !result.passed })),
      ),
    ),
  )

const niceLow = (value: number): number =>
  10 ** Math.floor(Math.log10(Math.max(value, 0.01)))

export const buildSeries = ({ run, seconds }: TimelineData): TimelineSeries => {
  const length = Math.max(Math.ceil(run.duration), seconds.length)
  const x = Array.makeBy(length + 1, i => i)
  const byIndex = new Map(seconds.map(second => [second.t + 1, second]))
  const columns = x.map(i =>
    pipe(Option.fromNullishOr(byIndex.get(i)), Option.map(toColumn)),
  )
  const value = (pick: (column: SecondColumn) => number | null) =>
    columns.map(column =>
      Option.match(column, { onNone: () => null, onSome: pick }),
    )
  const p50 = value(column => column.p50)
  const p99 = value(column => column.p99)
  const isRate = run.plan.every(scenario => scenario.plan.model === 'rate')
  const target = x.map(i => plannedTotalAt(run.plan, i))
  const maybeLimit = latencyLimit(run)

  const observed = Array.getSomes(columns)
  const lowest = observed.reduce(
    (low, column) => Math.min(low, column.p50 ?? low),
    Number.POSITIVE_INFINITY,
  )
  const highest = observed.reduce(
    (high, column) => Math.max(high, column.p99 ?? 0),
    0,
  )
  const limitMs = Option.match(maybeLimit, {
    onNone: () => 0,
    onSome: limit => limit.ms,
  })
  const latencyRange = [
    Number.isFinite(lowest) ? niceLow(lowest / 2) : 1,
    Math.max(highest * 1.4, limitMs * 1.6, 10),
  ] as const

  return {
    x,
    columns,
    p50,
    p99,
    isRate,
    target,
    achieved: value(column => (isRate ? column.started : column.vus)),
    maybeLiveEdge:
      run.status === 'running' ? Option.some(seconds.length) : Option.none(),
    maybeLimit,
    latencyRange,
  }
}

/** What the charts show before any data arrives. */
export const EMPTY_SERIES: TimelineSeries = {
  x: [],
  columns: [],
  p50: [],
  p99: [],
  isRate: true,
  target: [],
  achieved: [],
  maybeLiveEdge: Option.none(),
  maybeLimit: Option.none(),
  latencyRange: [1, 1000],
}
