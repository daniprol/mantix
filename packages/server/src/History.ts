/**
 * Start a run and save it to the run history as it goes.
 *
 * Used by both `mantix run` and `mantix ui`, so every run ends up in the
 * same history whichever way it was started.
 */
import { Effect, Stream } from 'effect'
import { relative, resolve } from 'node:path'

import type { RunContext } from '@mantix/api'
import {
  type RunHandle,
  type RunOptions,
  type TestDefinition,
  startRun,
} from '@mantix/core'

import { gatherContext } from './RunContext.ts'
import { type HistoryError, RunStore } from './RunStore.ts'

/**
 * How a test file is named in the history: relative to the folder Mantix
 * runs in, so `checkout.ts` and `./checkout.ts` are the same test.
 */
export const historyName = (file: string): string =>
  relative(process.cwd(), resolve(file)).replaceAll('\\', '/')

/**
 * Saving history must never stop a load test (a full disk, a read-only
 * folder...). Failures are logged as warnings and the run goes on.
 */
const save = (effect: Effect.Effect<void, HistoryError>) =>
  Effect.catch(effect, error =>
    Effect.logWarning(`Run history: ${error.message}`),
  )

/**
 * `startRun`, plus a fiber that writes each Second to the RunStore as it
 * closes. Like `startRun`, the run belongs to the current Scope.
 *
 * The run's context (project, git, label...) is gathered here, once per
 * run, so a long `mantix ui` session still records the commit each run
 * was made at.
 */
export const startRecordedRun = Effect.fn('startRecordedRun')(function* (
  test: TestDefinition,
  options: Omit<RunOptions, 'context'> & {
    readonly file: string
    readonly label?: string | undefined
    readonly repeat?: RunContext['repeat']
  },
) {
  const store = yield* RunStore
  const { label, repeat, ...runOptions } = options
  const context = yield* gatherContext({ label, repeat })
  const finish = (handle: RunHandle) =>
    Effect.flatMap(handle.snapshot, result =>
      save(store.finish(result.info, result.seconds)),
    )

  // A Scope runs its finalizers in reverse order. This one is added before
  // the run starts, so it runs *after* the run's own cleanup: when Ctrl-C
  // closes the scope, the run stops, teardown runs, the status becomes
  // "stopped", and only then is the final state saved.
  let handle: RunHandle | undefined
  yield* Effect.addFinalizer(() =>
    handle === undefined ? Effect.void : finish(handle),
  )

  const started = yield* startRun(test, { ...runOptions, context })
  handle = started
  yield* save(store.create(yield* started.info, historyName(options.file)))

  // Follow the live events in the background (forkScoped: the fiber
  // belongs to the same Scope as the run). `events` replays from the
  // first Second, so nothing is missed even if this starts late.
  yield* started.events.pipe(
    Stream.runForEach(event =>
      event._tag === 'Second'
        ? save(store.addSecond(started.id, event.second))
        : save(store.update(event.run)),
    ),
    // The stream ends when the run does: save the totals right away.
    Effect.andThen(finish(started)),
    Effect.forkScoped,
  )
  return started
})
