import { describe, expect, it } from 'vitest'

import { planDuration, rate, targetAt, toPlan, vus } from '../src/Load.ts'

describe('load plans', () => {
  it('holds a constant rate for the whole duration', () => {
    const plan = toPlan(rate.constant(50, { duration: '1m' }))
    expect(planDuration(plan)).toBe(60)
    expect(targetAt(plan, 0)).toBe(50)
    expect(targetAt(plan, 59.9)).toBe(50)
    expect(targetAt(plan, 60)).toBe(0)
  })

  it('moves linearly between stages', () => {
    const plan = toPlan(
      vus.ramping({
        start: 0,
        stages: [
          { duration: '10s', target: 100 },
          { duration: 10, target: 100 },
          { duration: '10s', target: 0 },
        ],
      }),
    )
    expect(plan.model).toBe('vus')
    expect(targetAt(plan, 5)).toBe(50)
    expect(targetAt(plan, 15)).toBe(100)
    expect(targetAt(plan, 25)).toBe(50)
  })
})
