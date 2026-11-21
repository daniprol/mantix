/**
 * The Ready screen: what will happen when you press Start, in one sentence,
 * with a small picture of the planned load. Everything else is one click
 * away behind "Adjust load".
 */
import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { LoadPlan, TestInfo } from '@mantix/api'

import { effectivePlan, modelOf, readAdjust } from '../domain/adjust.ts'
import * as Format from '../domain/format.ts'
import { describePlan, planDuration, planPoints } from '../domain/plan.ts'
import { Message } from '../message.ts'
import type { Adjust } from '../model.ts'
import { chip, label } from './parts.ts'

const PREVIEW_WIDTH = 640
const PREVIEW_HEIGHT = 64

/** A small line of the planned load over time. */
const planPreview = (plan: LoadPlan, h: HtmlBuilder<Message>): Html => {
  const points = planPoints(plan)
  const duration = Math.max(1, planDuration(plan))
  const peak = Math.max(1, ...points.map(([, load]) => load))
  const toX = (t: number) => (t / duration) * PREVIEW_WIDTH
  const toY = (load: number) =>
    PREVIEW_HEIGHT - 2 - (load / peak) * (PREVIEW_HEIGHT - 6)
  const line = points
    .map(([t, load]) => `${toX(t).toFixed(1)},${toY(load).toFixed(1)}`)
    .join(' ')
  const unit = plan.model === 'rate' ? '/s' : ' VUs'
  return h.figure(
    [h.Class('mt-6 max-w-[640px]'), h.AriaLabel('Planned load over time')],
    [
      h.div(
        [h.Class('flex items-start gap-3')],
        [
          h.svg(
            [
              h.ViewBox(`0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}`),
              h.Attribute('preserveAspectRatio', 'none'),
              h.Class('h-16 w-full overflow-visible'),
              h.AriaHidden(true),
            ],
            [
              h.line([
                h.Attribute('x1', '0'),
                h.Attribute('x2', String(PREVIEW_WIDTH)),
                h.Attribute('y1', String(PREVIEW_HEIGHT - 0.5)),
                h.Attribute('y2', String(PREVIEW_HEIGHT - 0.5)),
                h.Class('stroke-hairline'),
                h.Attribute('vector-effect', 'non-scaling-stroke'),
              ]),
              h.polyline([
                h.Points(line),
                h.Fill('none'),
                h.Class('stroke-ink-2'),
                h.StrokeWidth('1.5'),
                h.StrokeDasharray('4 4'),
                h.Attribute('vector-effect', 'non-scaling-stroke'),
                h.Attribute('stroke-linejoin', 'round'),
              ]),
            ],
          ),
          h.span(
            [h.Class('num -mt-1.5 shrink-0 text-[11px] text-ink-3')],
            [`${Format.grouped(peak)}${unit}`],
          ),
        ],
      ),
      h.figcaption(
        [
          h.Class(
            'num mt-1.5 flex justify-between pr-14 text-[11px] text-ink-3',
          ),
        ],
        [h.span([], [Format.clock(0)]), h.span([], [Format.clock(duration)])],
      ),
    ],
  )
}

const field = (
  config: Readonly<{
    id: string
    label: string
    value: string
    placeholder: string
    suffix: string
    maybeError: Option.Option<string>
    toMessage: (value: string) => Message
    inputMode: string
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-1.5')],
    [
      h.label(
        [h.For(config.id), h.Class('text-[12px] text-ink-3')],
        [config.label],
      ),
      h.div(
        [
          h.Class(
            `flex h-8 w-40 items-center rounded-md border bg-paper pr-2.5 focus-within:border-ink-3 ${
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
            h.Class(
              'num h-full w-full min-w-0 bg-transparent px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-3',
            ),
          ]),
          h.span(
            [h.Class('num shrink-0 text-[12px] text-ink-3')],
            [config.suffix],
          ),
        ],
      ),
      Option.match(config.maybeError, {
        onNone: () => h.empty,
        onSome: error => h.span([h.Class('text-[12px] text-danger')], [error]),
      }),
    ],
  )

const adjustLoad = (
  test: TestInfo,
  adjust: Adjust,
  h: HtmlBuilder<Message>,
): Html => {
  const read = readAdjust(adjust, test)
  const model = modelOf(test)
  const plan = test.scenarios[0]?.plan
  const peak =
    plan === undefined
      ? 0
      : Math.max(...planPoints(plan).map(([, load]) => load))
  const hasChanges = adjust.load.trim() !== '' || adjust.duration.trim() !== ''
  return h.div(
    [h.Class('mt-8')],
    [
      h.button(
        [
          h.Type('button'),
          h.Class(
            'inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-ink',
          ),
          h.AriaExpanded(adjust.isOpen),
          h.AriaControls('adjust-load'),
          h.OnClick(Message.ClickedAdjustLoad()),
        ],
        [
          h.span(
            [
              h.Class(
                `inline-block text-[10px] text-ink-3 transition-transform duration-150 ease-out ${adjust.isOpen ? 'rotate-90' : ''}`,
              ),
              h.AriaHidden(true),
            ],
            ['▶'],
          ),
          'Adjust load',
          ...(hasChanges && !adjust.isOpen
            ? [h.span([h.Class('text-accent-ink')], ['· changed'])]
            : []),
        ],
      ),
      adjust.isOpen
        ? h.div(
            [
              h.Id('adjust-load'),
              h.Class('mt-4 flex flex-wrap items-start gap-x-6 gap-y-4'),
            ],
            [
              field(
                {
                  id: 'adjust-rate',
                  label: model === 'rate' ? 'Rate' : 'Virtual users',
                  value: adjust.load,
                  placeholder: Format.grouped(peak),
                  suffix: model === 'rate' ? 'req/s' : 'VUs',
                  maybeError: read.maybeLoadError,
                  toMessage: value => Message.UpdatedLoadInput({ value }),
                  inputMode: 'decimal',
                },
                h,
              ),
              field(
                {
                  id: 'adjust-duration',
                  label: 'Duration',
                  value: adjust.duration,
                  placeholder: Format.span(test.duration),
                  suffix: '',
                  maybeError: read.maybeDurationError,
                  toMessage: value => Message.UpdatedDurationInput({ value }),
                  inputMode: 'text',
                },
                h,
              ),
              hasChanges
                ? h.button(
                    [
                      h.Type('button'),
                      h.Class(
                        'mt-[26px] h-8 text-[13px] text-ink-2 underline decoration-hairline underline-offset-4 hover:text-ink',
                      ),
                      h.OnClick(Message.ClickedUseTestPlan()),
                    ],
                    ['Use the test’s plan'],
                  )
                : h.empty,
            ],
          )
        : h.empty,
      adjust.isOpen
        ? h.p(
            [h.Class('mt-3 max-w-[56ch] text-[12px] text-ink-3')],
            [
              model === 'rate'
                ? 'A rate holds steady for the whole run, instead of the ramp in the test file. Leave a field empty to keep the test’s value.'
                : 'A number of users holds steady for the whole run. Leave a field empty to keep the test’s value.',
            ],
          )
        : h.empty,
    ],
  )
}

const thresholds = (test: TestInfo, h: HtmlBuilder<Message>): Html =>
  test.thresholds.length === 0
    ? h.p(
        [h.Class('mt-8 text-[13px] text-ink-3')],
        [
          'No thresholds set. Add some to the test, like "p99 < 250ms", to get a pass or fail.',
        ],
      )
    : h.div(
        [h.Class('mt-8 flex flex-wrap items-center gap-2')],
        [
          h.span([h.Class('mr-1 text-[12px] text-ink-3')], ['Passes if']),
          ...test.thresholds.map(expression => chip(expression, h)),
        ],
      )

export const readyView = (
  test: TestInfo,
  adjust: Adjust,
  h: HtmlBuilder<Message>,
): Html => {
  const read = readAdjust(adjust, test)
  const maybePlan = effectivePlan(test, read.overrides)
  const others = test.scenarios.length - 1
  return h.section(
    [h.Class('pt-12 pb-10'), h.AriaLabel('Ready to run')],
    [
      label('The plan', h),
      h.p(
        [h.Class('mt-2 max-w-[48ch] text-[19px] leading-snug text-ink')],
        [
          Option.match(maybePlan, {
            onNone: () => 'This test has no scenarios yet.',
            onSome: describePlan,
          }),
          ...(others > 0
            ? [
                h.span(
                  [h.Class('text-ink-3')],
                  [
                    ` Plus ${others} more ${others === 1 ? 'scenario' : 'scenarios'}.`,
                  ],
                ),
              ]
            : []),
        ],
      ),
      Option.match(maybePlan, {
        onNone: () => h.empty,
        onSome: plan => planPreview(plan, h),
      }),
      thresholds(test, h),
      adjustLoad(test, adjust, h),
      h.p(
        [h.Class('mt-10 text-[12px] text-ink-3')],
        [
          'Press ',
          h.kbd(
            [
              h.Class(
                'num rounded border border-hairline px-1 py-px text-[11px] text-ink-2',
              ),
            ],
            ['Enter'],
          ),
          ' or Start run to begin.',
          test.baseUrl === undefined ? '' : ` Requests go to ${test.baseUrl}.`,
        ],
      ),
    ],
  )
}
