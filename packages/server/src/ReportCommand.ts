/**
 * `mantix report [run]`: write a shareable HTML report of a saved run.
 *
 * The run comes from the run history, so any run made with `mantix run`,
 * `mantix ui` or `mantix dev` can be shared later. With no run id, it is
 * the latest finished run.
 */
import { Console, Effect, Option } from 'effect'
import { Argument, Command, Flag } from 'effect/cli'
import { existsSync } from 'node:fs'

import type { RunInfo } from '@mantix/api'

import {
  defaultReportPath,
  fullFlag,
  reportOf,
  writeReport,
} from './HtmlReport.ts'
import { CliExit } from './RunCommand.ts'
import { RunStore, historyFlags } from './RunStore.ts'

const fail = (message: string) => new CliExit({ code: 1, message })

/** The run asked for, or the newest one that has finished. */
const findRun = Effect.fn('findRun')(function* (
  maybeId: Option.Option<string>,
  historyFile: string,
) {
  const store = yield* RunStore
  const maybeRun: Option.Option<RunInfo> = yield* Option.match(maybeId, {
    onSome: id => store.get(id),
    onNone: () =>
      Effect.map(store.list({ limit: 50 }), runs =>
        Option.fromNullishOr(runs.find(run => run.status !== 'running')),
      ),
  })
  if (Option.isNone(maybeRun)) {
    return yield* fail(
      Option.match(maybeId, {
        onSome: id => `No run ${id} in ${historyFile}.`,
        onNone: () => `No finished runs in ${historyFile} yet.`,
      }),
    )
  }
  const run = maybeRun.value
  if (run.status === 'running') {
    return yield* fail(`Run ${run.id} is still going. Report it once it ends.`)
  }
  return run
})

export const report = Command.make(
  'report',
  {
    run: Argument.String('run').pipe(
      Argument.withDescription(
        'The run id, as the dashboard shows it (default: the latest run)',
      ),
      Argument.optional,
    ),
    output: Flag.String('output').pipe(
      Flag.withAlias('o'),
      Flag.withDescription(
        'Where to write the report (default: .mantix/reports/<test>-<run>.html)',
      ),
      Flag.optional,
    ),
    full: fullFlag,
    historyFile: historyFlags.historyFile,
  },
  Effect.fn('report')(function* (args) {
    const program = Effect.gen(function* () {
      const store = yield* RunStore
      const run = yield* findRun(args.run, args.historyFile)
      const seconds = yield* store.seconds(run.id)
      const path = Option.getOrElse(args.output, () => defaultReportPath(run))
      yield* writeReport(
        path,
        reportOf([{ run, seconds }], args.full ? 'Full' : 'Summary'),
      )
      yield* Console.log(`\n  Report of ${run.testName} · ${run.id}`)
      yield* Console.log(`  Written to ${path}\n`)
    })
    // Opening a missing history would create an empty one: say so instead.
    const checked = existsSync(args.historyFile)
      ? program.pipe(Effect.provide(RunStore.layer(args.historyFile)))
      : Effect.fail(
          fail(
            `No run history at ${args.historyFile}. Run a test first, e.g. mantix run checkout.ts`,
          ),
        )
    // Explain failures in one plain line instead of a stack trace.
    yield* checked.pipe(
      Effect.mapError(error =>
        error._tag === 'CliExit' ? error : fail(error.message),
      ),
      Effect.tapError(error => Console.error(`\n  mantix: ${error.message}\n`)),
    )
  }),
).pipe(Command.withDescription('Write a shareable HTML report of a saved run'))
