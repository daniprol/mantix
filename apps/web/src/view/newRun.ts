/**
 * New run: the test, its load and checks, and the planned load drawn on
 * the same timeline the run will fill. Start, or press Enter.
 */
import { Array, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { TestInfo } from '@mantix/api'

import { isRatePlan } from '../analysis.ts'
import { modelOf, readLoadForm } from '../domain/adjust.ts'
import * as Format from '../domain/format.ts'
import { planPoints } from '../domain/plan.ts'
import { Message } from '../message.ts'
import type { Model } from '../model.ts'
import { button } from './parts.ts'
import { barView, testTitleOf } from './runBar.ts'
import { timelineView } from './timeline.ts'

type Field = Readonly<{
  id: string
  label: string
  value: string
  placeholder: string
  unit: string
  maybeError: Option.Option<string>
  toMessage: (value: string) => Message
  inputMode: string
}>

const field = (config: Field, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-1')],
    [
      h.label(
        [h.For(config.id), h.Class('text-[13px] text-ink-2')],
        [config.label],
      ),
      h.div(
        [
          h.Class(
            `flex h-8 w-36 items-center rounded-md border bg-paper pr-2.5 focus-within:border-ink-3 ${
              Option.isSome(config.maybeError)
                ? 'border-danger/60'
                : 'border-hairline'
            }`,
          ),
        ],
        [
          h.input([
            h.Id(config.id),
            h.Type('text'),
            h.InputMode(config.inputMode),
            h.Autocomplete('off'),
            h.Spellcheck(false),
            h.Value(config.value),
            h.Placeholder(config.placeholder),
            h.OnInput(config.toMessage),
            h.AriaInvalid(Option.isSome(config.maybeError)),
            h.Class(
              'num h-full w-full min-w-0 bg-transparent px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-2',
            ),
          ]),
          h.span(
            [h.Class('num shrink-0 text-[12px] text-ink-2')],
            [config.unit],
          ),
        ],
      ),
      Option.match(config.maybeError, {
        onNone: () => h.empty,
        onSome: error =>
          h.span([h.Class('num text-[12px] text-danger')], [error]),
      }),
    ],
  )

/** The highest load the test's plan reaches, as the input's placeholder. */
const peakLoad = (test: TestInfo): number =>
  Math.max(
    0,
    ...test.scenarios.flatMap(scenario =>
      planPoints(scenario.plan).map(([, load]) => load),
    ),
  )

const checksList = (test: TestInfo, h: HtmlBuilder<Message>): Html =>
  Array.match(test.thresholds, {
    onEmpty: () => h.empty,
    onNonEmpty: thresholds =>
      h.div(
        [h.Class('flex flex-col gap-1')],
        [
          h.span([h.Class('text-[13px] text-ink-2')], ['Checks']),
          h.ul(
            [h.Class('flex flex-col text-[13px]'), h.AriaLabel('Checks')],
            thresholds.map(expression =>
              h.keyed('li')(
                expression,
                [h.Class('num text-ink')],
                [expression],
              ),
            ),
          ),
        ],
      ),
  })

export const newRunView = (
  model: Model,
  test: TestInfo,
  h: HtmlBuilder<Message>,
): Html => {
  const read = readLoadForm(model.loadForm, test)
  const isRate = modelOf(test) === 'rate'
  return h.div(
    [],
    [
      barView(
        [
          testTitleOf(test, h),
          test.baseUrl === undefined
            ? h.empty
            : h.span(
                [h.Class('num truncate text-[12px] text-ink-2')],
                [test.baseUrl],
              ),
        ],
        [
          button(
            model.launch._tag === 'Starting' ? 'Starting…' : 'Start run',
            Message.ClickedStart(),
            'Primary',
            h,
            { isDisabled: model.launch._tag === 'Starting', hint: '↵' },
          ),
        ],
        h,
      ),
      h.div(
        [h.Class('px-8 pb-16')],
        [
          h.section(
            [
              h.Class('flex flex-wrap items-start gap-x-10 gap-y-4 pt-8'),
              h.AriaLabel('Load'),
            ],
            [
              field(
                {
                  id: 'load',
                  label: isRate ? 'Rate' : 'Virtual users',
                  value: model.loadForm.load,
                  placeholder: Format.grouped(peakLoad(test)),
                  unit: isRate ? '/s' : 'VUs',
                  maybeError: read.maybeLoadError,
                  toMessage: value => Message.UpdatedLoadInput({ value }),
                  inputMode: 'decimal',
                },
                h,
              ),
              field(
                {
                  id: 'duration',
                  label: 'Duration',
                  value: model.loadForm.duration,
                  placeholder: Format.span(test.duration),
                  unit: '',
                  maybeError: read.maybeDurationError,
                  toMessage: value => Message.UpdatedDurationInput({ value }),
                  inputMode: 'text',
                },
                h,
              ),
              checksList(test, h),
            ],
          ),
          timelineView(
            {
              topTrack: 'Load',
              topNote: isRatePlan(test.scenarios)
                ? 'iterations /s'
                : 'virtual users',
              latencyNote: '',
            },
            h,
          ),
        ],
      ),
    ],
  )
}
