import { Effect, Option } from 'effect'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { Histogram, type RunInfo, type Second } from '@mantix/api'

import { type ListOptions, RunStore } from '../src/RunStore.ts'

const run = (id: string, startedAt: number): RunInfo => ({
  id,
  testName: 'checkout',
  status: 'running',
  startedAt,
  endedAt: null,
  duration: 2,
  plan: [],
  thresholds: [],
  journal: [],
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

  it('keeps the phase of setup rows in the totals', async () => {
    const setup = second(0, [5_000])
    const withSetup: Second = {
      ...setup,
      endpoints: [
        {
          ...setup.endpoints[0]!,
          endpoint: 'POST /login (setup)',
          phase: 'setup',
        },
      ],
    }
    const totals = await withStore(tempFile(), store =>
      Effect.gen(function* () {
        yield* store.create(run('s', 1_000), 'checkout.ts')
        yield* store.finish({ ...run('s', 1_000), status: 'finished' }, [
          withSetup,
          second(1, [1_000]),
        ])
        return yield* store.totals('s')
      }),
    )
    expect(totals.map(t => [t.endpoint, t.phase])).toEqual([
      ['GET /cart', undefined],
      ['POST /login (setup)', 'setup'],
    ])
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

  it('reads runs saved before runs had a journal', async () => {
    const file = tempFile()
    await withStore(file, store =>
      Effect.gen(function* () {
        yield* store.create(run('old', 1_000), 'checkout.ts')
        yield* store.finish({ ...run('old', 1_000), status: 'finished' }, [])
      }),
    )
    // Rewrite the row the way an older Mantix saved it: no journal.
    const db = new DatabaseSync(file)
    const row = db.prepare("SELECT info FROM runs WHERE id = 'old'").get() as {
      readonly info: string
    }
    const { journal: _, ...older } = JSON.parse(row.info)
    db.prepare("UPDATE runs SET info = ? WHERE id = 'old'").run(
      JSON.stringify(older),
    )
    db.close()

    const info = await withStore(file, store => store.get('old'))
    expect(Option.getOrThrow(info).journal).toEqual([])
  })
})

describe('RunStore run context', () => {
  const withContext = (
    id: string,
    startedAt: number,
    context: { project: string; branch?: string; label?: string },
  ): RunInfo => ({
    ...run(id, startedAt),
    context: {
      project: context.project,
      git: {
        commit: `${id}0000`,
        dirty: false,
        ...(context.branch === undefined ? {} : { branch: context.branch }),
      },
      mantixVersion: '1.0.0',
      machine: { hostname: 'ci', os: 'linux x64', node: '22.19.0' },
      ...(context.label === undefined ? {} : { label: context.label }),
    },
  })

  it('filters by project, branch and label', async () => {
    const ids = await withStore(tempFile(), store =>
      Effect.gen(function* () {
        yield* store.create(
          withContext('a', 1, { project: 'shop', branch: 'main' }),
          'load.ts',
        )
        yield* store.create(
          withContext('b', 2, {
            project: 'shop',
            branch: 'feature',
            label: 'v2',
          }),
          'load.ts',
        )
        yield* store.create(
          withContext('c', 3, { project: 'blog', branch: 'main' }),
          'load.ts',
        )
        const ids = (options: ListOptions) =>
          Effect.map(store.list(options), runs => runs.map(r => r.id))
        return yield* Effect.all({
          shop: ids({ project: 'shop' }),
          main: ids({ branch: 'main' }),
          shopMain: ids({ file: 'load.ts', project: 'shop', branch: 'main' }),
          label: ids({ label: 'v2' }),
          none: ids({ project: 'nope' }),
        })
      }),
    )
    expect(ids).toEqual({
      shop: ['b', 'a'],
      main: ['c', 'a'],
      shopMain: ['a'],
      label: ['b'],
      none: [],
    })
  })

  it('upgrades a version 1 file and keeps its runs readable', async () => {
    // A history file as Mantix 1 wrote it, before runs had a context.
    const file = tempFile()
    mkdirSync(dirname(file), { recursive: true })
    const v1 = new DatabaseSync(file)
    v1.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, file TEXT NOT NULL, test_name TEXT NOT NULL,
        status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
        info TEXT NOT NULL
      );
      CREATE TABLE seconds (
        run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        t INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (run_id, t)
      ) WITHOUT ROWID;
      CREATE TABLE endpoint_totals (
        run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (run_id, endpoint)
      ) WITHOUT ROWID;
      PRAGMA user_version = 1;
    `)
    const old = { ...run('old', 1_000), status: 'finished', endedAt: 3_000 }
    v1.prepare(
      `INSERT INTO runs VALUES ('old', 'load.ts', 'checkout', 'finished', 1000, 3000, ?)`,
    ).run(JSON.stringify(old))
    v1.close()

    const result = await withStore(file, store =>
      Effect.gen(function* () {
        yield* store.create(
          withContext('new', 2_000, { project: 'shop' }),
          'load.ts',
        )
        return yield* Effect.all({
          all: store.list({ file: 'load.ts' }),
          shop: store.list({ project: 'shop' }),
        })
      }),
    )
    expect(result.all.map(r => [r.id, r.context?.project])).toEqual([
      ['new', 'shop'],
      ['old', undefined],
    ])
    // Old runs have no project, so a project filter leaves them out.
    expect(result.shop.map(r => r.id)).toEqual(['new'])
    const db = new DatabaseSync(file)
    const row = db.prepare('PRAGMA user_version').get() as {
      readonly user_version: number
    }
    db.close()
    expect(row.user_version).toBe(2)
  })
})
