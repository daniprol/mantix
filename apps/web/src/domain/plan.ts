/**
 * Load plans in plain language, and as points for the little preview line.
 */
import { Array, Option, pipe } from 'effect'

import type { LoadPlan, RunOverrides, ScenarioInfo } from '@mantix/api'

import * as Format from './format.ts'

const unitOf = (plan: LoadPlan, amount: number): string =>
  plan.model === 'rate'
    ? `${Format.grouped(amount)} requests/s`
    : `${Format.grouped(amount)} virtual ${amount === 1 ? 'user' : 'users'}`

/** Total length of a plan in seconds. */
export const planDuration = (plan: LoadPlan): number =>
  plan.stages.reduce((sum, stage) => sum + stage.duration, 0)

const stagePhrases = (plan: LoadPlan): ReadonlyArray<string> =>
  pipe(
    plan.stages,
    Array.mapAccum(plan.start, (from, stage, index) => {
      const over = Format.span(stage.duration)
      const text =
        stage.target === from
          ? index === 0
            ? `holds ${unitOf(plan, from)} for ${over}`
            : `holds for ${over}`
          : stage.target === 0
            ? `ramps down to zero over ${over}`
            : stage.target > from
              ? `ramps to ${unitOf(plan, stage.target)} over ${over}`
              : `eases down to ${unitOf(plan, stage.target)} over ${over}`
      return [stage.target, text]
    }),
    ([, phrases]) => phrases,
  )

const capitalize = (text: string): string =>
  text.charAt(0).toUpperCase() + text.slice(1)

/**
 * "Ramps to 200 requests/s over 15 s, then holds for 45 s."
 */
export const describePlan = (plan: LoadPlan): string =>
  Array.match(stagePhrases(plan), {
    onEmpty: () => 'Runs a single iteration.',
    onNonEmpty: phrases => capitalize(phrases.join(', then ') + '.'),
  })

/** The plan that will actually run once the overrides are applied. */
export const applyOverrides = (
  plan: LoadPlan,
  overrides: RunOverrides,
): LoadPlan => {
  const duration = overrides.duration ?? planDuration(plan)
  if (overrides.rate !== undefined) {
    const amount = overrides.rate
    return {
      model: 'rate',
      start: amount,
      stages: [{ duration, target: amount }],
    }
  }
  if (overrides.vus !== undefined) {
    const amount = overrides.vus
    return {
      model: 'vus',
      start: amount,
      stages: [{ duration, target: amount }],
    }
  }
  // Only the duration changed: stretch every stage by the same factor.
  const factor = duration / Math.max(1, planDuration(plan))
  return {
    model: plan.model,
    start: plan.start,
    stages: Array.map(plan.stages, stage => ({
      duration: stage.duration * factor,
      target: stage.target,
    })),
  }
}

/** The planned load at `t` seconds into a plan. */
export const plannedAt = (plan: LoadPlan, t: number): number =>
  pipe(
    plan.stages,
    Array.reduce(
      { from: plan.start, elapsed: 0, value: Option.none<number>() },
      (state, stage) => {
        if (Option.isSome(state.value)) {
          return state
        }
        const end = state.elapsed + stage.duration
        const value =
          t < end
            ? Option.some(
                state.from +
                  ((stage.target - state.from) * (t - state.elapsed)) /
                    stage.duration,
              )
            : Option.none()
        return { from: stage.target, elapsed: end, value }
      },
    ),
    state => Option.getOrElse(state.value, () => state.from),
  )

/**
 * The planned load of all scenarios together at `t` (a scenario adds
 * nothing before its `startAfter` or after its plan ends).
 */
export const plannedTotalAt = (
  scenarios: ReadonlyArray<ScenarioInfo>,
  t: number,
): number =>
  scenarios.reduce((sum, scenario) => {
    const local = t - scenario.startAfter
    const inside = local >= 0 && local <= planDuration(scenario.plan)
    return inside ? sum + plannedAt(scenario.plan, local) : sum
  }, 0)

/** The corner points of a plan: [seconds, load] pairs, for drawing. */
export const planPoints = (
  plan: LoadPlan,
): ReadonlyArray<readonly [number, number]> =>
  pipe(
    plan.stages,
    Array.mapAccum(0, (elapsed, stage) => [
      elapsed + stage.duration,
      [elapsed + stage.duration, stage.target] as const,
    ]),
    ([, points]) => Array.prepend(points, [0, plan.start] as const),
  )
