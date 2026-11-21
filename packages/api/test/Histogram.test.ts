import { describe, expect, it } from 'vitest'

import * as Histogram from '../src/Histogram.ts'

describe('Histogram', () => {
  it('keeps small values exact', () => {
    const h = Histogram.fromValues([1, 2, 3, 63])
    expect(h.count).toBe(4)
    expect(Histogram.percentile(h, 0.5)).toBe(2)
    expect(Histogram.percentile(h, 1)).toBe(63)
  })

  it('puts every value inside its own bucket bounds', () => {
    for (const value of [64, 65, 127, 128, 1000, 123_456, 2 ** 31, 3e10]) {
      const [lower, upper] = Histogram.bucketBounds(
        Histogram.bucketIndex(value),
      )
      expect(value).toBeGreaterThanOrEqual(lower)
      expect(value).toBeLessThan(upper)
    }
  })

  it('reports percentiles within 1% of the true value', () => {
    // 1..100,000 µs, so the true p99 is 99,000 µs.
    const values = Array.from({ length: 100_000 }, (_, i) => i + 1)
    const h = Histogram.fromValues(values)
    const p99 = Histogram.percentile(h, 0.99)
    expect(Math.abs(p99 - 99_000) / 99_000).toBeLessThan(0.01)
    expect(Histogram.percentile(h, 0)).toBe(1)
    expect(Histogram.percentile(h, 1)).toBe(100_000)
  })

  it('merges exactly: merging two halves equals recording everything', () => {
    const a = Array.from({ length: 500 }, (_, i) => i * 37 + 5)
    const b = Array.from({ length: 700 }, (_, i) => i * 91 + 11)
    const merged = Histogram.merge(
      Histogram.fromValues(a),
      Histogram.fromValues(b),
    )
    expect(merged).toEqual(Histogram.fromValues([...a, ...b]))
  })

  it('treats the empty histogram as a neutral element', () => {
    const h = Histogram.fromValues([10, 20, 30])
    expect(Histogram.merge(Histogram.empty, h)).toBe(h)
    expect(Histogram.merge(h, Histogram.empty)).toBe(h)
    expect(Histogram.percentile(Histogram.empty, 0.99)).toBe(0)
  })
})
