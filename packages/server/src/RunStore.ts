/**
 * Run history: every run, saved to a SQLite file so it survives restarts.
 *
 * What is stored follows decision D2 in the proposal: raw, mergeable data,
 * never percentiles.
 *
 * - `runs`: one row per run. The full RunInfo is kept as JSON, plus a few
 *   columns copied out of it so lists can be filtered and sorted.
 * - `seconds`: every Second of every run, as JSON, histograms included.
 *   Any window of any run can be summarised exactly later, and the
 *   per-second histograms are what a run comparison needs to resample.
 * - `endpoint_totals`: one EndpointSecond per endpoint, merged over the
 *   whole run. Still histograms, so two runs can be compared, or many runs
 *   merged, without reading every Second again.
 *
 * SQLite comes from `node:sqlite`, built into Node, so there is no native
 * module to compile and nothing extra to bundle. Its calls are synchronous;
 * a run writes one small row per second, which takes far less than a
 * millisecond, so blocking the event loop for it is fine.
 *
 * Writing history must never break a run: callers log failures and go on
 * (see `recordRun` in History.ts).
 */
import { Config, Context, Data, Effect, Layer, Option, Schema } from 'effect'
import { Flag } from 'effect/cli'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import {
  EndpointSecond,
  type RunInfo,
  RunInfo as RunInfoSchema,
  Second,
  endpointTotals,
} from '@mantix/api'

/** Reading or writing the history file failed. */
export class HistoryError extends Data.TaggedError('HistoryError')<{
  readonly message: string
}> {}

/** Filters for `list`. */
export interface ListOptions {
  /** Only runs of this test file (as stored, relative to the project). */
  readonly file?: string | undefined
  /** At most this many runs, newest first (default 50). */
  readonly limit?: number | undefined
}

export class RunStore extends Context.Service<
  RunStore,
  {
    /** Save a run that just started. */
    readonly create: (
      info: RunInfo,
      file: string,
    ) => Effect.Effect<void, HistoryError>
    /** Save a new status or threshold results. */
    readonly update: (info: RunInfo) => Effect.Effect<void, HistoryError>
    /** Save one closed Second. Saving the same `t` twice keeps the first. */
    readonly addSecond: (
      runId: string,
      second: Second,
    ) => Effect.Effect<void, HistoryError>
    /**
     * Save the final state of a run: its info, any Seconds not saved yet,
     * and the per-endpoint totals. Safe to call more than once.
     */
    readonly finish: (
      info: RunInfo,
      seconds: ReadonlyArray<Second>,
    ) => Effect.Effect<void, HistoryError>
    /** Runs, newest first. */
    readonly list: (
      options?: ListOptions,
    ) => Effect.Effect<ReadonlyArray<RunInfo>, HistoryError>
    readonly get: (
      id: string,
    ) => Effect.Effect<Option.Option<RunInfo>, HistoryError>
    /** Every saved Second of a run, in order. Empty if there are none. */
    readonly seconds: (
      id: string,
    ) => Effect.Effect<ReadonlyArray<Second>, HistoryError>
    /** The merged per-endpoint totals of a run that has ended. */
    readonly totals: (
      id: string,
    ) => Effect.Effect<ReadonlyArray<EndpointSecond>, HistoryError>
  }
>()('mantix/server/RunStore') {
  /**
   * A store backed by a SQLite file (created if missing), or `":memory:"`
   * for tests. The file is closed when the layer's scope closes.
   */
  static readonly layer = (path: string) =>
    Layer.effect(
      RunStore,
      Effect.gen(function* () {
        // acquireRelease: open now, and close for sure when the scope ends.
        const db = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => openDatabase(path),
            catch: error =>
              new HistoryError({
                message: `Could not open run history at ${path}: ${messageOf(error)}`,
              }),
          }),
          db => Effect.sync(() => db.close()),
        )
        return makeStore(db)
      }),
    )

  /** A store that forgets everything on exit: tests and `--no-history`. */
  // An in-memory database cannot fail to open, so orDie drops the error.
  static readonly memory = RunStore.layer(':memory:').pipe(Layer.orDie)

  /**
   * The store the CLI uses. If the file cannot be opened (a read-only
   * folder, a file from a newer Mantix), say so and keep going without
   * history rather than refusing to run the test.
   */
  static readonly forCli = (options: {
    readonly enabled: boolean
    readonly file: string
  }) =>
    options.enabled
      ? RunStore.layer(options.file).pipe(
          Layer.catchTag('HistoryError', error =>
            Layer.unwrap(
              Effect.as(
                Effect.logWarning(`${error.message}. Runs will not be saved.`),
                RunStore.memory,
              ),
            ),
          ),
        )
      : RunStore.memory
}

/** Where the history is saved unless `--history-file` says otherwise. */
const DEFAULT_HISTORY_FILE = '.mantix/history.db'

/**
 * The `--no-history` and `--history-file` flags, shared by run, ui and dev.
 *
 * Each can also be set with an environment variable, handy in CI or a
 * container. `withFallbackConfig` reads the variable only when the flag is
 * not given, so a flag always wins; `withDefault` applies when neither is.
 */
export const historyFlags = {
  history: Flag.Boolean('history').pipe(
    Flag.withDescription(
      'Save runs to the run history (use --no-history to skip; env MANTIX_HISTORY=false)',
    ),
    Flag.withFallbackConfig(Config.Boolean('MANTIX_HISTORY')),
    Flag.withDefault(true),
  ),
  historyFile: Flag.String('history-file').pipe(
    Flag.withDescription('The run history file (env MANTIX_HISTORY_FILE)'),
    Flag.withFallbackConfig(Config.String('MANTIX_HISTORY_FILE')),
    Flag.withDefault(DEFAULT_HISTORY_FILE),
  ),
}

// ---------------------------------------------------------------------------
// Opening the database

/**
 * Bump this and add a step to `migrate` whenever the tables change. SQLite
 * keeps the number in the file (`PRAGMA user_version`).
 */
const SCHEMA_VERSION = 1

const openDatabase = async (path: string): Promise<DatabaseSync> => {
  const { DatabaseSync } = await importSqlite()
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  // WAL lets the dashboard read while a run writes; foreign keys make
  // deleting a run delete its Seconds too.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  migrate(db)
  markInterruptedRuns(db)
  return db
}

/**
 * `node:sqlite` still prints an "experimental feature" warning the first
 * time it loads (Node 22 and 24). It works fine, so hide that one warning
 * instead of worrying everyone who runs `mantix`.
 */
const importSqlite = async () => {
  const emitWarning = process.emitWarning
  process.emitWarning = ((warning: string | Error, ...rest: Array<never>) => {
    if (String(warning).includes('SQLite')) return
    emitWarning.call(process, warning, ...rest)
  }) as typeof process.emitWarning
  try {
    return await import('node:sqlite')
  } finally {
    process.emitWarning = emitWarning
  }
}

const migrate = (db: DatabaseSync): void => {
  const row = db.prepare('PRAGMA user_version').get() as {
    readonly user_version: number
  }
  const version = row.user_version
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `it was written by a newer version of Mantix (history version ${version}). Upgrade Mantix, or pass --history with another file.`,
    )
  }
  if (version < 1) {
    db.exec(`
      CREATE TABLE runs (
        id         TEXT PRIMARY KEY,
        file       TEXT NOT NULL,     -- test file, relative to the project
        test_name  TEXT NOT NULL,
        status     TEXT NOT NULL,
        started_at INTEGER NOT NULL,  -- epoch ms
        ended_at   INTEGER,           -- epoch ms, NULL while running
        info       TEXT NOT NULL      -- the whole RunInfo as JSON
      );
      CREATE INDEX runs_by_file ON runs (file, started_at DESC);
      CREATE INDEX runs_by_start ON runs (started_at DESC);

      CREATE TABLE seconds (
        run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        t      INTEGER NOT NULL,
        data   TEXT NOT NULL,         -- the Second as JSON
        PRIMARY KEY (run_id, t)
      ) WITHOUT ROWID;

      CREATE TABLE endpoint_totals (
        run_id   TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL,
        data     TEXT NOT NULL,       -- an EndpointSecond merged over the run
        PRIMARY KEY (run_id, endpoint)
      ) WITHOUT ROWID;
    `)
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}

/**
 * A run still marked "running" when the file is opened was cut off: the
 * process was killed, or the machine went down. Mark it crashed, ending at
 * its last saved Second, and save its totals, so it reads like any other
 * finished run.
 */
const markInterruptedRuns = (db: DatabaseSync): void => {
  const rows = db
    .prepare("SELECT id, info FROM runs WHERE status = 'running'")
    .all() as Array<{ readonly id: string; readonly info: string }>
  for (const row of rows) {
    const info = decodeInfo(row.info)
    const seconds = readSeconds(db, row.id)
    finishRun(db, {
      ...info,
      status: 'crashed',
      endedAt: info.startedAt + seconds.length * 1000,
      error: 'Mantix stopped before this run ended.',
    })
  }
}

// ---------------------------------------------------------------------------
// The store

// Schemas turn JSON text into typed values (and back), checking it on the
// way in, so a hand-edited or corrupt row fails loudly instead of quietly.
const decodeRunInfo = Schema.decodeUnknownSync(RunInfoSchema)
/**
 * Rows saved before runs had a journal (steering) lack the field: those
 * runs were never steered, so an empty journal is exactly right.
 */
const decodeInfo = (json: string): RunInfo => {
  const raw: unknown = JSON.parse(json)
  return decodeRunInfo(
    typeof raw === 'object' && raw !== null && !('journal' in raw)
      ? { ...raw, journal: [] }
      : raw,
  )
}
const encodeInfo = Schema.encodeSync(Schema.fromJsonString(RunInfoSchema))
const decodeSecond = Schema.decodeUnknownSync(Schema.fromJsonString(Second))
const encodeSecond = Schema.encodeSync(Schema.fromJsonString(Second))
const decodeTotal = Schema.decodeUnknownSync(
  Schema.fromJsonString(EndpointSecond),
)
const encodeTotal = Schema.encodeSync(Schema.fromJsonString(EndpointSecond))

const readSeconds = (db: DatabaseSync, id: string): Array<Second> =>
  (
    db
      .prepare('SELECT data FROM seconds WHERE run_id = ? ORDER BY t')
      .all(id) as Array<{ readonly data: string }>
  ).map(row => decodeSecond(row.data))

const updateRun = (db: DatabaseSync, info: RunInfo): void => {
  db.prepare(
    'UPDATE runs SET status = ?, ended_at = ?, info = ? WHERE id = ?',
  ).run(info.status, info.endedAt, encodeInfo(info), info.id)
}

/** Save the final info and the totals, merged from the saved Seconds. */
const finishRun = (db: DatabaseSync, info: RunInfo): void => {
  const totals = endpointTotals(readSeconds(db, info.id))
  // One transaction: either all of it is saved, or none of it.
  db.exec('BEGIN')
  try {
    updateRun(db, info)
    db.prepare('DELETE FROM endpoint_totals WHERE run_id = ?').run(info.id)
    const insert = db.prepare(
      'INSERT INTO endpoint_totals (run_id, endpoint, data) VALUES (?, ?, ?)',
    )
    for (const total of totals) {
      insert.run(info.id, total.endpoint, encodeTotal(total))
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const makeStore = (db: DatabaseSync) => {
  /** Run a synchronous database call as an Effect with a typed error. */
  const use = <A>(what: string, f: () => A) =>
    Effect.try({
      try: f,
      catch: error =>
        new HistoryError({ message: `${what}: ${messageOf(error)}` }),
    })

  const insertSecond = db.prepare(
    'INSERT OR IGNORE INTO seconds (run_id, t, data) VALUES (?, ?, ?)',
  )

  return RunStore.of({
    create: (info, file) =>
      use('Could not save the run', () => {
        db.prepare(
          `INSERT INTO runs (id, file, test_name, status, started_at, ended_at, info)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          info.id,
          file,
          info.testName,
          info.status,
          info.startedAt,
          info.endedAt,
          encodeInfo(info),
        )
      }),

    update: info => use('Could not save the run', () => updateRun(db, info)),

    addSecond: (runId, second) =>
      use('Could not save a second', () => {
        insertSecond.run(runId, second.t, encodeSecond(second))
      }),

    finish: (info, seconds) =>
      use('Could not save the finished run', () => {
        // Seconds the live writer missed (it may have been interrupted on
        // Ctrl-C) are saved here; ones already saved are kept as they are.
        for (const second of seconds) {
          insertSecond.run(info.id, second.t, encodeSecond(second))
        }
        finishRun(db, info)
      }),

    list: (options = {}) =>
      use('Could not read the run history', () => {
        const limit = options.limit ?? 50
        const rows = (
          options.file === undefined
            ? db
                .prepare(
                  'SELECT info FROM runs ORDER BY started_at DESC LIMIT ?',
                )
                .all(limit)
            : db
                .prepare(
                  'SELECT info FROM runs WHERE file = ? ORDER BY started_at DESC LIMIT ?',
                )
                .all(options.file, limit)
        ) as Array<{ readonly info: string }>
        return rows.map(row => decodeInfo(row.info))
      }),

    get: id =>
      use('Could not read the run history', () => {
        const row = db.prepare('SELECT info FROM runs WHERE id = ?').get(id) as
          | { readonly info: string }
          | undefined
        return Option.map(Option.fromNullishOr(row), r => decodeInfo(r.info))
      }),

    seconds: id =>
      use('Could not read the run history', () => readSeconds(db, id)),

    totals: id =>
      use('Could not read the run history', () =>
        (
          db
            .prepare(
              'SELECT data FROM endpoint_totals WHERE run_id = ? ORDER BY endpoint',
            )
            .all(id) as Array<{ readonly data: string }>
        ).map(row => decodeTotal(row.data)),
      ),
  })
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
