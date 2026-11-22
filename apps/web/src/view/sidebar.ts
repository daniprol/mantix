/**
 * The left sidebar: the wordmark, the four sections, and at the bottom
 * where the runs come from (project and branch) and the theme switch.
 */
import { Array, Option, Record } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { RunInfo } from '@mantix/api'

import * as Format from '../domain/format.ts'
import { isOver } from '../domain/stats.ts'
import type { Message } from '../message.ts'
import type { Model } from '../model.ts'
import {
  newRunRouter,
  pickCompareRouter,
  runRouter,
  runsRouter,
} from '../route.ts'
import { themeSwitch } from './themeSwitch.ts'

type Section = 'NewRun' | 'Live' | 'Runs' | 'Compare'

/** Which section the page on screen belongs to. */
const sectionOf = (
  model: Model,
  maybeLive: Option.Option<RunInfo>,
): Section => {
  const { route } = model
  if (route._tag === 'NewRun') {
    return 'NewRun'
  }
  if (route._tag === 'Run' || route._tag === 'RunEndpoint') {
    return Option.exists(maybeLive, live => live.id === route.runId)
      ? 'Live'
      : 'Runs'
  }
  return route._tag === 'Runs' ? 'Runs' : 'Compare'
}

/** The run going on right now, if any, from the runs loaded or the history. */
const liveRun = (model: Model): Option.Option<RunInfo> =>
  Option.orElse(
    Array.findFirst(Record.values(model.runs), data =>
      data._tag === 'Loaded' && !isOver(data.run)
        ? Option.some(data.run)
        : Option.none(),
    ),
    () =>
      model.history._tag === 'Loaded'
        ? Array.findFirst(model.history.runs, run => !isOver(run))
        : Option.none(),
  )

const secondsSeen = (model: Model, runId: string): number => {
  const data = model.runs[runId]
  return data?._tag === 'Loaded' ? data.seconds.length : 0
}

const itemClass = (isCurrent: boolean) =>
  `flex h-8 items-center justify-between rounded-md px-3 text-[13px] transition-colors duration-150 ease-out ${
    isCurrent ? 'bg-wash text-ink' : 'text-ink-2 hover:text-ink'
  }`

const item = (
  label: string,
  href: string,
  isCurrent: boolean,
  h: HtmlBuilder<Message>,
  extra: ReadonlyArray<Html> = [],
): Html =>
  h.a(
    [
      h.Href(href),
      h.Class(itemClass(isCurrent)),
      ...(isCurrent ? [h.AriaCurrent('page')] : []),
    ],
    [h.span([], [label]), ...extra],
  )

const liveItem = (
  model: Model,
  maybeLive: Option.Option<RunInfo>,
  isCurrent: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(maybeLive, {
    // Nothing running: Live is a label, not a link.
    onNone: () =>
      h.span(
        [
          h.Class(
            `${itemClass(false)} cursor-default text-ink-3 hover:text-ink-3`,
          ),
        ],
        ['Live'],
      ),
    onSome: live =>
      item('Live', runRouter({ runId: live.id }), isCurrent, h, [
        h.span(
          [h.Class('flex items-center gap-2')],
          [
            h.span([
              h.Class(
                'live-dot inline-block size-[6px] rounded-full bg-accent',
              ),
              h.AriaHidden(true),
            ]),
            h.span(
              [h.Class('num text-[11px] text-ink-2')],
              [Format.clock(secondsSeen(model, live.id))],
            ),
          ],
        ),
      ]),
  })

/** The project and branch of the newest run, quietly. */
const origin = (model: Model, h: HtmlBuilder<Message>): Html => {
  const maybeContext = Option.flatMap(
    model.history._tag === 'Loaded'
      ? Array.head(model.history.runs)
      : Option.none(),
    run => Option.fromNullishOr(run.context),
  )
  return Option.match(maybeContext, {
    onNone: () => h.empty,
    onSome: context =>
      h.div(
        [h.Class('text-[13px]')],
        [
          h.div([h.Class('truncate text-ink')], [context.project]),
          context.git?.branch === undefined
            ? h.empty
            : h.div(
                [h.Class('num truncate text-[12px] text-ink-2')],
                [context.git.branch],
              ),
        ],
      ),
  })
}

export const sidebarView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const maybeLive = liveRun(model)
  const section = sectionOf(model, maybeLive)
  return h.aside(
    [
      h.Class(
        'sticky top-0 flex h-screen w-[200px] shrink-0 flex-col border-r border-hairline bg-paper',
      ),
    ],
    [
      h.div(
        [h.Class('flex h-14 items-center px-5')],
        [
          h.a(
            [
              h.Href(newRunRouter()),
              h.Class('text-[16px] font-semibold tracking-[-0.02em] text-ink'),
            ],
            ['mantix'],
          ),
        ],
      ),
      h.nav(
        [h.Class('flex flex-col gap-0.5 px-2 pt-4'), h.AriaLabel('Sections')],
        [
          item('New run', newRunRouter(), section === 'NewRun', h),
          liveItem(model, maybeLive, section === 'Live', h),
          item('Runs', runsRouter(), section === 'Runs', h),
          item('Compare', pickCompareRouter(), section === 'Compare', h),
        ],
      ),
      h.div([h.Class('flex-1')]),
      h.div(
        [h.Class('flex flex-col gap-4 px-5 pb-5')],
        [origin(model, h), themeSwitch(model.theme, h)],
      ),
    ],
  )
}
