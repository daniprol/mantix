/**
 * The endpoint list, under the timeline and aligned with it: the name in
 * the gutter, a small p95 curve under the plot, the numbers under the end
 * labels. "All requests" comes first; each endpoint after it is a link to
 * its own page.
 *
 * One run: p50, p95, errors. Two runs: baseline p95, this run's p95, and
 * the verdict on the change, with the range it most likely lies in.
 */
import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { Compare, EndpointStats, Second } from '@mantix/api'

import { COLUMNS } from '../charts/layout.ts'
import { type ComparedRow, readP95 } from '../domain/compare.ts'
import * as Format from '../domain/format.ts'
import type { Range } from '../domain/span.ts'
import { hasEnoughForP95, p95Curve } from '../domain/stats.ts'
import type { Message } from '../message.ts'
import { changeView } from './change.ts'
import { curveView } from './curve.ts'
import { endpointName, missing, quantity } from './parts.ts'

/** What every row needs to draw its curve on the timeline's clock. */
export type ListContext = Readonly<{
  current: ReadonlyArray<Second>
  maybeBaseline: Option.Option<ReadonlyArray<Second>>
  duration: number
  maybeRange: Option.Option<Range>
  spanLabel: string
  hrefOf: (endpoint: string) => string
}>

const ALL_REQUESTS = 'All requests'

const rowClass = `grid h-11 items-center border-b border-hairline`

/** One run: three equal columns. Two runs: the change gets more room. */
type Columns = 'Even' | 'WideLast'

const numbers = (
  cells: ReadonlyArray<Html>,
  columns: Columns,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Class('grid gap-x-2 text-right text-[13px]'),
      h.Style({
        'grid-template-columns':
          columns === 'Even'
            ? 'repeat(3, minmax(0, 1fr))'
            : 'minmax(0, 1fr) minmax(0, 1fr) 92px',
      }),
    ],
    [...cells],
  )

const curveOf = (
  context: ListContext,
  maybeEndpoint: Option.Option<string>,
  h: HtmlBuilder<Message>,
): Html =>
  curveView(
    {
      current: p95Curve(context.current, maybeEndpoint),
      maybeBaseline: Option.map(context.maybeBaseline, seconds =>
        p95Curve(seconds, maybeEndpoint),
      ),
      duration: context.duration,
      maybeRange: context.maybeRange,
    },
    h,
  )

/** A row: the whole line is a link, except for "All requests". */
const row = (
  key: string,
  maybeHref: Option.Option<string>,
  name: Html,
  curve: Html,
  cells: ReadonlyArray<Html>,
  columns: Columns,
  h: HtmlBuilder<Message>,
): Html => {
  const children = [
    h.div([h.Class('min-w-0 pr-4')], [name]),
    h.div([]),
    curve,
    numbers(cells, columns, h),
  ]
  const style = h.Style({ 'grid-template-columns': COLUMNS })
  return Option.match(maybeHref, {
    onNone: () => h.keyed('div')(key, [h.Class(rowClass), style], children),
    onSome: href =>
      h.keyed('a')(
        key,
        [
          h.Href(href),
          h.Class(
            `${rowClass} -mx-3 px-3 transition-colors duration-150 ease-out hover:bg-wash`,
          ),
          style,
        ],
        children,
      ),
  })
}

const header = (
  spanLabel: string,
  titles: ReadonlyArray<string>,
  columns: Columns,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Class('grid items-end border-b border-hairline pb-2'),
      h.Style({ 'grid-template-columns': COLUMNS }),
    ],
    [
      h.div(
        [h.Class('flex items-baseline gap-3')],
        [
          h.h2([h.Class('text-[15px] font-medium text-ink')], ['Endpoints']),
          h.span([h.Class('num text-[12px] text-ink-2')], [spanLabel]),
        ],
      ),
      h.div([]),
      h.div([h.Class('text-[12px] text-ink-2')], ['p95']),
      numbers(
        titles.map(title =>
          h.span([h.Class('text-[12px] text-ink-2')], [title]),
        ),
        columns,
        h,
      ),
    ],
  )

const p95Cell = (stats: EndpointStats, h: HtmlBuilder<Message>): Html =>
  hasEnoughForP95(stats.requests)
    ? quantity(Format.latency(stats.latency.p95), h)
    : missing(`n=${stats.requests}`, h)

const errorsCell = (stats: EndpointStats, h: HtmlBuilder<Message>): Html =>
  h.span(
    [h.Class(`num ${stats.errors > 0 ? 'text-danger' : 'text-ink'}`)],
    [Format.grouped(stats.errors)],
  )

const singleCells = (
  stats: EndpointStats,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  quantity(Format.latency(stats.latency.p50), h),
  p95Cell(stats, h),
  errorsCell(stats, h),
]

export const endpointListView = (
  total: EndpointStats,
  rows: ReadonlyArray<EndpointStats>,
  context: ListContext,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.Class('mt-10'), h.AriaLabel('Endpoints')],
    [
      header(context.spanLabel, ['p50', 'p95', 'errors'], 'Even', h),
      row(
        ALL_REQUESTS,
        Option.none(),
        h.span([h.Class('text-ink')], [ALL_REQUESTS]),
        curveOf(context, Option.none(), h),
        singleCells(total, h),
        'Even',
        h,
      ),
      ...rows.map(stats =>
        row(
          stats.endpoint,
          Option.some(context.hrefOf(stats.endpoint)),
          endpointName(stats.endpoint, h),
          curveOf(context, Option.some(stats.endpoint), h),
          singleCells(stats, h),
          'Even',
          h,
        ),
      ),
    ],
  )

const comparedCells = (
  maybeCurrent: Option.Option<EndpointStats>,
  maybeBaseline: Option.Option<EndpointStats>,
  maybeComparison: Option.Option<Compare.EndpointComparison>,
  band: number,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const p95 = (maybeStats: Option.Option<EndpointStats>) =>
    Option.match(maybeStats, {
      onNone: () => missing('–', h),
      onSome: stats => p95Cell(stats, h),
    })
  return [
    h.span([h.Class('text-ink-2')], [p95(maybeBaseline)]),
    p95(maybeCurrent),
    Option.match(maybeComparison, {
      onNone: () => missing('–', h),
      onSome: compared => changeView(readP95(compared, band), h),
    }),
  ]
}

export const comparedListView = (
  comparison: Compare.Comparison,
  totals: Readonly<{ current: EndpointStats; baseline: EndpointStats }>,
  rows: ReadonlyArray<ComparedRow>,
  context: ListContext,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.Class('mt-10'), h.AriaLabel('Endpoints')],
    [
      header(
        context.spanLabel,
        ['baseline', 'this run', 'change'],
        'WideLast',
        h,
      ),
      row(
        ALL_REQUESTS,
        Option.none(),
        h.span([h.Class('text-ink')], [ALL_REQUESTS]),
        curveOf(context, Option.none(), h),
        comparedCells(
          Option.some(totals.current),
          Option.some(totals.baseline),
          Option.some(comparison.total),
          comparison.band,
          h,
        ),
        'WideLast',
        h,
      ),
      ...rows.map(compared =>
        row(
          compared.endpoint,
          Option.some(context.hrefOf(compared.endpoint)),
          endpointName(compared.endpoint, h),
          curveOf(context, Option.some(compared.endpoint), h),
          comparedCells(
            compared.maybeCurrent,
            compared.maybeBaseline,
            compared.maybeComparison,
            comparison.band,
            h,
          ),
          'WideLast',
          h,
        ),
      ),
    ],
  )
