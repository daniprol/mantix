/**
 * Small, hand-made data for the tests.
 */
import {
  Histogram,
  type RunInfo,
  type Second,
  type TestInfo,
} from '@mantix/api'

import {
  Feed,
  History,
  type Model,
  RunData,
  TestState,
  initialModel,
} from './model.ts'
import { AppRoute } from './route.ts'

const testInfo: TestInfo = {
  file: 'examples/checkout.ts',
  name: 'checkout-flow',
  scenarios: [
    {
      name: 'checkout-flow',
      plan: {
        model: 'rate',
        start: 0,
        stages: [
          { duration: 30, target: 100 },
          { duration: 120, target: 100 },
        ],
      },
      startAfter: 0,
    },
  ],
  thresholds: ['p99 < 250ms', 'errors < 1%'],
  duration: 150,
}

export const runningRun: RunInfo = {
  id: 'run-1',
  testName: 'checkout-flow',
  status: 'running',
  startedAt: 1_700_000_000_000,
  endedAt: null,
  duration: 150,
  plan: testInfo.scenarios,
  thresholds: [
    { expression: 'p99 < 250ms', actual: 0, passed: true },
    { expression: 'errors < 1%', actual: 0, passed: true },
  ],
  journal: [],
}

/** One second where every request took `ms` and `failed` of them failed. */
export const makeSecond = (
  t: number,
  options: Readonly<{
    ms: number
    requests?: number
    failed?: number
    endpoint?: string
  }>,
): Second => {
  const requests = options.requests ?? 100
  const failed = options.failed ?? 0
  const latency = Histogram.fromValues(
    Array.from({ length: requests }, () => options.ms * 1000),
  )
  return {
    t,
    target: 100,
    offered: requests,
    started: requests,
    dropped: 0,
    completed: requests - failed,
    failed,
    inFlight: 0,
    vus: 10,
    loopLagMs: 1,
    endpoints: [
      {
        endpoint: options.endpoint ?? 'POST /checkout',
        requests,
        latency,
        uncorrected: latency,
        statuses:
          failed === 0
            ? { '200': requests }
            : { '200': requests - failed, '503': failed },
        errors: failed === 0 ? {} : { HttpStatus: failed },
      },
    ],
    errorSamples:
      failed === 0
        ? []
        : [
            {
              endpoint: options.endpoint ?? 'POST /checkout',
              kind: 'HttpStatus',
              message: '503 Service Unavailable',
            },
          ],
  }
}

export const finishedRun: RunInfo = {
  ...runningRun,
  status: 'finished',
  endedAt: runningRun.startedAt + 150_000,
  thresholds: [
    { expression: 'p99 < 250ms', actual: 412, passed: false },
    { expression: 'errors < 1%', actual: 0.2, passed: true },
  ],
}

export const baselineRun: RunInfo = {
  ...finishedRun,
  id: 'run-0',
  startedAt: finishedRun.startedAt - 3_600_000,
  endedAt:
    finishedRun.endedAt === null ? null : finishedRun.endedAt - 3_600_000,
}

/** The New run page with the test loaded. */
export const readyModel: Model = {
  ...initialModel(AppRoute.NewRun()),
  test: TestState.Loaded({ test: testInfo }),
}

/** A page on `route` with these runs already loaded. */
export const modelWithRuns = (
  route: AppRoute,
  runs: ReadonlyArray<readonly [RunInfo, ReadonlyArray<Second>]>,
): Model => ({
  ...readyModel,
  route,
  history: History.Loaded({ runs: runs.map(([run]) => run) }),
  runs: Object.fromEntries(
    runs.map(([run, seconds]) => [
      run.id,
      RunData.Loaded({
        run,
        seconds,
        feed: run.status === 'running' ? Feed.Following() : Feed.Ended(),
        connection: 0,
        stop: 'NotRequested',
      }),
    ]),
  ),
})
