/**
 * VIEW: the whole page as a function of the Model.
 *
 * Foldkit idea: the view never changes anything. It describes the page for
 * the current Model, and user actions become Messages (`OnClick(...)`).
 */
import { Array, Option } from 'effect'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'

import type { RunInfo } from '@mantix/api'

import * as Format from '../domain/format.ts'
import { isOver } from '../domain/stats.ts'
import { verdict } from '../domain/verdict.ts'
import { Message } from '../message.ts'
import { type Model, RunState, TestState } from '../model.ts'
import { headerView } from './header.ts'
import { primaryButton, quietButton } from './parts.ts'
import { readyView } from './ready.ts'
import { runView } from './run.ts'

const page = (children: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html =>
  h.main([h.Class('mx-auto max-w-[1240px] px-4 sm:px-8')], [...children])

const connectingView = (h: HtmlBuilder<Message>): Html =>
  h.p([h.Class('pt-16 text-ink-3')], ['Connecting to Mantix…'])

const unreachableView = (error: string, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('max-w-[52ch] pt-16'), h.Role('alert')],
    [
      h.h1(
        [h.Class('text-[15px] font-medium text-ink')],
        ['Can’t reach the Mantix server'],
      ),
      h.p(
        [h.Class('mt-2 text-ink-2')],
        [
          'This page talks to the server that ',
          h.code([h.Class('num text-[12px] text-ink')], ['mantix ui']),
          ' starts. Check that it is still running in your terminal, then try again.',
        ],
      ),
      h.p([h.Class('num mt-2 text-[12px] text-ink-3')], [error]),
      h.div(
        [h.Class('mt-6')],
        [primaryButton('Try again', Message.ClickedRetryConnect(), h)],
      ),
    ],
  )

const actionError = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.maybeActionError, {
    onNone: () => h.empty,
    onSome: error =>
      h.div(
        [
          h.Class(
            'mt-6 flex items-center gap-4 border-y border-hairline py-2.5',
          ),
          h.Role('alert'),
        ],
        [
          h.span([h.Class('text-danger')], [error]),
          h.div([h.Class('flex-1')]),
          quietButton('Dismiss', Message.ClickedDismissError(), h),
        ],
      ),
  })

const pastRunLabel = (run: RunInfo): string =>
  run.status === 'running'
    ? 'Running'
    : verdict(run, Math.round(run.duration)).tone === 'Failed'
      ? 'Failed'
      : run.status === 'stopped'
        ? 'Stopped'
        : 'Passed'

const startTime = (epochMs: number): string =>
  new Date(epochMs).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })

/** Earlier runs from this session, quiet, at the bottom. */
const pastRunsView = (
  runs: ReadonlyArray<RunInfo>,
  maybeCurrentId: Option.Option<string>,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(
    runs.filter(run => isOver(run) && !Option.contains(maybeCurrentId, run.id)),
    {
      onEmpty: () => h.empty,
      onNonEmpty: list =>
        h.section(
          [
            h.Class('border-t border-hairline pt-6 pb-16'),
            h.AriaLabel('Previous runs'),
          ],
          [
            h.h2([h.Class('mb-2 text-[12px] text-ink-3')], ['Previous runs']),
            h.ul(
              [h.Class('flex flex-col')],
              list
                .slice(0, 8)
                .map(run =>
                  h.keyed('li')(
                    run.id,
                    [],
                    [
                      h.button(
                        [
                          h.Type('button'),
                          h.Class(
                            'grid h-8 w-full grid-cols-[4rem_5rem_minmax(0,1fr)] items-center gap-4 rounded-md px-2 -mx-2 text-left text-[13px] hover:bg-wash',
                          ),
                          h.OnClick(Message.ClickedPastRun({ runId: run.id })),
                        ],
                        [
                          h.span(
                            [h.Class('num text-ink-3')],
                            [startTime(run.startedAt)],
                          ),
                          h.span(
                            [
                              h.Class(
                                pastRunLabel(run) === 'Failed'
                                  ? 'text-danger'
                                  : 'text-ink-2',
                              ),
                            ],
                            [pastRunLabel(run)],
                          ),
                          h.span(
                            [h.Class('num truncate text-ink-3')],
                            [
                              `${Format.clock(
                                run.endedAt === null
                                  ? run.duration
                                  : (run.endedAt - run.startedAt) / 1000,
                              )} · ${run.id}`,
                            ],
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
            ),
          ],
        ),
    },
  )

const body = (model: Model, h: HtmlBuilder<Message>): Html =>
  TestState.match(model.test, {
    Connecting: () => page([connectingView(h)], h),
    Unreachable: ({ error }) => page([unreachableView(error, h)], h),
    Loaded: ({ test }) =>
      RunState.match(model.runState, {
        NoRun: () =>
          page(
            [
              actionError(model, h),
              readyView(test, model.adjust, h),
              pastRunsView(model.pastRuns, Option.none(), h),
            ],
            h,
          ),
        Starting: () => page([readyView(test, model.adjust, h)], h),
        Watching: ({ run, seconds, feed }) =>
          page(
            [
              actionError(model, h),
              runView(
                run,
                seconds,
                feed,
                model.window,
                model.maybeExpandedEndpoint,
                h,
              ),
              isOver(run)
                ? h.div(
                    [h.Class('-mx-2 -mt-10 pb-8')],
                    [
                      quietButton(
                        'Change the load and run again…',
                        Message.ClickedNewRun(),
                        h,
                      ),
                    ],
                  )
                : h.empty,
              isOver(run)
                ? pastRunsView(model.pastRuns, Option.some(run.id), h)
                : h.empty,
            ],
            h,
          ),
      }),
  })

const title = (model: Model): string =>
  model.runState._tag === 'Watching'
    ? isOver(model.runState.run)
      ? `${verdict(model.runState.run, model.runState.seconds.length).tone} · mantix`
      : `Running ${Format.clock(model.runState.seconds.length)} · mantix`
    : 'mantix'

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: title(model),
  body: h.div(
    [h.Class('min-h-screen bg-paper text-ink')],
    [headerView(model, h), body(model, h)],
  ),
})
