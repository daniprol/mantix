/**
 * VIEW: the whole page as a function of the Model.
 *
 * Foldkit idea: the view never changes anything. It describes the page for
 * the current Model, and user actions become Messages (`OnClick(...)`) or
 * plain links, which Foldkit routing turns into `ClickedLink`.
 */
import { Option } from 'effect'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'

import { analysisOf } from '../analysis.ts'
import * as Format from '../domain/format.ts'
import { isOver } from '../domain/stats.ts'
import { Message } from '../message.ts'
import { type Model, TestState } from '../model.ts'
import { AppRoute, newRunRouter, runIdsOf } from '../route.ts'
import { analysisView } from './analysis.ts'
import { newRunView } from './newRun.ts'
import { button, buttonLink, missing } from './parts.ts'
import { pickCompareView } from './pickCompare.ts'
import { barView } from './runBar.ts'
import { runsView } from './runs.ts'
import { sidebarView } from './sidebar.ts'

const notice = (children: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [],
    [
      barView([], [], h),
      h.div(
        [h.Class('flex flex-col items-start gap-4 px-8 pt-10')],
        [...children],
      ),
    ],
  )

const unreachableView = (error: string, h: HtmlBuilder<Message>): Html =>
  notice(
    [
      h.p(
        [h.Class('text-ink'), h.Role('alert')],
        ['Mantix server unreachable'],
      ),
      h.p([h.Class('num text-[12px] text-ink-2')], [error]),
      button('Try again', Message.ClickedRetryConnect(), 'Primary', h),
    ],
    h,
  )

/** A run of the route is still loading, or failed to load. */
const runsPendingView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const maybeError = runIdsOf(model.route).flatMap(id => {
    const data = model.runs[id]
    return data?._tag === 'Failed' ? [data.error] : []
  })[0]
  return maybeError === undefined
    ? notice([missing('Loading…', h)], h)
    : notice(
        [
          h.p([h.Class('text-ink'), h.Role('alert')], [maybeError]),
          buttonLink('New run', newRunRouter(), 'Secondary', h),
        ],
        h,
      )
}

const pageView = (model: Model, h: HtmlBuilder<Message>): Html =>
  TestState.match(model.test, {
    Connecting: () => notice([missing('Connecting…', h)], h),
    Unreachable: ({ error }) => unreachableView(error, h),
    Loaded: ({ test }) =>
      AppRoute.match(model.route, {
        NewRun: () => newRunView(model, test, h),
        Runs: () => runsView(model, h),
        PickCompare: () => pickCompareView(model, h),
        NotFound: ({ path }) =>
          notice(
            [
              h.p([h.Class('num text-ink')], [`${path} not found`]),
              buttonLink('New run', newRunRouter(), 'Secondary', h),
            ],
            h,
          ),
        Run: () => analysedView(model, h),
        RunEndpoint: () => analysedView(model, h),
        Compare: () => analysedView(model, h),
        CompareEndpoint: () => analysedView(model, h),
      }),
  })

const analysedView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(analysisOf(model), {
    onNone: () => runsPendingView(model, h),
    onSome: analysis => analysisView(model, analysis, h),
  })

const actionError = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.maybeActionError, {
    onNone: () => h.empty,
    onSome: error =>
      h.div(
        [
          h.Class(
            'fixed right-6 bottom-6 z-20 flex items-center gap-4 rounded-md border border-hairline bg-paper px-4 py-2.5',
          ),
          h.Role('alert'),
        ],
        [
          h.span([h.Class('text-danger')], [error]),
          button('Dismiss', Message.ClickedDismissError(), 'Secondary', h),
        ],
      ),
  })

/** The tab title: the live clock while a run is going. */
const title = (model: Model): string =>
  Option.match(analysisOf(model), {
    onNone: () => 'mantix',
    onSome: ({ current }) =>
      isOver(current.run)
        ? `${current.run.testName} · mantix`
        : `${Format.clock(current.seconds.length)} · mantix`,
  })

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: title(model),
  body: h.div(
    [h.Class('flex min-h-screen bg-paper text-ink')],
    [
      sidebarView(model, h),
      h.main([h.Class('min-w-0 flex-1')], [pageView(model, h)]),
      actionError(model, h),
    ],
  ),
})
