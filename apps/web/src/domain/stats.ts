/**
 * The numbers the dashboard shows, computed from a list of Seconds.
 *
 * Everything merges per-second histograms first (via `summarizeSeconds`)
 * and computes percentiles from the result. Percentiles are never averaged.
 */
import { Array, Option, Order } from 'effect'

import {
  type EndpointSecond,
  type EndpointStats,
  Histogram,
  type RunInfo,
  type Second,
  fingerprint,
  isLoad,
  summarizeSeconds,
} from '@mantix/api'

import { type Span, spanSeconds } from './span.ts'

/** Fewer requests than this and a p95 would be made up, so we say so. */
const MIN_SAMPLES_FOR_P95 = 20

/** Event-loop lag above this means Mantix itself could not keep up. */
export const LAG_LIMIT_MS = 100

export const isOver = (run: RunInfo): boolean => run.status !== 'running'

/**
 * A pure cache keyed by an immutable array. The Model never changes an
 * array in place, so the same `seconds` always gives the same answer, and
 * the view (which runs many times a second) can ask again for free. The
 * entry is forgotten together with the array.
 */
const remember = <A>() => {
  const cache = new WeakMap<ReadonlyArray<Second>, Map<string, A>>()
  return (seconds: ReadonlyArray<Second>, key: string, compute: () => A): A => {
    const byKey = cache.get(seconds) ?? new Map<string, A>()
    cache.set(seconds, byKey)
    const cached = byKey.get(key)
    if (cached !== undefined) {
      return cached
    }
    const value = compute()
    byKey.set(key, value)
    return value
  }
}

type Summary = ReturnType<typeof summarizeSeconds>

const rememberSummary = remember<Summary>()

/**
 * The summary of a span. A finished run usually ends with one short extra
 * Second while the last requests finish; req/s divides by the planned
 * duration so that Second does not drag it down.
 */
export const summarize = (
  seconds: ReadonlyArray<Second>,
  span: Span,
  plannedDuration: number,
): Summary =>
  rememberSummary(seconds, `${span._tag}:${spanKey(span)}`, () => {
    const inSpan = spanSeconds(seconds, span)
    const elapsed =
      span._tag === 'WholeRun' && plannedDuration > 0
        ? Math.min(inSpan.length, Math.ceil(plannedDuration))
        : inSpan.length
    return summarizeSeconds(inSpan, elapsed)
  })

const spanKey = (span: Span): string =>
  span._tag === 'Range' ? `${span.from}-${span.to}` : ''

/** The three headline figures, plus what their notes need. */
export type Figures = Readonly<{
  /** Requests finished per second. */
  rps: number
  requests: number
  errors: number
  /** Failed share of requests, 0..1. */
  errorRate: number
  p50: number
  p95: number
}>

export const figuresOf = (total: EndpointStats): Figures => ({
  rps: total.rps,
  requests: total.requests,
  errors: total.errors,
  errorRate: total.errorRate,
  p50: total.latency.p50,
  p95: total.latency.p95,
})

export const hasEnoughForP95 = (requests: number): boolean =>
  requests >= MIN_SAMPLES_FOR_P95

const byP95Descending = Order.mapInput(
  Order.flip(Order.Number),
  (row: EndpointStats) => row.latency.p95,
)

/** One row per endpoint, the slowest (by p95) first. */
export const endpointRows = (summary: Summary): ReadonlyArray<EndpointStats> =>
  Array.sort(summary.endpoints, byP95Descending)

const rememberFocus = remember<ReadonlyArray<Second>>()

/** An endpoint part as plain load, so the totals count it (see isLoad). */
const asLoad = (part: EndpointSecond): EndpointSecond => ({
  endpoint: part.endpoint,
  requests: part.requests,
  latency: part.latency,
  uncorrected: part.uncorrected,
  statuses: part.statuses,
  errors: part.errors,
})

/** The error samples and fingerprint counts that belong to one endpoint. */
const focusErrors = (
  second: Second,
  endpoint: string,
): Pick<Second, 'errorSamples' | 'fingerprints'> => {
  const errorSamples = second.errorSamples.filter(
    sample => sample.endpoint === endpoint,
  )
  if (second.fingerprints === undefined) {
    return { errorSamples }
  }
  // A fingerprint includes the endpoint, and every fingerprint seen in a
  // second has a sample, so the samples say which counts are ours.
  const ours = new Set(
    errorSamples.map(sample => sample.fingerprint ?? fingerprint(sample)),
  )
  return {
    errorSamples,
    fingerprints: Object.fromEntries(
      Object.entries(second.fingerprints).filter(([key]) => ours.has(key)),
    ),
  }
}

/**
 * The Seconds of a run as if it had only one endpoint. Everything that
 * works on a whole run (figures, timeline, error groups) then works on
 * that endpoint unchanged.
 */
export const focusSeconds = (
  seconds: ReadonlyArray<Second>,
  endpoint: string,
): ReadonlyArray<Second> =>
  rememberFocus(seconds, endpoint, () =>
    seconds.map(second => ({
      ...second,
      endpoints: second.endpoints
        .filter(part => part.endpoint === endpoint)
        .map(asLoad),
      ...focusErrors(second, endpoint),
    })),
  )

/** Responses by status code, most common first. */
export const statusCounts = (
  seconds: ReadonlyArray<Second>,
): ReadonlyArray<readonly [string, number]> => {
  const counts = new Map<string, number>()
  seconds.forEach(second =>
    second.endpoints.forEach(part =>
      Object.entries(part.statuses).forEach(([status, count]) =>
        counts.set(status, (counts.get(status) ?? 0) + count),
      ),
    ),
  )
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

/** How many seconds a smoothed curve merges: the second and the four before. */
const CURVE_WINDOW = 5

const rememberCurve = remember<ReadonlyArray<number | null>>()

/**
 * p95 latency per second for one endpoint (or all of them), for the small
 * curve on its row.
 * Each point merges the histograms of the last few seconds (never averages
 * percentiles), so a quiet endpoint draws a readable line instead of noise.
 * Index i holds second t = i; null where there were no requests.
 */
export const p95Curve = (
  seconds: ReadonlyArray<Second>,
  maybeEndpoint: Option.Option<string>,
): ReadonlyArray<number | null> =>
  rememberCurve(
    seconds,
    Option.getOrElse(maybeEndpoint, () => ''),
    () => {
      const parts = (second: Second) =>
        Option.match(maybeEndpoint, {
          onNone: () => second.endpoints.filter(isLoad),
          onSome: endpoint =>
            second.endpoints.filter(part => part.endpoint === endpoint),
        })
      const length = seconds.reduce(
        (end, second) => Math.max(end, second.t + 1),
        0,
      )
      const histograms = Array.makeBy(length, () => Histogram.empty)
      seconds.forEach(second => {
        histograms[second.t] = Histogram.mergeAll(
          parts(second).map(part => part.latency),
        )
      })
      return histograms.map((histogram, t) => {
        if (histogram.count === 0) {
          return null
        }
        const merged = Histogram.mergeAll(
          histograms.slice(Math.max(0, t - CURVE_WINDOW + 1), t + 1),
        )
        return Histogram.percentile(merged, 0.95) / 1000
      })
    },
  )
