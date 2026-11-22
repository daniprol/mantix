/**
 * Turning a scenario into Effects the engine can run.
 *
 * Both kinds of scenario end up here as the same three Effects (setup, one
 * iteration, teardown), so the scheduler, the VU pool and the recorder have
 * exactly one code path:
 *
 * - An async scenario is wrapped once with `Effect.tryPromise`. Its
 *   AbortSignal fires when the fiber is interrupted (the run stops, or a VU
 *   is scaled down), and we hand that signal to the scenario and to `http`.
 * - An Effect scenario is used as it is.
 */
import { Cause, Data, Effect, type Exit } from 'effect'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  type ClientConfig,
  type IterationTiming,
  RequestCancelled,
  makeEffectHttp,
  makeHttp,
  makeTiming,
} from './HttpClient.ts'
import type { Recorder } from './Recorder.ts'
import { RequestFailed, type Scenario } from './Scenario.ts'

/** A scenario's setup failed, so the run cannot start. */
class SetupFailed extends Data.TaggedError('SetupFailed')<{
  readonly scenario: string
  readonly message: string
}> {}

/** Whatever an async scenario threw or rejected with, kept as-is. */
class Thrown extends Data.TaggedError('Thrown')<{ readonly error: unknown }> {}

/**
 * Run a scenario's async function as an Effect. `Effect.tryPromise` hands
 * us an AbortSignal that fires when the fiber is interrupted; we pass it on
 * to the scenario and to its `http`.
 */
const fromAsync = <A>(
  run: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, Thrown> =>
  Effect.tryPromise({ try: run, catch: error => new Thrown({ error }) })

/** The same wrapper for an Effect scenario's own (untyped) errors. */
const wrapError = <A, E>(
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, Thrown> =>
  Effect.mapError(effect, error => new Thrown({ error }))

/** A readable message for anything a test might throw. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// The engine's own source folder: stack frames inside it are Mantix, not
// the test.
const ENGINE_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * The line of the test file where an error was thrown, e.g.
 * "checkout.ts:42", read from the stack. Frames inside Node, node_modules
 * or Mantix itself are skipped, so it points at the test author's code.
 */
export const locationOf = (error: unknown): string | undefined => {
  if (!(error instanceof Error) || error.stack === undefined) return undefined
  for (const line of error.stack.split('\n').slice(1)) {
    // "at fn (file:///a/b/checkout.ts:42:13)" or "at file:///a/b.ts:42:13"
    const match = /\(?((?:file:\/\/)?\/[^()]*?):(\d+):\d+\)?\s*$/.exec(line)
    if (match === null) continue
    const file = match[1]!.startsWith('file:')
      ? fileURLToPath(match[1]!)
      : match[1]!
    if (file.includes('/node_modules/') || file.startsWith(ENGINE_DIR)) {
      continue
    }
    return `${file.split('/').pop()}:${match[2]}`
  }
  return undefined
}

/** Find the first real error in a Cause (a failure or a defect). */
const errorOf = (cause: Cause.Cause<unknown>): unknown => {
  const error = Cause.squash(cause)
  return error instanceof Thrown ? error.error : error
}

export interface PreparedScenario {
  readonly setup: Effect.Effect<unknown, SetupFailed>
  /**
   * One iteration. It never fails: the outcome is recorded instead.
   * `intendedStart` is set in the open model (see IterationTiming).
   */
  readonly iteration: (
    data: unknown,
    vu: number,
    intendedStart?: number,
  ) => Effect.Effect<void>
  /** Never fails; a failing teardown is recorded as a ScriptError. */
  readonly teardown: (data: unknown) => Effect.Effect<void>
}

export const prepareScenario = (
  scenario: Scenario,
  config: ClientConfig,
  recorder: Recorder,
): PreparedScenario => {
  const name = scenario.options.name
  // Script errors have no endpoint; they are labelled with the scenario.
  const scriptLabel = `${name} (script)`
  // How many iterations each VU has started, for `context.iteration`.
  const counts = new Map<number, number>()
  const nextCount = (vu: number): number => {
    const n = (counts.get(vu) ?? 0) + 1
    counts.set(vu, n)
    return n
  }

  // The body of one iteration, for either kind of scenario.
  const body = (
    data: unknown,
    vu: number,
    iteration: number,
    timing: IterationTiming,
  ): Effect.Effect<void, Thrown> => {
    if (scenario._tag === 'AsyncScenario') {
      return fromAsync(signal =>
        scenario.options.iteration({
          http: makeHttp(config, timing, signal),
          data,
          vu,
          iteration,
          signal,
        }),
      )
    }
    // Effect scenarios get a signal too, for libraries outside Effect.
    return Effect.suspend(() => {
      const controller = new AbortController()
      const run = wrapError(
        // The scenario's own error type is whatever the test author chose,
        // so it is untyped here; wrapError gives it a tag straight away.
        // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context
        scenario.options.iteration({
          http: makeEffectHttp(config, timing),
          data,
          vu,
          iteration,
          signal: controller.signal,
        }),
      )
      return Effect.onInterrupt(run, () =>
        Effect.sync(() => controller.abort()),
      )
    })
  }

  // Record how an iteration ended.
  const recordOutcome = (
    exit: Exit.Exit<void, Thrown>,
  ): 'completed' | 'failed' | 'interrupted' => {
    if (exit._tag === 'Success') {
      recorder.iterationEnded('completed')
      return 'completed'
    }
    if (Cause.hasInterruptsOnly(exit.cause)) {
      recorder.iterationEnded('interrupted')
      return 'interrupted'
    }
    const error = errorOf(exit.cause)
    if (error instanceof RequestCancelled) {
      recorder.iterationEnded('interrupted')
      return 'interrupted'
    }
    if (error instanceof RequestFailed) {
      // Already recorded by the http client.
      recorder.iterationEnded('failed')
    } else {
      // The test code threw: its bug, not the server's. It is counted as a
      // failed iteration but never as a request error.
      recorder.iterationEnded('failed')
      const location = locationOf(error)
      recorder.sample(
        scriptLabel,
        'ScriptError',
        messageOf(error),
        location === undefined ? {} : { location },
      )
    }
    return 'failed'
  }

  const iteration = (data: unknown, vu: number, intendedStart?: number) =>
    Effect.suspend(() => {
      const startedAt = config.now()
      const timing = makeTiming(intendedStart, startedAt)
      const count = nextCount(vu)
      recorder.iterationStarted(timing.firstDelay)
      // When it ended: record the outcome, and offer the iteration for the
      // waterfall (the recorder keeps the slowest of each second).
      const onEnd = (exit: Exit.Exit<void, Thrown>) => {
        const outcome = recordOutcome(exit)
        if (outcome === 'interrupted') return
        const end = config.now()
        recorder.offerTrace({
          scenario: name,
          vu,
          iteration: count,
          lateMs: Math.round((timing.firstDelay ?? 0) * 100) / 100,
          duration:
            Math.round((end - (intendedStart ?? startedAt)) * 100) / 100,
          outcome,
          spans: [...timing.spans].sort((a, b) => a.start - b.start),
        })
      }
      return body(data, vu, count, timing).pipe(
        Effect.onExit(exit => Effect.sync(() => onEnd(exit))),
        // The outcome is recorded; the error itself is not needed any more.
        Effect.ignoreCause,
      )
    })

  // Setup and teardown send requests through the same client and recorder
  // as the load; the phase only labels them (see ClientConfig.phase).
  const setupConfig: ClientConfig = { ...config, phase: 'setup' }
  const teardownConfig: ClientConfig = { ...config, phase: 'teardown' }

  const setup: Effect.Effect<unknown, SetupFailed> =
    scenario.options.setup === undefined
      ? Effect.undefined
      : (scenario._tag === 'AsyncScenario'
          ? fromAsync(signal =>
              scenario.options.setup!({
                http: makeHttp(setupConfig, makeTiming(), signal),
                signal,
              }),
            )
          : Effect.suspend(() =>
              scenario.options.setup!({
                http: makeEffectHttp(setupConfig, makeTiming()),
                signal: new AbortController().signal,
              }).pipe(wrapError),
            )
        ).pipe(
          Effect.catchCause(cause =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause as Cause.Cause<never>)
              : Effect.fail(
                  new SetupFailed({
                    scenario: name,
                    message: messageOf(errorOf(cause)),
                  }),
                ),
          ),
        )

  const teardown = (data: unknown): Effect.Effect<void> => {
    if (scenario.options.teardown === undefined) {
      return Effect.void
    }
    const effect: Effect.Effect<void, Thrown> =
      scenario._tag === 'AsyncScenario'
        ? fromAsync(signal =>
            scenario.options.teardown!({
              http: makeHttp(teardownConfig, makeTiming(), signal),
              signal,
              data,
            }),
          )
        : Effect.suspend(() =>
            scenario.options.teardown!({
              http: makeEffectHttp(teardownConfig, makeTiming()),
              signal: new AbortController().signal,
              data,
            }).pipe(wrapError),
          )
    return effect.pipe(
      Effect.catchCause(cause =>
        Effect.sync(() =>
          recorder.sample(
            scriptLabel,
            'ScriptError',
            `teardown failed: ${messageOf(errorOf(cause))}`,
          ),
        ),
      ),
    )
  }

  return { setup, iteration, teardown }
}
