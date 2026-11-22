import { describe, expect, it } from 'vitest'

import type { Control, JournalEntry } from '../src/Journal.ts'
import type { ScenarioInfo } from '../src/Run.ts'
import { checkControl, plannedPath, steer } from '../src/Steering.ts'

/** A constant-rate scenario. */
const constant = (
  name: string,
  rate: number,
  duration: number,
  startAfter = 0,
): ScenarioInfo => ({
  name,
  startAfter,
  plan: {
    model: 'rate',
    start: rate,
    stages: [{ duration, target: rate }],
  },
})

/** Build a journal from [at, control] pairs. */
const journal = (
  ...entries: ReadonlyArray<readonly [number, Control]>
): Array<JournalEntry> =>
  entries.map(([at, control], i) => ({ seq: i + 1, at, control }))

describe('steer', () => {
  const plan = [constant('a', 100, 60)]

  it('follows the plan when the journal is empty', () => {
    const s = steer(plan, [])
    expect(s.total(10)).toBe(100)
    expect(s.end).toBe(60)
    expect(s.ended(0, 59.9)).toBe(false)
    expect(s.ended(0, 60)).toBe(true)
  })

  it('holds a new rate, ramping to it', () => {
    const s = steer(
      plan,
      journal([10, { _tag: 'Rate', target: 300, over: 10 }]),
    )
    expect(s.total(9)).toBe(100)
    expect(s.total(15)).toBe(200)
    expect(s.total(30)).toBe(300)
    // The plan's end does not move.
    expect(s.total(60)).toBe(0)
  })

  it('pauses the plan clock and pushes the end back', () => {
    const s = steer(
      plan,
      journal([10, { _tag: 'Pause' }], [25, { _tag: 'Resume' }]),
    )
    expect(s.isPaused(20)).toBe(true)
    expect(s.total(20)).toBe(0)
    expect(s.planTime(30)).toBe(15)
    expect(s.total(30)).toBe(100)
    expect(s.end).toBe(75)
    // While a pause is open, nobody knows when the run ends.
    expect(steer(plan, journal([10, { _tag: 'Pause' }])).end).toBe(Infinity)
  })

  it('freezes a ramp while paused', () => {
    const s = steer(
      plan,
      journal(
        [10, { _tag: 'Rate', target: 300, over: 10 }],
        [15, { _tag: 'Pause' }],
        [100, { _tag: 'Resume' }],
      ),
    )
    // Half way up the ramp when paused, and still half way on resume.
    expect(s.total(100)).toBe(200)
    expect(s.total(105)).toBe(300)
  })

  it('shapes a spike with ramps in and out', () => {
    const s = steer(
      plan,
      journal([10, { _tag: 'Spike', factor: 2, duration: 20, ramp: 5 }]),
    )
    expect(s.total(9)).toBe(100)
    expect(s.total(12.5)).toBe(150)
    expect(s.total(20)).toBe(200)
    expect(s.total(27.5)).toBe(150)
    expect(s.total(31)).toBe(100)
  })

  it('shares a run-wide rate in proportion, or sets one scenario', () => {
    const two = [constant('browse', 300, 60), constant('buy', 100, 60)]
    const shared = steer(two, journal([5, { _tag: 'Rate', target: 800 }]))
    expect(shared.target(0, 10)).toBe(600)
    expect(shared.target(1, 10)).toBe(200)
    const one = steer(
      two,
      journal([5, { _tag: 'Rate', target: 50, scenario: 'buy' }]),
    )
    expect(one.target(0, 10)).toBe(300)
    expect(one.target(1, 10)).toBe(50)
  })

  it('leaves scenarios that have not started yet alone', () => {
    const later = [constant('a', 100, 60), constant('b', 10, 30, 30)]
    const s = steer(later, journal([5, { _tag: 'Rate', target: 200 }]))
    expect(s.target(0, 40)).toBe(200)
    expect(s.target(1, 40)).toBe(10)
  })
})

describe('checkControl', () => {
  const plan = [constant('a', 100, 60)]

  it('accepts sensible controls', () => {
    expect(checkControl(plan, [], { _tag: 'Rate', target: 5 }, 1)).toBe(
      undefined,
    )
    expect(checkControl(plan, [], { _tag: 'Pin', note: 'deploy' }, 1)).toBe(
      undefined,
    )
  })

  it('explains what is wrong', () => {
    expect(checkControl(plan, [], { _tag: 'Rate', target: -1 }, 1)).toMatch(
      /0 or more/,
    )
    expect(
      checkControl(plan, [], { _tag: 'Rate', target: 1, scenario: 'x' }, 1),
    ).toMatch(/no scenario named "x"/)
    expect(checkControl(plan, [], { _tag: 'Resume' }, 1)).toMatch(/not paused/)
    const paused = journal([1, { _tag: 'Pause' }])
    expect(checkControl(plan, paused, { _tag: 'Pause' }, 2)).toMatch(
      /already paused/,
    )
    expect(checkControl(plan, [], { _tag: 'Rate', target: 1 }, 61)).toMatch(
      /Nothing is running/,
    )
    expect(
      checkControl(plan, [], { _tag: 'Spike', factor: 2, duration: 0 }, 1),
    ).toMatch(/duration/)
  })
})

describe('plannedPath', () => {
  const plan = [constant('a', 100, 10)]

  it('draws the rest of the run, including a staged change', () => {
    const now = plannedPath(plan, [], 7)
    expect(now.points.map(p => p.target)).toEqual([100, 100, 100, 0])
    expect(now.end).toBe(10)

    const staged = plannedPath(plan, [], 7, {
      staged: { _tag: 'Rate', target: 50 },
    })
    expect(staged.points.map(p => p.target)).toEqual([50, 50, 50, 0])
  })

  it('shows what happens on resume while paused', () => {
    const paused = plannedPath(plan, journal([4, { _tag: 'Pause' }]), 20)
    expect(paused.paused).toBe(true)
    // 6 s of plan were left at the pause; resuming at 20 ends at 26.
    expect(paused.end).toBe(26)
    expect(paused.points[0]).toEqual({ t: 20, target: 100 })
  })
})
