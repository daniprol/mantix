/**
 * Which stretch of a run the figures and the endpoint list describe.
 *
 * - Now: the last few seconds, while the run is live.
 * - WholeRun: every second.
 * - Range: what someone dragged on the timeline, in whole seconds since
 *   the start, `from` inclusive and `to` exclusive.
 */
import { Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import type { Second } from '@mantix/api'

import * as Format from './format.ts'

export const Span = defineTaggedUnion({
  Now: {},
  WholeRun: {},
  Range: { from: Schema.Finite, to: Schema.Finite },
})
export type Span = typeof Span.Type
export type Range = typeof Span.Range.Type

/** How many seconds "Now" covers. */
const NOW_SECONDS = 30

export const spanSeconds = (
  seconds: ReadonlyArray<Second>,
  span: Span,
): ReadonlyArray<Second> =>
  Span.match(span, {
    Now: () => seconds.slice(Math.max(0, seconds.length - NOW_SECONDS)),
    WholeRun: () => seconds,
    Range: ({ from, to }) =>
      seconds.filter(second => second.t >= from && second.t < to),
  })

/** "Now", "Whole run" or "03:00 – 03:45". */
export const spanLabel = (span: Span): string =>
  Span.match(span, {
    Now: () => 'Now',
    WholeRun: () => 'Whole run',
    Range: ({ from, to }) => `${Format.clock(from)} – ${Format.clock(to)}`,
  })

/** "Now" only means something while the run is live. */
export const effectiveSpan = (span: Span, isLive: boolean): Span =>
  span._tag === 'Now' && !isLive ? Span.WholeRun() : span
