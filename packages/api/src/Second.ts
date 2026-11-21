/**
 * One second of a run.
 *
 * The engine publishes exactly one `Second` per elapsed second. Everything
 * the dashboard, the terminal summary and the thresholds show is computed
 * by merging these.
 */
import { Schema } from 'effect'

import { Histogram } from './Histogram.ts'

/**
 * Every failure is put into one of these classes, so a bug in your test
 * script never looks like a server failure.
 *
 * - Transport: connection refused, reset, DNS failure...
 * - Timeout: no response within the request timeout.
 * - HttpStatus: the server answered with a status we treat as a failure.
 * - SchemaMismatch: the body did not match the `expect` schema.
 * - CheckFailed: a check written in the test failed.
 * - ScriptError: the test code itself threw (your bug, not the server's).
 */
export const ErrorKind = Schema.Literals([
  'Transport',
  'Timeout',
  'HttpStatus',
  'SchemaMismatch',
  'CheckFailed',
  'ScriptError',
])
export type ErrorKind = typeof ErrorKind.Type

/** What happened on one endpoint during one second. */
export const EndpointSecond = Schema.Struct({
  /** Method plus route template, e.g. "GET /cart/:id". */
  endpoint: Schema.String,
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

/** One example of an error, kept so people can see what went wrong. */
export const ErrorSample = Schema.Struct({
  endpoint: Schema.String,
  kind: ErrorKind,
  /** A short, human readable message. Secrets are never included. */
  message: Schema.String,
})
export type ErrorSample = typeof ErrorSample.Type

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
  /** Per-endpoint results. */
  endpoints: Schema.Array(EndpointSecond),
  /** A few example errors from this second (at most a handful). */
  errorSamples: Schema.Array(ErrorSample),
})
export type Second = typeof Second.Type
