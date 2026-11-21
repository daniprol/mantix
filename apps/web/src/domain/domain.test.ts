import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import type { LoadPlan } from '@mantix/api'

import * as Format from './format.ts'
import { applyOverrides, describePlan, plannedAt } from './plan.ts'
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
