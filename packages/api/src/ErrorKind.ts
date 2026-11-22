/** The error classes, in a file of their own so Trace.ts can use them too. */
import { Schema } from 'effect'

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
