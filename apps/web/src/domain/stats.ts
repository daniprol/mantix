/**
 * The numbers the dashboard shows, computed from a list of Seconds.
 *
 * Everything merges per-second histograms first (via `summarizeSeconds`)
 * and computes percentiles from the result. Percentiles are never averaged.
 */
import { Array, Order, pipe } from 'effect'

import {
  type EndpointStats,
  type ErrorKind,
  type RunInfo,
  type Second,
  summarizeSeconds,
} from '@mantix/api'

/** How many recent seconds "Last 30 s" covers. */
export const RECENT_SECONDS = 30

/** Fewer requests than this and a p99 would be made up, so we say so. */
export const MIN_SAMPLES_FOR_P99 = 100

/** Event-loop lag above this means Mantix itself could not keep up. */
export const LAG_LIMIT_MS = 100

type Summary = ReturnType<typeof summarizeSeconds>

/**
 * Merging histograms costs a few milliseconds for a long run, and the view
 * runs many times a second. Since the Model is immutable, the same `seconds`
 * array always gives the same summary, so we remember it (a pure cache keyed
 * by the array itself; it is forgotten when the array is).
 */
const summaries = new WeakMap<ReadonlyArray<Second>, Map<number, Summary>>()

/** `summarizeSeconds` over the last `count` seconds (or all), remembered. */
export const summarizeLast = (
  seconds: ReadonlyArray<Second>,
  count: number,
): Summary => {
  const byCount = summaries.get(seconds) ?? new Map<number, Summary>()
  summaries.set(seconds, byCount)
  const cached = byCount.get(count)
  if (cached !== undefined) {
    return cached
  }
  const summary = summarizeSeconds(lastSeconds(seconds, count))
  byCount.set(count, summary)
  return summary
}

export const lastSeconds = (
  seconds: ReadonlyArray<Second>,
  count: number,
): ReadonlyArray<Second> => seconds.slice(Math.max(0, seconds.length - count))

/** The headline figures for a window. */
export type Figures = Readonly<{
  /** Requests finished per second, on average. */
  achieved: number
  /** What the plan asked for, on average: iterations/s, or VUs. */
  target: number
  /** Iterations started per second, on average (compare with `target`). */
  iterations: number
  /** Virtual users alive, on average (compare with `target` for VUs). */
  vus: number
  requests: number
  /** Failed share of requests, 0..1. */
  errorRate: number
  p99: number
}>

const average = (
  seconds: ReadonlyArray<Second>,
  pick: (second: Second) => number,
): number =>
  Array.isReadonlyArrayNonEmpty(seconds)
    ? seconds.reduce((sum, second) => sum + pick(second), 0) / seconds.length
    : 0

export const figures = (all: ReadonlyArray<Second>, count: number): Figures => {
  const { total } = summarizeLast(all, count)
  const seconds = lastSeconds(all, count)
  const target = average(seconds, second => second.target)
  return {
    achieved: total.rps,
    target,
    iterations: average(seconds, second => second.started),
    vus: average(seconds, second => second.vus),
    requests: total.requests,
    errorRate: total.errorRate,
    p99: total.latency.p99,
  }
}

const byP99Descending = Order.mapInput(
  Order.flip(Order.Number),
  (row: EndpointStats) => row.latency.p99,
)

/** One row per endpoint, the slowest (by p99) first. */
export const endpointRows = (
  all: ReadonlyArray<Second>,
  count: number,
): ReadonlyArray<EndpointStats> =>
  Array.sort(summarizeLast(all, count).endpoints, byP99Descending)

/** Responses by status code for one endpoint, most common first. */
export const statusCounts = (
  seconds: ReadonlyArray<Second>,
  endpoint: string,
): ReadonlyArray<readonly [string, number]> => {
  const counts = new Map<string, number>()
  seconds.forEach(second =>
    second.endpoints
      .filter(part => part.endpoint === endpoint)
      .forEach(part =>
        Object.entries(part.statuses).forEach(([status, count]) =>
          counts.set(status, (counts.get(status) ?? 0) + count),
        ),
      ),
  )
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

export type ErrorSampleGroup = Readonly<{
  kind: ErrorKind
  message: string
  count: number
}>

/** Recent error samples for one endpoint, grouped by message, newest first. */
export const recentErrorSamples = (
  seconds: ReadonlyArray<Second>,
  endpoint: string,
  limit = 4,
): ReadonlyArray<ErrorSampleGroup> => {
  const groups = new Map<string, ErrorSampleGroup>()
  pipe(
    seconds,
    Array.reverse,
    Array.forEach(second =>
      second.errorSamples
        .filter(sample => sample.endpoint === endpoint)
        .forEach(sample => {
          const key = `${sample.kind}:${sample.message}`
          const existing = groups.get(key)
          groups.set(key, {
            kind: sample.kind,
            message: sample.message,
            count: (existing?.count ?? 0) + 1,
          })
        }),
    ),
  )
  return [...groups.values()].slice(0, limit)
}

/** Seconds where Mantix's own event loop lagged too much to trust. */
export const laggedSeconds = (
  seconds: ReadonlyArray<Second>,
): ReadonlyArray<Second> =>
  seconds.filter(second => second.loopLagMs > LAG_LIMIT_MS)

export const isOver = (run: RunInfo): boolean => run.status !== 'running'
