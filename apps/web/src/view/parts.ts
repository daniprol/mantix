/**
 * Small view pieces used across screens: buttons, quantities, chips.
 *
 * Foldkit idea: a view is a plain function from data to Html. `h` is the
 * typed Html builder; passing it down keeps every helper tied to our
 * Message type, so a button can only ever send a real Message.
 */
import type { Html, HtmlBuilder } from 'foldkit/html'

import type * as Format from '../domain/format.ts'
import type { Message } from '../message.ts'

export const primaryButtonClass =
  'inline-flex h-8 items-center gap-2 rounded-md bg-ink px-3.5 text-[13px] font-medium text-paper transition-opacity duration-150 ease-out hover:opacity-85 disabled:cursor-default disabled:opacity-50'

export const quietButtonClass =
  'inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] text-ink-2 transition-colors duration-150 ease-out hover:bg-wash hover:text-ink'

export const primaryButton = (
  label: string,
  message: Message,
  h: HtmlBuilder<Message>,
  options: Readonly<{ isDisabled?: boolean; hint?: string }> = {},
): Html =>
  h.button(
    [
      h.Type('button'),
      h.Class(primaryButtonClass),
      h.OnClick(message),
      h.Disabled(options.isDisabled === true),
    ],
    [
      label,
      ...(options.hint === undefined
        ? []
        : [
            h.span(
              [h.Class('num text-[11px] opacity-55'), h.AriaHidden(true)],
              [options.hint],
            ),
          ]),
    ],
  )

export const quietButton = (
  label: string,
  message: Message,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [h.Type('button'), h.Class(quietButtonClass), h.OnClick(message)],
    [label],
  )

/** A number with its unit set smaller and muted: 212 ms. */
export const quantity = (
  { value, unit }: Format.Quantity,
  h: HtmlBuilder<Message>,
  unitClass = 'text-ink-3',
): Html =>
  h.span(
    [h.Class('num whitespace-nowrap')],
    [
      value,
      h.span(
        [
          h.Class(
            `${unit.startsWith('/') || unit === '%' ? '' : 'ml-[0.2em] '}text-[0.72em] ${unitClass}`,
          ),
        ],
        [unit],
      ),
    ],
  )

/** A quiet pill for thresholds: "p99 < 250ms", optionally with the result. */
export const chip = (
  expression: string,
  h: HtmlBuilder<Message>,
  result: Readonly<{ actual: string; failed: boolean }> | undefined = undefined,
): Html =>
  h.span(
    [
      h.Class(
        `num inline-flex h-6 items-center gap-2 rounded-full border px-2.5 text-[12px] ${
          result?.failed === true
            ? 'border-danger/40 bg-danger-wash text-danger'
            : 'border-hairline text-ink-2'
        }`,
      ),
    ],
    [
      expression,
      ...(result === undefined
        ? []
        : [
            h.span(
              [h.Class(result.failed ? 'font-medium text-danger' : 'text-ink')],
              [result.actual],
            ),
          ]),
    ],
  )

/** A small label above a figure or a section. */
export const label = (text: string, h: HtmlBuilder<Message>): Html =>
  h.div([h.Class('text-[12px] text-ink-3')], [text])
