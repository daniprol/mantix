/**
 * One second of a run.
 *
 * The engine publishes exactly one `Second` per elapsed second. Everything
 * the dashboard, the terminal summary and the thresholds show is computed
 * by merging these.
 */
import { Schema } from 'effect'

import { ErrorKind } from './ErrorKind.ts'
import { Histogram } from './Histogram.ts'
import { IterationTrace } from './Trace.ts'

// The error classes live in their own file; re-exported from here.
export { ErrorKind } from './ErrorKind.ts'

/**
 * Does an error of this kind count as a failed request? Every kind does
 * except ScriptError: a bug in the test is not the server's failure, so it
 * must never move the `errors` figure or the "errors < 1%" threshold. It
 * stays visible in `errorsByKind` and in the error samples.
 */
export const isRequestError = (kind: string): boolean => kind !== 'ScriptError'

/** Failed requests in an `errors` record, without any ScriptErrors. */
export const countRequestErrors = (
  errors: Readonly<Record<string, number>>,
): number =>
  Object.entries(errors).reduce(
    (sum, [kind, count]) => (isRequestError(kind) ? sum + count : sum),
    0,
  )

/**
 * Requests sent by a scenario's `setup` or `teardown` instead of by its
 * load. They are recorded like any other request, but under their own
 * endpoint (e.g. "POST /login (setup)") and marked with this phase.
 */
export const Phase = Schema.Literals(['setup', 'teardown'])
export type Phase = typeof Phase.Type

/** What happened on one endpoint during one second. */
export const EndpointSecond = Schema.Struct({
  /** Method plus route template, e.g. "GET /cart/:id". */
  endpoint: Schema.String,
  /** Set for setup and teardown requests; absent for load requests. */
  phase: Schema.optionalKey(Phase),
  /** Requests that finished this second (successful or not). */
  requests: Schema.Finite,
  /** Latency measured from when the request should have started (µs). */
  latency: Histogram,
  /** Latency measured from when the request actually started (µs). */
  uncorrected: Histogram,
  /** Responses by status code, e.g. { "200": 41, "503": 2 }. */
  statuses: Schema.Record(Schema.String, Schema.Finite),
  /** Failed requests by error class, e.g. { "Timeout": 3 }. */
  errors: Schema.Record(Schema.String, Schema.Finite),
})
export type EndpointSecond = typeof EndpointSecond.Type

/**
 * Is this part of the load? Setup and teardown requests are kept out of
 * the "All endpoints" totals (and so out of thresholds on them): a setup
 * that seeds a thousand records, or a slow first login on a cold server,
 * says nothing about how the server handles the load. They still get
 * their own rows, so they can be seen and given their own thresholds.
 */
export const isLoad = (part: EndpointSecond): boolean =>
  part.phase === undefined

/**
 * Where a response body did not match the `expect` schema: the exact
 * path, what the schema wanted and what actually arrived.
 */
export const SchemaDiff = Schema.Struct({
  /** The path in the body, e.g. "$.items[3].price". */
  path: Schema.String,
  /** What the schema library said, e.g. "Expected number". */
  expected: Schema.String,
  /** The value that arrived, as short JSON, e.g. "\"19.99\"". */
  received: Schema.String,
  /** Its type: string, number, boolean, null, array, object or missing. */
  receivedType: Schema.String,
})
export type SchemaDiff = typeof SchemaDiff.Type

/** One example of an error, kept so people can see what went wrong. */
export const ErrorSample = Schema.Struct({
  endpoint: Schema.String,
  kind: ErrorKind,
  /** A short, human readable message. Secrets are never included. */
  message: Schema.String,
  /**
   * Errors with the same fingerprint are the same problem (see Errors.ts).
   * Absent in data recorded before Mantix grouped errors.
   */
  fingerprint: Schema.optionalKey(Schema.String),
  /** For SchemaMismatch: where the body differed from the schema. */
  diff: Schema.optionalKey(SchemaDiff),
  /** For ScriptError: the line in the test file that threw, e.g. "checkout.ts:42". */
  location: Schema.optionalKey(Schema.String),
})
export type ErrorSample = typeof ErrorSample.Type

/**
 * Why a second's numbers should not be trusted. Each one means Mantix
 * itself (the load generator) was struggling, so slow responses in that
 * second may be our fault, not the server's.
 *
 * - LoopLag: the event loop was blocked for a long stretch.
 * - LateStarts: iterations started well after their scheduled time.
 * - Cpu: the Mantix process used (nearly) a whole CPU core.
 * - Gc: garbage collection paused the process for a long time.
 */
export const GeneratorIssue = Schema.Literals([
  'LoopLag',
  'LateStarts',
  'Cpu',
  'Gc',
])
export type GeneratorIssue = typeof GeneratorIssue.Type

/** How the load generator itself was doing during one second. */
export const GeneratorHealth = Schema.Struct({
  /** CPU used by the Mantix process, in % of one core (can exceed 100). */
  cpuPercent: Schema.Finite,
  /** Time spent paused in garbage collection, in ms. */
  gcMs: Schema.Finite,
  /** JavaScript heap in use when the second closed, in MB. */
  heapMb: Schema.Finite,
  /**
   * The latest an iteration started compared to its schedule, in ms
   * (open model only; 0 in the closed model).
   */
  lateStartMs: Schema.Finite,
  /** Empty when the second can be trusted. */
  issues: Schema.Array(GeneratorIssue),
})
export type GeneratorHealth = typeof GeneratorHealth.Type

export const Second = Schema.Struct({
  /** Whole seconds since the run started: 0 is the first second. */
  t: Schema.Finite,
  /** The load the plan asked for this second: iterations/s or VUs. */
  target: Schema.Finite,
  /** Iterations the schedule wanted to start this second. */
  offered: Schema.Finite,
  /** Iterations that actually started. */
  started: Schema.Finite,
  /** Iterations that could not start because no VU was free. */
  dropped: Schema.Finite,
  /** Iterations that finished without an error. */
  completed: Schema.Finite,
  /** Iterations that ended with an error. */
  failed: Schema.Finite,
  /** Iterations still running when the second closed. */
  inFlight: Schema.Finite,
  /** Virtual users alive when the second closed. */
  vus: Schema.Finite,
  /**
   * The worst event-loop delay the load generator saw this second, in ms.
   * High values mean Mantix itself was the bottleneck, so the numbers for
   * this second should not be trusted.
   */
  loopLagMs: Schema.Finite,
  /**
   * The generator's own health, and whether to trust this second. Absent
   * in data recorded before Mantix measured it.
   */
  generator: Schema.optionalKey(GeneratorHealth),
  /** Per-endpoint results. */
  endpoints: Schema.Array(EndpointSecond),
  /**
   * A few example errors from this second. Every fingerprint seen this
   * second has at least one, so a rare error is never pushed out by a
   * noisy one.
   */
  errorSamples: Schema.Array(ErrorSample),
  /** The slowest iteration that finished this second, for the waterfall. */
  slowest: Schema.optionalKey(IterationTrace),
  /** How many errors of each fingerprint happened this second. */
  fingerprints: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
})
export type Second = typeof Second.Type
