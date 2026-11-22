/**
 * The runs behind `mantix ui`: the one going now, and every earlier one.
 *
 * A Context.Service: the HTTP handlers ask for `Runs` and Effect hands them
 * the one instance built by `Runs.layer`. Runs started by this server are
 * kept in memory while it runs (that is where live data comes from), and
 * every run is also saved to the RunStore, so runs from earlier sessions,
 * and from `mantix run`, can be opened too.
 */
import { Context, Effect, Layer, Option, Ref, Scope, Stream } from 'effect'

import {
  RunAlreadyActive,
  type RunEvent,
  type RunInfo,
  RunNotFound,
  type RunOverrides,
  type Second,
  type TestInfo,
} from '@mantix/api'
import {
  InvalidTest,
  type RunHandle,
  type TestDefinition,
  testInfo,
} from '@mantix/core'

import { historyName, startRecordedRun } from './History.ts'
import { RunStore } from './RunStore.ts'

export class Runs extends Context.Service<
  Runs,
  {
    /** The test file this server was started with. */
    readonly test: TestInfo
    /** Start a run. Fails if one is still going. */
    readonly start: (
      overrides: RunOverrides,
    ) => Effect.Effect<RunInfo, RunAlreadyActive | InvalidTest>
    /** Runs of this test file, newest first, from the history. */
    readonly list: (limit?: number) => Effect.Effect<ReadonlyArray<RunInfo>>
    readonly get: (id: string) => Effect.Effect<RunInfo, RunNotFound>
    /** Stop a run early and wait until teardown has finished. */
    readonly stop: (id: string) => Effect.Effect<RunInfo, RunNotFound>
    /** Every Second of a run so far. */
    readonly seconds: (
      id: string,
    ) => Effect.Effect<ReadonlyArray<Second>, RunNotFound>
    /**
     * Replays the run so far, then follows it live until it ends. A run
     * from the history is replayed and the stream ends straight away.
     */
    readonly events: (
      id: string,
    ) => Effect.Effect<Stream.Stream<RunEvent>, RunNotFound>
  }
>()('mantix/server/Runs') {
  static readonly layer = (test: TestDefinition, file: string) =>
    Layer.effect(
      Runs,
      Effect.gen(function* () {
        // Validate the test once, up front, so a typo fails at startup.
        const info = testInfo(test, file)
        const store = yield* RunStore

        // The layer's own scope: it closes when the server shuts down
        // (Ctrl-C), which stops any run still going and runs its teardown.
        const serverScope = yield* Effect.scope
        // Runs started by this server, newest first.
        const handles = yield* Ref.make<ReadonlyArray<RunHandle>>([])

        const live = (id: string) =>
          Effect.map(Ref.get(handles), list =>
            Option.fromNullishOr(list.find(handle => handle.id === id)),
          )

        // Reading the history should not fail; if it does (a corrupt
        // file), orDie turns it into a 500 with the reason in the log.
        const stored = (id: string) =>
          store.get(id).pipe(
            Effect.orDie,
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new RunNotFound({ id })),
                onSome: Effect.succeed,
              }),
            ),
          )

        /** A live run's handle, or the saved run if it is not live. */
        const find = Effect.fn('Runs.find')(function* (
          id: string,
        ): Effect.fn.Return<Found, RunNotFound> {
          const found = yield* live(id)
          if (Option.isSome(found)) {
            return { _tag: 'Live', handle: found.value }
          }
          return { _tag: 'Stored', run: yield* stored(id) }
        })

        const start = Effect.fn('Runs.start')(function* (
          overrides: RunOverrides,
        ) {
          const list = yield* Ref.get(handles)
          const latest = list[0]
          if (latest !== undefined) {
            const current = yield* latest.info
            if (current.status === 'running') {
              return yield* new RunAlreadyActive({ id: current.id })
            }
          }
          // Each run gets a child of the server scope, so it keeps running
          // after this request has been answered.
          const runScope = yield* Scope.fork(serverScope)
          const handle = yield* startRecordedRun(test, {
            file,
            overrides,
          }).pipe(
            Scope.provide(runScope),
            Effect.provideService(RunStore, store),
          )
          yield* Ref.update(handles, all => [handle, ...all])
          return yield* handle.info
        })

        const list = Effect.fn('Runs.list')(function* (limit?: number) {
          const saved = yield* store
            .list({ file: historyName(file), limit })
            .pipe(Effect.orDie)
          // The history is written once per second; for runs of this
          // session, answer with the in-memory info, which is never behind.
          const current = yield* Ref.get(handles)
          return yield* Effect.forEach(saved, run =>
            Option.match(
              Option.fromNullishOr(current.find(h => h.id === run.id)),
              { onNone: () => Effect.succeed(run), onSome: h => h.info },
            ),
          )
        })

        return Runs.of({
          test: info,
          start,
          list,
          get: id =>
            Effect.flatMap(find(id), found =>
              found._tag === 'Live'
                ? found.handle.info
                : Effect.succeed(found.run),
            ),
          // A saved run that is not live is already over: nothing to stop.
          stop: id =>
            Effect.flatMap(find(id), found =>
              found._tag === 'Live'
                ? Effect.andThen(found.handle.stop, found.handle.info)
                : Effect.succeed(found.run),
            ),
          seconds: id =>
            Effect.flatMap(find(id), found =>
              found._tag === 'Live'
                ? Effect.map(found.handle.snapshot, result => result.seconds)
                : Effect.orDie(store.seconds(id)),
            ),
          events: id =>
            Effect.flatMap(find(id), found =>
              found._tag === 'Live'
                ? Effect.succeed(found.handle.events)
                : Effect.map(Effect.orDie(store.seconds(id)), seconds =>
                    replay(found.run, seconds),
                  ),
            ),
        })
      }),
    )
}

/** Where a run was found: running in this server, or only in the history. */
type Found =
  | { readonly _tag: 'Live'; readonly handle: RunHandle }
  | { readonly _tag: 'Stored'; readonly run: RunInfo }

/** The events of a run that is over: every Second, then its final info. */
const replay = (
  run: RunInfo,
  seconds: ReadonlyArray<Second>,
): Stream.Stream<RunEvent> =>
  Stream.fromIterable<RunEvent>([
    ...seconds.map(second => ({ _tag: 'Second' as const, second })),
    { _tag: 'RunUpdated' as const, run },
  ])
