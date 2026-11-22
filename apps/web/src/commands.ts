/**
 * COMMAND: the side effects update can ask for.
 *
 * Foldkit idea: a Command is a named Effect that ends in a Message. Every
 * error is caught and turned into a `Failed*` Message, so a failing request
 * becomes data the update function handles instead of a crash.
 */
import { Effect, Option, Schema } from 'effect'
import { Command } from 'foldkit'
import { load, pushUrl } from 'foldkit/navigation'

import { RunOverrides } from '@mantix/api'

import { MantixClient, describeError } from './api.ts'
import {
  TIMELINE_HOST_ID,
  TimelineInput,
  findTimeline,
} from './charts/store.ts'
import { Message } from './message.ts'
import { Theme, applyTheme } from './theme.ts'

export const NavigateInternal = Command.define('NavigateInternal', {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigate],
  execute: ({ url }) =>
    pushUrl(url).pipe(Effect.as(Message.CompletedNavigate())),
})

export const LoadExternal = Command.define('LoadExternal', {
  args: { href: Schema.String },
  messages: [Message.CompletedNavigate],
  execute: ({ href }) =>
    load(href).pipe(Effect.as(Message.CompletedNavigate())),
})

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

export const FetchHistory = Command.define('FetchHistory', {
  messages: [Message.SucceededFetchHistory, Message.FailedFetchHistory],
  execute: Effect.gen(function* () {
    const client = yield* MantixClient
    const runs = yield* client.runs.list({ query: {} })
    return Message.SucceededFetchHistory({ runs })
  }).pipe(
    Effect.catch(error =>
      Effect.succeed(
        Message.FailedFetchHistory({ error: describeError(error) }),
      ),
    ),
    Effect.provide(MantixClient.layer),
  ),
})

/**
 * A run and every Second it has so far. A finished run never changes, so
 * this happens once; a live run then follows its stream (subscriptions.ts).
 */
export const LoadRun = Command.define('LoadRun', {
  args: { runId: Schema.String },
  messages: [Message.SucceededLoadRun, Message.FailedLoadRun],
  execute: ({ runId }) =>
    Effect.gen(function* () {
      const client = yield* MantixClient
      const [run, seconds] = yield* Effect.all(
        [
          client.runs.get({ params: { id: runId } }),
          client.runs.seconds({ params: { id: runId } }),
        ],
        { concurrency: 2 },
      )
      return Message.SucceededLoadRun({ run, seconds })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedLoadRun({ runId, error: describeError(error) }),
        ),
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

/**
 * Hand the latest data to the mounted timeline. The chart keeps its own
 * copy outside the Model; if no timeline is mounted, there is nothing to do.
 */
export const SyncTimeline = Command.define('SyncTimeline', {
  args: { input: TimelineInput },
  messages: [Message.CompletedSyncTimeline],
  execute: ({ input }) =>
    Effect.sync(() => {
      Option.map(findTimeline(TIMELINE_HOST_ID), timeline =>
        timeline.update(input),
      )
      return Message.CompletedSyncTimeline()
    }),
})

/** Switch the page to a theme and remember the choice. */
export const ApplyTheme = Command.define('ApplyTheme', {
  args: { theme: Theme },
  messages: [Message.CompletedApplyTheme],
  execute: ({ theme }) =>
    applyTheme(theme).pipe(Effect.as(Message.CompletedApplyTheme())),
})
