/**
 * What `mantix dev` tells the dashboard: one DevEvent per save.
 *
 * A SubscriptionRef holds the latest event. Its `changes` stream starts
 * with the current value, so a dashboard that opens late still gets the
 * last result straight away, then every new one.
 */
import { Context, Effect, Layer, Stream, SubscriptionRef } from 'effect'

import type { DevEvent } from '@mantix/api'

export class DevEvents extends Context.Service<
  DevEvents,
  {
    /** The latest event (if any), then every new one. Never ends. */
    readonly events: Stream.Stream<DevEvent>
    readonly publish: (event: DevEvent) => Effect.Effect<void>
  }
>()('mantix/server/DevEvents') {
  /** For `mantix dev`. */
  static readonly layer = Layer.effect(
    DevEvents,
    Effect.gen(function* () {
      const latest = yield* SubscriptionRef.make<DevEvent | undefined>(
        undefined,
      )
      return DevEvents.of({
        events: SubscriptionRef.changes(latest).pipe(
          Stream.filter(event => event !== undefined),
        ),
        publish: event => SubscriptionRef.set(latest, event),
      })
    }),
  )

  /** For `mantix ui`: there is no watcher, so the stream stays quiet. */
  static readonly idle = Layer.succeed(DevEvents)({
    events: Stream.never,
    publish: () => Effect.void,
  })
}
