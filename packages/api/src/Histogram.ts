/**
 * A small log-linear latency histogram.
 *
 * This is Mantix's data atom (decision D2 in the proposal): every endpoint
 * gets one histogram per second. Percentiles are never stored. They are
 * computed from histograms, and histograms merge exactly by adding counts,
 * so any time window can be summarised precisely.
 *
 * Values are recorded in whole microseconds.
 *
 * Bucket layout:
 * - Values below 64 µs get one exact bucket each (index = value).
 * - Above that, every power of two is split into 64 equal sub-buckets, so a
 *   bucket is at most 1/64 (about 1.6%) wide and the midpoint we report is
 *   within about 0.8% of any value inside it.
 */
import { Schema } from 'effect'

/** How many sub-buckets each power of two is split into (2^6 = 64). */
const SUB_BUCKET_BITS = 6
const SUB_BUCKETS = 1 << SUB_BUCKET_BITS

/**
 * The serialisable form of a histogram. It is a Schema, so the same value
 * travels unchanged from the engine to the SSE stream, to disk and into the
 * browser.
 */
export const Histogram = Schema.Struct({
  /** How many values were recorded. */
  count: Schema.Finite,
  /** Exact smallest value, in microseconds (0 when empty). */
  min: Schema.Finite,
  /** Exact largest value, in microseconds (0 when empty). */
  max: Schema.Finite,
  /** Sparse buckets as [bucketIndex, count] pairs, sorted by index. */
  buckets: Schema.Array(Schema.Tuple([Schema.Finite, Schema.Finite])),
})
export type Histogram = typeof Histogram.Type

/** A histogram with nothing recorded. */
export const empty: Histogram = { count: 0, min: 0, max: 0, buckets: [] }

/** Which bucket a value (in microseconds) falls into. */
export const bucketIndex = (micros: number): number => {
  const value = Math.max(0, Math.floor(micros))
  if (value < SUB_BUCKETS) {
    return value
  }
  // floor(log2(value)): which power of two the value sits in.
  let exponent = Math.floor(Math.log2(value))
  // Guard against floating-point rounding right at a power of two.
  if (2 ** exponent > value) exponent--
  else if (2 ** (exponent + 1) <= value) exponent++
  const shift = exponent - SUB_BUCKET_BITS
  const subBucket = Math.floor(value / 2 ** shift) - SUB_BUCKETS
  return SUB_BUCKETS + shift * SUB_BUCKETS + subBucket
}

/** The [lower, upper) range of values, in microseconds, that a bucket holds. */
export const bucketBounds = (index: number): readonly [number, number] => {
  if (index < SUB_BUCKETS) {
    return [index, index + 1]
  }
  const shift = Math.floor((index - SUB_BUCKETS) / SUB_BUCKETS)
  const subBucket = (index - SUB_BUCKETS) % SUB_BUCKETS
  const width = 2 ** shift
  const lower = (SUB_BUCKETS + subBucket) * width
  return [lower, lower + width]
}

/** The value we report for a bucket: the middle of its range. */
const bucketMidpoint = (index: number): number => {
  const [lower, upper] = bucketBounds(index)
  return index < SUB_BUCKETS ? lower : (lower + upper) / 2
}

/**
 * The value at quantile `q` (0..1), in microseconds. For example
 * `percentile(h, 0.99)` is the p99. Returns 0 for an empty histogram.
 *
 * The result is clamped to the exact min and max, so p0 and p100 are exact.
 */
export const percentile = (histogram: Histogram, q: number): number => {
  if (histogram.count === 0) {
    return 0
  }
  if (q <= 0) {
    return histogram.min
  }
  if (q >= 1) {
    return histogram.max
  }
  // The rank of the value we want, counting from 1.
  const rank = Math.ceil(q * histogram.count)
  let seen = 0
  for (const [index, count] of histogram.buckets) {
    seen += count
    if (seen >= rank) {
      const value = bucketMidpoint(index)
      return Math.min(histogram.max, Math.max(histogram.min, value))
    }
  }
  return histogram.max
}

/**
 * Combine two histograms. This is exact: counts are added bucket by bucket,
 * which is why we can summarise any window of seconds without losing
 * precision.
 */
export const merge = (a: Histogram, b: Histogram): Histogram => {
  if (a.count === 0) {
    return b
  }
  if (b.count === 0) {
    return a
  }
  const buckets: Array<[number, number]> = []
  let i = 0
  let j = 0
  // Both bucket lists are sorted, so we walk them together like merge sort.
  while (i < a.buckets.length || j < b.buckets.length) {
    const left = a.buckets[i]
    const right = b.buckets[j]
    if (right === undefined || (left !== undefined && left[0] < right[0])) {
      buckets.push([left![0], left![1]])
      i++
    } else if (left === undefined || right[0] < left[0]) {
      buckets.push([right[0], right[1]])
      j++
    } else {
      buckets.push([left[0], left[1] + right[1]])
      i++
      j++
    }
  }
  return {
    count: a.count + b.count,
    min: Math.min(a.min, b.min),
    max: Math.max(a.max, b.max),
    buckets,
  }
}

/** Merge any number of histograms. */
export const mergeAll = (histograms: Iterable<Histogram>): Histogram => {
  let result = empty
  for (const histogram of histograms) {
    result = merge(result, histogram)
  }
  return result
}

/**
 * A mutable recorder for the hot path. The engine records every request into
 * one of these and turns it into an immutable `Histogram` once per second.
 */
export class Recorder {
  private counts = new Map<number, number>()
  private total = 0
  private lowest = Number.POSITIVE_INFINITY
  private highest = 0

  /** Record one value, in microseconds. */
  record(micros: number): void {
    const value = Math.max(0, Math.round(micros))
    const index = bucketIndex(value)
    this.counts.set(index, (this.counts.get(index) ?? 0) + 1)
    this.total++
    if (value < this.lowest) this.lowest = value
    if (value > this.highest) this.highest = value
  }

  /** How many values have been recorded since the last reset. */
  get count(): number {
    return this.total
  }

  /** An immutable snapshot of everything recorded so far. */
  snapshot(): Histogram {
    if (this.total === 0) {
      return empty
    }
    const buckets = [...this.counts.entries()].sort((a, b) => a[0] - b[0])
    return {
      count: this.total,
      min: this.lowest,
      max: this.highest,
      buckets,
    }
  }

  /** Forget everything, ready for the next second. */
  reset(): void {
    this.counts.clear()
    this.total = 0
    this.lowest = Number.POSITIVE_INFINITY
    this.highest = 0
  }
}

/** Build a histogram from a list of values. Handy in tests. */
export const fromValues = (micros: Iterable<number>): Histogram => {
  const recorder = new Recorder()
  for (const value of micros) {
    recorder.record(value)
  }
  return recorder.snapshot()
}
