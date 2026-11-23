/**
 * A shareable report: finished runs with every one of their Seconds,
 * written into a single HTML file by `mantix report` (or `mantix run
 * --report`) and read back by the dashboard, which then shows them
 * without a server.
 *
 * Shared by the CLI (which writes it) and the dashboard (which reads it),
 * so both agree on the shape and on where the data sits in the page.
 */
import { Schema } from 'effect'

import { fingerprint, normalizeMessage } from './Errors.ts'
import { RunInfo } from './Run.ts'
import { type ErrorSample, Second } from './Second.ts'

/**
 * How much of the errors a report keeps.
 *
 * - Summary (the default): every count, plus what kind of problem each
 *   error group is ("POST /checkout · HttpStatus · 503 Service
 *   Unavailable"). Messages are blanked the way error groups already are,
 *   and response values are left out, so the file is safe to pass around.
 * - Full: the error messages and response values as they arrived too.
 */
export const ReportDetail = Schema.Literals(['Summary', 'Full'])
export type ReportDetail = typeof ReportDetail.Type

/** One run and all of its data. */
export const ReportRun = Schema.Struct({
  run: RunInfo,
  seconds: Schema.Array(Second),
})
export type ReportRun = typeof ReportRun.Type

export const Report = Schema.Struct({
  version: Schema.Literal(1),
  detail: ReportDetail,
  /** The first run is the one the report opens on. */
  runs: Schema.NonEmptyArray(ReportRun),
})
export type Report = typeof Report.Type

/**
 * Where the data sits in the page: a script element the browser does not
 * run, holding the Report as gzipped JSON in base64. Base64 also means no
 * value in the data can ever close the script tag early.
 */
export const REPORT_ELEMENT_ID = 'mantix-report'

/** What the report template holds until the CLI puts the data in. */
export const REPORT_PLACEHOLDER = '__MANTIX_REPORT_DATA__'

/**
 * The element itself. The CLI looks for the whole empty element, not just
 * the placeholder: the dashboard's own code (inlined in the same file)
 * contains the placeholder too, to recognise an unfilled template.
 */
export const reportSlot = (content: string): string =>
  `<script id="${REPORT_ELEMENT_ID}" type="application/octet-stream">${content}</script>`

/**
 * An error sample as a Summary report keeps it. The fingerprint stays,
 * so errors still group exactly as before; the message is blanked like an
 * error group's description (numbers, ids and quoted values removed), and
 * a schema mismatch keeps where and what was expected, but not the value
 * that arrived.
 */
export const summarizeErrorSample = (sample: ErrorSample): ErrorSample => {
  const kept: ErrorSample = {
    endpoint: sample.endpoint,
    kind: sample.kind,
    fingerprint: sample.fingerprint ?? fingerprint(sample),
    // A status line or a time limit says nothing private; keep it whole.
    message:
      sample.kind === 'HttpStatus' || sample.kind === 'Timeout'
        ? sample.message
        : normalizeMessage(sample.message),
  }
  return {
    ...kept,
    ...(sample.diff === undefined
      ? {}
      : { diff: { ...sample.diff, received: '' } }),
    ...(sample.location === undefined ? {} : { location: sample.location }),
  }
}

/** A Second as a report with this much detail keeps it. */
export const secondForReport = (second: Second, detail: ReportDetail): Second =>
  detail === 'Full'
    ? second
    : {
        ...second,
        errorSamples: second.errorSamples.map(summarizeErrorSample),
      }

/**
 * What one error example adds to its group's description: the message as
 * it arrived, or the value a schema mismatch received. Undefined when it
 * adds nothing (a 503 example says what the group already says).
 */
export const exampleText = (
  detail: string,
  example: {
    readonly message: string
    readonly diff?: { readonly received: string } | undefined
  },
): string | undefined => {
  const text =
    example.diff === undefined
      ? example.message
      : example.diff.received === ''
        ? undefined
        : `received ${example.diff.received}`
  return text === undefined || text === '' || text === detail ? undefined : text
}
