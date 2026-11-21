import { describe, expect, it } from 'vitest'

import type { EndpointStats } from '@mantix/api'

import { evaluate, parseThreshold } from '../src/Thresholds.ts'

const stats = (p99: number, errorRate: number): EndpointStats => ({
  endpoint: 'All endpoints',
  requests: 100,
  errors: errorRate * 100,
  errorRate,
  rps: 10,
  latency: { p50: 10, p90: 20, p95: 30, p99, max: p99 * 2 },
  uncorrected: { p50: 10, p90: 20, p95: 30, p99, max: p99 * 2 },
  errorsByKind: {},
})

describe('thresholds', () => {
  it('parses latency in ms and seconds', () => {
    expect(parseThreshold('p99 < 250ms').value).toBe(250)
    expect(parseThreshold('max <= 2s').value).toBe(2000)
    expect(parseThreshold('p95<300').value).toBe(300)
  })

  it('rejects text it cannot read', () => {
    expect(() => parseThreshold('p99 under 250')).toThrow(/Cannot read/)
    expect(() => parseThreshold('errors < 0.01')).toThrow(/percentage/)
  })

  it('evaluates against stats', () => {
    const p99 = parseThreshold('p99 < 250ms')
    expect(evaluate(p99, stats(200, 0), []).passed).toBe(true)
    expect(evaluate(p99, stats(300, 0), []).passed).toBe(false)
    const errors = parseThreshold('errors < 1%')
    expect(evaluate(errors, stats(1, 0.02), []).actual).toBe(2)
    expect(evaluate(errors, stats(1, 0.02), []).passed).toBe(false)
  })

  it('passes endpoint thresholds while the endpoint has no traffic', () => {
    const t = parseThreshold({ endpoint: 'POST /checkout', check: 'p99 < 1ms' })
    expect(evaluate(t, stats(500, 0), [])).toEqual({
      expression: 'p99 < 1ms',
      endpoint: 'POST /checkout',
      actual: 0,
      passed: true,
    })
  })
})
