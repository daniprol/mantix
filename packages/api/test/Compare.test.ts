import { describe, expect, it } from 'vitest'

import { compareRuns, warnings } from '../src/Compare.ts'
import * as Histogram from '../src/Histogram.ts'
import type { RunInfo } from '../src/Run.ts'
import type { Second } from '../src/Second.ts'

/** A seeded random source, so every test sees the same "random" runs. */
const randomFrom = (seed: number) => {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}

interface RunShape {
  readonly seed: number
  readonly seconds?: number
  readonly perSecond?: number
  /** Multiplies every latency: 1.2 is 20% slower. */
  readonly scale?: number
  /** Seconds where every request is ten times slower (a GC pause, say). */
  readonly spikes?: ReadonlyArray<number>
  /** Share of requests that fail. */
  readonly errorRate?: number
  /** Seconds the generator could not keep up in. */
  readonly untrusted?: ReadonlyArray<number>
}

/**
 * A fake run on one endpoint: latencies around 50 ms with a long tail
 * (log-normal), like a real server.
 */
const fakeRun = ({
  seed,
  seconds = 60,
  perSecond = 100,
  scale = 1,
  spikes = [],
  errorRate = 0,
  untrusted = [],
}: RunShape): Array<Second> => {
  const random = randomFrom(seed)
  const normal = () =>
    Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random())
  return Array.from({ length: seconds }, (_, t) => {
    const slow = spikes.includes(t) ? 10 : 1
    const values = Array.from(
      { length: perSecond },
      () => 50_000 * Math.exp(0.4 * normal()) * scale * slow,
    )
    const errors = Math.round(perSecond * errorRate)
    return {
      t,
      target: perSecond,
      offered: perSecond,
      started: perSecond,
      dropped: 0,
      completed: perSecond - errors,
      failed: errors,
      inFlight: 0,
      vus: 10,
      loopLagMs: untrusted.includes(t) ? 500 : 0,
      endpoints: [
        {
          endpoint: 'GET /a',
          requests: perSecond,
          latency: Histogram.fromValues(values),
          uncorrected: Histogram.fromValues(values),
          statuses: { '200': perSecond - errors },
          errors: errors === 0 ? {} : { HttpStatus: errors },
        },
      ],
      errorSamples: [],
    }
  })
}

const compare = (before: RunShape, after: RunShape) =>
  compareRuns([fakeRun(before)], [fakeRun(after)])

describe('compareRuns', () => {
  it('catches a real 20% slowdown, with a range around it', () => {
    const { total } = compare({ seed: 1 }, { seed: 2, scale: 1.2 })
    expect(total.p95.verdict).toBe('Worse')
    expect(total.p95.change).toBeGreaterThan(0.12)
    expect(total.p95.range!.low).toBeGreaterThan(0)
    expect(total.p95.range!.low).toBeLessThan(total.p95.change)
    expect(total.p95.range!.high).toBeGreaterThan(total.p95.change)
  })

  it('catches a real speed-up the other way round', () => {
    const { total } = compare({ seed: 1, scale: 1.2 }, { seed: 2 })
    expect(total.p50.verdict).toBe('Better')
    expect(total.p95.verdict).toBe('Better')
  })

  it('says "no real change" for two runs of the same server', () => {
    const { total } = compare({ seed: 1 }, { seed: 2 })
    expect(total.p50.verdict).toBe('NoChange')
    expect(total.p95.verdict).toBe('NoChange')
    expect(total.errors.verdict).toBe('NoChange')
  })

  it('does not call a spike that moved by a second a slowdown', () => {
    // The Compare screen's old "7% slower": the same spikes, one second
    // later, happen to land differently in the p95.
    const { total } = compare(
      { seed: 1, spikes: [12, 42] },
      { seed: 2, spikes: [13, 43, 44] },
    )
    expect(total.p95.verdict).toBe('CantTell')
    expect(total.p95.reason).toBe('Noisy')
  })

  it('rarely raises a false alarm', () => {
    // Forty comparisons of the same server: every "slower" or "faster"
    // here is wrong. The tests behind the verdicts allow about 5%.
    const alarms = Array.from({ length: 40 }, (_, i) =>
      compareRuns(
        [fakeRun({ seed: 100 + i, perSecond: 30 })],
        [fakeRun({ seed: 200 + i, perSecond: 30 })],
        { rounds: 300 },
      ),
    ).filter(({ total }) =>
      [total.p50, total.p95].some(
        change => change.verdict === 'Worse' || change.verdict === 'Better',
      ),
    )
    expect(alarms.length).toBeLessThanOrEqual(2)
  })

  it('needs enough requests for a percentile, and a long enough run', () => {
    const few = compare(
      { seed: 1, perSecond: 2 },
      { seed: 2, perSecond: 2, scale: 2 },
    )
    // 120 requests: plenty for a p50, too few for a p95 or p99.
    expect(few.total.p50.verdict).toBe('Worse')
    expect(few.total.p95.verdict).toBe('CantTell')
    expect(few.total.p95.reason).toBe('TooFewRequests')
    expect(few.total.p95.range).toBeUndefined()

    const short = compare({ seed: 1, seconds: 3 }, { seed: 2, seconds: 3 })
    expect(short.total.p50.reason).toBe('TooShort')
  })

  it('compares errors in percentage points', () => {
    const { total } = compare({ seed: 1 }, { seed: 2, errorRate: 0.05 })
    expect(total.errors.verdict).toBe('Worse')
    expect(total.errors.change).toBeCloseTo(0.05)
  })

  it('leaves out the seconds Mantix could not keep up in', () => {
    const result = compare(
      { seed: 1 },
      { seed: 2, spikes: [20, 21, 22], untrusted: [20, 21, 22] },
    )
    expect(result.leftOut).toEqual({ baseline: 0, current: 3 })
    expect(result.total.p95.verdict).toBe('NoChange')
  })

  it('pairs runs by time when they have the same length', () => {
    expect(compare({ seed: 1 }, { seed: 2 }).isPaired).toBe(true)
    expect(compare({ seed: 1 }, { seed: 2, seconds: 30 }).isPaired).toBe(false)
  })

  it('gives the same numbers every time', () => {
    const a = compare({ seed: 1 }, { seed: 2, scale: 1.05 })
    const b = compare({ seed: 1 }, { seed: 2, scale: 1.05 })
    expect(a).toEqual(b)
  })

  it('uses repeated runs', () => {
    const runs = (from: number, scale = 1) =>
      [0, 1, 2].map(i => fakeRun({ seed: from + i, scale }))
    const same = compareRuns(runs(10), runs(20))
    expect(same.total.p95.verdict).toBe('NoChange')
    const slower = compareRuns(runs(10), runs(20, 1.1))
    expect(slower.total.p95.verdict).toBe('Worse')
  })

  it('compares every endpoint that ran on both sides', () => {
    const { endpoints, total } = compare({ seed: 1 }, { seed: 2 })
    expect(endpoints.map(e => e.endpoint)).toEqual(['GET /a'])
    expect(total.endpoint).toBe('All requests')
    expect(total.currentRequests).toBe(6000)
  })
})

describe('warnings', () => {
  const run = (overrides: Partial<RunInfo> = {}): RunInfo => ({
    id: 'r',
    testName: 'checkout',
    status: 'finished',
    startedAt: 0,
    endedAt: 60_000,
    duration: 60,
    plan: [
      {
        name: 'checkout',
        startAfter: 0,
        plan: { model: 'rate', start: 10, stages: [] },
      },
    ],
    thresholds: [],
    journal: [],
    ...overrides,
  })

  it('is quiet for comparable runs', () => {
    expect(warnings([run()], [run()])).toEqual([])
  })

  it('names what differs', () => {
    expect(warnings([run()], [run({ duration: 30 })])).toEqual([
      'DifferentPlans',
    ])
    expect(
      warnings(
        [run()],
        [run({ journal: [{ seq: 1, at: 5, control: { _tag: 'Pause' } }] })],
      ),
    ).toEqual(['ChangedLive'])
  })
})
