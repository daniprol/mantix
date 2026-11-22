import { describe, expect, it } from 'vitest'

import { type IterationTrace, worstIteration } from '../src/Trace.ts'

const trace = (duration: number): IterationTrace => ({
  scenario: 's',
  vu: 1,
  iteration: 1,
  lateMs: 0,
  duration,
  outcome: 'completed',
  spans: [],
})

describe('worstIteration', () => {
  it('finds the slowest iteration in the window', () => {
    const seconds = [
      { t: 0, slowest: trace(900) },
      { t: 5, slowest: trace(120) },
      { t: 8 },
      { t: 12, slowest: trace(300) },
    ]
    // Seconds 3..12: the 900 ms one at t=0 is too old.
    expect(worstIteration(seconds)?.duration).toBe(300)
    expect(worstIteration(seconds, 20)?.duration).toBe(900)
    expect(worstIteration([])).toBe(undefined)
  })
})
