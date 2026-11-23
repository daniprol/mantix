import { Schema } from 'effect'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import {
  REPORT_PLACEHOLDER,
  Report,
  type RunInfo,
  type Second,
  reportSlot,
} from '@mantix/api'

import { defaultReportPath, fillTemplate, reportOf } from '../src/HtmlReport.ts'

const run: RunInfo = {
  id: 'a1b2c3d4',
  testName: 'Checkout API',
  status: 'finished',
  startedAt: 0,
  endedAt: 1000,
  duration: 1,
  plan: [],
  thresholds: [],
  journal: [],
}

const second: Second = {
  t: 0,
  target: 1,
  offered: 1,
  started: 1,
  dropped: 0,
  completed: 0,
  failed: 1,
  inFlight: 0,
  vus: 1,
  loopLagMs: 0,
  endpoints: [],
  errorSamples: [
    {
      endpoint: 'GET /cart/:id',
      kind: 'SchemaMismatch',
      message: '$.items[0].price: Expected number',
      diff: {
        path: '$.items[0].price',
        expected: 'Expected number',
        received: '"19.99"',
        receivedType: 'string',
      },
    },
  ],
}

/** A template like the one the dashboard build writes. */
const template = `<html><script type="module">const p = "${REPORT_PLACEHOLDER}"</script><body>${reportSlot(REPORT_PLACEHOLDER)}</body></html>`

/** Read the data back out of a written report. */
const readBack = (html: string): Report => {
  const match = /<script id="mantix-report"[^>]*>([^<]*)<\/script>/.exec(html)
  const json = gunzipSync(Buffer.from(match?.[1] ?? '', 'base64')).toString()
  return Schema.decodeSync(Schema.fromJsonString(Report))(json)
}

describe('HTML reports', () => {
  it('put the runs in the slot, and only there', () => {
    const html = fillTemplate(
      template,
      reportOf([{ run, seconds: [second] }], 'Full'),
    )
    // The dashboard's own code keeps its copy of the placeholder.
    expect(html).toContain(`const p = "${REPORT_PLACEHOLDER}"`)
    const report = readBack(html)
    expect(report.runs[0].run.id).toBe('a1b2c3d4')
    expect(report.runs[0].seconds[0]?.errorSamples[0]?.diff?.received).toBe(
      '"19.99"',
    )
  })

  it('leave out the values that arrived unless asked', () => {
    const html = fillTemplate(
      template,
      reportOf([{ run, seconds: [second] }], 'Summary'),
    )
    const report = readBack(html)
    expect(report.detail).toBe('Summary')
    expect(report.runs[0].seconds[0]?.errorSamples[0]?.diff?.received).toBe('')
  })

  it('refuse a template without the slot', () => {
    expect(() =>
      fillTemplate('<html></html>', reportOf([{ run, seconds: [] }], 'Full')),
    ).toThrow()
  })

  it('go next to the run history by default', () => {
    expect(defaultReportPath(run)).toBe(
      '.mantix/reports/checkout-api-a1b2c3d4.html',
    )
  })
})
