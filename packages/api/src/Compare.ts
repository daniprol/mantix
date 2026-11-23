/**
 * Comparing runs honestly: is a difference bigger than the normal wobble?
 *
 * Two runs of the same test never give the same numbers. Requests also
 * come in clumps: one garbage-collection pause or slow query hits many of
 * them at once. A test that treats every request as independent calls
 * almost any difference "significant". So this file uses a *block
 * bootstrap* over the stored per-second histograms instead:
 *
 * 1. Cut each run into blocks of a few seconds, and merge each block's
 *    histograms (exact, see Histogram.ts).
 * 2. Build a pretend run by picking blocks at random, some twice and some
 *    not at all, and measure the change between the two sides.
 * 3. Do that a thousand times. The middle 95% of those changes is the
 *    range the real change most likely lies in.
 *
 * Picking whole blocks keeps a clump of slow requests together, which is
 * what makes the range honest about spikes. When every run has the same
 * number of blocks (the same load plan), each round picks the *same*
 * positions on both sides, so ramp-up is compared with ramp-up and the
 * plateau with the plateau ("paired by time").
 *
 * With several runs per side (`mantix run --repeat`), each round first
 * picks runs at random and then blocks inside them, so the range also
 * covers the wobble between runs.
 *
 * Finally, a band (±5% by default) says how small a change is too small
 * to matter, and each metric gets one of four verdicts.
 *
 * Everything here is pure and seeded: the same runs always give the same
 * numbers, in the dashboard and in `mantix compare` alike.
 */
import { bucketMidpoint } from './Histogram.ts'
import type { RunInfo } from './Run.ts'
import { type Second, countRequestErrors, isLoad } from './Second.ts'
import { issuesOf } from './Stretches.ts'

// ---------------------------------------------------------------------------
// The result

export type Metric = 'p50' | 'p95' | 'p99' | 'errors'

/**
 * - Worse: slower (or more errors), and by enough to matter.
 * - Better: faster (or fewer errors), and by enough to matter.
 * - NoChange: confident that nothing that matters moved.
 * - CantTell: too noisy or too little data to say either way.
 */
export type Verdict = 'Worse' | 'Better' | 'NoChange' | 'CantTell'

/**
 * Why a metric is CantTell.
 * - TooShort: a run has fewer than 5 blocks to pick from.
 * - TooFewRequests: too few requests for this percentile to mean much.
 * - Noisy: the range is too wide, or reaches across the band.
 */
export type Reason = 'TooShort' | 'TooFewRequests' | 'Noisy'

export interface Change {
  readonly metric: Metric
  /** Latency in ms; errors as a share of requests, from 0 to 1. */
  readonly baseline: number
  readonly current: number
  /**
   * Latency: the relative change, so 0.12 is 12% slower.
   * Errors: the difference in error rate, so 0.0014 is +0.14 points.
   */
  readonly change: number
  /**
   * Where `change` most likely lies: 95% of the pretend runs fell inside.
   * Absent when there is too little data.
   */
  readonly range?: { readonly low: number; readonly high: number }
  readonly verdict: Verdict
  /** Set when the verdict is CantTell. */
  readonly reason?: Reason
}

export interface EndpointComparison {
  readonly endpoint: string
  /** False for setup and teardown requests (see isLoad in Second.ts). */
  readonly isLoad: boolean
  readonly baselineRequests: number
  readonly currentRequests: number
  readonly p50: Change
  readonly p95: Change
  readonly p99: Change
  readonly errors: Change
}

export interface Comparison {
  /** All load requests together (setup and teardown left out, see isLoad). */
  readonly total: EndpointComparison
  /** Every endpoint that has requests on both sides, by name. */
  readonly endpoints: ReadonlyArray<EndpointComparison>
  /** Latency changes smaller than this (0.05 = 5%) do not matter. */
  readonly band: number
  /** How many seconds each block holds. */
  readonly blockSeconds: number
  /** Whether both sides were picked at the same positions in time. */
  readonly isPaired: boolean
  /** Seconds left out because Mantix itself could not keep up in them. */
  readonly leftOut: { readonly baseline: number; readonly current: number }
}

export interface CompareOptions {
  /** See Comparison.band. Defaults to DEFAULT_BAND. */
  readonly band?: number
  /** How many pretend runs to build. More is steadier and slower. */
  readonly rounds?: number
  /** The random seed. Fixed by default, so results never change. */
  readonly seed?: number
}

// ---------------------------------------------------------------------------
// The rules

/** A latency change under 5% is too small to matter. */
export const DEFAULT_BAND = 0.05

/** Error rates that differ by less than 0.1 percentage points are the same. */
export const ERROR_BAND = 0.001

const ROUNDS = 1000
const SEED = 1
const MIN_BLOCKS = 5

/**
 * The fewest requests a side needs before a metric is judged: about fifty
 * requests beyond the percentile. With fewer, a p99 rests on a handful of
 * requests, and its range comes out narrower than the truth.
 */
const MIN_REQUESTS: Record<Metric, number> = {
  p50: 100,
  p95: 1000,
  p99: 5000,
  errors: 20,
}

const QUANTILES = { p50: 0.5, p95: 0.95, p99: 0.99 } as const

/**
 * Seconds per block. About 5 s, so a spike stays in one piece; at least 10
 * blocks for a short run; at most 60 for a long one, to stay fast.
 */
export const blockSecondsFor = (longestRun: number): number =>
  longestRun >= 50
    ? Math.max(5, Math.ceil(longestRun / 60))
    : Math.max(1, Math.floor(longestRun / 10))

/** Where a change most likely lies, at two levels of confidence. */
interface Ranges {
  /** 95% of the pretend runs fell inside: the range people see. */
  readonly wide: { readonly low: number; readonly high: number }
  /** 90% of them fell inside. */
  readonly narrow: { readonly low: number; readonly high: number }
}

/**
 * The verdict for a change and its ranges. These are the two standard
 * tests, each wrong at most 5% of the time:
 *
 * - "Slower" or "faster" needs the whole 95% range on one side of zero
 *   (a two-sided test), and the change itself past the band.
 * - "No real change" needs the whole 90% range inside the band. That is
 *   the equivalence test (two one-sided tests, each at 5%).
 */
const judge = (
  change: number,
  { wide, narrow }: Ranges,
  band: number,
): Pick<Change, 'verdict' | 'reason'> => {
  if (wide.low > 0 && change > band) return { verdict: 'Worse' }
  if (wide.high < 0 && change < -band) return { verdict: 'Better' }
  if (narrow.low >= -band && narrow.high <= band) return { verdict: 'NoChange' }
  return { verdict: 'CantTell', reason: 'Noisy' }
}

// ---------------------------------------------------------------------------
// Blocks

/** One endpoint in one block of seconds: raw counts, ready to add up. */
interface Block {
  /** Bucket indexes and their counts, side by side (fast to loop over). */
  readonly indexes: Int32Array
  readonly counts: Float64Array
  readonly total: number
  readonly min: number
  readonly max: number
  readonly requests: number
  readonly errors: number
}

/** One run cut into blocks, per endpoint. A block with no requests is undefined. */
interface RunBlocks {
  readonly length: number
  readonly byEndpoint: ReadonlyMap<string, ReadonlyArray<Block | undefined>>
  /** Endpoints of setup and teardown requests. */
  readonly notLoad: ReadonlySet<string>
  readonly leftOut: number
}

/** The key the "all requests" total is stored under. No endpoint has it. */
const TOTAL = '\u0000total'

const emptyBlock = () => ({
  counts: new Map<number, number>(),
  min: Number.POSITIVE_INFINITY,
  max: 0,
  requests: 0,
  errors: 0,
})

const cutIntoBlocks = (
  seconds: ReadonlyArray<Second>,
  blockSeconds: number,
): RunBlocks => {
  const first = seconds[0]?.t ?? 0
  const last = seconds.at(-1)?.t ?? -1
  const length = Math.ceil((last - first + 1) / blockSeconds)
  const building = new Map<string, Array<ReturnType<typeof emptyBlock>>>()
  const blockOf = (key: string, index: number) => {
    const blocks = building.get(key) ?? []
    building.set(key, blocks)
    blocks[index] ??= emptyBlock()
    return blocks[index]
  }
  const notLoad = new Set<string>()
  let leftOut = 0
  for (const second of seconds) {
    // The generator could not keep up: its slow numbers are Mantix's, not
    // the server's. The block keeps its place, it just holds less.
    if (issuesOf(second).length > 0) {
      leftOut++
      continue
    }
    const index = Math.floor((second.t - first) / blockSeconds)
    for (const part of second.endpoints) {
      if (!isLoad(part)) notLoad.add(part.endpoint)
      const keys = isLoad(part) ? [part.endpoint, TOTAL] : [part.endpoint]
      for (const key of keys) {
        const block = blockOf(key, index)
        for (const [bucket, count] of part.latency.buckets) {
          block.counts.set(bucket, (block.counts.get(bucket) ?? 0) + count)
        }
        if (part.latency.count > 0) {
          block.min = Math.min(block.min, part.latency.min)
          block.max = Math.max(block.max, part.latency.max)
        }
        block.requests += part.requests
        block.errors += countRequestErrors(part.errors)
      }
    }
  }
  const byEndpoint = new Map<string, ReadonlyArray<Block | undefined>>()
  for (const [key, blocks] of building) {
    byEndpoint.set(
      key,
      Array.from({ length }, (_, index) => {
        const block = blocks[index]
        return block === undefined || block.requests === 0
          ? undefined
          : {
              indexes: Int32Array.from(block.counts.keys()),
              counts: Float64Array.from(block.counts.values()),
              total: [...block.counts.values()].reduce((a, b) => a + b, 0),
              min: block.min,
              max: block.max,
              requests: block.requests,
              errors: block.errors,
            }
      }),
    )
  }
  return { length, byEndpoint, notLoad, leftOut }
}

// ---------------------------------------------------------------------------
// Adding blocks up

/**
 * Counts per bucket in a plain array, so adding a block is just adding
 * numbers. This is the hot loop: a thousand rounds, every endpoint, both
 * sides.
 */
class Tally {
  private readonly counts: Float64Array
  // The lowest and highest bucket touched, so clearing and walking skip
  // the empty ends.
  private low = Number.POSITIVE_INFINITY
  private high = -1
  private total = 0
  private min = Number.POSITIVE_INFINITY
  private max = 0
  requests = 0
  errors = 0

  constructor(size: number) {
    this.counts = new Float64Array(size)
  }

  clear(): void {
    if (this.high >= 0) this.counts.fill(0, this.low, this.high + 1)
    this.low = Number.POSITIVE_INFINITY
    this.high = -1
    this.total = 0
    this.min = Number.POSITIVE_INFINITY
    this.max = 0
    this.requests = 0
    this.errors = 0
  }

  add(block: Block): void {
    const { indexes, counts } = block
    for (let i = 0; i < indexes.length; i++) {
      const bucket = indexes[i]!
      this.counts[bucket]! += counts[i]!
      if (bucket < this.low) this.low = bucket
      if (bucket > this.high) this.high = bucket
    }
    this.total += block.total
    this.min = Math.min(this.min, block.min)
    this.max = Math.max(this.max, block.max)
    this.requests += block.requests
    this.errors += block.errors
  }

  /**
   * p50, p95 and p99 in ms, in one walk. Same rule as Histogram.percentile.
   * NaN when nothing was added: a round that picked no requests for this
   * endpoint says nothing, and is skipped.
   */
  percentiles(): Record<'p50' | 'p95' | 'p99', number> {
    const result = { p50: Number.NaN, p95: Number.NaN, p99: Number.NaN }
    if (this.total === 0) return result
    const wanted = (['p50', 'p95', 'p99'] as const).map(
      name => [name, Math.ceil(QUANTILES[name] * this.total)] as const,
    )
    let next = 0
    let seen = 0
    for (let bucket = this.low; bucket <= this.high; bucket++) {
      seen += this.counts[bucket]!
      while (next < wanted.length && seen >= wanted[next]![1]) {
        const value = bucketMidpoint(bucket)
        result[wanted[next]![0]] =
          Math.min(this.max, Math.max(this.min, value)) / 1000
        next++
      }
      if (next === wanted.length) break
    }
    return result
  }

  errorRate(): number {
    return this.requests === 0 ? Number.NaN : this.errors / this.requests
  }
}

/** Which block of which run: one pick of a round. */
type Picks = ReadonlyArray<readonly [run: number, block: number]>

const tallyOf = (
  tally: Tally,
  side: ReadonlyArray<RunBlocks>,
  key: string,
  picks: Picks,
): Tally => {
  tally.clear()
  for (const [run, index] of picks) {
    const block = side[run]!.byEndpoint.get(key)?.[index]
    if (block !== undefined) tally.add(block)
  }
  return tally
}

/** Every block of every run: the real, unresampled side. */
const everything = (side: ReadonlyArray<RunBlocks>): Picks =>
  side.flatMap((run, r) =>
    Array.from({ length: run.length }, (_, b) => [r, b] as const),
  )

/** A small, fast, seedable random number generator (mulberry32). */
const randomFrom = (seed: number) => {
  let state = seed >>> 0
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let x = state
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// Comparing

const latencyChange = (before: number, after: number): number =>
  before === 0 ? Number.NaN : (after - before) / before

/** The middle 95% and 90% of the valid samples; undefined if most rounds failed. */
const rangesOf = (samples: Float64Array): Ranges | undefined => {
  const valid = samples.filter(Number.isFinite).sort()
  if (valid.length < samples.length / 2) return undefined
  const at = (q: number) =>
    valid[Math.min(valid.length - 1, Math.floor(q * valid.length))]!
  return {
    wide: { low: at(0.025), high: at(0.975) },
    narrow: { low: at(0.05), high: at(0.95) },
  }
}

/**
 * Compare two sides, each one or more runs' Seconds. `baseline` is what
 * you compare against; `current` is the run being judged.
 */
export const compareRuns = (
  baseline: ReadonlyArray<ReadonlyArray<Second>>,
  current: ReadonlyArray<ReadonlyArray<Second>>,
  options: CompareOptions = {},
): Comparison => {
  const band = options.band ?? DEFAULT_BAND
  const rounds = options.rounds ?? ROUNDS
  const random = randomFrom(options.seed ?? SEED)

  const longest = Math.max(...[...baseline, ...current].map(s => s.length))
  const blockSeconds = blockSecondsFor(longest)
  const blocksOf = (runs: ReadonlyArray<ReadonlyArray<Second>>) =>
    runs.map(seconds => cutIntoBlocks(seconds, blockSeconds))
  const sides = [blocksOf(baseline), blocksOf(current)] as const
  const allRuns = [...sides[0], ...sides[1]]
  const isPaired = allRuns.every(run => run.length === allRuns[0]?.length)
  const isTooShort = allRuns.some(run => run.length < MIN_BLOCKS)

  // Endpoints with requests on both sides.
  const keysOf = (side: ReadonlyArray<RunBlocks>) =>
    new Set(side.flatMap(run => [...run.byEndpoint.keys()]))
  const baselineKeys = keysOf(sides[0])
  const keys = [...keysOf(sides[1])]
    .filter(key => baselineKeys.has(key))
    .sort((a, b) => a.localeCompare(b))

  // The largest bucket index anywhere sets the Tally's size.
  let size = 1
  for (const run of allRuns) {
    for (const blocks of run.byEndpoint.values()) {
      for (const block of blocks) {
        for (const bucket of block?.indexes ?? []) {
          size = Math.max(size, bucket + 1)
        }
      }
    }
  }
  const tallies = [new Tally(size), new Tally(size)] as const

  const metrics: ReadonlyArray<Metric> = ['p50', 'p95', 'p99', 'errors']
  const measure = (picks: readonly [Picks, Picks], key: string) => {
    const [before, after] = [0, 1].map(i =>
      tallyOf(tallies[i]!, sides[i]!, key, picks[i]!),
    ) as [Tally, Tally]
    const p = [before.percentiles(), after.percentiles()] as const
    return {
      requests: [before.requests, after.requests] as const,
      values: {
        p50: [p[0].p50, p[1].p50],
        p95: [p[0].p95, p[1].p95],
        p99: [p[0].p99, p[1].p99],
        errors: [before.errorRate(), after.errorRate()],
      } as Record<Metric, readonly [number, number]>,
    }
  }
  const changeOf = (
    metric: Metric,
    [before, after]: readonly [number, number],
  ) => (metric === 'errors' ? after - before : latencyChange(before, after))

  // The thousand pretend runs. Each round's picks are shared by every
  // endpoint, so the endpoints stay consistent with the total.
  const samples = new Map(
    keys.map(key => [
      key,
      Object.fromEntries(
        metrics.map(metric => [
          metric,
          new Float64Array(rounds).fill(Number.NaN),
        ]),
      ) as Record<Metric, Float64Array>,
    ]),
  )
  const pickIndex = (length: number) => Math.floor(random() * length)
  const positions = (length: number) =>
    Array.from({ length }, () => pickIndex(length))
  const pickSide = (
    side: ReadonlyArray<RunBlocks>,
    shared: ReadonlyArray<number> | undefined,
  ): Picks =>
    // One run is always itself; several are picked with replacement.
    (side.length === 1 ? [0] : positions(side.length)).flatMap(run =>
      (shared ?? positions(side[run]!.length)).map(b => [run, b] as const),
    )
  if (!isTooShort) {
    for (let round = 0; round < rounds; round++) {
      const shared = isPaired ? positions(allRuns[0]!.length) : undefined
      const picks = [
        pickSide(sides[0], shared),
        pickSide(sides[1], shared),
      ] as const
      for (const key of keys) {
        const { values } = measure(picks, key)
        const sampled = samples.get(key)!
        for (const metric of metrics) {
          sampled[metric][round] = changeOf(metric, values[metric])
        }
      }
    }
  }

  const compareKey = (key: string): EndpointComparison => {
    const { requests, values } = measure(
      [everything(sides[0]), everything(sides[1])],
      key,
    )
    const changeFor = (metric: Metric): Change => {
      const [before, after] = values[metric]
      const change = changeOf(metric, values[metric])
      const base = { metric, baseline: before, current: after, change }
      if (isTooShort)
        return { ...base, verdict: 'CantTell', reason: 'TooShort' }
      const sampled = samples.get(key)
      const ranges =
        sampled === undefined ? undefined : rangesOf(sampled[metric])
      if (
        Math.min(...requests) < MIN_REQUESTS[metric] ||
        ranges === undefined
      ) {
        return { ...base, verdict: 'CantTell', reason: 'TooFewRequests' }
      }
      return {
        ...base,
        range: ranges.wide,
        ...judge(change, ranges, metric === 'errors' ? ERROR_BAND : band),
      }
    }
    return {
      endpoint: key === TOTAL ? 'All requests' : key,
      isLoad: !allRuns.some(run => run.notLoad.has(key)),
      baselineRequests: requests[0],
      currentRequests: requests[1],
      p50: changeFor('p50'),
      p95: changeFor('p95'),
      p99: changeFor('p99'),
      errors: changeFor('errors'),
    }
  }

  const count = (side: ReadonlyArray<RunBlocks>) =>
    side.reduce((sum, run) => sum + run.leftOut, 0)
  return {
    total: compareKey(TOTAL),
    endpoints: keys.filter(key => key !== TOTAL).map(compareKey),
    band,
    blockSeconds,
    isPaired,
    leftOut: { baseline: count(sides[0]), current: count(sides[1]) },
  }
}

// ---------------------------------------------------------------------------
// Can these runs be compared at all?

const changesLoad = (run: RunInfo): boolean =>
  run.journal.some(entry => entry.control._tag !== 'Pin')

const distinct = <A>(values: ReadonlyArray<A>): number => new Set(values).size

/**
 * Why the verdicts may not mean much:
 * - DifferentTests: the runs are of different tests.
 * - DifferentPlans: the load plans differ, so the load did too.
 * - ChangedLive: someone changed the load during a run (see Steering.ts).
 * - DifferentMachines: the runs were made on different machines.
 */
export type Warning =
  | 'DifferentTests'
  | 'DifferentPlans'
  | 'ChangedLive'
  | 'DifferentMachines'

/**
 * What makes these runs less than like for like. Empty when they look
 * comparable. The verdicts are still given: the person decides.
 */
export const warnings = (
  baseline: ReadonlyArray<RunInfo>,
  current: ReadonlyArray<RunInfo>,
): ReadonlyArray<Warning> => {
  const runs = [...baseline, ...current]
  const machines = runs.flatMap(run =>
    run.context === undefined ? [] : [run.context.machine.hostname],
  )
  const checks: ReadonlyArray<readonly [Warning, boolean]> = [
    ['DifferentTests', distinct(runs.map(run => run.testName)) > 1],
    [
      'DifferentPlans',
      distinct(runs.map(run => JSON.stringify([run.plan, run.duration]))) > 1,
    ],
    ['ChangedLive', runs.some(changesLoad)],
    ['DifferentMachines', distinct(machines) > 1],
  ]
  return checks.filter(([, applies]) => applies).map(([warning]) => warning)
}
