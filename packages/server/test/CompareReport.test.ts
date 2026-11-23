import { describe, expect, it } from 'vitest'

import type { Compare, RunInfo } from '@mantix/api'

import {
  compareReport,
  parseRules,
  regressionsOf,
  verdictWord,
} from '../src/CompareReport.ts'

// styleText adds no colour when output is not a terminal, as in tests.
const change = (overrides: Partial<Compare.Change> = {}): Compare.Change => ({
  metric: 'p95',
  baseline: 20,
  current: 26,
  change: 0.3,
  range: { low: 0.22, high: 0.38 },
  verdict: 'Worse',
  ...overrides,
})

const row = (
  endpoint: string,
  p95: Compare.Change,
): Compare.EndpointComparison => ({
  endpoint,
  isLoad: true,
  baselineRequests: 5000,
  currentRequests: 5000,
  p50: change({ metric: 'p50', verdict: 'NoChange', change: 0.01 }),
  p95,
  p99: {
    metric: 'p99',
    baseline: 40,
    current: 45,
    change: 0.125,
    verdict: 'CantTell',
    reason: 'TooFewRequests',
  },
  errors: change({
    metric: 'errors',
    baseline: 0.01,
    current: 0.01,
    change: 0,
    range: { low: -0.001, high: 0.001 },
    verdict: 'NoChange',
  }),
})

const comparison: Compare.Comparison = {
  total: row(
    'All requests',
    change({
      change: 0.04,
      range: { low: -0.01, high: 0.09 },
      verdict: 'CantTell',
      reason: 'Noisy',
    }),
  ),
  endpoints: [
    row('GET /products/:sku', change()),
    row(
      'GET /cart/:id',
      change({
        change: 0.01,
        range: { low: -0.02, high: 0.03 },
        verdict: 'NoChange',
      }),
    ),
  ],
  band: 0.05,
  blockSeconds: 5,
  isPaired: true,
  leftOut: { baseline: 0, current: 0 },
}

const run = (id: string): RunInfo => ({
  id,
  testName: 'checkout',
  status: 'finished',
  startedAt: Date.UTC(2026, 10, 23, 17, 40),
  endedAt: null,
  duration: 60,
  plan: [],
  thresholds: [],
  journal: [],
})

describe('parseRules', () => {
  it('reads limits for latency and errors', () => {
    expect(parseRules('p95:+10%, errors:+0.5%')).toEqual([
      { metric: 'p95', limit: 0.1 },
      { metric: 'errors', limit: 0.005 },
    ])
  })

  it('says what it could not read', () => {
    expect(parseRules('p95>10')).toContain('p95:+10%')
  })
})

describe('regressionsOf', () => {
  it('fails only a confident slowdown past the limit', () => {
    const found = regressionsOf(comparison, [{ metric: 'p95', limit: 0.1 }])
    expect(found.map(each => each.endpoint)).toEqual(['GET /products/:sku'])
    expect(regressionsOf(comparison, [{ metric: 'p95', limit: 0.5 }])).toEqual(
      [],
    )
  })
})

describe('verdictWord', () => {
  it('uses the same words as the dashboard', () => {
    expect(verdictWord(change())).toBe('30% slower')
    expect(verdictWord(change({ change: -0.2, verdict: 'Better' }))).toBe(
      '20% faster',
    )
    expect(verdictWord(change({ verdict: 'NoChange' }))).toBe('same')
    expect(verdictWord(change({ verdict: 'CantTell', reason: 'Noisy' }))).toBe(
      'unclear',
    )
  })
})

describe('compareReport', () => {
  it('prints a table per metric and the regressions', () => {
    const rules = [{ metric: 'p95', limit: 0.1 }] as const
    const text = compareReport({
      baseline: [run('aaaa1111')],
      current: [run('bbbb2222'), run('cccc3333')],
      comparison,
      warnings: ['DifferentMachines'],
      rules,
      regressions: regressionsOf(comparison, rules),
    })
    expect(text).toContain('baseline  aaaa1111')
    expect(text).toContain('2 runs (bbbb2222, cccc3333)')
    expect(text).toMatch(
      /GET \/products\/:sku +20\.0 ms +26\.0 ms +30% slower +\+22 to \+38%/,
    )
    expect(text).toContain('unclear')
    // No row has enough requests for a p99, so that table is left out.
    expect(text).not.toMatch(/^ {2}p99/m)
    expect(text).toContain('different machines')
    expect(text).toContain('✗ REGRESSION  GET /products/:sku p95 30% slower')
  })
})
