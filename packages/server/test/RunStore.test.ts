import { Effect, Option } from 'effect'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { Histogram, type RunInfo, type Second } from '@mantix/api'

import { RunStore } from '../src/RunStore.ts'

const run = (id: string, startedAt: number): RunInfo => ({
  id,
  testName: 'checkout',
  status: 'running',
  startedAt,
  endedAt: null,
  duration: 2,
  plan: [],
  thresholds: [],
})

const second = (t: number, latencies: Array<number>): Second => ({
  t,
  target: 10,
  offered: 10,
  started: 10,
  dropped: 0,
  completed: latencies.length,
  failed: 0,
  inFlight: 0,
  vus: 1,
  loopLagMs: 0,
  endpoints: [
    {
      endpoint: 'GET /cart',
      requests: latencies.length,
      latency: Histogram.fromValues(latencies),
      uncorrected: Histogram.fromValues(latencies),
      statuses: { '200': latencies.length },
      errors: {},
    },
  ],
  errorSamples: [],
})

/** Run an effect against a store saved in `file` (closed afterwards). */
const withStore = <A, E>(
  file: string,
  f: (store: RunStore['Service']) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.flatMap(RunStore, f).pipe(Effect.provide(RunStore.layer(file))),
  )

let folder: string | undefined
const tempFile = () => {
  folder = mkdtempSync(join(tmpdir(), 'mantix-history-'))
  return join(folder, 'nested', 'history.db')
}
afterEach(() => {
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true })
  folder = undefined
})

describe('RunStore', () => {
  it('saves a run, its Seconds and mergeable totals', async () => {
    const file = tempFile()
    await withStore(file, store =>
      Effect.gen(function* () {
        yield* store.create(run('a', 1_000), 'checkout.ts')
        yield* store.addSecond('a', second(0, [1_000, 2_000]))
        // Saving the same second twice keeps the first one.
        yield* store.addSecond('a', second(0, [9_999]))
        const done = { ...run('a', 1_000), status: 'finished' as const }
        yield* store.finish({ ...done, endedAt: 3_000 }, [
          second(0, [1_000, 2_000]),
          second(1, [3_000]),
        ])
      }),
    )

    // A new store on the same file: everything survived the "restart".
    const result = await withStore(file, store =>
      Effect.all({
        list: store.list({ file: 'checkout.ts' }),
        other: store.list({ file: 'other.ts' }),
        got: store.get('a'),
        missing: store.get('nope'),
        seconds: store.seconds('a'),
        totals: store.totals('a'),
      }),
    )
    expect(result.list.map(r => r.status)).toEqual(['finished'])
    expect(result.other).toEqual([])
    expect(Option.getOrThrow(result.got).endedAt).toBe(3_000)
    expect(Option.isNone(result.missing)).toBe(true)
    expect(result.seconds.map(s => s.t)).toEqual([0, 1])
    expect(result.seconds[0]!.endpoints[0]!.requests).toBe(2)
    // Totals are histograms merged over the run, not percentiles.
    const total = result.totals[0]!
    expect(total.requests).toBe(3)
    expect(total.statuses).toEqual({ '200': 3 })
    expect(total.latency.count).toBe(3)
    expect(total.latency.max).toBe(3_000)
  })

  it('lists newest first and honours the limit', async () => {
    const list = await withStore(tempFile(), store =>
      Effect.gen(function* () {
        yield* store.create(run('old', 1_000), 'checkout.ts')
        yield* store.create(run('new', 2_000), 'checkout.ts')
        yield* store.create(run('mid', 1_500), 'checkout.ts')
        return yield* store.list({ limit: 2 })
      }),
    )
    expect(list.map(r => r.id)).toEqual(['new', 'mid'])
  })

  it('marks a run cut off by a crash as crashed when reopened', async () => {
    const file = tempFile()
    await withStore(file, store =>
      Effect.gen(function* () {
        yield* store.create(run('cut', 10_000), 'checkout.ts')
        yield* store.addSecond('cut', second(0, [1_000]))
        yield* store.addSecond('cut', second(1, [1_000]))
      }),
    )
    const [info, totals] = await withStore(file, store =>
      Effect.all([store.get('cut'), store.totals('cut')]),
    )
    const cut = Option.getOrThrow(info)
    expect(cut.status).toBe('crashed')
    expect(cut.endedAt).toBe(12_000)
    expect(cut.error).toContain('stopped before this run ended')
    expect(totals[0]!.requests).toBe(2)
  })
})
