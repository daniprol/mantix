/**
 * The one sentence at the top of a finished run: did it pass?
 */
import { Array, Match } from 'effect'

import type { RunInfo } from '@mantix/api'

import * as Format from './format.ts'
import * as Threshold from './threshold.ts'

export type Verdict = Readonly<{
  tone: 'Passed' | 'Failed' | 'Neutral'
  headline: string
  detail: string
}>

const ranFor = (run: RunInfo, secondsSeen: number): string =>
  Match.value(run.status).pipe(
    Match.when('stopped', () => `Stopped after ${Format.clock(secondsSeen)}`),
    Match.when(
      'aborted',
      () => `Stopped by a threshold after ${Format.clock(secondsSeen)}`,
    ),
    Match.when('crashed', () => `Ended after ${Format.clock(secondsSeen)}`),
    Match.orElse(() => `Ran the full ${Format.clock(secondsSeen)}`),
  )

const passedHeadline = (count: number): string =>
  count === 1
    ? 'Passed its threshold'
    : count === 2
      ? 'Passed both thresholds'
      : `Passed all ${count} thresholds`

export const verdict = (run: RunInfo, secondsSeen: number): Verdict => {
  const detail = ranFor(run, secondsSeen)
  if (run.status === 'crashed') {
    return {
      tone: 'Failed',
      headline: `Mantix stopped with an error: ${run.error ?? 'unknown error'}`,
      detail,
    }
  }
  const failures = run.thresholds.filter(result => !result.passed)
  return Array.match(failures, {
    onEmpty: () =>
      Array.isReadonlyArrayEmpty(run.thresholds)
        ? {
            tone: 'Neutral',
            headline: 'Finished. No thresholds were set',
            detail,
          }
        : {
            tone: 'Passed',
            headline: passedHeadline(run.thresholds.length),
            detail,
          },
    onNonEmpty: failed => ({
      tone: 'Failed',
      headline: `Failed: ${failed.map(Threshold.describeFailure).join('; ')}`,
      detail,
    }),
  })
}
