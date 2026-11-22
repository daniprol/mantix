/**
 * Turning a TimelineInput into the columns the timeline draws. Pure
 * functions: the chart code only paints what this returns.
 *
 * The x axis is "seconds since start". Second `t` covers [t, t+1), so its
 * point sits at x = t + 1 and the planned line starts at x = 0.
 */
import { Array, Option, pipe } from 'effect'

import { Histogram, type Second, countRequestErrors, isLoad } from '@mantix/api'

import { plannedTotalAt } from '../domain/plan.ts'
import { LAG_LIMIT_MS } from '../domain/stats.ts'
import type { LatencyLimit, TimelineInput } from './store.ts'

/** One second, boiled down to what the charts need. */
type SecondColumn = Readonly<{
  p50: number | null
  p95: number | null
  requests: number
  /** The top track's value: iterations/s, VUs or requests/s. */
  load: number
  errors: number
  lagged: boolean
  /** Latency distribution as [ms, count] pairs, for the heatmap. */
  cells: ReadonlyArray<readonly [number, number]>
}>

type Columns = ReadonlyArray<Option.Option<SecondColumn>>

export type TimelineSeries = Readonly<{
  x: Array<number>
  /** Index i holds second t = i - 1; index 0 is the start (no data). */
  columns: Columns
  baselineColumns: Columns
  hasBaseline: boolean
  p50: Array<number | null>
  p95: Array<number | null>
  baselineP95: Array<number | null>
  planned: Array<number | null>
  load: Array<number | null>
  baselineLoad: Array<number | null>
  topTrack: TimelineInput['topTrack']
  isRate: boolean
  maybeLiveEdge: Option.Option<number>
  maybeLimit: Option.Option<LatencyLimit>
  maybeRange: TimelineInput['maybeRange']
  latencyRange: readonly [number, number]
  /** The error count at full height, so both runs share one scale. */
  mostErrors: number
}>

const toColumn =
  (topTrack: TimelineInput['topTrack'], isRate: boolean) =>
  (second: Second): SecondColumn => {
    // The timeline shows the load (no setup or teardown requests), and a
    // ScriptError is not a failed request: the same rules as the summary.
    const endpoints = second.endpoints.filter(isLoad)
    const merged = Histogram.mergeAll(endpoints.map(each => each.latency))
    const requests = endpoints.reduce((sum, each) => sum + each.requests, 0)
    const errors = endpoints.reduce(
      (sum, each) => sum + countRequestErrors(each.errors),
      0,
    )
    const cells = merged.buckets.map(([index, count]) => {
      const [lower, upper] = Histogram.bucketBounds(index)
      return [(lower + upper) / 2 / 1000, count] as const
    })
    const percentile = (q: number) =>
      merged.count === 0 ? null : Histogram.percentile(merged, q) / 1000
    return {
      p50: percentile(0.5),
      p95: percentile(0.95),
      requests,
      load:
        topTrack === 'Throughput'
          ? requests
          : isRate
            ? second.started
            : second.vus,
      errors,
      lagged: second.loopLagMs > LAG_LIMIT_MS,
      cells,
    }
  }

const columnsOf = (
  seconds: ReadonlyArray<Second>,
  x: ReadonlyArray<number>,
  toSecondColumn: (second: Second) => SecondColumn,
): Columns => {
  const byIndex = new Map(seconds.map(second => [second.t + 1, second]))
  return x.map(i =>
    pipe(Option.fromNullishOr(byIndex.get(i)), Option.map(toSecondColumn)),
  )
}

const valuesOf = (
  columns: Columns,
  pick: (column: SecondColumn) => number | null,
): Array<number | null> =>
  columns.map(column =>
    Option.match(column, { onNone: () => null, onSome: pick }),
  )

/** Errors per second drawn at full height, at least. */
const ERRORS_FLOOR = 10

const niceLow = (value: number): number =>
  10 ** Math.floor(Math.log10(Math.max(value, 0.01)))

export const buildSeries = (input: TimelineInput): TimelineSeries => {
  const baseline = Option.getOrElse(input.maybeBaseline, () => [])
  const length = Math.max(
    Math.ceil(input.duration),
    input.current.length,
    baseline.length,
  )
  const x = Array.makeBy(length + 1, i => i)
  const toSecondColumn = toColumn(input.topTrack, input.isRate)
  const columns = columnsOf(input.current, x, toSecondColumn)
  const baselineColumns = columnsOf(baseline, x, toSecondColumn)

  const observed = [
    ...Array.getSomes(columns),
    ...Array.getSomes(baselineColumns),
  ]
  const lowest = observed.reduce(
    (low, column) => Math.min(low, column.p50 ?? low),
    Number.POSITIVE_INFINITY,
  )
  const highest = observed.reduce(
    (high, column) => Math.max(high, column.p95 ?? 0),
    0,
  )
  const limitMs = Option.match(input.maybeLimit, {
    onNone: () => 0,
    onSome: limit => limit.ms,
  })

  return {
    x,
    columns,
    baselineColumns,
    hasBaseline: Option.isSome(input.maybeBaseline),
    p50: valuesOf(columns, column => column.p50),
    p95: valuesOf(columns, column => column.p95),
    baselineP95: valuesOf(baselineColumns, column => column.p95),
    planned: Array.isReadonlyArrayEmpty(input.plan)
      ? x.map(() => null)
      : x.map(i => plannedTotalAt(input.plan, i)),
    load: valuesOf(columns, column => column.load),
    baselineLoad: valuesOf(baselineColumns, column => column.load),
    topTrack: input.topTrack,
    isRate: input.isRate,
    maybeLiveEdge: input.isLive
      ? Option.some(input.current.length)
      : Option.none(),
    maybeLimit: input.maybeLimit,
    maybeRange: input.maybeRange,
    latencyRange: [
      Number.isFinite(lowest) ? niceLow(lowest / 2) : 10,
      Math.max(highest * 1.6, limitMs * 1.6, 100),
    ],
    // A floor keeps a lone error a small tick instead of a full bar.
    mostErrors: Math.max(
      ERRORS_FLOOR,
      ...observed.map(column => column.errors),
    ),
  }
}
