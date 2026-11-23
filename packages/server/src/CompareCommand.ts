/**
 * `mantix compare [run] --baseline <run>`: is this run really slower than
 * the baseline, or is the difference just the normal wobble between runs?
 *
 * Both sides come from the run history. A side is one run, or every run of
 * a `mantix run --repeat` group. With no arguments it compares the newest
 * run with the one before it, of the same test.
 *
 * `--fail-on-regression p95:+10%` turns it into a CI gate: exit code 99
 * when an endpoint is confidently slower than the limit. "Unclear" never
 * fails a build.
 */
import { Console, Effect, Option } from 'effect'
import { Argument, Command, Flag } from 'effect/cli'
import { writeFile } from 'node:fs/promises'

import { Compare, type RunInfo } from '@mantix/api'

import {
  type RegressionRule,
  compareReport,
  parseRules,
  regressionsOf,
} from './CompareReport.ts'
import { CliExit } from './RunCommand.ts'
import { RunStore, historyFlags } from './RunStore.ts'

/** How far back to look for runs. */
const HISTORY_LIMIT = 1000

/** A run that ended and can be compared (a crash says nothing about speed). */
const isComparable = (run: RunInfo): boolean =>
  run.status !== 'running' && run.status !== 'crashed'

/**
 * Does `run` match a selector? A selector is a run id (or the start of
 * one), `label:<text>`, `branch:<name>` or `commit:<sha>`.
 */
const matches =
  (selector: string) =>
  (run: RunInfo): boolean => {
    const colon = selector.indexOf(':')
    const kind = colon === -1 ? 'id' : selector.slice(0, colon)
    const value = selector.slice(colon + 1)
    switch (kind) {
      case 'label':
        return run.context?.label === value
      case 'branch':
        return run.context?.git?.branch === value
      case 'commit':
        return run.context?.git?.commit.startsWith(value) ?? false
      default:
        return run.id.startsWith(selector)
    }
  }

/** A run and the rest of its repeat group, newest first. */
const groupOf = (
  runs: ReadonlyArray<RunInfo>,
  run: RunInfo,
): ReadonlyArray<RunInfo> => {
  const group = run.context?.repeat?.group
  return group === undefined
    ? [run]
    : runs.filter(each => each.context?.repeat?.group === group)
}

const fail = (message: string) => Effect.fail(new CliExit({ code: 1, message }))

/** The side's runs, or what went wrong, in a sentence. */
type Side = ReadonlyArray<RunInfo> | string

/** The newest run a selector names (or the newest run), with its group. */
export const pickCurrent = (
  runs: ReadonlyArray<RunInfo>,
  maybeSelector: Option.Option<string>,
): Side =>
  Option.match(maybeSelector, {
    onNone: () =>
      runs[0] === undefined
        ? 'No finished runs in the history yet. Run a test first.'
        : groupOf(runs, runs[0]),
    onSome: selector => {
      const found = runs.find(matches(selector))
      return found === undefined
        ? `No finished run matches "${selector}".`
        : groupOf(runs, found)
    },
  })

/**
 * The baseline: runs of the same test, outside the current side. With a
 * selector, the newest match; without, the newest run before the current
 * one. `maybeCount` takes that many matching runs instead of one group.
 */
export const pickBaseline = (
  runs: ReadonlyArray<RunInfo>,
  current: ReadonlyArray<RunInfo>,
  maybeSelector: Option.Option<string>,
  maybeCount: Option.Option<number>,
): Side => {
  const newest = current[0]!
  const ids = new Set(current.map(run => run.id))
  const candidates = runs.filter(
    run =>
      !ids.has(run.id) &&
      run.testName === newest.testName &&
      Option.match(maybeSelector, {
        onNone: () => run.startedAt < newest.startedAt,
        onSome: selector => matches(selector)(run),
      }),
  )
  const first = candidates[0]
  if (first === undefined) {
    return Option.match(maybeSelector, {
      onNone: () =>
        `No earlier run of ${newest.testName} to compare with. Run it again, or pass --baseline.`,
      onSome: selector =>
        `No other run of ${newest.testName} matches "${selector}".`,
    })
  }
  return Option.match(maybeCount, {
    onNone: () => groupOf(candidates, first),
    onSome: count => candidates.slice(0, count),
  })
}

const orFail = (side: Side) =>
  typeof side === 'string' ? fail(side) : Effect.succeed(side)

const writeJson = (path: string, value: unknown) =>
  Effect.tryPromise({
    try: () => writeFile(path, `${JSON.stringify(value, null, 2)}\n`),
    catch: error =>
      new CliExit({
        code: 1,
        message: `Could not write ${path}: ${String(error)}`,
      }),
  })

export const compare = Command.make(
  'compare',
  {
    run: Argument.String('run').pipe(
      Argument.withDescription(
        'The run to judge: an id, label:<text>, branch:<name> or commit:<sha> (default: the newest run)',
      ),
      Argument.optional,
    ),
    baseline: Flag.String('baseline').pipe(
      Flag.withDescription(
        'What to compare against, picked the same way (default: the run before)',
      ),
      Flag.optional,
    ),
    baselineRuns: Flag.Int('baseline-runs').pipe(
      Flag.withDescription(
        'Use the newest N matching runs as the baseline, e.g. --baseline branch:main --baseline-runs 5',
      ),
      Flag.optional,
    ),
    failOnRegression: Flag.String('fail-on-regression').pipe(
      Flag.withDescription(
        'Exit with code 99 when an endpoint is confidently worse than this, e.g. p95:+10%,errors:+0.5%',
      ),
      Flag.optional,
    ),
    band: Flag.Finite('band').pipe(
      Flag.withDescription(
        'Latency changes smaller than this percent count as the same (default 5)',
      ),
      Flag.withDefault(Compare.DEFAULT_BAND * 100),
    ),
    json: Flag.String('json').pipe(
      Flag.withDescription('Write the comparison to this file as JSON'),
      Flag.optional,
    ),
    ...historyFlags,
  },
  Effect.fn('compare')(function* (args) {
    const program = Effect.gen(function* () {
      const rules: ReadonlyArray<RegressionRule> = yield* Option.match(
        args.failOnRegression,
        {
          onNone: () => Effect.succeed([]),
          onSome: text => {
            const parsed = parseRules(text)
            return typeof parsed === 'string'
              ? fail(parsed)
              : Effect.succeed(parsed)
          },
        },
      )
      if (!(args.band > 0 && args.band < 100)) {
        return yield* fail('--band is a percent between 0 and 100, e.g. 5.')
      }
      if (Option.exists(args.baselineRuns, count => count < 1)) {
        return yield* fail('--baseline-runs must be 1 or more.')
      }

      const store = yield* RunStore
      const runs = (yield* store.list({ limit: HISTORY_LIMIT })).filter(
        isComparable,
      )
      const current = yield* orFail(pickCurrent(runs, args.run))
      const baseline = yield* orFail(
        pickBaseline(runs, current, args.baseline, args.baselineRuns),
      )
      const secondsOf = (side: ReadonlyArray<RunInfo>) =>
        Effect.forEach(side, run => store.seconds(run.id))
      const comparison = Compare.compareRuns(
        yield* secondsOf(baseline),
        yield* secondsOf(current),
        { band: args.band / 100 },
      )
      const warnings = Compare.warnings(baseline, current)
      const regressions = regressionsOf(comparison, rules)

      yield* Console.log(
        compareReport({
          baseline,
          current,
          comparison,
          warnings,
          rules,
          regressions,
        }),
      )
      if (Option.isSome(args.json)) {
        yield* writeJson(args.json.value, {
          version: 1,
          baseline: baseline.map(run => run.id),
          current: current.map(run => run.id),
          warnings,
          comparison,
          regressions,
        })
        yield* Console.log(`  Comparison written to ${args.json.value}\n`)
      }
      if (regressions.length > 0) {
        return yield* new CliExit({ code: 99, message: 'regression' })
      }
    }).pipe(
      Effect.mapError(error =>
        error instanceof CliExit
          ? error
          : new CliExit({ code: 1, message: error.message }),
      ),
      Effect.provide(
        RunStore.forCli({ enabled: args.history, file: args.historyFile }),
      ),
    )
    // Explain failures in one plain line instead of a stack trace.
    yield* program.pipe(
      Effect.tapError(error =>
        error.code === 99
          ? Effect.void
          : Console.error(`\n  mantix: ${error.message}\n`),
      ),
    )
  }),
).pipe(
  Command.withDescription(
    'Compare a run with a baseline: slower, faster, the same, or unclear',
  ),
)
