/**
 * Compare, before two runs are chosen: pick a run and a baseline. Both
 * start on the newest finished run and the one before it.
 */
import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { RunInfo } from '@mantix/api'

import { comparePair, finishedRuns } from '../analysis.ts'
import { gitOf, startedAt } from '../domain/identity.ts'
import { Message } from '../message.ts'
import type { Model } from '../model.ts'
import { button } from './parts.ts'
import { barView, testTitleOf } from './runBar.ts'

const optionText = (run: RunInfo): string =>
  [startedAt(run), gitOf(run), run.context?.label ?? '']
    .filter(part => part !== '')
    .join('   ')

const picker = (
  id: string,
  label: string,
  runs: ReadonlyArray<RunInfo>,
  maybeSelected: Option.Option<string>,
  toMessage: (runId: string) => Message,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-1')],
    [
      h.label([h.For(id), h.Class('text-[13px] text-ink-2')], [label]),
      h.select(
        [
          h.Id(id),
          h.OnChange(toMessage),
          h.Class(
            'num h-8 w-80 rounded-md border border-hairline bg-paper px-2 text-[13px] text-ink',
          ),
        ],
        runs.map(run =>
          h.keyed('option')(
            run.id,
            [
              h.Value(run.id),
              h.Selected(Option.contains(maybeSelected, run.id)),
            ],
            [optionText(run)],
          ),
        ),
      ),
    ],
  )

export const pickCompareView = (
  model: Model,
  h: HtmlBuilder<Message>,
): Html => {
  const runs = finishedRuns(model)
  const maybePair = comparePair(model)
  return h.div(
    [],
    [
      barView(
        model.test._tag === 'Loaded' ? [testTitleOf(model.test.test, h)] : [],
        [],
        h,
      ),
      h.section(
        [
          h.Class('flex flex-wrap items-end gap-x-8 gap-y-4 px-8 pt-8'),
          h.AriaLabel('Choose runs'),
        ],
        [
          picker(
            'compare-run',
            'Run',
            runs,
            Option.map(maybePair, ([runId]) => runId),
            runId => Message.SelectedCompareRun({ runId }),
            h,
          ),
          picker(
            'compare-baseline',
            'Baseline',
            runs,
            Option.map(maybePair, ([, baselineId]) => baselineId),
            runId => Message.SelectedCompareBaseline({ runId }),
            h,
          ),
          button('Compare', Message.ClickedCompare(), 'Primary', h, {
            isDisabled: Option.isNone(maybePair),
          }),
        ],
      ),
    ],
  )
}
