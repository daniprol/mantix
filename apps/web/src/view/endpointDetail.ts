/**
 * Under the timeline on an endpoint's page: its latency percentiles, its
 * status codes and its failures grouped by problem. When comparing, each
 * one shows the baseline next to this run.
 */
import { Array, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import {
  type EndpointStats,
  type ErrorGroup,
  type Second,
  exampleText,
  groupErrors,
} from '@mantix/api'

import { COLUMNS } from '../charts/layout.ts'
import * as Format from '../domain/format.ts'
import { statusCounts } from '../domain/stats.ts'
import type { Message } from '../message.ts'
import { missing, quantity } from './parts.ts'

/** One side of the page: this run, or the baseline. */
export type Side = Readonly<{
  label: string
  stats: EndpointStats
  seconds: ReadonlyArray<Second>
}>

const block = (
  title: string,
  content: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [
      h.Class('grid border-b border-hairline py-4'),
      h.Style({ 'grid-template-columns': COLUMNS }),
      h.AriaLabel(title),
    ],
    [
      h.h2([h.Class('text-[13px] font-medium text-ink')], [title]),
      h.div([h.Class('col-span-3 min-w-0')], [...content]),
    ],
  )

const PERCENTILES = ['p50', 'p90', 'p95', 'p99', 'max'] as const

const latencyRow = (
  side: Side,
  isMuted: boolean,
  hasLabel: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('tr')(
    side.label,
    [h.Class(isMuted ? 'text-ink-2' : 'text-ink')],
    [
      h.td(
        [h.Class('pr-6 text-[12px] text-ink-2')],
        [hasLabel ? side.label : ''],
      ),
      ...PERCENTILES.map(name =>
        h.td(
          [h.Class('pr-8 text-right')],
          [quantity(Format.latency(side.stats.latency[name]), h)],
        ),
      ),
      h.td([h.Class('num text-right')], [Format.grouped(side.stats.requests)]),
    ],
  )

const latencyBlock = (
  sides: ReadonlyArray<Side>,
  h: HtmlBuilder<Message>,
): Html =>
  block(
    'Percentiles',
    [
      h.table(
        [h.Class('text-[13px]')],
        [
          h.thead(
            [],
            [
              h.tr(
                [h.Class('text-[12px] text-ink-2')],
                [
                  h.th([h.Class('pr-6 text-left font-normal')]),
                  ...[...PERCENTILES, 'requests'].map(name =>
                    h.th(
                      [h.Class('pr-8 text-right font-normal last:pr-0')],
                      [name],
                    ),
                  ),
                ],
              ),
            ],
          ),
          h.tbody(
            [],
            sides.map((side, index) =>
              latencyRow(side, index > 0, sides.length > 1, h),
            ),
          ),
        ],
      ),
    ],
    h,
  )

const statusLine = (
  side: Side,
  hasLabel: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-wrap items-baseline gap-x-6 gap-y-1')],
    [
      hasLabel
        ? h.span([h.Class('w-16 text-[12px] text-ink-2')], [side.label])
        : h.empty,
      ...Array.match(statusCounts(side.seconds), {
        onEmpty: () => [missing('–', h)],
        onNonEmpty: counts =>
          counts.map(([status, count]) =>
            h.span(
              [h.Class('num')],
              [
                h.span(
                  [h.Class(Number(status) >= 400 ? 'text-danger' : 'text-ink')],
                  [status],
                ),
                h.span(
                  [h.Class('ml-1.5 text-ink-2')],
                  [`× ${Format.grouped(count)}`],
                ),
              ],
            ),
          ),
      }),
    ],
  )

const statusBlock = (
  sides: ReadonlyArray<Side>,
  h: HtmlBuilder<Message>,
): Html =>
  block(
    'Status codes',
    [
      h.div(
        [h.Class('flex flex-col gap-1.5')],
        sides.map(side => statusLine(side, sides.length > 1, h)),
      ),
    ],
    h,
  )

/** "03:06 – 03:35", or one time when it happened in a single second. */
const when = (group: ErrorGroup): string =>
  group.firstSeen === group.lastSeen
    ? Format.clock(group.firstSeen)
    : `${Format.clock(group.firstSeen)} – ${Format.clock(group.lastSeen + 1)}`

/** The latest few examples that say more than the group's description. */
const examplesOf = (
  group: ErrorGroup,
): ReadonlyArray<{ readonly t: number; readonly text: string }> => {
  const seen = new Set<string>()
  return group.examples
    .flatMap(example => {
      const text = exampleText(group.detail, example)
      if (text === undefined || seen.has(text)) return []
      seen.add(text)
      return [{ t: example.t, text }]
    })
    .slice(-3)
}

const examplesView = (group: ErrorGroup, h: HtmlBuilder<Message>): Html =>
  Array.match(examplesOf(group), {
    onEmpty: () => h.empty,
    onNonEmpty: examples =>
      h.div(
        [h.Class('flex min-w-0 flex-col gap-0.5 pt-1 text-[12px]')],
        examples.map(({ t, text }) =>
          h.div(
            [h.Class('flex min-w-0 items-baseline gap-4')],
            [
              h.span([h.Class('num shrink-0 text-ink-3')], [Format.clock(t)]),
              h.span(
                [h.Class('num truncate text-ink-2'), h.Title(text)],
                [text],
              ),
            ],
          ),
        ),
      ),
  })

const failureRow = (
  group: ErrorGroup,
  counts: ReadonlyArray<Html>,
  showExamples: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('li')(
    group.fingerprint,
    [
      h.Class('grid items-baseline gap-x-4 py-1.5'),
      h.Style({ 'grid-template-columns': 'minmax(0, 1fr) auto' }),
    ],
    [
      h.div(
        [h.Class('flex min-w-0 flex-wrap items-baseline gap-x-4')],
        [
          h.span([h.Class('text-danger')], [group.kind]),
          h.span([h.Class('num truncate text-ink')], [group.detail]),
          h.span([h.Class('num text-[12px] text-ink-2')], [when(group)]),
        ],
      ),
      h.div([h.Class('flex gap-6 text-right')], [...counts]),
      showExamples ? examplesView(group, h) : h.empty,
    ],
  )

const countCell = (
  count: number,
  isMuted: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.span(
    [h.Class(`num w-16 ${isMuted ? 'text-ink-2' : 'text-ink'}`)],
    [Format.grouped(count)],
  )

const failuresBlock = (
  current: Side,
  maybeBaseline: Option.Option<Side>,
  showExamples: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const groups = groupErrors(current.seconds)
  const baselineGroups = Option.match(maybeBaseline, {
    onNone: () => [],
    onSome: baseline => groupErrors(baseline.seconds),
  })
  // Problems only the baseline had are listed too: they were fixed.
  const fixed = baselineGroups.filter(
    group => !groups.some(each => each.fingerprint === group.fingerprint),
  )
  const countIn = (list: ReadonlyArray<ErrorGroup>, fingerprint: string) =>
    Array.findFirst(list, each => each.fingerprint === fingerprint).pipe(
      Option.match({ onNone: () => 0, onSome: each => each.count }),
    )
  const counts = (group: ErrorGroup) =>
    Option.isSome(maybeBaseline)
      ? [
          countCell(countIn(baselineGroups, group.fingerprint), true, h),
          countCell(countIn(groups, group.fingerprint), false, h),
        ]
      : [countCell(group.count, false, h)]
  return block(
    'Failures',
    [
      Array.match([...groups, ...fixed], {
        onEmpty: () => missing('0', h),
        onNonEmpty: list =>
          h.ul(
            [h.Class('flex flex-col text-[13px]')],
            [
              Option.isSome(maybeBaseline)
                ? h.li(
                    [
                      h.Class(
                        'flex justify-end gap-6 pb-1 text-right text-[12px] text-ink-2',
                      ),
                    ],
                    [
                      h.span([h.Class('w-16')], ['baseline']),
                      h.span([h.Class('w-16')], ['this run']),
                    ],
                  )
                : h.empty,
              ...list.map(group =>
                failureRow(group, counts(group), showExamples, h),
              ),
            ],
          ),
      }),
    ],
    h,
  )
}

/**
 * `showExamples`: the error messages and values as they arrived. A Summary
 * report leaves them out (see ReportDetail in @mantix/api).
 */
export const endpointDetailView = (
  current: Side,
  maybeBaseline: Option.Option<Side>,
  showExamples: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const sides = [current, ...Option.toArray(maybeBaseline)]
  return h.div(
    [h.Class('mt-10 border-t border-hairline')],
    [
      latencyBlock(sides, h),
      statusBlock(sides, h),
      failuresBlock(current, maybeBaseline, showExamples, h),
    ],
  )
}
