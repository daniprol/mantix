/**
 * `mantix run <file>`: run a test headless, print progress and a summary,
 * and exit with a code CI can act on (0 pass, 99 threshold failed, 1 crash
 * or bad input; the same codes as k6).
 *
 * Built with `effect/cli`: flags and arguments are declared once, and the
 * handler receives them parsed and typed.
 */

import { Console, Data, Effect, Option, Runtime, Stream } from 'effect'
import { Argument, Command, Flag } from 'effect/cli'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { type RunOverrides, summarizeRun } from '@mantix/api'
import {
  type RunHandle,
  type RunResult,
  type TestDefinition,
  parseDuration,
} from '@mantix/core'

import { startRecordedRun } from './History.ts'
import { passed, secondLine, summaryReport } from './Report.ts'
import { RunStore, historyFlags } from './RunStore.ts'

/**
 * A failure we already explained to the person. The two markers tell
 * `NodeRuntime.runMain` which exit code to use and not to print it again.
 */
export class CliExit extends Data.TaggedError('CliExit')<{
  readonly code: number
  readonly message: string
}> {
  override get [Runtime.errorExitCode](): number {
    return this.code
  }
  // `false` means "do not log this error for me": we already printed it.
  override get [Runtime.errorReported](): boolean {
    return false
  }
}

/** Load a test file and return its default export. */
export const loadTest = (file: string) =>
  Effect.tryPromise({
    // Node runs TypeScript test files directly (type stripping).
    try: () =>
      import(pathToFileURL(resolve(file)).href) as Promise<{
        readonly default?: TestDefinition
      }>,
    catch: error =>
      new CliExit({
        code: 1,
        message: `Could not load ${file}: ${error instanceof Error ? error.message : String(error)}`,
      }),
  }).pipe(
    Effect.flatMap(module =>
      module.default === undefined
        ? Effect.fail(
            new CliExit({
              code: 1,
              message: `${file} has no default export. Add \`export default scenario({...})\`.`,
            }),
          )
        : Effect.succeed(module.default),
    ),
  )

const parseOverrides = (flags: {
  readonly rate: Option.Option<number>
  readonly vus: Option.Option<number>
  readonly duration: Option.Option<string>
}) =>
  Effect.try({
    try: (): RunOverrides => {
      if (Option.isSome(flags.rate) && Option.isSome(flags.vus)) {
        throw new Error('Use --rate or --vus, not both.')
      }
      return {
        ...(Option.isSome(flags.rate) ? { rate: flags.rate.value } : {}),
        ...(Option.isSome(flags.vus) ? { vus: flags.vus.value } : {}),
        ...(Option.isSome(flags.duration)
          ? { duration: parseDuration(flags.duration.value) }
          : {}),
      }
    },
    catch: error =>
      new CliExit({
        code: 1,
        message: error instanceof Error ? error.message : String(error),
      }),
  })

/** Print the summary, write the JSON file, and decide the exit code. */
const finish = Effect.fn('finish')(function* (
  result: RunResult,
  jsonPath: Option.Option<string>,
) {
  const summary = summarizeRun(result.info, result.seconds)
  yield* Console.log(summaryReport(summary, result.seconds))
  if (Option.isSome(jsonPath)) {
    const path = jsonPath.value
    yield* Effect.tryPromise({
      try: () => writeFile(path, `${JSON.stringify(summary, null, 2)}\n`),
      catch: error =>
        new CliExit({
          code: 1,
          message: `Could not write ${path}: ${String(error)}`,
        }),
    })
    yield* Console.log(`  Summary written to ${path}\n`)
  }
  if (result.info.status === 'crashed') {
    return yield* new CliExit({ code: 1, message: result.info.error ?? '' })
  }
  if (!passed(result.info)) {
    return yield* new CliExit({ code: 99, message: 'thresholds failed' })
  }
})

const run = Command.make(
  'run',
  {
    file: Argument.String('file').pipe(
      Argument.withDescription('The test file, e.g. examples/quick.ts'),
    ),
    rate: Flag.Finite('rate').pipe(
      Flag.withDescription(
        'Constant arrival rate (iterations/s); replaces the load plan',
      ),
      Flag.optional,
    ),
    vus: Flag.Int('vus').pipe(
      Flag.withDescription(
        'Constant number of virtual users; replaces the load plan',
      ),
      Flag.optional,
    ),
    duration: Flag.String('duration').pipe(
      Flag.withDescription('How long to run, e.g. 30s or 2m'),
      Flag.optional,
    ),
    json: Flag.String('json').pipe(
      Flag.withDescription('Write a JSON summary to this file'),
      Flag.optional,
    ),
    quiet: Flag.Boolean('quiet').pipe(
      Flag.withAlias('q'),
      Flag.withDescription('Only print the final summary'),
      Flag.withDefault(false),
    ),
    ...historyFlags,
  },
  Effect.fn('run')(function* (args) {
    const program = Effect.gen(function* () {
      const overrides = yield* parseOverrides(args)
      const test = yield* loadTest(args.file)

      // Remember the handle so a Ctrl-C can still print the summary.
      let handle: RunHandle | undefined
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          // startRecordedRun also saves the run to the history, so it can
          // be opened in `mantix ui` and compared later.
          handle = yield* startRecordedRun(test, {
            file: args.file,
            overrides,
          }).pipe(
            Effect.mapError(e => new CliExit({ code: 1, message: e.message })),
          )
          const info = yield* handle.info
          const models = new Set(info.plan.map(s => s.plan.model))
          const model = models.size === 1 ? [...models][0]! : 'mixed'
          yield* Console.log(
            `\n  mantix · ${info.testName} · ${info.duration} s planned${args.quiet ? '' : '\n'}`,
          )
          if (!args.quiet) {
            // `events` replays and then follows the run, ending with it.
            yield* handle.events.pipe(
              Stream.runForEach(event =>
                event._tag === 'Second'
                  ? Console.log(secondLine(event.second, model))
                  : Effect.void,
              ),
            )
          }
          return yield* handle.await
        }),
      ).pipe(
        // Ctrl-C interrupts us. By the time this runs, the run's scope has
        // closed: teardown has run and the status says "stopped".
        Effect.onInterrupt(() =>
          handle === undefined
            ? Effect.void
            : Effect.flatMap(handle.snapshot, snapshot =>
                Effect.ignore(finish(snapshot, args.json)),
              ),
        ),
      )
      yield* finish(result, args.json)
    }).pipe(
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
).pipe(Command.withDescription('Run a test file headless and print a summary'))

export { run }
