/**
 * The page for a run, a comparison of two runs, or one endpoint of either.
 * The four share one layout, so learning one teaches all four:
 *
 *   run bar     who is on screen, its state, the actions
 *   figures     throughput, p95, errors for the span (+ checks, + span)
 *   timeline    load, latency, errors over time
 *   below       the endpoint list, or on an endpoint's page its details
 */
import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { type Analysis, checksFor, isRatePlan, secondsOf } from '../analysis.ts'
import { compareRows } from '../domain/compare.ts'
import {
  type Span,
  effectiveSpan,
  spanLabel,
  spanSeconds,
} from '../domain/span.ts'
import { endpointRows, figuresOf, isOver, summarize } from '../domain/stats.ts'
import { Message } from '../message.ts'
import type { Feed, LoadedRun, Model } from '../model.ts'
import {
  compareEndpointRouter,
  compareRouter,
  runEndpointRouter,
  runRouter,
} from '../route.ts'
import { endpointDetailView } from './endpointDetail.ts'
import { comparedListView, endpointListView } from './endpoints.ts'
import { checksView, figuresView } from './figures.ts'
import { button, buttonLink, endpointName, segmented } from './parts.ts'
import { barView, runIdentity, runStatus, testTitle } from './runBar.ts'
import { timelineView } from './timeline.ts'

// THE RUN BAR

const backArrow = (href: string, h: HtmlBuilder<Message>): Html =>
  h.a(
    [
      h.Href(href),
      h.AriaLabel('Back'),
      h.Class(
        '-ml-2 inline-flex size-7 shrink-0 items-center justify-center self-center rounded-md text-[15px] text-ink-2 hover:bg-wash hover:text-ink',
      ),
    ],
    ['←'],
  )

const crumb = (
  href: string,
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.a(
    [
      h.Href(href),
      h.Class(
        'flex min-w-0 items-baseline gap-2.5 hover:underline decoration-hairline underline-offset-4',
      ),
    ],
    [...children],
  )

const separator = (h: HtmlBuilder<Message>): Html =>
  h.span([h.Class('text-ink-3'), h.AriaHidden(true)], ['/'])

/** Where the page is: the test, the run(s), and the endpoint if any. */
const whereView = (
  analysis: Analysis,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const { current, maybeBaseline, maybeEndpoint } = analysis
  const run = current.run
  const parentHref = Option.match(maybeBaseline, {
    onNone: () => runRouter({ runId: run.id }),
    onSome: baseline =>
      compareRouter({ runId: run.id, baselineId: baseline.run.id }),
  })
  // In a breadcrumb the endpoint needs the room: runs get the short form.
  const isShort = Option.isSome(maybeEndpoint)
  const runs: ReadonlyArray<Html> = Option.match(maybeBaseline, {
    onNone: () => [runIdentity(run, h, { isShort })],
    onSome: baseline => [
      h.span([h.Class('text-[12px] text-ink'), h.AriaHidden(true)], ['●']),
      runIdentity(run, h, { isShort }),
      h.span([h.Class('text-[12px] text-ink-2')], ['vs']),
      h.span([h.Class('text-[12px] text-ink-2'), h.AriaHidden(true)], ['○']),
      runIdentity(baseline.run, h, { isShort, tone: 'text-ink-2' }),
    ],
  })
  return Option.match(maybeEndpoint, {
    onNone: () => [testTitle(run.testName, '', h), ...runs],
    onSome: endpoint => [
      h.nav(
        [
          h.Class('flex min-w-0 items-baseline gap-3'),
          h.AriaLabel('Breadcrumb'),
        ],
        [
          backArrow(parentHref, h),
          crumb(parentHref, [testTitle(run.testName, '', h), ...runs], h),
          separator(h),
          h.span(
            [h.AriaCurrent('page'), h.Class('shrink-0')],
            [endpointName(endpoint, h)],
          ),
        ],
      ),
    ],
  })
}

/** The previous finished run of the same test, to compare with. */
const previousRun = (model: Model, runId: string): Option.Option<string> => {
  if (model.history._tag !== 'Loaded') {
    return Option.none()
  }
  const runs = model.history.runs
  const index = runs.findIndex(run => run.id === runId)
  return Option.fromNullishOr(
    runs.slice(index + 1).find(run => isOver(run))?.id,
  )
}

const actionsView = (
  model: Model,
  analysis: Analysis,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const { current, maybeBaseline } = analysis
  const run = current.run
  if (Option.isSome(maybeBaseline)) {
    return [buttonLink('Change runs', '/compare', 'Secondary', h)]
  }
  if (!isOver(run)) {
    return [
      runStatus(run, current.seconds.length, h),
      button(
        current.stop === 'Requested' ? 'Stopping…' : 'Stop',
        Message.ClickedStop(),
        'Primary',
        h,
        { isDisabled: current.stop === 'Requested' },
      ),
    ]
  }
  return [
    runStatus(run, current.seconds.length, h),
    button('Run again', Message.ClickedStart(), 'Secondary', h, {
      isDisabled: model.launch._tag === 'Starting',
    }),
    Option.match(previousRun(model, run.id), {
      onNone: () => buttonLink('Compare', '/compare', 'Primary', h),
      onSome: baselineId =>
        buttonLink(
          'Compare',
          compareRouter({ runId: run.id, baselineId }),
          'Primary',
          h,
        ),
    }),
  ]
}

// THE SPAN

const spanControl = (
  span: Span,
  isLive: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  segmented(
    'Span',
    [
      ...(isLive
        ? [
            {
              key: 'now',
              text: 'Now',
              isPressed: span._tag === 'Now',
              message: Message.ClickedNow(),
            },
          ]
        : []),
      {
        key: 'whole',
        text: 'Whole run',
        isPressed: span._tag === 'WholeRun',
        message: Message.ClickedWholeRun(),
      },
      ...(span._tag === 'Range'
        ? [
            {
              key: 'range',
              text: spanLabel(span),
              isPressed: true,
              message: Message.SelectedRange({ from: span.from, to: span.to }),
            },
          ]
        : []),
    ],
    h,
  )

const lostBanner = (feed: Feed, h: HtmlBuilder<Message>): Html =>
  feed._tag === 'Lost'
    ? h.div(
        [
          h.Class(
            'mt-6 flex items-center gap-4 border-y border-hairline py-2.5',
          ),
          h.Role('status'),
        ],
        [
          h.span(
            [h.Class('text-ink'), h.Title(feed.error)],
            ['Connection lost'],
          ),
          h.div([h.Class('flex-1')]),
          button('Reconnect', Message.ClickedReconnect(), 'Secondary', h),
        ],
      )
    : h.empty

// THE PAGE

const planDurationOf = (loaded: LoadedRun) => loaded.run.duration

export const analysisView = (
  model: Model,
  analysis: Analysis,
  h: HtmlBuilder<Message>,
): Html => {
  const { current, maybeBaseline, maybeEndpoint } = analysis
  const isLive = !isOver(current.run)
  const span = effectiveSpan(model.span, isLive)
  const seconds = secondsOf(current, maybeEndpoint)
  const maybeBaselineSeconds = Option.map(maybeBaseline, baseline =>
    secondsOf(baseline, maybeEndpoint),
  )
  const summary = summarize(seconds, span, planDurationOf(current))
  const maybeBaselineSummary = Option.map(
    Option.all([maybeBaseline, maybeBaselineSeconds]),
    ([baseline, baselineSeconds]) =>
      summarize(baselineSeconds, span, planDurationOf(baseline)),
  )
  const checks = checksFor(current.run, maybeEndpoint)
  const isEndpoint = Option.isSome(maybeEndpoint)
  const duration = Math.max(
    current.run.duration,
    current.seconds.length,
    ...Option.toArray(maybeBaseline).map(b =>
      Math.max(b.run.duration, b.seconds.length),
    ),
  )
  const listContext = {
    current: seconds,
    maybeBaseline: maybeBaselineSeconds,
    duration,
    maybeRange: span._tag === 'Range' ? Option.some(span) : Option.none(),
    spanLabel: spanLabel(span),
    hrefOf: (endpoint: string) =>
      Option.match(maybeBaseline, {
        onNone: () => runEndpointRouter({ runId: current.run.id, endpoint }),
        onSome: baseline =>
          compareEndpointRouter({
            runId: current.run.id,
            baselineId: baseline.run.id,
            endpoint,
          }),
      }),
  }

  const below = Option.match(maybeEndpoint, {
    onNone: () =>
      Option.match(maybeBaselineSummary, {
        onNone: () =>
          endpointListView(
            summary.total,
            endpointRows(summary),
            listContext,
            h,
          ),
        onSome: baselineSummary =>
          comparedListView(
            { current: summary.total, baseline: baselineSummary.total },
            compareRows(summary.endpoints, baselineSummary.endpoints),
            listContext,
            h,
          ),
      }),
    onSome: () =>
      endpointDetailView(
        {
          label: 'this run',
          stats: summary.total,
          seconds: spanSeconds(seconds, span),
        },
        Option.map(
          Option.all([maybeBaselineSummary, maybeBaselineSeconds]),
          ([baselineSummary, baselineSeconds]) => ({
            label: 'baseline',
            stats: baselineSummary.total,
            seconds: spanSeconds(baselineSeconds, span),
          }),
        ),
        h,
      ),
  })

  return h.div(
    [],
    [
      barView(whereView(analysis, h), actionsView(model, analysis, h), h),
      h.div(
        [h.Class('px-8 pb-16')],
        [
          lostBanner(current.feed, h),
          h.div(
            [h.Class('flex flex-wrap items-start justify-between gap-6 pt-8')],
            [
              h.div(
                [h.Class('flex flex-wrap items-start gap-x-16 gap-y-4')],
                [
                  figuresView(
                    figuresOf(summary.total),
                    Option.map(maybeBaselineSummary, s => figuresOf(s.total)),
                    checks,
                    h,
                  ),
                  Option.isSome(maybeBaseline) || isLive
                    ? h.empty
                    : checksView(checks, h),
                ],
              ),
              spanControl(span, isLive, h),
            ],
          ),
          timelineView(
            {
              topTrack: isEndpoint ? 'Throughput' : 'Load',
              topNote: isEndpoint
                ? 'requests /s'
                : isRatePlan(current.run.plan)
                  ? 'iterations /s'
                  : 'virtual users',
              latencyNote: Option.isSome(maybeBaseline)
                ? 'p95'
                : isEndpoint
                  ? ''
                  : 'All requests',
            },
            h,
          ),
          below,
        ],
      ),
    ],
  )
}
