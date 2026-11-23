/**
 * Reading the runs a report file carries (see `Report` in @mantix/api).
 *
 * The CLI writes them into a script element the browser does not run, as
 * gzipped JSON in base64. The browser's own DecompressionStream unpacks
 * them, so no library is needed. On a page served by `mantix ui` the
 * element is missing, and there is no report.
 */
import { Effect, Option, Schema } from 'effect'

import { REPORT_ELEMENT_ID, REPORT_PLACEHOLDER, Report } from '@mantix/api'

/** Base64 → bytes → gunzip → text. */
const unpack = (base64: string): Promise<string> => {
  const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
  const json = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
  return new Response(json).text()
}

const ReportFromJson = Schema.fromJsonString(Report)

/**
 * The report in this page, if it is one. Data that can't be read is a
 * defect: Foldkit then shows its crash screen with the reason, instead of
 * a dashboard waiting for a server that isn't there.
 */
export const embeddedReport: Effect.Effect<Option.Option<Report>> = Effect.gen(
  function* () {
    const text = yield* Effect.sync(() =>
      document.getElementById(REPORT_ELEMENT_ID)?.textContent?.trim(),
    )
    // The template itself, before the CLI filled it in, is no report.
    if (text === undefined || text === '' || text === REPORT_PLACEHOLDER) {
      return Option.none()
    }
    const json = yield* Effect.promise(() => unpack(text))
    return Option.some(yield* Schema.decodeEffect(ReportFromJson)(json))
  },
).pipe(Effect.orDie)
