/**
 * Turning a list of Seconds into the numbers people read.
 *
 * These are pure functions, shared by the CLI's terminal summary, the JSON
 * summary file and the dashboard. Percentiles always come from merged
 * histograms, never from averaging other percentiles.
 */
import { Schema } from 'effect'

import * as Histogram from './Histogram.ts'
import { RunInfo } from './Run.ts'
import {
  type EndpointSecond,
  type Second,
  countRequestErrors,
} from './Second.ts'

/** Latency figures for a window, in milliseconds. */
export const LatencyStats = Schema.Struct({
  p50: Schema.Finite,
  p90: Schema.Finite,
  p95: Schema.Finite,
  p99: Schema.Finite,
  max: Schema.Finite,
})
export type LatencyStats = typeof LatencyStats.Type

export const EndpointStats = Schema.Struct({
  endpoint: Schema.String,
  requests: Schema.Finite,
  /** Failed requests. ScriptErrors (bugs in the test) are not included. */
  errors: Schema.Finite,
  /** errors / requests, from 0 to 1. What the `errors` threshold checks. */
  errorRate: Schema.Finite,
  /** Requests per second over the window. */
  rps: Schema.Finite,
  /** Latency from intended start (the honest number). */
  latency: LatencyStats,
  /** Latency from actual send, shown for comparison. */
  uncorrected: LatencyStats,
  /** Errors by class, ScriptErrors included, so they are still shown. */
  errorsByKind: Schema.Record(Schema.String, Schema.Finite),
})
export type EndpointStats = typeof EndpointStats.Type

/** The versioned JSON summary written by `mantix run --json`. */
export const RunSummary = Schema.Struct({
  version: Schema.Literal(1),
  run: RunInfo,
  /** Seconds of data the summary covers. */
  seconds: Schema.Finite,
  iterations: Schema.Struct({
    started: Schema.Finite,
    completed: Schema.Finite,
    failed: Schema.Finite,
    dropped: Schema.Finite,
  }),
  total: EndpointStats,
  endpoints: Schema.Array(EndpointStats),
})
export type RunSummary = typeof RunSummary.Type

const toMs = (micros: number): number => micros / 1000

/** p50/p90/p95/p99/max of a histogram, in milliseconds. */
export const latencyStats = (h: Histogram.Histogram): LatencyStats => ({
  p50: toMs(Histogram.percentile(h, 0.5)),
  p90: toMs(Histogram.percentile(h, 0.9)),
  p95: toMs(Histogram.percentile(h, 0.95)),
  p99: toMs(Histogram.percentile(h, 0.99)),
  max: toMs(h.max),
})

const addCounts = (
  into: Record<string, number>,
  from: Readonly<Record<string, number>>,
): void => {
  for (const [key, value] of Object.entries(from)) {
    into[key] = (into[key] ?? 0) + value
  }
}

/** Merge many per-second endpoint results into one set of stats. */
const statsFor = (
  endpoint: string,
  parts: ReadonlyArray<EndpointSecond>,
  seconds: number,
): EndpointStats => {
  let requests = 0
  const errorsByKind: Record<string, number> = {}
  for (const part of parts) {
    requests += part.requests
    addCounts(errorsByKind, part.errors)
  }
  // Only server and transport failures count; see isRequestError.
  const errors = countRequestErrors(errorsByKind)
  return {
    endpoint,
    requests,
    errors,
    errorRate: requests === 0 ? 0 : errors / requests,
    rps: seconds === 0 ? 0 : requests / seconds,
    latency: latencyStats(Histogram.mergeAll(parts.map(p => p.latency))),
    uncorrected: latencyStats(
      Histogram.mergeAll(parts.map(p => p.uncorrected)),
    ),
    errorsByKind,
  }
}

/**
 * Stats per endpoint (sorted by name) and for all endpoints together, over
 * any list of Seconds. Pass a slice to summarise a window.
 *
 * `elapsedSeconds` is what req/s divides by. It defaults to the number of
 * Seconds; pass the planned duration to ignore the short extra Second in
 * which the last in-flight requests finish.
 */
export const summarizeSeconds = (
  seconds: ReadonlyArray<Second>,
  elapsedSeconds: number = seconds.length,
): {
  readonly total: EndpointStats
  readonly endpoints: Array<EndpointStats>
} => {
  const byEndpoint = new Map<string, Array<EndpointSecond>>()
  const all: Array<EndpointSecond> = []
  for (const second of seconds) {
    for (const part of second.endpoints) {
      const list = byEndpoint.get(part.endpoint) ?? []
      list.push(part)
      byEndpoint.set(part.endpoint, list)
      all.push(part)
    }
  }
  const count = elapsedSeconds
  const endpoints = [...byEndpoint.entries()]
    .map(([name, parts]) => statsFor(name, parts, count))
    .sort((a, b) => a.endpoint.localeCompare(b.endpoint))
  return { total: statsFor('All endpoints', all, count), endpoints }
}

/** Build the full, versioned run summary. */
export const summarizeRun = (
  run: RunInfo,
  seconds: ReadonlyArray<Second>,
): RunSummary => {
  const iterations = { started: 0, completed: 0, failed: 0, dropped: 0 }
  for (const second of seconds) {
    iterations.started += second.started
    iterations.completed += second.completed
    iterations.failed += second.failed
    iterations.dropped += second.dropped
  }
  // A run usually ends with one short extra Second while in-flight requests
  // finish; don't let it drag req/s down.
  const elapsed =
    run.duration > 0
      ? Math.min(seconds.length, Math.ceil(run.duration))
      : seconds.length
  const { total, endpoints } = summarizeSeconds(seconds, elapsed)
  return {
    version: 1,
    run,
    seconds: seconds.length,
    iterations,
    total,
    endpoints,
  }
}
