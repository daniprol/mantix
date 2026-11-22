/**
 * `mantix dev <file>`: the dashboard, plus a watcher that lets you test
 * your test.
 *
 * It starts the same server as `mantix ui`. Then, every time you save the
 * test file (or any file in its folder), it reloads the test, runs one
 * traced iteration of each scenario, and prints the result as a small
 * waterfall, with any errors in plain words. The dashboard can follow the
 * same results on /api/dev/events. Start a full run from the dashboard
 * whenever you're ready; it uses the latest code.
 */
import { Console, Effect, Layer, Option, Queue, Result, Stream } from 'effect'
import { Argument, Command, Flag } from 'effect/cli'
import { watch } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'

import type { ProbeResult, TestInfo } from '@mantix/api'
import { type TestDefinition, probe, testInfo } from '@mantix/core'

import { DevEvents } from './DevEvents.ts'
import { probeReport } from './DevReport.ts'
import { enableFreshImports, freshUrl } from './FreshImport.ts'
import { CliExit, loadTest } from './RunCommand.ts'
import { labelFlag } from './RunContext.ts'
import { RunStore, historyFlags } from './RunStore.ts'
import { Runs } from './Runs.ts'
import { findWebRoot, serverLayer } from './Server.ts'
import { describeServeError } from './UiCommand.ts'

/** Files whose changes trigger a reload. */
const WATCHED = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'])

/**
 * Changed file names under `root`, as a Stream. `Stream.callback` turns
 * the callback-based fs.watch into a stream; closing the stream's scope
 * closes the watcher.
 */
const changes = (root: string): Stream.Stream<string> =>
  Stream.callback<string>(queue =>
    Effect.acquireRelease(
      Effect.sync(() =>
        watch(root, { recursive: true }, (_event, name) => {
          if (name === null) return
          const path = String(name)
          const ignored =
            path
              .split(/[\\/]/)
              .some(p => p === 'node_modules' || p.startsWith('.')) ||
            !WATCHED.has(extname(path))
          if (!ignored) Queue.offerUnsafe(queue, path)
        }),
      ),
      watcher => Effect.sync(() => watcher.close()),
    ),
  )

/** The watcher, as a Layer that runs in the background next to the server. */
const watcherLayer = (file: string, first: TestDefinition) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const runs = yield* Runs
      const dev = yield* DevEvents
      const root = dirname(resolve(file))
      let version = 0

      // One traced iteration per scenario, printed and published.
      const probeAndReport = Effect.fn('dev.probe')(function* (
        definition: TestDefinition,
        info: TestInfo,
      ) {
        const results: ReadonlyArray<ProbeResult> = yield* probe(
          definition,
        ).pipe(
          // reload() already checked the file, so this cannot fail.
          Effect.orDie,
        )
        for (const result of results) {
          yield* Console.log(`${probeReport(file, result)}\n`)
        }
        yield* dev.publish({ _tag: 'Reloaded', test: info, results })
      })

      const failed = (message: string) =>
        Effect.andThen(
          Console.log(
            `  ✗ ${message}\n    (keeping the last version that worked)\n`,
          ),
          dev.publish({ _tag: 'ReloadFailed', message }),
        )

      // Load the new version; on any error keep the old one.
      const reload = Effect.gen(function* () {
        version++
        const loaded = yield* Effect.result(
          loadTest(file, freshUrl(file, version)),
        )
        if (Result.isFailure(loaded))
          return yield* failed(loaded.failure.message)
        const info = yield* Effect.result(runs.reload(loaded.success))
        if (Result.isFailure(info)) {
          return yield* failed(`${file}: ${info.failure.message}`)
        }
        yield* probeAndReport(loaded.success, info.success)
      })

      // The first trace straight away, then one per save. `debounce`
      // waits for saving to settle (editors often write a file twice).
      const loop = Effect.gen(function* () {
        yield* probeAndReport(first, yield* runs.test)
        yield* changes(root).pipe(
          Stream.debounce('200 millis'),
          Stream.runForEach(() => reload),
        )
      })
      // forkScoped: the loop lives as long as the server does.
      yield* Effect.forkScoped(loop)
    }),
  )

export const dev = Command.make(
  'dev',
  {
    file: Argument.String('file').pipe(
      Argument.withDescription('The test file, e.g. examples/checkout.ts'),
    ),
    port: Flag.Int('port').pipe(
      Flag.withDescription('Port for the dashboard'),
      Flag.withDefault(4100),
    ),
    label: labelFlag,
    ...historyFlags,
  },
  Effect.fn('dev')(
    function* (args) {
      // Must happen before the first import of the test file.
      enableFreshImports(dirname(resolve(args.file)))
      const test = yield* loadTest(args.file, freshUrl(args.file, 0))
      yield* Effect.try({
        try: () => testInfo(test, args.file),
        catch: error =>
          new CliExit({
            code: 1,
            message: error instanceof Error ? error.message : String(error),
          }),
      })
      const url = `http://localhost:${args.port}`
      // Both the server and the watcher use these, so they are provided
      // once: Layer.provide builds each service a single time.
      const services = Layer.mergeAll(
        Runs.layer(test, args.file, {
          label: Option.getOrUndefined(args.label),
        }),
        DevEvents.layer,
      ).pipe(
        // Runs started from the dev dashboard are saved like any other.
        Layer.provide(
          RunStore.forCli({ enabled: args.history, file: args.historyFile }),
        ),
      )
      const app = Layer.mergeAll(
        serverLayer({ port: args.port, webRoot: findWebRoot() }),
        watcherLayer(args.file, test),
      ).pipe(Layer.provide(services))

      yield* Console.log(
        `\n  mantix dev · dashboard at ${url}\n  Watching ${dirname(args.file)}/ · save to run one traced iteration · Ctrl-C to stop\n`,
      )
      return yield* Layer.launch(app).pipe(
        Effect.mapError(
          error =>
            new CliExit({
              code: 1,
              message: describeServeError(error, args.port),
            }),
        ),
      )
    },
    Effect.tapError(error => Console.error(`\n  mantix: ${error.message}\n`)),
  ),
).pipe(
  Command.withDescription(
    'Open the dashboard and run one traced iteration every time you save',
  ),
)
