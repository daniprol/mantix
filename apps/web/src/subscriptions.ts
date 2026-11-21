/**
 * SUBSCRIPTION: streams of Messages that run while the Model says so.
 *
 * Foldkit idea: a Subscription maps the Model to "dependencies". While they
 * stay the same, the stream keeps running; when they change, Foldkit stops
 * the old stream (running its cleanup) and starts a new one. So the live
 * feed starts when a run appears, stops when we stop following it, and
 * restarts when "Reconnect" bumps `connection`. No manual bookkeeping.
 */
import { Effect, Option, Schema, Stream } from 'effect'
import { Subscription } from 'foldkit'

import type { RunEvent } from '@mantix/api'

import { MantixClient, describeError } from './api.ts'
import { Message } from './message.ts'
import type { Model } from './model.ts'

const toMessage = (event: RunEvent): Message =>
  event._tag === 'Second'
    ? Message.ReceivedSecond({ second: event.second })
    : Message.ReceivedRunUpdate({ run: event.run })

/**
 * The run's Server-Sent Events, through the typed client: it replays every
 * Second so far, follows live ones, and ends when the run is over.
 */
const followRun = (runId: string): Stream.Stream<Message> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const client = yield* MantixClient
      return yield* client.runs.events({ params: { id: runId } })
    }),
  ).pipe(
    Stream.map(toMessage),
    Stream.concat(Stream.make(Message.CompletedFollowRun())),
    Stream.catch(error =>
      Stream.make(Message.FailedFollowRun({ error: describeError(error) })),
    ),
    Stream.provide(MantixClient.layer),
  )

/** Enter anywhere on the page, except where Enter already means something. */
const isPlainEnter = (event: KeyboardEvent): boolean =>
  event.key === 'Enter' &&
  !event.repeat &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.altKey &&
  !(
    event.target instanceof HTMLElement &&
    event.target.closest('button, a, summary, textarea, [role="button"]') !==
      null
  )

export const subscriptions = Subscription.make<Model, Message>()(entry => ({
  runEvents: entry(
    { maybeRunId: Schema.Option(Schema.String), connection: Schema.Finite },
    {
      modelToDependencies: model =>
        model.runState._tag === 'Watching' &&
        model.runState.feed._tag === 'Following'
          ? {
              maybeRunId: Option.some(model.runState.run.id),
              connection: model.runState.connection,
            }
          : { maybeRunId: Option.none(), connection: 0 },
      dependenciesToStream: ({ maybeRunId }) =>
        Option.match(maybeRunId, {
          onNone: () => Stream.empty,
          onSome: followRun,
        }),
    },
  ),

  enterToStart: entry(
    { isReady: Schema.Boolean },
    {
      modelToDependencies: model => ({
        isReady:
          model.test._tag === 'Loaded' && model.runState._tag === 'NoRun',
      }),
      dependenciesToStream: ({ isReady }) =>
        isReady
          ? Stream.fromEventListener<KeyboardEvent>(document, 'keydown').pipe(
              Stream.filter(isPlainEnter),
              Stream.map(() => Message.PressedEnter()),
            )
          : Stream.empty,
    },
  ),
}))
