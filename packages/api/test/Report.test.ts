import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { fingerprint, groupErrors } from '../src/Errors.ts'
import {
  Report,
  exampleText,
  secondForReport,
  summarizeErrorSample,
} from '../src/Report.ts'
import type { ErrorSample, Second } from '../src/Second.ts'

const second = (t: number, samples: Array<ErrorSample>): Second => ({
  t,
  target: 0,
  offered: 0,
  started: 0,
  dropped: 0,
  completed: 0,
  failed: 0,
  inFlight: 0,
  vus: 0,
  loopLagMs: 0,
  endpoints: [],
  errorSamples: samples,
  fingerprints: Object.fromEntries(
    samples.map(sample => [sample.fingerprint ?? fingerprint(sample), 1]),
  ),
})

const stamped = (sample: ErrorSample): ErrorSample => ({
  ...sample,
  fingerprint: fingerprint(sample),
})

const samples: Array<ErrorSample> = [
  stamped({
    endpoint: 'POST /checkout',
    kind: 'HttpStatus',
    message: '503 Service Unavailable',
  }),
  stamped({
    endpoint: 'GET /cart/:id',
    kind: 'SchemaMismatch',
    message: '$.items[0].price: Expected number',
    diff: {
      path: '$.items[0].price',
      expected: 'Expected number',
      received: '"19.99"',
      receivedType: 'string',
    },
  }),
  stamped({
    endpoint: 'POST /login',
    kind: 'ScriptError',
    message: "Cannot read 'token' of user 4821",
    location: 'checkout.ts:42',
  }),
  stamped({
    endpoint: 'GET /orders',
    kind: 'Transport',
    message: 'connect ECONNREFUSED 10.0.3.7:5432',
  }),
]

describe('summary reports', () => {
  it('leave out the values that arrived', () => {
    const summarized = samples.map(summarizeErrorSample)
    expect(summarized[0]?.message).toBe('503 Service Unavailable')
    expect(summarized[1]?.diff?.received).toBe('')
    expect(summarized[1]?.diff?.receivedType).toBe('string')
    expect(summarized[2]?.message).toBe('Cannot read "…" of user N')
    expect(summarized[2]?.location).toBe('checkout.ts:42')
    expect(summarized[3]?.message).toBe('connect ECONNREFUSED N.N:N')
  })

  it('group errors exactly as the full data does', () => {
    const full = [second(0, samples), second(1, samples)]
    const summary = full.map(each => secondForReport(each, 'Summary'))
    const shape = (seconds: ReadonlyArray<Second>) =>
      groupErrors(seconds).map(group => ({
        fingerprint: group.fingerprint,
        kind: group.kind,
        detail: group.detail,
        count: group.count,
      }))
    expect(shape(summary)).toEqual(shape(full))
  })

  it('keep a sample without a fingerprint in its group', () => {
    const { fingerprint: _, ...old } = samples[3]!
    expect(summarizeErrorSample(old).fingerprint).toBe(samples[3]?.fingerprint)
  })
})

describe('error examples', () => {
  it('show the message or the value that arrived', () => {
    expect(
      exampleText('$.items[*].price: Expected number (received string)', {
        message: '$.items[0].price: Expected number',
        diff: { received: '"19.99"' },
      }),
    ).toBe('received "19.99"')
    expect(
      exampleText('connect ECONNREFUSED N.N:N', {
        message: 'connect ECONNREFUSED 10.0.3.7:5432',
      }),
    ).toBe('connect ECONNREFUSED 10.0.3.7:5432')
  })

  it('show nothing when they repeat the description', () => {
    expect(
      exampleText('503 Service Unavailable', {
        message: '503 Service Unavailable',
      }),
    ).toBeUndefined()
    // A summary report has no value to show.
    expect(
      exampleText('$.items[*].price: Expected number (received string)', {
        message: '$.items[N].price: Expected number',
        diff: { received: '' },
      }),
    ).toBeUndefined()
  })
})

describe('the report schema', () => {
  it('needs at least one run', () => {
    const decode = Schema.decodeUnknownSync(Report)
    expect(() =>
      decode({
        version: 1,
        detail: 'Summary',
        runs: [],
      }),
    ).toThrow()
  })
})
