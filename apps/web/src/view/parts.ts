/**
 * Small view pieces used across pages: buttons, links, quantities.
 *
 * Foldkit idea: a view is a plain function from data to Html. `h` is the
 * typed Html builder; passing it down keeps every helper tied to our
 * Message type, so a button can only ever send a real Message.
 */
import type { Html, HtmlBuilder } from 'foldkit/html'

import type * as Format from '../domain/format.ts'
import type { Message } from '../message.ts'

const primaryClass =
  'inline-flex h-8 items-center gap-2 rounded-md bg-ink px-3.5 text-[13px] font-medium text-paper transition-opacity duration-150 ease-out hover:opacity-85 disabled:cursor-default disabled:opacity-50'

const secondaryClass =
  'inline-flex h-8 items-center gap-2 rounded-md border border-hairline bg-paper px-3.5 text-[13px] text-ink transition-colors duration-150 ease-out hover:bg-wash disabled:cursor-default disabled:opacity-50'

export type Emphasis = 'Primary' | 'Secondary'

const buttonClass = (emphasis: Emphasis) =>
  emphasis === 'Primary' ? primaryClass : secondaryClass

export const button = (
  label: string,
  message: Message,
  emphasis: Emphasis,
  h: HtmlBuilder<Message>,
  options: Readonly<{ isDisabled?: boolean; hint?: string }> = {},
): Html =>
  h.button(
    [
      h.Type('button'),
      h.Class(buttonClass(emphasis)),
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

/** A link that looks like a button: navigation, not an action. */
export const buttonLink = (
  label: string,
  href: string,
  emphasis: Emphasis,
  h: HtmlBuilder<Message>,
): Html => h.a([h.Href(href), h.Class(buttonClass(emphasis))], [label])

/** A number with its unit set smaller and muted: 212 ms. */
export const quantity = (
  { value, unit }: Format.Quantity,
  h: HtmlBuilder<Message>,
  unitClass = 'text-ink-2',
): Html =>
  h.span(
    [h.Class('num whitespace-nowrap')],
    [
      value,
      h.span([h.Class(`ml-[0.25em] text-[0.72em] ${unitClass}`)], [unit]),
    ],
  )

/** A muted placeholder where a number is missing or not meaningful. */
export const missing = (text: string, h: HtmlBuilder<Message>): Html =>
  h.span([h.Class('num text-ink-3')], [text])

/** "GET /cart/:id": the method small and gray, the route in full. */
export const endpointName = (
  endpoint: string,
  h: HtmlBuilder<Message>,
): Html => {
  const [method, ...rest] = endpoint.split(' ')
  return rest.length === 0
    ? h.span([h.Class('num truncate text-ink')], [endpoint])
    : h.span(
        [h.Class('flex min-w-0 items-baseline gap-2.5')],
        [
          h.span(
            [h.Class('num w-9 shrink-0 text-[11px] text-ink-2')],
            [method ?? ''],
          ),
          h.span([h.Class('num truncate text-ink')], [rest.join(' ')]),
        ],
      )
}

/** A small segmented control: one choice pressed at a time. */
export const segmented = (
  label: string,
  options: ReadonlyArray<
    Readonly<{
      key: string
      text: string
      isPressed: boolean
      message: Message
    }>
  >,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Class(
        'inline-flex h-8 rounded-md border border-hairline bg-paper p-0.5',
      ),
      h.Role('group'),
      h.AriaLabel(label),
    ],
    options.map(option =>
      h.keyed('button')(
        option.key,
        [
          h.Type('button'),
          h.AriaPressed(String(option.isPressed)),
          h.OnClick(option.message),
          h.Class(
            `num rounded-[4px] px-3 text-[12px] transition-colors duration-150 ease-out ${
              option.isPressed
                ? 'bg-wash text-ink'
                : 'text-ink-2 hover:text-ink'
            }`,
          ),
        ],
        [option.text],
      ),
    ),
  )
