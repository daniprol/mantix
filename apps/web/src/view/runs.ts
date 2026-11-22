/**
 * Runs: the history, newest first. Each line opens its run.
 */
import { Array } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { RunInfo } from '@mantix/api'

import * as Format from '../domain/format.ts'
import { gitOf, ranFor, startedAt } from '../domain/identity.ts'
import { STATUS_WORDS, checksSummary, outcomeOf } from '../domain/verdict.ts'
import type { Message } from '../message.ts'
import { History, type Model } from '../model.ts'
import { runRouter } from '../route.ts'
import { missing } from './parts.ts'
import { barView, testTitleOf } from './runBar.ts'

const COLUMNS = '9rem 6.5rem minmax(0, 1fr) 5rem minmax(0, 1fr) minmax(0, 1fr)'

const cellsClass = 'grid items-center gap-x-6'

const header = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class(
        `${cellsClass} border-b border-hairline pb-2 text-[12px] text-ink-2`,
      ),
      h.Style({ 'grid-template-columns': COLUMNS }),
    ],
    ['Started', 'Status', 'Checks', 'Duration', 'Commit', 'Label'].map(title =>
      h.span([h.Class(title === 'Duration' ? 'text-right' : '')], [title]),
    ),
  )

/** What the Checks column says: the crash, the checks once over, or nothing yet. */
const checksOf = (run: RunInfo): string =>
  run.status === 'crashed'
    ? (run.error ?? '')
    : run.status === 'running'
      ? ''
      : checksSummary(run)

const runRow = (run: RunInfo, h: HtmlBuilder<Message>): Html => {
  const outcome = outcomeOf(run)
  return h.keyed('a')(
    run.id,
    [
      h.Href(runRouter({ runId: run.id })),
      h.Class(
        `${cellsClass} -mx-3 h-11 border-b border-hairline px-3 text-[13px] transition-colors duration-150 ease-out hover:bg-wash`,
      ),
      h.Style({ 'grid-template-columns': COLUMNS }),
    ],
    [
      h.span([h.Class('num text-ink')], [startedAt(run)]),
      h.span(
        [h.Class('flex items-center gap-2 text-ink')],
        [
          outcome === 'Running'
            ? h.span([
                h.Class(
                  'live-dot inline-block size-[6px] rounded-full bg-accent',
                ),
                h.AriaHidden(true),
              ])
            : h.empty,
          STATUS_WORDS[run.status],
        ],
      ),
      h.span(
        [
          h.Class(
            `truncate ${outcome === 'Failed' ? 'text-danger' : 'text-ink-2'}`,
          ),
        ],
        [checksOf(run)],
      ),
      h.span(
        [h.Class('num text-right text-ink')],
        [Format.clock(ranFor(run, run.duration))],
      ),
      h.span([h.Class('num truncate text-ink-2')], [gitOf(run)]),
      h.span([h.Class('truncate text-ink-2')], [run.context?.label ?? '']),
    ],
  )
}

export const runsView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [],
    [
      barView(
        model.test._tag === 'Loaded' ? [testTitleOf(model.test.test, h)] : [],
        [],
        h,
      ),
      h.section(
        [h.Class('px-8 pt-8 pb-16'), h.AriaLabel('Runs')],
        [
          header(h),
          History.match(model.history, {
            Loading: () => h.empty,
            Failed: ({ error }) =>
              h.p([h.Class('py-3 text-danger'), h.Role('alert')], [error]),
            Loaded: ({ runs }) =>
              Array.match(runs, {
                onEmpty: () =>
                  h.div([h.Class('py-3')], [missing('No runs', h)]),
                onNonEmpty: list =>
                  h.div(
                    [],
                    list.map(run => runRow(run, h)),
                  ),
              }),
          }),
        ],
      ),
    ],
  )
