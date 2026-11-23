import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import type { Compare, LoadPlan } from '@mantix/api'

import { makeSecond } from '../fixture.ts'
import { endpointsVerdict, readChange } from './compare.ts'
import * as Format from './format.ts'
import { applyOverrides, describePlan, plannedAt } from './plan.ts'
import { Span, effectiveSpan, spanLabel, spanSeconds } from './span.ts'
import { focusSeconds, p95Curve } from './stats.ts'
import {
  controlLabel,
  isPaused,
  plannedEnd,
  stagedControl,
  steerNow,
} from './steer.ts'
import * as Threshold from './threshold.ts'

describe('format', () => {
  test('latency picks one unit and three significant figures', () => {
    expect(Format.text(Format.latency(0.412))).toBe('412 µs')
    expect(Format.text(Format.latency(4.051))).toBe('4.05 ms')
    expect(Format.text(Format.latency(41.23))).toBe('41.2 ms')
    expect(Format.text(Format.latency(212.4))).toBe('212 ms')
    expect(Format.text(Format.latency(999.7))).toBe('1 s')
    expect(Format.text(Format.latency(1840))).toBe('1.84 s')
    expect(Format.text(Format.latency(0))).toBe('0 ms')
  })

  test('rates are whole from 100 up, grouped by thousands', () => {
    expect(Format.text(Format.rate(1694.4))).toBe('1,694/s')
    expect(Format.text(Format.rate(196.6))).toBe('197/s')
    expect(Format.text(Format.rate(21.36))).toBe('21.4/s')
  })

  test('percentages keep three figures and never show a fake zero', () => {
    expect(Format.text(Format.percent(0))).toBe('0%')
    expect(Format.text(Format.percent(0.0412))).toBe('4.12%')
    expect(Format.text(Format.percent(0.00001))).toBe('<0.01%')
    expect(Format.text(Format.percent(1))).toBe('100%')
  })

  test('clock and span', () => {
    expect(Format.clock(83)).toBe('01:23')
    expect(Format.clock(3723)).toBe('1:02:03')
    expect(Format.span(30)).toBe('30 s')
    expect(Format.span(120)).toBe('2 min')
    expect(Format.span(90)).toBe('1 min 30 s')
  })

  test('parseSpan reads what people type', () => {
    expect(Format.parseSpan('90')).toBe(90)
    expect(Format.parseSpan('90s')).toBe(90)
    expect(Format.parseSpan('2m')).toBe(120)
    expect(Format.parseSpan('1.5 min')).toBe(90)
    expect(Format.parseSpan('1h')).toBe(3600)
    expect(Format.parseSpan('soon')).toBeUndefined()
    expect(Format.parseSpan('0')).toBeUndefined()
  })
})

const ramp: LoadPlan = {
  model: 'rate',
  start: 0,
  stages: [
    { duration: 30, target: 100 },
    { duration: 120, target: 100 },
  ],
}

describe('plan', () => {
  test('describes a ramp and hold in one sentence', () => {
    expect(describePlan(ramp)).toBe(
      'Ramps to 100 requests/s over 30 s, then holds for 2 min.',
    )
    expect(
      describePlan({
        model: 'vus',
        start: 20,
        stages: [{ duration: 60, target: 20 }],
      }),
    ).toBe('Holds 20 virtual users for 1 min.')
  })

  test('plannedAt walks the stages', () => {
    expect(plannedAt(ramp, 15)).toBe(50)
    expect(plannedAt(ramp, 100)).toBe(100)
  })

  test('overrides replace the load or stretch the duration', () => {
    expect(applyOverrides(ramp, { rate: 300 })).toEqual({
      model: 'rate',
      start: 300,
      stages: [{ duration: 150, target: 300 }],
    })
    expect(applyOverrides(ramp, { duration: 300 }).stages).toEqual([
      { duration: 60, target: 100 },
      { duration: 240, target: 100 },
    ])
  })
})

describe('threshold', () => {
  test('parses and explains a failure', () => {
    const parsed = Threshold.parse('p99 < 0.25s')
    expect(Option.map(parsed, t => t.limit)).toEqual(Option.some(250))
    expect(
      Threshold.describeFailure({
        expression: 'errors < 1%',
        actual: 2.13,
        passed: false,
      }),
    ).toBe('errors were 2.13%, limit 1%')
  })
})

describe('compare', () => {
  const change = (overrides: Partial<Compare.Change>): Compare.Change => ({
    metric: 'p95',
    baseline: 100,
    current: 112,
    change: 0.12,
    range: { low: 0.08, high: 0.16 },
    verdict: 'Worse',
    ...overrides,
  })

  test('a real change says which way, by how much, and its range', () => {
    const reading = readChange(change({}), 0.05, 5000)
    expect(reading.word).toBe('12% slower')
    expect(reading.maybeRange).toEqual(Option.some('+8 to +16%'))
    expect(reading.tone).toBe('Worse')
    const faster = readChange(
      change({
        change: -0.2,
        range: { low: -0.25, high: -0.15 },
        verdict: 'Better',
      }),
      0.05,
      5000,
    )
    expect(faster.word).toBe('20% faster')
    expect(faster.maybeRange).toEqual(Option.some('−25 to −15%'))
  })

  test('"same" and "unclear" are different answers', () => {
    expect(
      readChange(
        change({
          change: 0.01,
          range: { low: -0.02, high: 0.03 },
          verdict: 'NoChange',
        }),
        0.05,
        5000,
      ).word,
    ).toBe('same')
    const unclear = readChange(
      change({
        change: 0.07,
        range: { low: -0.1, high: 0.25 },
        verdict: 'CantTell',
        reason: 'Noisy',
      }),
      0.05,
      5000,
    )
    expect(unclear.word).toBe('unclear')
    expect(unclear.maybeRange).toEqual(Option.some('−10 to +25%'))
    const few = readChange(
      change({ verdict: 'CantTell', reason: 'TooFewRequests' }),
      0.05,
      140,
    )
    expect(few.word).toBe('too few')
    expect(few.hint).toContain('140')
  })

  test('errors change in percentage points', () => {
    const reading = readChange(
      change({
        metric: 'errors',
        change: 0.0014,
        range: { low: 0.0004, high: 0.0025 },
      }),
      0.05,
      5000,
    )
    expect(reading.word).toBe('+0.14 pts')
    expect(reading.maybeRange).toEqual(Option.some('+0.04 to +0.25 pts'))
  })

  test('the endpoints figure leads with the slowdowns', () => {
    const row = (verdict: Compare.Verdict): Compare.EndpointComparison => ({
      endpoint: 'GET /a',
      isLoad: true,
      baselineRequests: 5000,
      currentRequests: 5000,
      p50: change({ verdict }),
      p95: change({ verdict }),
      p99: change({ verdict }),
      errors: change({ verdict }),
    })
    const comparison: Compare.Comparison = {
      total: row('Worse'),
      endpoints: [
        row('Worse'),
        row('NoChange'),
        row('NoChange'),
        row('CantTell'),
      ],
      band: 0.05,
      blockSeconds: 5,
      isPaired: true,
      leftOut: { baseline: 0, current: 0 },
    }
    expect(endpointsVerdict(comparison)).toEqual({
      value: '1 slower',
      isWorse: true,
      note: '2 same · 1 unclear',
    })
  })
})

describe('span', () => {
  const seconds = [0, 1, 2, 3, 4].map(t => makeSecond(t, { ms: 10 }))

  test('a range keeps the seconds from `from` up to, not including, `to`', () => {
    expect(
      spanSeconds(seconds, Span.Range({ from: 1, to: 3 })).map(s => s.t),
    ).toEqual([1, 2])
    expect(spanLabel(Span.Range({ from: 180, to: 225 }))).toBe('03:00 – 03:45')
  })

  test('"Now" only means something while the run is live', () => {
    expect(effectiveSpan(Span.Now(), false)).toEqual(Span.WholeRun())
    expect(effectiveSpan(Span.Now(), true)).toEqual(Span.Now())
  })
})

describe('stats', () => {
  const seconds = [
    makeSecond(0, { ms: 40, endpoint: 'GET /a' }),
    makeSecond(1, { ms: 400, failed: 3, endpoint: 'POST /b' }),
  ]

  test('focusing keeps one endpoint, its errors and its counts', () => {
    const focused = focusSeconds(seconds, 'POST /b')
    expect(focused[0]?.endpoints).toEqual([])
    expect(focused[1]?.endpoints.map(part => part.endpoint)).toEqual([
      'POST /b',
    ])
    expect(focused[1]?.errorSamples).toHaveLength(1)
  })

  test('the p95 curve has a point for each second with requests', () => {
    const curve = p95Curve(seconds, Option.some('GET /a'))
    expect(curve).toHaveLength(2)
    expect(curve[0]).toBeCloseTo(40, -1)
    expect(curve[1]).toBeNull()
  })
})

describe('steer', () => {
  const plan = [
    {
      name: 'load',
      startAfter: 0,
      plan: {
        model: 'rate' as const,
        start: 10,
        stages: [{ duration: 60, target: 10 }],
      },
    },
  ]

  test('the typed form becomes a control only when it makes sense', () => {
    expect(
      stagedControl({ _tag: 'Spike', factor: '2', duration: '1m' }),
    ).toEqual(Option.some({ _tag: 'Spike', factor: 2, duration: 60 }))
    expect(
      stagedControl({ _tag: 'Spike', factor: '0', duration: '30' }),
    ).toEqual(Option.none())
    expect(stagedControl({ _tag: 'Rate', target: '40', over: '' })).toEqual(
      Option.some({ _tag: 'Rate', target: 40 }),
    )
    expect(stagedControl({ _tag: 'Rate', target: '40', over: '10s' })).toEqual(
      Option.some({ _tag: 'Rate', target: 40, over: 10 }),
    )
  })

  test('a pause moves the end; "now" never falls before a control', () => {
    const journal = [{ seq: 1, at: 20.4, control: { _tag: 'Pause' as const } }]
    expect(isPaused(journal)).toBe(true)
    expect(steerNow(20, journal)).toBe(21)
    // Paused at 20.4: if it resumed at 30, the 60 s plan ends ~9.6 s later.
    expect(plannedEnd(plan, journal, 30)).toBeCloseTo(69.6)
    expect(plannedEnd(plan, [], 30)).toBe(60)
  })

  test('labels for the flags', () => {
    expect(controlLabel({ _tag: 'Spike', factor: 2, duration: 30 }, true)).toBe(
      '×2 30 s',
    )
    expect(controlLabel({ _tag: 'Rate', target: 400 }, true)).toBe('400/s')
    expect(controlLabel({ _tag: 'Rate', target: 50 }, false)).toBe('50 VUs')
  })
})
