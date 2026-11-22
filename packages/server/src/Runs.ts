/**
 * The runs of one `mantix ui` session.
 *
 * A Context.Service: the HTTP handlers ask for `Runs` and Effect hands them
 * the one instance built by `Runs.layer`. Runs live in memory for as long
 * as the server does, so the dashboard can reopen any earlier run.
 */
import { Context, Effect, Layer, Option, Ref, Scope, Stream } from 'effect'

import {
  type Control,
  type InvalidControl,
  type JournalEntry,
  RunAlreadyActive,
  type RunEvent,
  type RunInfo,
  RunNotFound,
  type RunOverrides,
  type TestInfo,
} from '@mantix/api'
import {
  InvalidTest,
  type RunHandle,
  type TestDefinition,
  startRun,
  testInfo,
} from '@mantix/core'

export class Runs extends Context.Service<
  Runs,
  {
    /** The test file this server was started with. */
    readonly test: TestInfo
    /** Start a run. Fails if one is still going. */
    readonly start: (
      overrides: RunOverrides,
    ) => Effect.Effect<RunInfo, RunAlreadyActive | InvalidTest>
    /** Every run so far, newest first. */
    readonly list: Effect.Effect<ReadonlyArray<RunInfo>>
    readonly get: (id: string) => Effect.Effect<RunInfo, RunNotFound>
    /** Steer a running run; the control is added to its journal. */
    readonly control: (
      id: string,
      control: Control,
    ) => Effect.Effect<JournalEntry, RunNotFound | InvalidControl>
    /** Stop a run early and wait until teardown has finished. */
    readonly stop: (id: string) => Effect.Effect<RunInfo, RunNotFound>
    /** Replays the run so far, then follows it live until it ends. */
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

        // The layer's own scope: it closes when the server shuts down
        // (Ctrl-C), which stops any run still going and runs its teardown.
        const serverScope = yield* Effect.scope
        // Newest first.
        const handles = yield* Ref.make<ReadonlyArray<RunHandle>>([])

        const find = (id: string) =>
          Effect.flatMap(Ref.get(handles), list =>
            Option.match(
              Option.fromNullishOr(list.find(handle => handle.id === id)),
              {
                onNone: () => Effect.fail(new RunNotFound({ id })),
                onSome: Effect.succeed,
              },
            ),
          )

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
          const handle = yield* startRun(test, { file, overrides }).pipe(
            Scope.provide(runScope),
          )
          yield* Ref.update(handles, all => [handle, ...all])
          return yield* handle.info
        })

        return Runs.of({
          test: info,
          start,
          list: Effect.flatMap(Ref.get(handles), list =>
            Effect.forEach(list, handle => handle.info),
          ),
          get: id => Effect.flatMap(find(id), handle => handle.info),
          control: (id, control) =>
            Effect.flatMap(find(id), handle => handle.control(control)),
          stop: id =>
            Effect.flatMap(find(id), handle =>
              Effect.andThen(handle.stop, handle.info),
            ),
          events: id => Effect.map(find(id), handle => handle.events),
        })
      }),
    )
}
