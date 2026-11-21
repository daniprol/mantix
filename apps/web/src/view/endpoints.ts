/**
 * The endpoints table, slowest p99 first. Clicking a row opens its details
 * in place: more percentiles, corrected versus uncorrected latency, status
 * codes and recent errors.
 */
import { Array, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { EndpointStats, Second } from '@mantix/api'

import * as Format from '../domain/format.ts'
import {
  MIN_SAMPLES_FOR_P99,
  recentErrorSamples,
  statusCounts,
} from '../domain/stats.ts'
import { Message } from '../message.ts'
import { quantity } from './parts.ts'

const COLUMNS = 'grid grid-cols-[minmax(0,1fr)_repeat(4,5.5rem)] gap-x-4'

/** "GET /cart/:id" → method set apart, muted, the route in full. */
const endpointName = (endpoint: string, h: HtmlBuilder<Message>): Html => {
  const [method, ...rest] = endpoint.split(' ')
  return rest.length === 0
    ? h.span([h.Class('num truncate')], [endpoint])
    : h.span(
        [h.Class('flex min-w-0 items-baseline gap-2')],
        [
          h.span(
            [h.Class('num w-10 shrink-0 text-[11px] text-ink-3')],
            [method ?? ''],
          ),
          h.span([h.Class('num truncate text-ink')], [rest.join(' ')]),
        ],
      )
}

const p99Cell = (row: EndpointStats, h: HtmlBuilder<Message>): Html =>
  row.requests < MIN_SAMPLES_FOR_P99
    ? h.span([h.Class('num text-ink-3')], ['n<100'])
    : quantity(Format.latency(row.latency.p99), h)

const errorCell = (row: EndpointStats, h: HtmlBuilder<Message>): Html =>
  row.errors === 0
    ? h.span([h.Class('num text-ink-3')], ['0%'])
    : quantity(Format.percent(row.errorRate), h, 'text-danger/70')

const headerRow = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class(
        `${COLUMNS} border-b border-hairline px-3 pb-2 text-[12px] text-ink-3`,
      ),
      h.AriaHidden(true),
    ],
    [
      h.span([], ['Endpoint']),
      ...['req/s', 'p50', 'p99', 'errors'].map(title =>
        h.span([h.Class('text-right')], [title]),
      ),
    ],
  )

const stat = (title: string, value: Html, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-0.5')],
    [h.span([h.Class('text-[11px] text-ink-3')], [title]), value],
  )

const detail = (
  row: EndpointStats,
  seconds: ReadonlyArray<Second>,
  h: HtmlBuilder<Message>,
): Html => {
  const statuses = statusCounts(seconds, row.endpoint)
  const samples = recentErrorSamples(seconds, row.endpoint)
  const hasEnough = row.requests >= MIN_SAMPLES_FOR_P99
  return h.div(
    [
      h.Class(
        'grid gap-6 border-b border-hairline px-3 pt-3 pb-5 pl-[3.75rem] sm:grid-cols-[auto_minmax(0,1fr)]',
      ),
    ],
    [
      h.div(
        [h.Class('flex flex-col gap-5')],
        [
          h.div(
            [h.Class('flex flex-wrap gap-x-6 gap-y-3')],
            [
              stat('p50', quantity(Format.latency(row.latency.p50), h), h),
              stat('p90', quantity(Format.latency(row.latency.p90), h), h),
              stat('p95', quantity(Format.latency(row.latency.p95), h), h),
              stat(
                'p99',
                hasEnough
                  ? quantity(Format.latency(row.latency.p99), h)
                  : h.span([h.Class('num text-ink-3')], ['n<100']),
                h,
              ),
              stat('max', quantity(Format.latency(row.latency.max), h), h),
              stat(
                'requests',
                h.span([h.Class('num')], [Format.grouped(row.requests)]),
                h,
              ),
            ],
          ),
          h.div(
            [h.Class('max-w-[46ch]')],
            [
              h.div(
                [h.Class('flex flex-wrap items-baseline gap-x-5 gap-y-1')],
                [
                  h.span(
                    [h.Class('text-ink-2')],
                    [
                      'p99 corrected ',
                      quantity(Format.latency(row.latency.p99), h),
                    ],
                  ),
                  h.span(
                    [h.Class('text-ink-3')],
                    [
                      'uncorrected ',
                      quantity(Format.latency(row.uncorrected.p99), h),
                    ],
                  ),
                ],
              ),
              h.p(
                [h.Class('mt-1 text-[12px] text-ink-3')],
                [
                  'Corrected latency starts the clock when a request should have been sent, so time spent waiting behind a slow server counts. Uncorrected starts it when the request actually left.',
                ],
              ),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class('flex flex-col gap-4 text-[12px]')],
        [
          h.div(
            [],
            [
              h.div([h.Class('mb-1 text-[11px] text-ink-3')], ['Status codes']),
              Array.match(statuses, {
                onEmpty: () => h.span([h.Class('text-ink-3')], ['None yet']),
                onNonEmpty: list =>
                  h.div(
                    [h.Class('num flex flex-wrap gap-x-4 gap-y-1')],
                    list.map(([status, count]) =>
                      h.span(
                        [
                          h.Class(
                            Number(status) >= 400
                              ? 'text-danger'
                              : 'text-ink-2',
                          ),
                        ],
                        [
                          status,
                          h.span(
                            [h.Class('ml-1.5 text-ink-3')],
                            [`× ${Format.grouped(count)}`],
                          ),
                        ],
                      ),
                    ),
                  ),
              }),
            ],
          ),
          h.div(
            [],
            [
              h.div(
                [h.Class('mb-1 text-[11px] text-ink-3')],
                ['Recent errors'],
              ),
              Array.match(samples, {
                onEmpty: () =>
                  h.span([h.Class('text-ink-3')], ['No errors in this window']),
                onNonEmpty: list =>
                  h.ul(
                    [h.Class('flex flex-col gap-1')],
                    list.map(sample =>
                      h.keyed('li')(
                        `${sample.kind}:${sample.message}`,
                        [h.Class('flex min-w-0 items-baseline gap-2')],
                        [
                          h.span(
                            [h.Class('shrink-0 text-danger')],
                            [sample.kind],
                          ),
                          h.span(
                            [h.Class('num truncate text-ink-2')],
                            [sample.message],
                          ),
                          sample.count > 1
                            ? h.span(
                                [h.Class('num shrink-0 text-ink-3')],
                                [`× ${sample.count}`],
                              )
                            : h.empty,
                        ],
                      ),
                    ),
                  ),
              }),
            ],
          ),
        ],
      ),
    ],
  )
}

const row = (
  stats: EndpointStats,
  isExpanded: boolean,
  seconds: ReadonlyArray<Second>,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('div')(
    stats.endpoint,
    [],
    [
      h.button(
        [
          h.Type('button'),
          h.Class(
            `${COLUMNS} relative h-9 w-full items-center px-3 text-left transition-colors duration-150 ease-out hover:bg-wash ${
              isExpanded ? 'bg-wash' : 'border-b border-hairline'
            }`,
          ),
          h.AriaExpanded(isExpanded),
          h.OnClick(Message.ClickedEndpoint({ endpoint: stats.endpoint })),
        ],
        [
          isExpanded
            ? h.span([
                h.Class('absolute inset-y-0 left-0 w-0.5 bg-accent'),
                h.AriaHidden(true),
              ])
            : h.empty,
          endpointName(stats.endpoint, h),
          h.span(
            [h.Class('text-right')],
            [quantity(Format.rate(stats.rps), h)],
          ),
          h.span(
            [h.Class('text-right')],
            [quantity(Format.latency(stats.latency.p50), h)],
          ),
          h.span([h.Class('text-right text-ink')], [p99Cell(stats, h)]),
          h.span([h.Class('text-right')], [errorCell(stats, h)]),
        ],
      ),
      isExpanded ? detail(stats, seconds, h) : h.empty,
    ],
  )

export const endpointsView = (
  rows: ReadonlyArray<EndpointStats>,
  seconds: ReadonlyArray<Second>,
  maybeExpanded: Option.Option<string>,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(rows, {
    onEmpty: () =>
      h.p(
        [h.Class('py-6 text-ink-3')],
        ['Endpoints appear here once the first requests finish.'],
      ),
    onNonEmpty: list =>
      h.div(
        [h.Class('text-[13px]')],
        [
          headerRow(h),
          ...list.map(stats =>
            row(
              stats,
              Option.contains(maybeExpanded, stats.endpoint),
              seconds,
              h,
            ),
          ),
        ],
      ),
  })
