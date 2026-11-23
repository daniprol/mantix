/**
 * Steering a live run from its timeline: "Add spike" and "Change rate" sit
 * above the right column, where the dotted plan ends, and open a small
 * form in that column. While the form makes sense, the change is drawn
 * ahead of the playhead in amber; Apply (or Enter) sends it, Escape or
 * Cancel drops it.
 *
 * Pause and Resume are in the run bar, next to Stop (see analysis.ts).
 */
import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { RIGHT } from '../charts/layout.ts'
import { checkForm } from '../domain/steer.ts'
import { Message } from '../message.ts'
import { type Model, SteerForm } from '../model.ts'

/** End labels on the timeline start 8px into the right column; so do we. */
const LABEL_INSET = 8

const linkButton = (
  label: string,
  message: Message,
  isOpen: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(message),
      h.AriaExpanded(isOpen),
      h.Class(
        `text-[13px] leading-5 underline underline-offset-[3px] transition-colors duration-150 ease-out ${
          isOpen
            ? 'text-accent-ink decoration-accent'
            : 'text-ink decoration-ink-3 hover:decoration-ink'
        }`,
      ),
    ],
    [label],
  )

type Field = Readonly<{
  id: string
  /** The word before the box: "×", "for", "to", "over". */
  label: string
  value: string
  unit: string
  width: string
  isValid: boolean
  toMessage: (value: string) => Message
}>

/** A small labelled number box, the New run input at the size of a row. */
const field = (config: Field, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex items-center gap-1.5')],
    [
      h.label(
        [h.For(config.id), h.Class('text-[12px] text-ink-2')],
        [config.label],
      ),
      h.div(
        [
          h.Class(
            `flex h-7 ${config.width} items-center rounded-md border bg-paper pr-2 focus-within:border-ink-3 ${
              config.isValid ? 'border-hairline' : 'border-danger/60'
            }`,
          ),
        ],
        [
          h.input([
            h.Id(config.id),
            h.Type('text'),
            h.InputMode('decimal'),
            h.Autocomplete('off'),
            h.Spellcheck(false),
            h.Value(config.value),
            h.OnInput(config.toMessage),
            h.AriaInvalid(!config.isValid),
            h.Class(
              'num h-full w-full min-w-0 bg-transparent px-2 text-[12px] text-ink outline-none',
            ),
          ]),
          config.unit === ''
            ? h.empty
            : h.span(
                [h.Class('num shrink-0 text-[11px] text-ink-2')],
                [config.unit],
              ),
        ],
      ),
    ],
  )

/** The two fields of the open form. */
const fields = (
  form: SteerForm,
  isRate: boolean,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const check = checkForm(form)
  return SteerForm.match(form, {
    Closed: () => [],
    Spike: ({ factor, duration }) => [
      field(
        {
          id: 'spike-factor',
          label: '×',
          value: factor,
          unit: '',
          width: 'w-12',
          isValid: check.first,
          toMessage: value => Message.UpdatedSpikeFactor({ value }),
        },
        h,
      ),
      field(
        {
          id: 'spike-duration',
          label: 'for',
          value: duration,
          unit: 's',
          width: 'w-16',
          isValid: check.second,
          toMessage: value => Message.UpdatedSpikeDuration({ value }),
        },
        h,
      ),
    ],
    Rate: ({ target, over }) => [
      field(
        {
          id: 'rate-target',
          label: 'to',
          value: target,
          unit: isRate ? '/s' : 'VUs',
          width: 'w-[76px]',
          isValid: check.first,
          toMessage: value => Message.UpdatedRateTarget({ value }),
        },
        h,
      ),
      field(
        {
          id: 'rate-over',
          label: 'over',
          value: over,
          unit: 's',
          width: 'w-14',
          isValid: check.second,
          toMessage: value => Message.UpdatedRateOver({ value }),
        },
        h,
      ),
    ],
  })
}

const formView = (
  form: SteerForm,
  isRate: boolean,
  isSending: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const check = checkForm(form)
  return h.form(
    [
      h.Class('mt-2 flex flex-col items-start gap-2'),
      h.AriaLabel(form._tag === 'Spike' ? 'Spike' : 'Rate'),
      h.OnSubmit(Message.SubmittedChange()),
      h.OnKeyDownPreventDefault(key =>
        key === 'Escape'
          ? Option.some(Message.ClickedCancelChange())
          : Option.none(),
      ),
    ],
    [
      h.div([h.Class('flex items-center gap-3')], [...fields(form, isRate, h)]),
      h.div(
        [h.Class('flex items-center gap-3')],
        [
          h.button(
            [
              h.Type('submit'),
              h.Disabled(isSending || !check.first || !check.second),
              h.Class(
                'inline-flex h-7 items-center rounded-md border border-hairline bg-paper px-3 text-[12px] text-ink transition-colors duration-150 ease-out hover:bg-wash disabled:cursor-default disabled:opacity-50',
              ),
            ],
            [isSending ? 'Applying…' : 'Apply'],
          ),
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ClickedCancelChange()),
              h.Class('text-[12px] text-ink-2 hover:text-ink'),
            ],
            ['Cancel'],
          ),
        ],
      ),
    ],
  )
}

/**
 * The steering controls, placed over the timeline's right column. The
 * timeline section is `relative`, so `top: 0` is the row above the top
 * track where the playhead's time is written.
 */
export const steerView = (
  model: Model,
  isRate: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const form = model.steerForm
  return h.div(
    [
      h.Class('absolute top-0 right-0'),
      h.Style({ width: `${RIGHT - LABEL_INSET}px` }),
    ],
    [
      h.div(
        [h.Class('flex items-center gap-4')],
        [
          linkButton(
            'Add spike',
            Message.ClickedAddSpike(),
            form._tag === 'Spike',
            h,
          ),
          linkButton(
            'Change rate',
            Message.ClickedChangeRate(),
            form._tag === 'Rate',
            h,
          ),
        ],
      ),
      form._tag === 'Closed'
        ? h.empty
        : formView(form, isRate, model.controlRequest === 'Sending', h),
    ],
  )
}
