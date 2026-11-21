/**
 * The runner: one entry point that runs a test, used by the CLI and (next)
 * by the HTTP server.
 *
 * ```ts
 * startRun(test: TestDefinition, options?: RunOptions)
 *   : Effect<RunHandle, InvalidTest, Scope>
 *
 * interface RunHandle {
 *   id: string
 *   info: Effect<RunInfo>             // the run as it is right now
 *   snapshot: Effect<RunResult>       // RunInfo plus every Second so far
 *   events: Stream<RunEvent>          // replays every Second so far, then
 *                                     // follows live ones; ends with the run
 *   stop: Effect<void>                // stop early; waits for teardown
 *   await: Effect<RunResult>          // wait for the end
 * }
 * ```
 *
 * The run belongs to the Scope it was started in. Closing that Scope (for
 * example on Ctrl-C) interrupts the run; teardown still runs, and the run
 * ends with status "stopped". Bad input (an unreadable threshold or
 * duration, a missing default export) fails up front with `InvalidTest`.
 *
 * Inside, one fiber runs the whole thing:
 *   - every scenario runs concurrently: wait `startAfter`, setup, generate
 *     load (open or closed model), teardown (always, via `Effect.ensuring`);
 *   - a ticker closes one `Second` per elapsed second, appends it to the
 *     state, and checks thresholds on the cumulative stats;
 *   - the work races a stop signal, fired by `stop` or by a failing
 *     `abortOnFail` threshold.
 *
 * All state lives in one SubscriptionRef. `events` is built from its
 * `changes` stream, which is why late subscribers get a full replay.
 */

import {
  Cause,
  Data,
  Deferred,
  Effect,
  FiberSet,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect'
import { monitorEventLoopDelay } from 'node:perf_hooks'

import {
  type EndpointSecond,
  Histogram,
  type LoadPlan,
  type RunEvent,
  type RunInfo,
  type RunOverrides,
  type RunStatus,
  type ScenarioInfo,
  type Second,
  type TestInfo,
  type ThresholdResult,
  summarizeSeconds,
} from '@mantix/api'

import { toSeconds } from './Duration.ts'
import {
  type ClientConfig,
  DEFAULT_TIMEOUT_MS,
  makeAgent,
} from './HttpClient.ts'
import { messageOf, prepareScenario } from './Iteration.ts'
import { planDuration, targetAt, toPlan } from './Load.ts'
import { Recorder } from './Recorder.ts'
import { type Scenario, type TestDefinition } from './Scenario.ts'
import { runOpenModel } from './Scheduler.ts'
import { type Threshold, evaluate, parseThreshold } from './Thresholds.ts'
import { runClosedModel } from './VuPool.ts'

/** The test cannot run as written. The message says why. */
export class InvalidTest extends Data.TaggedError('InvalidTest')<{
  readonly message: string
}> {}

export interface RunOptions {
  /** The test file, for display. */
  readonly file?: string
  /** Changes made from the CLI flags or the dashboard. */
  readonly overrides?: RunOverrides
  /** A run id; a random one is made when absent. */
  readonly id?: string
}

/** The run as it is (or was, once it has ended). */
export interface RunResult {
  readonly info: RunInfo
  readonly seconds: ReadonlyArray<Second>
}

export interface RunHandle {
  readonly id: string
  readonly info: Effect.Effect<RunInfo>
  readonly snapshot: Effect.Effect<RunResult>
  readonly events: Stream.Stream<RunEvent>
  readonly stop: Effect.Effect<void>
  readonly await: Effect.Effect<RunResult>
}

// ---------------------------------------------------------------------------
// Planning: pure functions, checked before anything starts
// ---------------------------------------------------------------------------

/** A scenario with everything turned into plain numbers. */
interface Planned {
  readonly scenario: Scenario
  readonly info: ScenarioInfo
  readonly maxVus: number
  readonly timeoutMs: number
}

const isScenario = (value: unknown): value is Scenario =>
  typeof value === 'object' &&
  value !== null &&
  ((value as { _tag?: unknown })._tag === 'AsyncScenario' ||
    (value as { _tag?: unknown })._tag === 'EffectScenario')

/** Normalise a default export to scenarios, with a clear error if it isn't. */
const scenariosIn = (test: unknown): ReadonlyArray<Scenario> => {
  const list = Array.isArray(test) ? test : [test]
  if (list.length === 0 || !list.every(isScenario)) {
    throw new Error(
      'The test file must `export default` a scenario (or an array of them) made with scenario() or scenario.effect().',
    )
  }
  return list
}

/**
 * Apply overrides to one plan.
 * - `rate` or `vus` replaces the plan with a constant one, for `duration`
 *   seconds when given, else for the plan's own duration.
 * - `duration` alone keeps the plan's shape and stretches or squeezes its
 *   stages to fit, so a warm-up stays a warm-up.
 */
export const applyOverrides = (
  plan: LoadPlan,
  overrides: RunOverrides | undefined,
): LoadPlan => {
  if (overrides === undefined) return plan
  const total = planDuration(plan)
  const duration = overrides.duration ?? total
  if (overrides.rate !== undefined) {
    return constantPlan('rate', overrides.rate, duration)
  }
  if (overrides.vus !== undefined) {
    return constantPlan('vus', overrides.vus, duration)
  }
  if (overrides.duration !== undefined && total > 0) {
    const scale = overrides.duration / total
    return {
      ...plan,
      stages: plan.stages.map(stage => ({
        duration: stage.duration * scale,
        target: stage.target,
      })),
    }
  }
  return plan
}

const constantPlan = (
  model: LoadPlan['model'],
  target: number,
  duration: number,
): LoadPlan => ({ model, start: target, stages: [{ duration, target }] })

const planTest = (
  test: unknown,
  overrides: RunOverrides | undefined,
): {
  readonly scenarios: ReadonlyArray<Planned>
  readonly thresholds: ReadonlyArray<Threshold>
} => {
  const scenarios = scenariosIn(test).map(scenario => {
    const options = scenario.options
    const plan = applyOverrides(toPlan(options.load), overrides)
    if (plan.stages.some(s => !(s.duration >= 0) || !(s.target >= 0))) {
      throw new Error(
        `Scenario "${options.name}": stage durations and targets must be 0 or more.`,
      )
    }
    return {
      scenario,
      info: {
        name: options.name,
        plan,
        startAfter:
          options.startAfter === undefined ? 0 : toSeconds(options.startAfter),
      },
      maxVus: options.load._tag === 'Rate' ? options.load.maxVus : 1000,
      timeoutMs:
        options.timeout === undefined
          ? DEFAULT_TIMEOUT_MS
          : toSeconds(options.timeout) * 1000,
    }
  })
  const thresholds = scenariosIn(test).flatMap(scenario =>
    (scenario.options.thresholds ?? []).map(parseThreshold),
  )
  return { scenarios, thresholds }
}

const totalDuration = (scenarios: ReadonlyArray<ScenarioInfo>): number =>
  Math.max(0, ...scenarios.map(s => s.startAfter + planDuration(s.plan)))

const baseName = (file: string): string =>
  file
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.[cm]?[jt]s$/, '') ?? file

/**
 * Describe a test file for the dashboard, before any run. Throws on a
 * default export that is not a scenario.
 */
export const testInfo = (test: TestDefinition, file: string): TestInfo => {
  const list = scenariosIn(test)
  const scenarios = list.map(scenario => ({
    name: scenario.options.name,
    plan: toPlan(scenario.options.load),
    startAfter:
      scenario.options.startAfter === undefined
        ? 0
        : toSeconds(scenario.options.startAfter),
  }))
  const baseUrls = new Set(list.map(s => s.options.baseUrl))
  const [baseUrl] = baseUrls
  return {
    file,
    name: list.length === 1 ? list[0]!.options.name : baseName(file),
    ...(baseUrls.size === 1 && baseUrl !== undefined ? { baseUrl } : {}),
    scenarios,
    thresholds: list.flatMap(s =>
      (s.options.thresholds ?? []).map(t =>
        typeof t === 'string' ? t : t.check,
      ),
    ),
    duration: totalDuration(scenarios),
  }
}

// ---------------------------------------------------------------------------
// Cumulative stats for thresholds
// ---------------------------------------------------------------------------

const addCounts = (
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): Record<string, number> => {
  const sum = { ...a }
  for (const [key, value] of Object.entries(b))
    sum[key] = (sum[key] ?? 0) + value
  return sum
}

/**
 * Fold one Second into a running per-endpoint total. Thresholds need stats
 * for the whole run so far; merging as we go costs the same every second,
 * instead of re-merging every Second of a long soak test each time.
 */
const accumulate = (
  totals: Map<string, EndpointSecond>,
  second: Second,
): void => {
  for (const part of second.endpoints) {
    const prev = totals.get(part.endpoint)
    totals.set(
      part.endpoint,
      prev === undefined
        ? part
        : {
            endpoint: part.endpoint,
            requests: prev.requests + part.requests,
            latency: Histogram.merge(prev.latency, part.latency),
            uncorrected: Histogram.merge(prev.uncorrected, part.uncorrected),
            statuses: addCounts(prev.statuses, part.statuses),
            errors: addCounts(prev.errors, part.errors),
          },
    )
  }
}

const checkThresholds = (
  thresholds: ReadonlyArray<Threshold>,
  totals: Map<string, EndpointSecond>,
  secondCount: number,
): Array<ThresholdResult> => {
  if (thresholds.length === 0) return []
  // summarizeSeconds over one merged "second"; rates are divided by the
  // real number of seconds so far.
  const merged: Second = {
    t: 0,
    target: 0,
    offered: 0,
    started: 0,
    dropped: 0,
    completed: 0,
    failed: 0,
    inFlight: 0,
    vus: 0,
    loopLagMs: 0,
    endpoints: [...totals.values()],
    errorSamples: [],
  }
  const { total, endpoints } = summarizeSeconds(
    [merged],
    Math.max(1, secondCount),
  )
  return thresholds.map(threshold => evaluate(threshold, total, endpoints))
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

type StopReason = 'stopped' | 'aborted'

/** How long the open model waits for running iterations after the plan. */
const graceMs = (planned: Planned): number => planned.timeoutMs

export const startRun = Effect.fn('startRun')(function* (
  test: TestDefinition,
  options: RunOptions = {},
): Effect.fn.Return<RunHandle, InvalidTest, Scope.Scope> {
  // Check everything up front, so a typo fails before any load is sent.
  const { scenarios, thresholds } = yield* Effect.try({
    try: () => planTest(test, options.overrides),
    catch: error => new InvalidTest({ message: messageOf(error) }),
  })

  // `now` reads Effect's Clock: real time in production, TestClock in tests.
  const clock = yield* Effect.clockWith(Effect.succeed)
  const now = (): number => Number(clock.monotonicTimeNanosUnsafe()) / 1e6

  const id = options.id ?? crypto.randomUUID().slice(0, 8)
  const plan = scenarios.map(s => s.info)
  const initial: RunInfo = {
    id,
    testName:
      scenarios.length === 1
        ? scenarios[0]!.info.name
        : baseName(options.file ?? 'test'),
    status: 'running',
    startedAt: clock.currentTimeMillisUnsafe(),
    endedAt: null,
    duration: totalDuration(plan),
    plan,
    thresholds: [],
  }

  // One SubscriptionRef holds the whole state. Every update is published
  // to `changes`, which is what `events` reads.
  const state = yield* SubscriptionRef.make<RunResult>({
    info: initial,
    seconds: [],
  })
  const stopSignal = yield* Deferred.make<StopReason>()
  const done = yield* Deferred.make<RunResult>()

  const recorder = new Recorder()
  // Gauges each scenario reports: busy slots (open) or live VUs (closed).
  const vusByScenario = scenarios.map(() => 0)
  const totals = new Map<string, EndpointSecond>()

  // The event-loop delay histogram tells us if Mantix itself is too busy
  // to keep its schedule (the "generator" lane on the dashboard).
  const loopDelay = monitorEventLoopDelay({ resolution: 10 })

  // The planned load for second t, read at its middle: for a linear ramp
  // that is exactly the average over the second.
  const targetFor = (t: number): number =>
    scenarios.reduce((sum, s) => {
      const local = t + 0.5 - s.info.startAfter
      return local < 0 ? sum : sum + targetAt(s.info.plan, local)
    }, 0)

  /** Close second `t` and publish it, checking thresholds. */
  const closeSecond = (t: number) =>
    Effect.gen(function* () {
      const lagMs = loopDelay.max > 0 ? loopDelay.max / 1e6 : 0
      loopDelay.reset()
      const second = recorder.snapshot(t, {
        target: targetFor(t),
        vus: vusByScenario.reduce((a, b) => a + b, 0),
        loopLagMs: Math.round(lagMs * 10) / 10,
      })
      accumulate(totals, second)
      const next = yield* SubscriptionRef.updateAndGet(state, current => {
        const seconds = [...current.seconds, second]
        return {
          seconds,
          info: {
            ...current.info,
            thresholds: checkThresholds(thresholds, totals, seconds.length),
          },
        }
      })
      // A failing threshold marked abortOnFail stops the run.
      const abort = next.info.thresholds.some(
        (result, i) => !result.passed && thresholds[i]!.abortOnFail,
      )
      if (abort) {
        yield* Deferred.succeed(stopSignal, 'aborted')
      }
    })

  // The ticker: wake at every second boundary and close that second.
  const ticker = (start: number) =>
    Effect.gen(function* () {
      for (let t = 0; ; t++) {
        const wait = start + (t + 1) * 1000 - now()
        if (wait > 0) yield* Effect.sleep(wait)
        yield* closeSecond(t)
      }
    })

  // One scenario from start to end.
  const runScenario = (
    planned: Planned,
    index: number,
    shared: Pick<ClientConfig, 'agent' | 'recorder' | 'now'>,
    runStart: number,
  ) =>
    Effect.gen(function* () {
      const { scenario, info } = planned
      const wait = runStart + info.startAfter * 1000 - now()
      if (wait > 0) {
        yield* Effect.sleep(wait)
      }
      const prepared = prepareScenario(
        scenario,
        {
          ...shared,
          baseUrl: scenario.options.baseUrl,
          headers: scenario.options.headers,
          timeoutMs: planned.timeoutMs,
        },
        recorder,
      )
      const data = yield* prepared.setup
      // The plan is anchored to the run's clock, so arrivals line up with
      // the Seconds. A slow setup shifts it instead of causing a burst.
      const planStart = Math.max(runStart + info.startAfter * 1000, now())
      const load =
        info.plan.model === 'rate'
          ? Effect.scoped(
              Effect.gen(function* () {
                const fibers = yield* runOpenModel({
                  plan: info.plan,
                  maxVus: planned.maxVus,
                  recorder,
                  now,
                  start: planStart,
                  iteration: (intendedStart, vu) =>
                    prepared.iteration(data, vu, intendedStart),
                  onBusy: busy => {
                    vusByScenario[index] = busy
                  },
                })
                // Let iterations that are still running finish, up to the
                // request timeout. Leaving the scope interrupts the rest.
                yield* FiberSet.awaitEmpty(fibers).pipe(
                  Effect.timeoutOption(graceMs(planned)),
                )
              }),
            )
          : Effect.scoped(
              runClosedModel({
                plan: info.plan,
                now,
                start: planStart,
                iteration: vu => prepared.iteration(data, vu),
                onVus: vus => {
                  vusByScenario[index] = vus
                },
              }),
            )
      // `ensuring` runs teardown however the load ends: finished, stopped,
      // aborted or interrupted by Ctrl-C.
      yield* load.pipe(Effect.ensuring(prepared.teardown(data)))
    })

  /** Write the final state. Runs once, however the run ended. */
  let finished = false
  const finish = (status: RunStatus, error?: string) =>
    Effect.gen(function* () {
      if (finished) return
      finished = true
      const endedAt = clock.currentTimeMillisUnsafe()
      const result = yield* SubscriptionRef.updateAndGet(state, current => {
        // The last, partial second, if anything happened in it.
        const seconds = recorder.isEmpty
          ? current.seconds
          : [
              ...current.seconds,
              recorder.snapshot(current.seconds.length, {
                target: targetFor(current.seconds.length),
                vus: 0,
                loopLagMs: 0,
              }),
            ]
        if (seconds.length > current.seconds.length) {
          accumulate(totals, seconds[seconds.length - 1]!)
        }
        return {
          seconds,
          info: {
            ...current.info,
            status,
            endedAt,
            thresholds: checkThresholds(thresholds, totals, seconds.length),
            ...(error === undefined ? {} : { error }),
          },
        }
      })
      yield* Deferred.succeed(done, result)
    })

  const main = Effect.scoped(
    Effect.gen(function* () {
      // One keep-alive connection pool for the whole run, closed at the end.
      const agent = yield* Effect.acquireRelease(Effect.sync(makeAgent), a =>
        Effect.promise(() => a.destroy()),
      )
      yield* Effect.acquireRelease(
        Effect.sync(() => loopDelay.enable()),
        () => Effect.sync(() => loopDelay.disable()),
      )
      const start = now()
      // forkScoped: the ticker lives exactly as long as this scope.
      yield* Effect.forkScoped(ticker(start))

      const work = Effect.forEach(
        scenarios,
        (planned, index) =>
          runScenario(planned, index, { agent, recorder, now }, start),
        { concurrency: 'unbounded', discard: true },
      ).pipe(Effect.as('finished' as const))

      // Whichever ends first wins; the loser is interrupted (and the
      // scenarios' teardowns run).
      return yield* Effect.raceFirst(work, Deferred.await(stopSignal))
    }),
  ).pipe(
    Effect.matchCauseEffect({
      onSuccess: status => finish(status),
      onFailure: cause =>
        Cause.hasInterruptsOnly(cause)
          ? finish('stopped')
          : finish('crashed', crashMessage(cause)),
    }),
    // If the scope closes (Ctrl-C) the run is interrupted; record that it
    // stopped. `finish` only acts the first time it is called.
    Effect.onInterrupt(() => finish('stopped')),
  )

  yield* Effect.forkScoped(main)

  const events: Stream.Stream<RunEvent> = SubscriptionRef.changes(state).pipe(
    // Stop after the first state that is no longer running (inclusive).
    Stream.takeUntil(s => s.info.status !== 'running'),
    // Turn whole states into events: only what is new since last time.
    Stream.mapAccum(
      () => ({ sent: 0, info: undefined as RunInfo | undefined }),
      (seen, current) => {
        const out: Array<RunEvent> = []
        const fresh = current.seconds
          .slice(seen.sent)
          .map(second => ({ _tag: 'Second', second }) as const)
        const updated =
          current.info === seen.info
            ? []
            : [{ _tag: 'RunUpdated', run: current.info } as const]
        // First message: the run, then the replay. Later: data, then the
        // change it caused (thresholds, final status).
        if (seen.info === undefined) out.push(...updated, ...fresh)
        else out.push(...fresh, ...updated)
        return [{ sent: current.seconds.length, info: current.info }, out]
      },
    ),
  )

  return {
    id,
    info: Effect.map(SubscriptionRef.get(state), s => s.info),
    snapshot: SubscriptionRef.get(state),
    events,
    stop: Effect.andThen(
      Deferred.succeed(stopSignal, 'stopped'),
      Deferred.await(done),
    ).pipe(Effect.asVoid),
    await: Deferred.await(done),
  }
})

const crashMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { _tag?: unknown })._tag === 'SetupFailed'
  ) {
    const e = error as unknown as { scenario: string; message: string }
    return `Setup of "${e.scenario}" failed: ${e.message}`
  }
  return messageOf(error)
}
