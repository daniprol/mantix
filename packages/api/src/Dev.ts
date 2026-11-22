/**
 * `mantix dev`: save the test file, see one traced iteration straight away.
 *
 * Every time the test file (or a file next to it) changes, Mantix reloads
 * it, runs each scenario's setup, one iteration and teardown, and sends a
 * `DevEvent` with what happened. The terminal prints it as a small
 * waterfall; the dashboard can follow `/api/dev/events`.
 */
import { Schema } from 'effect'

import { TestInfo } from './Run.ts'
import { ErrorSample } from './Second.ts'
import { IterationTrace } from './Trace.ts'

/** One scenario's traced iteration. */
export const ProbeResult = Schema.Struct({
  scenario: Schema.String,
  /** The iteration, request by request. Absent when setup failed. */
  trace: Schema.optionalKey(IterationTrace),
  /** Every error it produced, with its fingerprint and details. */
  errors: Schema.Array(ErrorSample),
  /** Set when setup failed, so no iteration ran. */
  setupError: Schema.optionalKey(Schema.String),
})
export type ProbeResult = typeof ProbeResult.Type

export const DevEvent = Schema.Union([
  /** The test loaded and every scenario ran one traced iteration. */
  Schema.TaggedStruct('Reloaded', {
    test: TestInfo,
    results: Schema.Array(ProbeResult),
  }),
  /** The test file could not be loaded (a syntax error, a bad export...). */
  Schema.TaggedStruct('ReloadFailed', { message: Schema.String }),
])
export type DevEvent = typeof DevEvent.Type
