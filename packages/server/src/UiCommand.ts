/**
 * `mantix ui <file>`: start the local dashboard for a test file.
 *
 * One process runs both the HTTP server and the engine. Press Start in the
 * browser and the run streams to the page one Second at a time.
 */
import { Console, Effect, Layer } from 'effect'
import { Argument, Command, Flag } from 'effect/cli'

import { testInfo } from '@mantix/core'

import { DevEvents } from './DevEvents.ts'
import { CliExit, loadTest } from './RunCommand.ts'
import { RunStore, historyFlags } from './RunStore.ts'
import { Runs } from './Runs.ts'
import { findWebRoot, serverLayer } from './Server.ts'

export const describeServeError = (error: unknown, port: number): string => {
  const cause =
    error instanceof Error && error.cause instanceof Error ? error.cause : error
  if (
    cause instanceof Error &&
    'code' in cause &&
    cause.code === 'EADDRINUSE'
  ) {
    return `Port ${port} is already in use. Stop the other process or pass --port ${port + 1}.`
  }
  return cause instanceof Error ? cause.message : String(cause)
}

export const ui = Command.make(
  'ui',
  {
    file: Argument.String('file').pipe(
      Argument.withDescription('The test file, e.g. examples/checkout.ts'),
    ),
    port: Flag.Int('port').pipe(
      Flag.withDescription('Port for the dashboard'),
      Flag.withDefault(4100),
    ),
    ...historyFlags,
  },
  Effect.fn('ui')(
    function* (args) {
      const test = yield* loadTest(args.file)
      // Read the test once up front, so a typo fails here with a clear
      // message instead of when someone presses Start.
      yield* Effect.try({
        try: () => testInfo(test, args.file),
        catch: error =>
          new CliExit({
            code: 1,
            message: error instanceof Error ? error.message : String(error),
          }),
      })
      const webRoot = findWebRoot()
      const url = `http://localhost:${args.port}`

      const app = serverLayer({ port: args.port, webRoot }).pipe(
        Layer.provide([Runs.layer(test, args.file), DevEvents.idle]),
        // Every run is saved, so earlier runs can be opened after a restart.
        Layer.provide(
          RunStore.forCli({ enabled: args.history, file: args.historyFile }),
        ),
      )

      yield* Console.log(
        `\n  mantix · dashboard at ${url}\n  Press Ctrl-C to stop.\n`,
      )
      // Layer.launch builds the server and keeps it running until Ctrl-C,
      // which closes every scope: running load stops and teardown runs.
      return yield* Layer.launch(app).pipe(
        // Turn "address in use" and friends into one plain sentence.
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
).pipe(Command.withDescription('Open the live dashboard for a test file'))
