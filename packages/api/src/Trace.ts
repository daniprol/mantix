/**
 * Iteration traces: one iteration drawn like the browser's network panel
 * (the waterfall). Multi-step flows are where TypeScript scenarios shine,
 * so seeing where one slow iteration spent its time matters.
 *
 * The engine keeps the slowest iteration of every second (`Second.slowest`),
 * so "the worst iteration in the last 10 seconds" is a lookup over Seconds,
 * like everything else.
 */
import { Schema } from 'effect'

import { ErrorKind } from './ErrorKind.ts'

/**
 * Where a request's time went, in ms. These come from undici's diagnostics
 * channels; they are absent when undici could not tell us.
 *
 * - blocked: from the call to the request going out, including waiting
 *   for a free connection and opening one (DNS, TCP, TLS).
 * - waiting: from the request going out to the first byte of the
 *   response (time to first byte).
 * - download: reading the response body.
 */
export const RequestPhases = Schema.Struct({
  blocked: Schema.Finite,
  waiting: Schema.Finite,
  download: Schema.Finite,
})
export type RequestPhases = typeof RequestPhases.Type

/** One request inside an iteration. */
export const RequestSpan = Schema.Struct({
  /** Method plus route template, e.g. "GET /cart/:id". */
  endpoint: Schema.String,
  /** ms after the iteration actually started. */
  start: Schema.Finite,
  /** ms from send to the end of the response body. */
  duration: Schema.Finite,
  status: Schema.optionalKey(Schema.Finite),
  error: Schema.optionalKey(ErrorKind),
  phases: Schema.optionalKey(RequestPhases),
  /** True when this request had to open a new connection. */
  connected: Schema.optionalKey(Schema.Boolean),
})
export type RequestSpan = typeof RequestSpan.Type

/** One whole iteration, request by request. */
export const IterationTrace = Schema.Struct({
  scenario: Schema.String,
  vu: Schema.Finite,
  /** This VU's iteration number, from 1. */
  iteration: Schema.Finite,
  /** How late the iteration started against its schedule, ms (open model). */
  lateMs: Schema.Finite,
  /** From the intended start (or the actual one) to the end, ms. */
  duration: Schema.Finite,
  outcome: Schema.Literals(['completed', 'failed']),
  /**
   * The requests in the order they started. Gaps between them are think
   * time or your own code.
   */
  spans: Schema.Array(RequestSpan),
})
export type IterationTrace = typeof IterationTrace.Type

/**
 * The slowest iteration in the last `window` seconds (10 by default),
 * from the slowest kept in each Second. Undefined when none finished.
 */
export const worstIteration = (
  seconds: ReadonlyArray<{
    readonly t: number
    readonly slowest?: IterationTrace | undefined
  }>,
  window = 10,
): IterationTrace | undefined => {
  const last = seconds.at(-1)
  if (last === undefined) return undefined
  let worst: IterationTrace | undefined
  for (const second of seconds) {
    if (second.t <= last.t - window || second.slowest === undefined) continue
    if (worst === undefined || second.slowest.duration > worst.duration) {
      worst = second.slowest
    }
  }
  return worst
}
