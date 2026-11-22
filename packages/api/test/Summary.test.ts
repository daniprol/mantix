import { describe, expect, it } from 'vitest'

import * as Histogram from '../src/Histogram.ts'
import type { Second } from '../src/Second.ts'
import { summarizeSeconds } from '../src/Summary.ts'

const second = (
  t: number,
  endpoint: string,
  values: Array<number>,
  errors = 0,
): Second => ({
  t,
  target: 10,
  offered: values.length,
  started: values.length,
  dropped: 0,
  completed: values.length - errors,
  failed: errors,
  inFlight: 0,
  vus: 1,
  loopLagMs: 0,
  endpoints: [
    {
      endpoint,
      requests: values.length,
      latency: Histogram.fromValues(values),
      uncorrected: Histogram.fromValues(values),
      statuses: { '200': values.length - errors, '500': errors },
      errors: errors === 0 ? {} : { HttpStatus: errors },
    },
  ],
  errorSamples: [],
})

describe('summarizeSeconds', () => {
  it('merges histograms across seconds instead of averaging percentiles', () => {
    // Second 0 is fast, second 1 has one very slow request.
    const fast = Array.from({ length: 99 }, () => 1_000)
    const seconds = [second(0, 'GET /a', fast), second(1, 'GET /a', [500_000])]
    const { total } = summarizeSeconds(seconds)
    expect(total.requests).toBe(100)
    expect(total.rps).toBe(50)
    expect(total.latency.max).toBe(500)
    // The p99 of all 100 requests is still the fast value (99th of 100).
    expect(Math.round(total.latency.p99)).toBe(1)
  })

  it('counts errors per endpoint and per class', () => {
    const seconds = [
      second(0, 'GET /a', [1, 2, 3, 4], 1),
      second(0, 'POST /b', [5, 6]),
    ]
    const { total, endpoints } = summarizeSeconds(seconds)
    expect(endpoints.map(e => e.endpoint)).toEqual(['GET /a', 'POST /b'])
    expect(endpoints[0]?.errorsByKind).toEqual({ HttpStatus: 1 })
    expect(total.errors).toBe(1)
    expect(total.errorRate).toBeCloseTo(1 / 6)
  })

  it('leaves script errors out of the error rate but still shows them', () => {
    const base = second(0, 'GET /a', [1, 2, 3, 4], 1)
    const part = base.endpoints[0]!
    const seconds = [
      {
        ...base,
        endpoints: [{ ...part, errors: { HttpStatus: 1, ScriptError: 2 } }],
      },
    ]
    const { total } = summarizeSeconds(seconds)
    expect(total.errors).toBe(1)
    expect(total.errorRate).toBeCloseTo(1 / 4)
    expect(total.errorsByKind).toEqual({ HttpStatus: 1, ScriptError: 2 })
  })

  it('shows setup requests in their own row, but not in the total', () => {
    const load = second(0, 'GET /a', [1_000, 2_000])
    const setup = second(0, 'POST /login (setup)', [900_000])
    const seconds = [
      {
        ...load,
        endpoints: [
          ...load.endpoints,
          { ...setup.endpoints[0]!, phase: 'setup' as const },
        ],
      },
    ]
    const { total, endpoints } = summarizeSeconds(seconds)
    expect(endpoints.map(e => e.endpoint)).toEqual([
      'GET /a',
      'POST /login (setup)',
    ])
    expect(total.requests).toBe(2)
    expect(total.latency.max).toBeLessThan(10)
  })
})
