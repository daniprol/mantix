/**
 * Reading the two load inputs of the New run page into RunOverrides.
 */
import { Option } from 'effect'

import type { LoadPlan, RunOverrides, TestInfo } from '@mantix/api'

import type { LoadForm } from '../model.ts'
import { parseSpan } from './format.ts'

export type ReadLoadForm = Readonly<{
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

export const readLoadForm = (form: LoadForm, test: TestInfo): ReadLoadForm => {
  const loadText = form.load.trim()
  const durationText = form.duration.trim()
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
    maybeLoadError: isLoadValid ? Option.none() : Option.some('above 0'),
    maybeDurationError: isDurationValid
      ? Option.none()
      : Option.some('90s, 2m, 1h'),
  }
}

export const isValid = (read: ReadLoadForm): boolean =>
  Option.isNone(read.maybeLoadError) && Option.isNone(read.maybeDurationError)
