/**
 * SUBSCRIPTION: streams of Messages that run while the Model says so.
 *
 * Foldkit idea: a Subscription maps the Model to "dependencies". While they
 * stay the same, the stream keeps running; when they change, Foldkit stops
 * the old stream (running its cleanup) and starts a new one. So the live
 * feed starts when a live run is loaded, keeps going while you move between
 * pages, stops when the run ends, and restarts when "Reconnect" bumps
 * `connection`. No manual bookkeeping.
 */
import { Array, Effect, Option, Record, Schema, Stream } from 'effect'
import { Subscription } from 'foldkit'

import type { RunEvent } from '@mantix/api'

import { MantixClient, describeError } from './api.ts'
import { Message } from './message.ts'
import type { LoadedRun, Model } from './model.ts'

const toMessage =
  (runId: string) =>
  (event: RunEvent): Message =>
    event._tag === 'Second'
      ? Message.ReceivedSecond({ runId, second: event.second })
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
    Stream.map(toMessage(runId)),
    Stream.concat(Stream.make(Message.CompletedFollowRun({ runId }))),
    Stream.catch(error =>
      Stream.make(
        Message.FailedFollowRun({ runId, error: describeError(error) }),
      ),
    ),
    Stream.provide(MantixClient.layer),
  )

/** The run whose stream to follow: the server runs one at a time. */
const followed = (model: Model): Option.Option<LoadedRun> =>
  Array.findFirst(Record.values(model.runs), data =>
    data._tag === 'Loaded' && data.feed._tag === 'Following'
      ? Option.some(data)
      : Option.none(),
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
    event.target.closest(
      'button, a, summary, select, textarea, [role="button"]',
    ) !== null
  )

export const subscriptions = Subscription.make<Model, Message>()(entry => ({
  runEvents: entry(
    { maybeRunId: Schema.Option(Schema.String), connection: Schema.Finite },
    {
      modelToDependencies: model =>
        Option.match(followed(model), {
          onNone: () => ({ maybeRunId: Option.none(), connection: 0 }),
          onSome: live => ({
            maybeRunId: Option.some(live.run.id),
            connection: live.connection,
          }),
        }),
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
          model.test._tag === 'Loaded' &&
          model.route._tag === 'NewRun' &&
          model.launch._tag === 'Idle',
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
