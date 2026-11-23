/**
 * A compared change as the page shows it: the verdict in words ("12%
 * slower", "same", "unclear"), and under it, small and gray, the range the
 * change most likely lies in. Hovering explains the verdict in a sentence.
 */
import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { Reading, Tone } from '../domain/compare.ts'
import type { Message } from '../message.ts'

const TONE_CLASS: Record<Tone, string> = {
  Worse: 'text-danger',
  Better: 'text-ink',
  Quiet: 'text-ink-2',
}

/** The verdict, and under it the range the change most likely lies in. */
export const changeView = (reading: Reading, h: HtmlBuilder<Message>): Html =>
  h.span(
    [h.Class('flex flex-col items-end leading-[1.15]'), h.Title(reading.hint)],
    [
      h.span(
        [h.Class(`whitespace-nowrap ${TONE_CLASS[reading.tone]}`)],
        [reading.word],
      ),
      Option.match(reading.maybeRange, {
        onNone: () => h.empty,
        onSome: range =>
          h.span(
            [h.Class('num whitespace-nowrap text-[11px] text-ink-3')],
            [range],
          ),
      }),
    ],
  )
