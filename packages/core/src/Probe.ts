/**
 * One traced iteration per scenario, for `mantix dev`.
 *
 * For each scenario: setup, exactly one iteration, teardown, all through
 * the same code path as a real run (prepareScenario), recorded by a
 * Recorder of its own. What comes back is the iteration's waterfall and
 * every error it produced, so you can test your test before loading
 * anything.
 */
import { Effect, Result } from 'effect'
import type { Agent } from 'undici'

import type { ProbeResult } from '@mantix/api'

import { toSeconds } from './Duration.ts'
import { DEFAULT_TIMEOUT_MS, makeAgent } from './HttpClient.ts'
import { messageOf, prepareScenario } from './Iteration.ts'
import { Recorder } from './Recorder.ts'
import { InvalidTest, scenariosIn } from './Runner.ts'
import type { Scenario, TestDefinition } from './Scenario.ts'

const probeScenario = Effect.fnUntraced(function* (
  scenario: Scenario,
  agent: Agent,
  now: () => number,
): Effect.fn.Return<ProbeResult> {
  const { options } = scenario
  const recorder = new Recorder()
  const prepared = prepareScenario(
    scenario,
    {
      agent,
      recorder,
      now,
      baseUrl: options.baseUrl,
      headers: options.headers,
      timeoutMs:
        options.timeout === undefined
          ? DEFAULT_TIMEOUT_MS
          : toSeconds(options.timeout) * 1000,
    },
    recorder,
  )
  // Effect.result turns a failure into a value we can look at.
  const setup = yield* Effect.result(prepared.setup)
  if (Result.isFailure(setup)) {
    return {
      scenario: options.name,
      errors: [],
      setupError: setup.failure.message,
    }
  }
  const data = setup.success
  // VU 1, no intended start: like the closed model, nothing to be late for.
  yield* prepared
    .iteration(data, 1)
    .pipe(Effect.ensuring(prepared.teardown(data)))
  const second = recorder.snapshot(0, { target: 0, vus: 0, loopLagMs: 0 })
  return {
    scenario: options.name,
    ...(second.slowest === undefined ? {} : { trace: second.slowest }),
    errors: second.errorSamples,
  }
})

/** Run one traced iteration of every scenario in a test file. */
export const probe = Effect.fn('probe')(function* (test: TestDefinition) {
  const scenarios = yield* Effect.try({
    try: () => scenariosIn(test),
    catch: error => new InvalidTest({ message: messageOf(error) }),
  })
  const clock = yield* Effect.clockWith(Effect.succeed)
  const now = (): number => Number(clock.monotonicTimeNanosUnsafe()) / 1e6
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const agent = yield* Effect.acquireRelease(Effect.sync(makeAgent), a =>
        Effect.promise(() => a.destroy()),
      )
      return yield* Effect.forEach(scenarios, scenario =>
        probeScenario(scenario, agent, now),
      )
    }),
  )
})
