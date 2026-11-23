/**
 * Shareable HTML reports: one file with the dashboard and the runs inside.
 * It opens in any browser, straight from disk, with no Mantix and no
 * server. Handy as a CI artifact, or attached to a PR or a chat.
 *
 * The dashboard build ships a template (report.html, see apps/web's
 * vite.config.ts) with an empty slot. Writing a report is: take the runs,
 * leave out the error details unless asked (`--full`), and put the data in
 * the slot. What goes in is the `Report` schema in @mantix/api, which the
 * dashboard uses to read it back.
 */
import { Array, Data, Effect, Schema } from 'effect'
import { Flag } from 'effect/cli'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'

import {
  REPORT_PLACEHOLDER,
  Report,
  type ReportDetail,
  type ReportRun,
  type RunInfo,
  reportSlot,
  secondForReport,
} from '@mantix/api'

import { findWebRoot } from './Server.ts'

class ReportError extends Data.TaggedError('ReportError')<{
  readonly message: string
}> {}

/** `--full`, shared by `mantix run --report` and `mantix report`. */
export const fullFlag = Flag.Boolean('full').pipe(
  Flag.withDescription(
    'Put error messages and response values in the report (left out by default, so the file is safe to share)',
  ),
  Flag.withDefault(false),
)

/** "Checkout API" → "checkout-api", for a file name. */
const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'run'

/** Where a report goes when no path is given: next to the run history. */
export const defaultReportPath = (run: RunInfo): string =>
  join('.mantix', 'reports', `${slug(run.testName)}-${run.id}.html`)

/** The runs, with as much error detail as asked for. */
export const reportOf = (
  runs: Array.NonEmptyReadonlyArray<ReportRun>,
  detail: ReportDetail,
): Report => ({
  version: 1,
  detail,
  runs: Array.map(runs, ({ run, seconds }) => ({
    run,
    seconds: seconds.map(second => secondForReport(second, detail)),
  })),
})

// The same Schema writes the data here and reads it in the browser.
const encodeReport = Schema.encodeSync(Schema.fromJsonString(Report))

/**
 * The template with the report in its slot, as gzipped JSON in base64:
 * a run's data shrinks about 8 times, and base64 can never close the
 * script element it sits in.
 */
export const fillTemplate = (template: string, report: Report): string => {
  const slot = reportSlot(REPORT_PLACEHOLDER)
  if (!template.includes(slot)) {
    throw new Error('The report template has no slot for the data.')
  }
  const data = gzipSync(encodeReport(report)).toString('base64')
  // A function, so a `$` in the data is never read as a replace pattern.
  return template.replace(slot, () => reportSlot(data))
}

/** Where the template is: next to the built dashboard. */
const findTemplate = (): string | undefined => {
  const webRoot = findWebRoot()
  const template =
    webRoot === undefined ? undefined : join(webRoot, 'report.html')
  return template !== undefined && existsSync(template) ? template : undefined
}

/** Write the report to `path`, creating its folder if needed. */
export const writeReport = Effect.fn('writeReport')(function* (
  path: string,
  report: Report,
) {
  const template = findTemplate()
  if (template === undefined) {
    return yield* new ReportError({
      message:
        'The report template is missing. Build the dashboard first: pnpm --filter @mantix/web build',
    })
  }
  yield* Effect.tryPromise({
    try: async () => {
      const html = fillTemplate(await readFile(template, 'utf8'), report)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, html)
    },
    catch: error =>
      new ReportError({
        message: `Could not write ${path}: ${error instanceof Error ? error.message : String(error)}`,
      }),
  })
})
