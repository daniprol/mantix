/**
 * A run on screen, live or finished. Same layout for both: verdict (once it
 * is over), headline figures, timeline, endpoints.
 */
import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { RunInfo, Second } from '@mantix/api'

import { MountTimeline } from '../charts/timeline.ts'
import {
  RECENT_SECONDS,
  endpointRows,
  figures,
  isOver,
  laggedSeconds,
  lastSeconds,
} from '../domain/stats.ts'
import * as Threshold from '../domain/threshold.ts'
import { verdict } from '../domain/verdict.ts'
import { Message } from '../message.ts'
import type { Feed, Window } from '../model.ts'
import { endpointsView } from './endpoints.ts'
import { figuresView } from './figures.ts'
import { chip, quietButton } from './parts.ts'

const WINDOWS: ReadonlyArray<readonly [Window, string]> = [
  ['Recent', 'Last 30 s'],
  ['WholeRun', 'Whole run'],
]

const windowControl = (window: Window, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class('inline-flex h-7 rounded-md border border-hairline p-0.5'),
      h.Role('group'),
      h.AriaLabel('Summarise'),
    ],
    WINDOWS.map(([value, text]) =>
      h.keyed('button')(
        value,
        [
          h.Type('button'),
          h.AriaPressed(String(window === value)),
          h.OnClick(Message.SelectedWindow({ window: value })),
          h.Class(
            `rounded-[4px] px-2.5 text-[12px] transition-colors duration-150 ease-out ${
              window === value
                ? 'bg-wash text-ink'
                : 'text-ink-3 hover:text-ink-2'
            }`,
          ),
        ],
        [text],
      ),
    ),
  )

const lostBanner = (feed: Feed, h: HtmlBuilder<Message>): Html =>
  feed._tag === 'Lost'
    ? h.div(
        [
          h.Class(
            'mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-hairline py-3',
          ),
          h.Role('status'),
        ],
        [
          h.span(
            [h.Class('text-ink')],
            ['Lost the live connection to Mantix.'],
          ),
          h.span(
            [h.Class('text-ink-3')],
            [`The run may still be going. (${feed.error})`],
          ),
          h.div([h.Class('flex-1')]),
          quietButton('Reconnect', Message.ClickedReconnect(), h),
        ],
      )
    : h.empty

const verdictView = (
  run: RunInfo,
  secondsSeen: number,
  h: HtmlBuilder<Message>,
): Html => {
  const result = verdict(run, secondsSeen)
  return h.div(
    [h.Class('pt-10')],
    [
      h.p(
        [
          h.Class(
            `max-w-[60ch] text-[19px] leading-snug ${result.tone === 'Failed' ? 'text-danger' : 'text-ink'}`,
          ),
          h.Role('status'),
        ],
        [result.headline],
      ),
      h.div(
        [h.Class('mt-3 flex flex-wrap items-center gap-2')],
        [
          ...run.thresholds.map(threshold =>
            chip(
              threshold.endpoint === undefined
                ? threshold.expression
                : `${threshold.endpoint}: ${threshold.expression}`,
              h,
              {
                actual: Option.getOrElse(
                  Threshold.formatActual(threshold),
                  () => String(threshold.actual),
                ),
                failed: !threshold.passed,
              },
            ),
          ),
          h.span([h.Class('ml-2 text-[12px] text-ink-3')], [result.detail]),
        ],
      ),
    ],
  )
}

const lagNote = (
  seconds: ReadonlyArray<Second>,
  h: HtmlBuilder<Message>,
): Html => {
  const lagged = laggedSeconds(seconds).length
  return lagged === 0
    ? h.empty
    : h.p(
        [h.Class('mt-3 text-[12px] text-ink-3')],
        [
          `Mantix itself was overloaded for ${lagged} s; those seconds are shaded. Their numbers include Mantix’s own delay.`,
        ],
      )
}

const sectionTitle = (
  title: string,
  note: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('mb-3 flex items-baseline gap-3')],
    [
      h.h2([h.Class('text-[13px] font-medium text-ink')], [title]),
      h.span([h.Class('text-[12px] text-ink-3')], [note]),
    ],
  )

export const runView = (
  run: RunInfo,
  seconds: ReadonlyArray<Second>,
  feed: Feed,
  chosenWindow: Window,
  maybeExpandedEndpoint: Option.Option<string>,
  h: HtmlBuilder<Message>,
): Html => {
  const isLive = !isOver(run)
  const window: Window = isLive ? chosenWindow : 'WholeRun'
  const count = window === 'Recent' ? RECENT_SECONDS : seconds.length
  const windowed = lastSeconds(seconds, count)
  return h.div(
    [h.Class('pb-16')],
    [
      lostBanner(feed, h),
      isLive ? h.empty : verdictView(run, seconds.length, h),
      h.div(
        [h.Class('flex flex-wrap items-end justify-between gap-6 pt-10')],
        [
          figuresView(run, figures(seconds, count), window, h),
          isLive ? windowControl(chosenWindow, h) : h.empty,
        ],
      ),
      h.section(
        [h.Class('mt-10'), h.AriaLabel('Timeline')],
        [
          h.div([
            h.Class('relative min-h-[412px]'),
            h.Role('img'),
            h.AriaLabel(
              'Latency heatmap with p50 and p99 lines, and throughput against the plan, over time',
            ),
            h.OnMount(MountTimeline()),
          ]),
          lagNote(seconds, h),
        ],
      ),
      h.section(
        [h.Class('mt-12'), h.AriaLabel('Endpoints')],
        [
          sectionTitle(
            'Endpoints',
            `slowest p99 first · ${window === 'Recent' ? 'last 30 s' : 'whole run'}`,
            h,
          ),
          endpointsView(
            endpointRows(seconds, count),
            windowed,
            maybeExpandedEndpoint,
            h,
          ),
        ],
      ),
    ],
  )
}
