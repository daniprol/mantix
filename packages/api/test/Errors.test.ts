import { describe, expect, it } from 'vitest'

import {
  fingerprint,
  groupErrors,
  normalizeMessage,
  pathPattern,
} from '../src/Errors.ts'
import type { ErrorSample, Second } from '../src/Second.ts'

const second = (
  t: number,
  samples: Array<ErrorSample>,
  fingerprints?: Record<string, number>,
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
  loopLagMs: 0,
  endpoints: [],
  errorSamples: samples,
  ...(fingerprints === undefined ? {} : { fingerprints }),
})

const mismatch = (index: number): ErrorSample => {
  const sample = {
    endpoint: 'GET /cart/:id',
    kind: 'SchemaMismatch' as const,
    message: `$.items[${index}].price: Expected number`,
    diff: {
      path: `$.items[${index}].price`,
      expected: 'Expected number',
      received: '"19.99"',
      receivedType: 'string',
    },
  }
  return { ...sample, fingerprint: fingerprint(sample) }
}

describe('fingerprints', () => {
  it('blanks out what changes between occurrences', () => {
    expect(normalizeMessage('Order 1234 for "bob" failed')).toBe(
      'Order N for "…" failed',
    )
    expect(
      normalizeMessage('id 3f2b8c1a-1111-2222-3333-444455556666 missing'),
    ).toBe('id ID missing')
    expect(pathPattern('$.items[3].tags[0]')).toBe('$.items[*].tags[*]')
  })

  it('groups schema mismatches by path pattern', () => {
    expect(mismatch(3).fingerprint).toBe(mismatch(7).fingerprint)
    const other = fingerprint({
      endpoint: 'GET /cart/:id',
      kind: 'HttpStatus',
      message: '503 Service Unavailable',
    })
    expect(other).not.toBe(mismatch(3).fingerprint)
  })
})

describe('groupErrors', () => {
  it('counts, dates and keeps examples per problem', () => {
    const fp = mismatch(0).fingerprint!
    const seconds = Array.from({ length: 30 }, (_, t) =>
      second(t, [mismatch(t)], { [fp]: 4 }),
    )
    const [group] = groupErrors(seconds)
    expect(group).toMatchObject({
      fingerprint: fp,
      kind: 'SchemaMismatch',
      count: 120,
      firstSeen: 0,
      lastSeen: 29,
      detail: '$.items[*].price: Expected number (received string)',
    })
    // First three, last three and three from the middle.
    const times = group!.examples.map(e => e.t)
    expect(times).toHaveLength(9)
    expect(times.slice(0, 3)).toEqual([0, 1, 2])
    expect(times.slice(-3)).toEqual([27, 28, 29])
    expect(groupErrors(seconds)).toEqual(groupErrors(seconds))
  })

  it('sorts by count and handles data without fingerprints', () => {
    const old = {
      endpoint: 'POST /checkout',
      kind: 'HttpStatus' as const,
      message: '503 Service Unavailable',
    }
    const groups = groupErrors([
      second(0, [old]),
      second(1, [old, mismatch(1)], undefined),
      second(2, [old]),
    ])
    expect(groups.map(g => [g.kind, g.count])).toEqual([
      ['HttpStatus', 3],
      ['SchemaMismatch', 1],
    ])
  })
})
