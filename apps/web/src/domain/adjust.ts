/**
 * Reading the two "Adjust load" inputs into RunOverrides.
 */
import { Option } from 'effect'

import type { LoadPlan, RunOverrides, TestInfo } from '@mantix/api'

import type { Adjust } from '../model.ts'
import { parseSpan } from './format.ts'
import { applyOverrides } from './plan.ts'

export type ReadAdjust = Readonly<{
  overrides: RunOverrides
  maybeLoadError: Option.Option<string>
  maybeDurationError: Option.Option<string>
}>

/** The test's plan model: open (rate) unless every scenario uses VUs. */
export const modelOf = (test: TestInfo): LoadPlan['model'] =>
  test.scenarios.length > 0 &&
  test.scenarios.every(scenario => scenario.plan.model === 'vus')
    ? 'vus'
    : 'rate'

export const readAdjust = (adjust: Adjust, test: TestInfo): ReadAdjust => {
  const loadText = adjust.load.trim()
  const durationText = adjust.duration.trim()
  const load = Number(loadText)
  const isLoadValid =
    loadText === '' || (Number.isFinite(load) && load > 0 && load <= 1e6)
  const maybeDuration = parseSpan(durationText)
  const isDurationValid = durationText === '' || maybeDuration !== undefined
  const model = modelOf(test)
  const loadOverride: RunOverrides =
    loadText === '' || !isLoadValid
      ? {}
      : model === 'rate'
        ? { rate: load }
        : { vus: Math.round(load) }
  const durationOverride: RunOverrides =
    maybeDuration === undefined ? {} : { duration: maybeDuration }
  return {
    overrides: { ...loadOverride, ...durationOverride },
    maybeLoadError: isLoadValid
      ? Option.none()
      : Option.some('Enter a number above zero.'),
    maybeDurationError: isDurationValid
      ? Option.none()
      : Option.some('Try 90s, 2m or 1h.'),
  }
}

export const isValid = (read: ReadAdjust): boolean =>
  Option.isNone(read.maybeLoadError) && Option.isNone(read.maybeDurationError)

/** The plan that will run, with the overrides applied, for the preview. */
export const effectivePlan = (
  test: TestInfo,
  overrides: RunOverrides,
): Option.Option<LoadPlan> =>
  Option.map(Option.fromNullishOr(test.scenarios[0]), scenario =>
    applyOverrides(scenario.plan, overrides),
  )
