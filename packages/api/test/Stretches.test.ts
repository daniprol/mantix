import { describe, expect, it } from 'vitest'

import type { GeneratorIssue, Second } from '../src/Second.ts'
import {
  generatorIssues,
  pausedStretches,
  untrustedStretches,
} from '../src/Stretches.ts'

const second = (
  t: number,
  issues?: Array<GeneratorIssue>,
  loopLagMs = 0,
): Second => ({
  t,
  target: 0,
  offered: 0,
  started: 0,
  dropped: 0,
  completed: 0,
  failed: 0,
  inFlight: 0,
  vus: 0,
  loopLagMs,
  endpoints: [],
  errorSamples: [],
  ...(issues === undefined
    ? {}
    : {
        generator: {
          cpuPercent: 0,
          gcMs: 0,
          heapMb: 0,
          lateStartMs: 0,
          issues,
        },
      }),
})

describe('generatorIssues', () => {
  it('names every limit that was crossed', () => {
    expect(
      generatorIssues({
        loopLagMs: 5,
        lateStartMs: 1,
        cpuPercent: 20,
        gcMs: 3,
        heapMb: 40,
      }),
    ).toEqual([])
    expect(
      generatorIssues({
        loopLagMs: 250,
        lateStartMs: 80,
        cpuPercent: 99,
        gcMs: 150,
        heapMb: 40,
      }),
    ).toEqual(['LoopLag', 'LateStarts', 'Cpu', 'Gc'])
  })
})

describe('untrustedStretches', () => {
  it('joins consecutive untrusted seconds', () => {
    const seconds = [
      second(0, []),
      second(1, ['Cpu']),
      second(2, ['LoopLag']),
      second(3, []),
      second(4, ['Gc']),
    ]
    expect(untrustedStretches(seconds)).toEqual([
      { from: 1, to: 3, issues: ['Cpu', 'LoopLag'] },
      { from: 4, to: 5, issues: ['Gc'] },
    ])
  })

  it('falls back to loop lag for older data', () => {
    expect(untrustedStretches([second(0, undefined, 300)])).toEqual([
      { from: 0, to: 1, issues: ['LoopLag'] },
    ])
  })
})

describe('pausedStretches', () => {
  it('reads pauses from the journal, open ones ending now', () => {
    const journal = [
      { seq: 1, at: 5, control: { _tag: 'Pause' as const } },
      { seq: 2, at: 8, control: { _tag: 'Resume' as const } },
      { seq: 3, at: 9, control: { _tag: 'Pin' as const, note: 'x' } },
      { seq: 4, at: 12, control: { _tag: 'Pause' as const } },
    ]
    expect(pausedStretches(journal, 20)).toEqual([
      { from: 5, to: 8 },
      { from: 12, to: 20 },
    ])
  })
})
