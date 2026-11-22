import { Effect, Layer, Queue, Stream } from 'effect'
import { HttpRouter } from 'effect/http'
import { HttpApiBuilder } from 'effect/http-api'
import { createServer } from 'node:http'

/**
 * A mock Mantix server for working on the dashboard before the real one
 * exists. It implements the same `MantixApi` contract with HttpApiBuilder,
 * so if this compiles and the dashboard works against it, the contract works
 * end to end.
 *
 *   pnpm --filter @mantix/web mock     # http://localhost:4100
 *
 * Environment:
 *   MOCK_DURATION=60   default run length in seconds
 *   MOCK_LAG=0         turn off the second where Mantix itself "lags"
 */
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node'
import {
  InvalidControl,
  MantixApi,
  type RunEvent,
  type RunInfo,
  RunAlreadyActive,
  RunNotFound,
  type Second,
  type ThresholdResult,
  checkControl,
  steer,
  summarizeSeconds,
} from '@mantix/api'

import {
  applyOverrides,
  makeSimulation,
  simulateSecond,
  testInfo,
} from './simulate.ts'

const PORT = 4100
const DEFAULT_DURATION = Number(process.env.MOCK_DURATION ?? 60)
const LAG = process.env.MOCK_LAG !== '0'

/** Everything the mock remembers about one run. Plain mutable state: it's a mock. */
interface MockRun {
  info: RunInfo
  readonly seconds: Array<Second>
  readonly listeners: Set<(event: RunEvent) => void>
}

const runs = new Map<string, MockRun>()

const publish = (run: MockRun, event: RunEvent): void => {
  for (const listener of run.listeners) listener(event)
}

const isOver = (run: MockRun): boolean => run.info.status !== 'running'

// Very small threshold checker, just enough for "p99 < 250ms" and "errors < 1%".
const evaluateThresholds = (
  seconds: ReadonlyArray<Second>,
): Array<ThresholdResult> => {
  const { total } = summarizeSeconds(seconds)
  return testInfo.thresholds.map(expression => {
    const match = /^(p\d\d|max|errors|rps)\s*<\s*([\d.]+)/.exec(expression)
    const metric = match?.[1] ?? 'p99'
    const limit = Number(match?.[2] ?? 0)
    const actual =
      metric === 'errors'
        ? total.errorRate * 100
        : metric === 'rps'
          ? total.rps
          : total.latency[metric as 'p99']
    return {
      expression,
      actual,
      passed: total.requests === 0 || actual < limit,
    }
  })
}

const endRun = (run: MockRun, status: RunInfo['status'], now: number) => {
  if (isOver(run)) return
  run.info = { ...run.info, status, endedAt: now }
  publish(run, { _tag: 'RunUpdated', run: run.info })
}

/**
 * Produces one Second per second until the plan is done or someone stops it.
 * The load comes from the plan plus the run journal, like the real engine,
 * so the controls (rate, spike, pause) show up in the fake data too.
 */
const generate = (run: MockRun, duration: number) =>
  Effect.gen(function* () {
    const plan = run.info.plan[0]!.plan
    const sim = makeSimulation(plan, duration, {
      seed: runs.size * 7919,
      lag: LAG,
    })
    for (let t = 0; t < steer(run.info.plan, run.info.journal).end; t++) {
      yield* Effect.sleep('1 second')
      if (isOver(run)) return
      const steering = steer(run.info.plan, run.info.journal)
      const second = simulateSecond(sim, t, steering.total(t + 0.5))
      run.seconds.push(second)
      publish(run, { _tag: 'Second', second })
      const thresholds = evaluateThresholds(run.seconds)
      run.info = { ...run.info, thresholds }
      publish(run, { _tag: 'RunUpdated', run: run.info })
    }
    endRun(run, 'finished', Date.now())
  })

/**
 * The live stream: replay what we have, then follow. Registering the listener
 * and copying the past seconds happen in one synchronous step, so no Second
 * can slip between the replay and the live part.
 */
const followRun = (run: MockRun): Stream.Stream<RunEvent> =>
  Stream.callback<RunEvent>(queue =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener = (event: RunEvent) => {
          Queue.offerUnsafe(queue, event)
          if (event._tag === 'RunUpdated' && event.run.status !== 'running') {
            Queue.endUnsafe(queue)
          }
        }
        Queue.offerUnsafe(queue, { _tag: 'RunUpdated', run: run.info })
        for (const second of run.seconds) {
          Queue.offerUnsafe(queue, { _tag: 'Second', second })
        }
        if (isOver(run)) {
          Queue.endUnsafe(queue)
        } else {
          run.listeners.add(listener)
        }
        return listener
      }),
      listener => Effect.sync(() => run.listeners.delete(listener)),
    ),
  )

const findRun = (id: string) =>
  Effect.suspend(() => {
    const run = runs.get(id)
    return run === undefined
      ? Effect.fail(new RunNotFound({ id }))
      : Effect.succeed(run)
  })

const TestHandlers = HttpApiBuilder.group(MantixApi, 'test', handlers =>
  handlers.handle('get', () => Effect.succeed(testInfo)),
)

const RunsHandlers = HttpApiBuilder.group(MantixApi, 'runs', handlers =>
  handlers
    .handle('start', ({ payload }) =>
      Effect.gen(function* () {
        const active = [...runs.values()].find(run => !isOver(run))
        if (active !== undefined) {
          return yield* new RunAlreadyActive({ id: active.info.id })
        }
        const duration = payload.duration ?? DEFAULT_DURATION
        const scenario = testInfo.scenarios[0]!
        const plan = applyOverrides(scenario.plan, { ...payload, duration })
        const run: MockRun = {
          info: {
            id: `run-${runs.size + 1}`,
            testName: testInfo.name,
            status: 'running',
            startedAt: Date.now(),
            endedAt: null,
            duration,
            plan: [{ ...scenario, plan }],
            thresholds: evaluateThresholds([]),
            journal: [],
          },
          seconds: [],
          listeners: new Set(),
        }
        runs.set(run.info.id, run)
        yield* Effect.forkDetach(generate(run, duration))
        return run.info
      }),
    )
    .handle('list', () =>
      Effect.sync(() => [...runs.values()].map(run => run.info).reverse()),
    )
    .handle('get', ({ params }) =>
      Effect.map(findRun(params.id), run => run.info),
    )
    .handle('control', ({ params, payload }) =>
      Effect.gen(function* () {
        const run = yield* findRun(params.id)
        if (isOver(run)) {
          return yield* new InvalidControl({
            message: 'The run has already ended.',
          })
        }
        const { plan, journal } = run.info
        const at = (Date.now() - run.info.startedAt) / 1000
        const problem = checkControl(plan, journal, payload, at)
        if (problem !== undefined) {
          return yield* new InvalidControl({ message: problem })
        }
        const entry = { seq: journal.length + 1, at, control: payload }
        run.info = { ...run.info, journal: [...journal, entry] }
        publish(run, { _tag: 'RunUpdated', run: run.info })
        return entry
      }),
    )
    .handle('stop', ({ params }) =>
      Effect.map(findRun(params.id), run => {
        endRun(run, 'stopped', Date.now())
        return run.info
      }),
    )
    .handle('events', ({ params }) =>
      Effect.map(findRun(params.id), followRun),
    ),
)

// The mock has no file watcher, so the dev stream stays quiet.
const DevHandlers = HttpApiBuilder.group(MantixApi, 'dev', handlers =>
  handlers.handle('events', () => Effect.succeed(Stream.never)),
)

const ApiRoutes = HttpApiBuilder.layer(MantixApi).pipe(
  Layer.provide([TestHandlers, RunsHandlers, DevHandlers]),
)

const Server = HttpRouter.serve(ApiRoutes).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: PORT })),
)

console.log(`Mock Mantix server on http://localhost:${PORT}/api`)
Layer.launch(Server).pipe(NodeRuntime.runMain)
