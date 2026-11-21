/**
 * The three headline figures in one row: throughput, p99 and errors. Each
 * turns red only when it breaks a threshold the test set.
 */
import { Array, Option, pipe } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { RunInfo } from '@mantix/api'

import * as Format from '../domain/format.ts'
import { type Figures, MIN_SAMPLES_FOR_P99 } from '../domain/stats.ts'
import * as Threshold from '../domain/threshold.ts'
import type { Message } from '../message.ts'
import type { Window } from '../model.ts'
import { quantity } from './parts.ts'

/** Is there a whole-run threshold on `metric` that `actual` breaks? */
const breaches = (
  run: RunInfo,
  metric: Threshold.Metric,
  actual: number,
): boolean =>
  pipe(
    run.thresholds,
    Array.filter(result => result.endpoint === undefined),
    Array.flatMap(result => Option.toArray(Threshold.parse(result.expression))),
    Array.some(
      threshold =>
        threshold.metric === metric && Threshold.isBreached(threshold, actual),
    ),
  )

const figure = (
  title: string,
  value: Html,
  note: string,
  isBreached: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex min-w-0 flex-col')],
    [
      h.span([h.Class('text-[12px] text-ink-3')], [title]),
      h.span(
        [
          h.Class(
            `mt-1 text-[26px] leading-none font-medium tracking-[-0.01em] ${isBreached ? 'text-danger' : 'text-ink'}`,
          ),
        ],
        [value],
      ),
      h.span(
        [
          h.Class(
            `mt-2 text-[12px] ${isBreached ? 'text-danger' : 'text-ink-3'}`,
          ),
        ],
        [note],
      ),
    ],
  )

const windowNote = (window: Window): string =>
  window === 'Recent' ? 'last 30 s' : 'whole run'

export const figuresView = (
  run: RunInfo,
  figures: Figures,
  window: Window,
  h: HtmlBuilder<Message>,
): Html => {
  const isRate = run.plan.every(scenario => scenario.plan.model === 'rate')
  const hasEnough = figures.requests >= MIN_SAMPLES_FOR_P99
  const errorPercent = figures.errorRate * 100
  // The plan counts iterations (one pass through the test, often several
  // requests), so the note compares iterations with iterations.
  const throughputNote = isRate
    ? `${Format.significant(figures.iterations)} iterations/s of ${Format.significant(figures.target)} planned`
    : `${Format.grouped(figures.vus)} users of ${Format.grouped(figures.target)} planned`
  return h.div(
    [h.Class('grid grid-cols-3 gap-6 sm:gap-12 sm:flex')],
    [
      figure(
        'Requests',
        quantity(Format.rate(figures.achieved), h),
        throughputNote,
        breaches(run, 'rps', figures.achieved),
        h,
      ),
      figure(
        'p99 latency',
        hasEnough
          ? quantity(Format.latency(figures.p99), h)
          : h.span([h.Class('num text-ink-3')], ['n<100']),
        hasEnough
          ? windowNote(window)
          : `${Format.grouped(figures.requests)} requests so far`,
        hasEnough && breaches(run, 'p99', figures.p99),
        h,
      ),
      figure(
        'Errors',
        quantity(Format.percent(figures.errorRate), h),
        figures.errorRate === 0
          ? windowNote(window)
          : `${Format.grouped(Math.round(figures.errorRate * figures.requests))} failed · ${windowNote(window)}`,
        breaches(run, 'errors', errorPercent),
        h,
      ),
    ],
  )
}
