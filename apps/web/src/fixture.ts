/**
 * Small, hand-made data for the tests.
 */
import { Option } from 'effect'

import {
  Histogram,
  type RunInfo,
  type Second,
  type TestInfo,
} from '@mantix/api'

import { type Model, RunState, TestState, initialModel } from './model.ts'
import { Feed } from './model.ts'

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
}

/** One second where every request took `ms` and `failed` of them failed. */
export const makeSecond = (
  t: number,
  options: Readonly<{ ms: number; requests?: number; failed?: number }>,
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
        endpoint: 'POST /checkout',
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
              endpoint: 'POST /checkout',
              kind: 'HttpStatus',
              message: '503 Service Unavailable',
            },
          ],
  }
}

export const readyModel: Model = {
  ...initialModel,
  test: TestState.Loaded({ test: testInfo }),
}

export const watchingModel = (
  run: RunInfo,
  seconds: ReadonlyArray<Second>,
): Model => ({
  ...readyModel,
  runState: RunState.Watching({
    run,
    seconds,
    feed: Feed.Following(),
    connection: 0,
    stop: 'NotRequested',
  }),
  maybeExpandedEndpoint: Option.none(),
})
