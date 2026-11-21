/**
 * COMMAND: the side effects update can ask for.
 *
 * Foldkit idea: a Command is a named Effect that ends in a Message. Every
 * error is caught and turned into a `Failed*` Message, so a failing request
 * becomes data the update function handles instead of a crash.
 */
import { Effect, Option, Schema } from 'effect'
import { Command } from 'foldkit'

import { RunInfo, RunOverrides, Second } from '@mantix/api'

import { MantixClient, describeError } from './api.ts'
import { TIMELINE_HOST_ID, findTimeline } from './charts/store.ts'
import { Message } from './message.ts'

export const LoadTest = Command.define('LoadTest', {
  messages: [Message.SucceededLoadTest, Message.FailedLoadTest],
  execute: Effect.gen(function* () {
    const client = yield* MantixClient
    const test = yield* client.test.get({})
    return Message.SucceededLoadTest({ test })
  }).pipe(
    Effect.catch(error =>
      Effect.succeed(Message.FailedLoadTest({ error: describeError(error) })),
    ),
    Effect.provide(MantixClient.layer),
  ),
})

export const StartRun = Command.define('StartRun', {
  args: { overrides: RunOverrides },
  messages: [Message.SucceededStartRun, Message.FailedStartRun],
  execute: ({ overrides }) =>
    Effect.gen(function* () {
      const client = yield* MantixClient
      const run = yield* client.runs.start({ payload: overrides })
      return Message.SucceededStartRun({ run })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(Message.FailedStartRun({ error: describeError(error) })),
      ),
      Effect.provide(MantixClient.layer),
    ),
})

export const StopRun = Command.define('StopRun', {
  args: { runId: Schema.String },
  messages: [Message.SucceededStopRun, Message.FailedStopRun],
  execute: ({ runId }) =>
    Effect.gen(function* () {
      const client = yield* MantixClient
      const run = yield* client.runs.stop({ params: { id: runId } })
      return Message.SucceededStopRun({ run })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(Message.FailedStopRun({ error: describeError(error) })),
      ),
      Effect.provide(MantixClient.layer),
    ),
})

export const FetchRuns = Command.define('FetchRuns', {
  messages: [Message.SucceededFetchRuns, Message.FailedFetchRuns],
  execute: Effect.gen(function* () {
    const client = yield* MantixClient
    const runs = yield* client.runs.list({})
    return Message.SucceededFetchRuns({ runs })
  }).pipe(
    Effect.catch(error =>
      Effect.succeed(Message.FailedFetchRuns({ error: describeError(error) })),
    ),
    Effect.provide(MantixClient.layer),
  ),
})

/**
 * Hand the latest data to the mounted timeline. The chart keeps its own
 * copy outside the Model; if no timeline is mounted, there is nothing to do.
 */
export const SyncTimeline = Command.define('SyncTimeline', {
  args: { run: RunInfo, seconds: Schema.Array(Second) },
  messages: [Message.CompletedSyncTimeline],
  execute: ({ run, seconds }) =>
    Effect.sync(() => {
      Option.map(findTimeline(TIMELINE_HOST_ID), timeline =>
        timeline.update({ run, seconds }),
      )
      return Message.CompletedSyncTimeline()
    }),
})
