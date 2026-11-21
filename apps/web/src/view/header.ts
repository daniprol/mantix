/**
 * The top bar: wordmark, test name, run status and the one primary action.
 */
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { RunInfo, TestInfo } from '@mantix/api'

import * as Format from '../domain/format.ts'
import { isOver } from '../domain/stats.ts'
import { Message } from '../message.ts'
import { type Model, RunState } from '../model.ts'
import { primaryButton } from './parts.ts'

const STATUS_WORDS: Record<RunInfo['status'], string> = {
  running: 'Running',
  finished: 'Finished',
  stopped: 'Stopped',
  aborted: 'Aborted',
  crashed: 'Crashed',
}

const wordmark = (h: HtmlBuilder<Message>): Html =>
  h.span(
    [h.Class('text-[15px] font-semibold tracking-[-0.02em] text-ink')],
    ['mantix'],
  )

const testName = (test: TestInfo, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex min-w-0 items-baseline gap-2.5')],
    [
      h.span([h.Class('truncate font-medium text-ink')], [test.name]),
      h.span(
        [h.Class('num hidden truncate text-[12px] text-ink-3 sm:inline')],
        [test.file],
      ),
    ],
  )

const runStatus = (
  run: RunInfo,
  elapsed: number,
  h: HtmlBuilder<Message>,
): Html => {
  const isLive = !isOver(run)
  return h.div(
    [
      h.Class('flex items-center gap-2 text-ink-2'),
      h.Role('status'),
      h.AriaLive('polite'),
    ],
    [
      h.span([
        h.Class(
          `inline-block size-[7px] rounded-full ${isLive ? 'live-dot bg-accent' : 'bg-ink-3'}`,
        ),
        h.AriaHidden(true),
      ]),
      h.span([h.Class(isLive ? 'text-ink' : '')], [STATUS_WORDS[run.status]]),
      h.span([h.Class('num text-ink')], [Format.clock(elapsed)]),
      ...(isLive
        ? [
            h.span(
              [h.Class('num text-ink-3')],
              [`/ ${Format.clock(run.duration)}`],
            ),
          ]
        : []),
    ],
  )
}

const action = (model: Model, h: HtmlBuilder<Message>): Html =>
  RunState.match(model.runState, {
    NoRun: () =>
      primaryButton('Start run', Message.ClickedStart(), h, { hint: '↵' }),
    Starting: () =>
      primaryButton('Starting…', Message.ClickedStart(), h, {
        isDisabled: true,
      }),
    Watching: ({ run, stop }) =>
      isOver(run)
        ? primaryButton('Run again', Message.ClickedStart(), h)
        : primaryButton(
            stop === 'Requested' ? 'Stopping…' : 'Stop',
            Message.ClickedStop(),
            h,
            { isDisabled: stop === 'Requested' },
          ),
  })

export const headerView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Class('border-b border-hairline')],
    [
      h.div(
        [
          h.Class(
            'mx-auto flex h-14 max-w-[1240px] items-center gap-5 px-4 sm:px-8',
          ),
        ],
        [
          wordmark(h),
          ...(model.test._tag === 'Loaded'
            ? [
                h.span([h.Class('h-4 w-px bg-hairline'), h.AriaHidden(true)]),
                testName(model.test.test, h),
              ]
            : []),
          h.div([h.Class('flex-1')]),
          ...(model.runState._tag === 'Watching'
            ? [runStatus(model.runState.run, model.runState.seconds.length, h)]
            : []),
          ...(model.test._tag === 'Loaded' ? [action(model, h)] : []),
        ],
      ),
    ],
  )
