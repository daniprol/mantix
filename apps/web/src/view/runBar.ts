/**
 * The bar at the top of every page: what is on screen on the left, its
 * state and the actions on the right. One line, no headline under it.
 */
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { RunInfo, TestInfo } from '@mantix/api'

import * as Format from '../domain/format.ts'
import { gitOf, startedAt } from '../domain/identity.ts'
import { isOver } from '../domain/stats.ts'
import { STATUS_WORDS, checksSummary } from '../domain/verdict.ts'
import type { Message } from '../message.ts'

export const barView = (
  left: ReadonlyArray<Html>,
  right: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.header(
    [
      // The page's top bar, even though it sits inside <main>.
      h.Role('banner'),
      h.Class(
        'sticky top-0 z-10 flex h-14 items-center gap-5 border-b border-hairline bg-paper px-8',
      ),
    ],
    [
      h.div([h.Class('flex min-w-0 flex-1 items-baseline gap-5')], [...left]),
      h.div([h.Class('flex shrink-0 items-center gap-3')], [...right]),
    ],
  )

/** "Checkout flow  scenarios/checkout.ts" */
export const testTitle = (
  name: string,
  file: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.span(
    [h.Class('flex min-w-0 items-baseline gap-2.5')],
    [
      h.span([h.Class('truncate font-medium text-ink')], [name]),
      h.span(
        [h.Class('num hidden truncate text-[12px] text-ink-2 lg:inline')],
        [file],
      ),
    ],
  )

export const testTitleOf = (test: TestInfo, h: HtmlBuilder<Message>): Html =>
  testTitle(test.name, test.file, h)

/**
 * "22 Nov 14:32  feat/cart-cache a3f9c1e  v2.3 on staging". The short form,
 * for breadcrumbs, leaves out the branch and commit.
 */
export const runIdentity = (
  run: RunInfo,
  h: HtmlBuilder<Message>,
  options: Readonly<{ tone?: string; isShort?: boolean }> = {},
): Html =>
  h.span(
    [
      h.Class(
        `num flex min-w-0 items-baseline gap-2.5 text-[12px] ${options.tone ?? 'text-ink'}`,
      ),
    ],
    [
      h.span([h.Class('shrink-0')], [startedAt(run)]),
      options.isShort === true
        ? h.empty
        : h.span([h.Class('truncate')], [gitOf(run)]),
      run.context?.label === undefined
        ? h.empty
        : h.span([h.Class('truncate text-ink-2')], [run.context.label]),
    ],
  )

/** "● Running 03:12 / 05:00" or "Finished · 2 of 3 checks passed". */
export const runStatus = (
  run: RunInfo,
  secondsSeen: number,
  h: HtmlBuilder<Message>,
): Html => {
  const isLive = !isOver(run)
  const checks = checksSummary(run)
  const hasFailed = run.thresholds.some(t => !t.passed)
  return h.div(
    [
      h.Class('flex items-center gap-2 text-[13px] text-ink'),
      h.Role('status'),
      h.AriaLive('polite'),
    ],
    isLive
      ? [
          h.span([
            h.Class('live-dot inline-block size-[7px] rounded-full bg-accent'),
            h.AriaHidden(true),
          ]),
          h.span([], [STATUS_WORDS[run.status]]),
          h.span([h.Class('num')], [Format.clock(secondsSeen)]),
          h.span(
            [h.Class('num text-ink-2')],
            [`/ ${Format.clock(run.duration)}`],
          ),
        ]
      : [
          h.span([], [STATUS_WORDS[run.status]]),
          checks === ''
            ? h.empty
            : h.span(
                [h.Class(hasFailed ? 'text-danger' : 'text-ink-2')],
                [`· ${checks}`],
              ),
        ],
  )
}
