import { describe, expect, it } from 'vitest'

import { Histogram, type RunInfo, type Second, summarizeRun } from '@mantix/api'

import { formatMs, passed, secondLine, summaryReport } from '../src/Report.ts'

// styleText adds no colour when output is not a terminal, as in tests.
const second: Second = {
  t: 4,
  target: 100,
  offered: 100,
  started: 98,
  dropped: 2,
  completed: 97,
  failed: 1,
  inFlight: 3,
  vus: 5,
  loopLagMs: 1,
  endpoints: [
    {
      endpoint: 'GET /a',
      requests: 200,
      latency: Histogram.fromValues(
        Array.from({ length: 200 }, (_, i) => 1000 + i * 100),
      ),
      uncorrected: Histogram.fromValues([1000]),
      statuses: { '200': 199, '503': 1 },
      errors: { HttpStatus: 1 },
    },
  ],
  errorSamples: [
    {
      endpoint: 'GET /a',
      kind: 'HttpStatus',
      message: '503 Service Unavailable',
    },
  ],
}

const run: RunInfo = {
  id: 'r1',
  testName: 'demo',
  status: 'finished',
  startedAt: 0,
  endedAt: 1000,
  duration: 1,
  plan: [],
  thresholds: [{ expression: 'p99 < 10ms', actual: 20.8, passed: false }],
}

describe('report', () => {
  it('formats latency with one unit and about three figures', () => {
    expect(formatMs(0.5)).toBe('0.50 ms')
    expect(formatMs(23.44)).toBe('23.4 ms')
    expect(formatMs(212.4)).toBe('212 ms')
    expect(formatMs(1840)).toBe('1.84 s')
  })

  it('prints one compact line per second', () => {
    const line = secondLine(second, 'rate')
    expect(line).toContain('5s')
    expect(line).toContain('200 req/s')
    expect(line).toContain('iter 98/s of 100')
    expect(line).toContain('p99')
    expect(line).toContain('err   0.5%')
    expect(line).toContain('dropped 2')
  })

  it('prints a table, thresholds and a verdict', () => {
    const report = summaryReport(summarizeRun(run, [second]), [second])
    expect(report).toMatch(
      /endpoint\s+req\s+req\/s\s+p50\s+p95\s+p99\s+max\s+errors/,
    )
    expect(report).toContain('GET /a')
    expect(report).toContain('✗ p99 < 10ms')
    expect(report).toContain('✗ FAILED')
    expect(report).toContain('2 iterations dropped')
    expect(passed(run)).toBe(false)
  })
})
