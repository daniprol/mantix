/**
 * The small p95 curve on each endpoint row. It spans the same seconds as
 * the timeline above it, so a bump on a row lines up with the moment it
 * happened. Each row has its own scale, so quiet endpoints stay readable.
 * When comparing, the baseline is drawn in gray under this run, with the
 * gap between them tinted.
 *
 * Plain SVG from the view: a few hundred points per row is cheap, and it
 * keeps the curve a pure function of the Model.
 */
import { Array, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { Range } from '../domain/span.ts'
import type { Message } from '../message.ts'

const WIDTH = 1000
const HEIGHT = 30
const PAD = 3

type Values = ReadonlyArray<number | null>

export type CurveInput = Readonly<{
  current: Values
  maybeBaseline: Option.Option<Values>
  /** Seconds on the x axis, the same as the timeline's. */
  duration: number
  maybeRange: Option.Option<Range>
}>

/** Second t is drawn at the end of its column, like on the timeline. */
const xOf = (t: number, duration: number) =>
  ((t + 1) / Math.max(1, duration)) * WIDTH

const noRuns = (): Array<Array<number>> => []

/** Runs of consecutive seconds where `isDrawn` holds; a gap breaks them. */
const runsOf = (
  length: number,
  isDrawn: (t: number) => boolean,
): ReadonlyArray<ReadonlyArray<number>> =>
  Array.reduce(
    Array.makeBy(length, t => t),
    noRuns(),
    (runs, t) => {
      if (isDrawn(t)) {
        const last = runs[runs.length - 1]
        // NOTE: the accumulator is local to this reduce, so growing it in
        // place is safe and keeps long runs linear.
        if (last !== undefined && last[last.length - 1] === t - 1) {
          last.push(t)
        } else {
          runs.push([t])
        }
      }
      return runs
    },
  )

const line = (
  points: string,
  className: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.polyline([
    h.Points(points),
    h.Fill('none'),
    h.Class(className),
    h.StrokeWidth('1.25'),
    h.StrokeLinejoin('round'),
    h.VectorEffect('non-scaling-stroke'),
  ])

/** Where both runs have data, tint the band between the two lines. */
const gaps = (
  current: Values,
  baseline: Values,
  toPoint: (t: number, value: number) => string,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  runsOf(
    Math.min(current.length, baseline.length),
    t => current[t] != null && baseline[t] != null,
  ).map(run =>
    h.polygon([
      h.Points(
        [
          ...run.map(t => toPoint(t, current[t] ?? 0)),
          ...[...run].reverse().map(t => toPoint(t, baseline[t] ?? 0)),
        ].join(' '),
      ),
      h.Class('fill-ink-3/20'),
    ]),
  )

/** One polyline per unbroken run of seconds. */
const lines = (
  values: Values,
  toPoint: (t: number, value: number) => string,
  className: string,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  runsOf(values.length, t => values[t] != null).map(run =>
    line(run.map(t => toPoint(t, values[t] ?? 0)).join(' '), className, h),
  )

export const curveView = (input: CurveInput, h: HtmlBuilder<Message>): Html => {
  const baseline = Option.getOrElse(input.maybeBaseline, () => [])
  const highest = Math.max(
    1,
    ...[...input.current, ...baseline].map(value => value ?? 0),
  )
  const toPoint = (t: number, value: number) =>
    `${xOf(t, input.duration).toFixed(1)},${(
      HEIGHT -
      PAD -
      (value / highest) * (HEIGHT - 2 * PAD)
    ).toFixed(1)}`
  return h.svg(
    [
      h.ViewBox(`0 0 ${WIDTH} ${HEIGHT}`),
      h.PreserveAspectRatio('none'),
      h.Class('block h-[30px] w-full overflow-visible'),
      h.AriaHidden(true),
    ],
    [
      Option.match(input.maybeRange, {
        onNone: () => h.empty,
        onSome: ({ from, to }) =>
          h.rect([
            h.X(String(xOf(from - 1, input.duration))),
            h.Y('0'),
            h.Width(
              String(
                xOf(to - 1, input.duration) - xOf(from - 1, input.duration),
              ),
            ),
            h.Height(String(HEIGHT)),
            h.Class('fill-accent/10'),
          ]),
      }),
      ...gaps(input.current, baseline, toPoint, h),
      ...lines(baseline, toPoint, 'stroke-ink-3', h),
      ...lines(input.current, toPoint, 'stroke-ink', h),
    ],
  )
}
