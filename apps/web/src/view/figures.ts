/**
 * The three headline figures: throughput, p95 latency and errors, for the
 * span the page shows. Each turns red only when it breaks one of the run's
 * checks. When comparing, the note under each one is the baseline's value.
 */
import { Array, Option, pipe } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { ThresholdResult } from '@mantix/api'

import * as Format from '../domain/format.ts'
import { type Figures, hasEnoughForP95 } from '../domain/stats.ts'
import * as Threshold from '../domain/threshold.ts'
import type { Message } from '../message.ts'
import { missing, quantity } from './parts.ts'

/** Does one of these checks on `metric` fail for `actual`? */
const breaches = (
  checks: ReadonlyArray<ThresholdResult>,
  metric: Threshold.Metric,
  actual: number,
): boolean =>
  pipe(
    checks,
    Array.flatMap(check => Option.toArray(Threshold.parse(check.expression))),
    Array.some(
      threshold =>
        threshold.metric === metric && Threshold.isBreached(threshold, actual),
    ),
  )

const figure = (
  title: string,
  value: Html,
  note: Html,
  isBreached: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex min-w-[7.5rem] flex-col')],
    [
      h.span([h.Class('text-[13px] text-ink-2')], [title]),
      h.span(
        [
          h.Class(
            `mt-1 text-[26px] leading-tight tracking-[-0.01em] ${isBreached ? 'text-danger' : 'text-ink'}`,
          ),
        ],
        [value],
      ),
      h.span([h.Class('mt-1 text-[12px] text-ink-2')], [note]),
    ],
  )

const p95Value = (figures: Figures, h: HtmlBuilder<Message>): Html =>
  hasEnoughForP95(figures.requests)
    ? quantity(Format.latency(figures.p95), h)
    : missing(`n=${figures.requests}`, h)

/** "baseline 248 ms" */
const baselineNote = (value: Html, h: HtmlBuilder<Message>): Html =>
  h.span([], ['baseline ', value])

export const figuresView = (
  figures: Figures,
  maybeBaseline: Option.Option<Figures>,
  checks: ReadonlyArray<ThresholdResult>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-wrap gap-x-12 gap-y-4'), h.AriaLabel('Figures')],
    [
      figure(
        'Throughput',
        quantity(Format.rate(figures.rps), h),
        Option.match(maybeBaseline, {
          onNone: () =>
            h.span(
              [h.Class('num')],
              [`${Format.grouped(figures.requests)} requests`],
            ),
          onSome: baseline =>
            baselineNote(quantity(Format.rate(baseline.rps), h), h),
        }),
        breaches(checks, 'rps', figures.rps),
        h,
      ),
      figure(
        'p95 latency',
        p95Value(figures, h),
        Option.match(maybeBaseline, {
          onNone: () =>
            h.span([], ['p50 ', quantity(Format.latency(figures.p50), h)]),
          onSome: baseline => baselineNote(p95Value(baseline, h), h),
        }),
        hasEnoughForP95(figures.requests) &&
          breaches(checks, 'p95', figures.p95),
        h,
      ),
      figure(
        'Errors',
        quantity(Format.percent(figures.errorRate), h),
        Option.match(maybeBaseline, {
          onNone: () =>
            h.span(
              [h.Class('num')],
              [`${Format.grouped(figures.errors)} failed`],
            ),
          onSome: baseline =>
            baselineNote(quantity(Format.percent(baseline.errorRate), h), h),
        }),
        breaches(checks, 'errors', figures.errorRate * 100),
        h,
      ),
    ],
  )

/** The run's checks as data: pass or fail, the expression, the value. */
export const checksView = (
  checks: ReadonlyArray<ThresholdResult>,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(checks, {
    onEmpty: () => h.empty,
    onNonEmpty: list =>
      h.table(
        [h.Class('self-center text-[12px]'), h.AriaLabel('Checks')],
        [
          h.tbody(
            [],
            list.map(check =>
              h.keyed('tr')(
                `${check.endpoint ?? ''}:${check.expression}`,
                [],
                [
                  h.td(
                    [
                      h.Class(
                        `pr-4 ${check.passed ? 'text-ink-2' : 'text-danger'}`,
                      ),
                    ],
                    [check.passed ? 'pass' : 'fail'],
                  ),
                  h.td(
                    [h.Class('num pr-6 text-ink')],
                    [
                      check.endpoint === undefined
                        ? check.expression
                        : `${check.endpoint} ${check.expression}`,
                    ],
                  ),
                  h.td(
                    [
                      h.Class(
                        `num text-right ${check.passed ? 'text-ink' : 'text-danger'}`,
                      ),
                    ],
                    [
                      Option.getOrElse(Threshold.formatActual(check), () =>
                        String(check.actual),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
  })
