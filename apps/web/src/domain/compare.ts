/**
 * Comparing two runs: this run against a baseline, endpoint by endpoint.
 *
 * The statistics live in `@mantix/api` (Compare.ts), shared with
 * `mantix compare`, so the dashboard and the terminal always agree. This
 * file turns their verdicts into the words and order the page shows.
 */
import { Array, Option, Order } from 'effect'

import {
  Compare,
  type EndpointStats,
  type RunInfo,
  type Second,
} from '@mantix/api'

import * as Format from './format.ts'
import { type Span, spanSeconds } from './span.ts'

// THE NUMBERS

/**
 * A pure cache: the same two arrays of Seconds and the same span always
 * give the same comparison. The bootstrap takes a moment, and the view
 * runs many times a second, so it is worked out once and remembered.
 * The Model never changes an array in place, which makes this safe.
 */
const cache = new WeakMap<
  ReadonlyArray<Second>,
  WeakMap<ReadonlyArray<Second>, Map<string, Compare.Comparison>>
>()

const spanKey = (span: Span): string =>
  span._tag === 'Range' ? `${span.from}-${span.to}` : span._tag

/** The comparison of the span on screen, for every endpoint at once. */
export const comparisonOf = (
  current: ReadonlyArray<Second>,
  baseline: ReadonlyArray<Second>,
  span: Span,
): Compare.Comparison => {
  const byBaseline = cache.get(current) ?? new WeakMap()
  cache.set(current, byBaseline)
  const bySpan = byBaseline.get(baseline) ?? new Map()
  byBaseline.set(baseline, bySpan)
  const key = spanKey(span)
  const cached = bySpan.get(key)
  if (cached !== undefined) {
    return cached
  }
  const comparison = Compare.compareRuns(
    [spanSeconds(baseline, span)],
    [spanSeconds(current, span)],
  )
  bySpan.set(key, comparison)
  return comparison
}

/** The comparison of one endpoint, or of all requests. */
export const endpointComparison = (
  comparison: Compare.Comparison,
  maybeEndpoint: Option.Option<string>,
): Option.Option<Compare.EndpointComparison> =>
  Option.match(maybeEndpoint, {
    onNone: () => Option.some(comparison.total),
    onSome: endpoint =>
      Array.findFirst(comparison.endpoints, row => row.endpoint === endpoint),
  })

// THE WORDS

export type Tone = 'Worse' | 'Better' | 'Quiet'

/** How one change reads: a word, its range, and a sentence on hover. */
export type Reading = Readonly<{
  word: string
  maybeRange: Option.Option<string>
  hint: string
  tone: Tone
}>

/** A number with its sign: "+12", "−3", "0". */
const signed = (value: number): string =>
  value > 0 ? `+${value}` : value < 0 ? `−${-value}` : '0'

/** A latency change in percent, an error-rate change in points. */
const amount = (metric: Compare.Metric, change: number): number =>
  metric === 'errors'
    ? Number((change * 100).toFixed(2))
    : Math.round(change * 100)

const unitOf = (metric: Compare.Metric): string =>
  metric === 'errors' ? ' pts' : '%'

/** "+8 to +16%", or "−0.1 to +0.3 pts" for errors. */
const rangeText = (change: Compare.Change): Option.Option<string> =>
  Option.map(
    Option.fromNullishOr(change.range),
    ({ low, high }) =>
      `${signed(amount(change.metric, low))} to ${signed(amount(change.metric, high))}${unitOf(change.metric)}`,
  )

const percentWord = (change: number, worse: string, better: string) =>
  `${Math.round(Math.abs(change) * 100)}% ${change > 0 ? worse : better}`

/** Why there is no verdict, in a sentence. */
const reasonHint = (change: Compare.Change, requests: number): string => {
  switch (change.reason) {
    case 'TooShort':
      return 'A run is too short to judge: it needs at least 5 seconds of data.'
    case 'TooFewRequests':
      return `Too few requests to judge a ${change.metric}: ${Format.grouped(requests)} on the smaller side.`
    default:
      return 'Too noisy to judge: the change could be anywhere in this range. Run longer, or repeat the runs.'
  }
}

/** How a change reads in the dashboard. `band` is what counts as too small to matter. */
export const readChange = (
  change: Compare.Change,
  band: number,
  requests: number,
): Reading => {
  const isErrors = change.metric === 'errors'
  const maybeRange = rangeText(change)
  const bandText = isErrors ? '0.1 points' : `${Math.round(band * 100)}%`
  switch (change.verdict) {
    case 'Worse':
    case 'Better':
      return {
        word: isErrors
          ? `${signed(amount('errors', change.change))} pts`
          : percentWord(change.change, 'slower', 'faster'),
        maybeRange,
        hint: `A real change, bigger than ${bandText}: it most likely lies in this range.`,
        tone: change.verdict,
      }
    case 'NoChange':
      return {
        word: 'same',
        maybeRange,
        hint: `No real change: anything that moved is smaller than ${bandText}.`,
        tone: 'Quiet',
      }
    case 'CantTell':
      return {
        word: change.reason === 'Noisy' ? 'unclear' : 'too few',
        maybeRange,
        hint: reasonHint(change, requests),
        tone: 'Quiet',
      }
  }
}

/** The p95 reading of an endpoint: what the list shows. */
export const readP95 = (
  row: Compare.EndpointComparison,
  band: number,
): Reading =>
  readChange(row.p95, band, Math.min(row.baselineRequests, row.currentRequests))

/** The endpoints' p95 verdicts, as a figure: "1 slower", "3 same · 1 unclear". */
export type EndpointsVerdict = Readonly<{
  value: string
  isWorse: boolean
  note: string
}>

export const endpointsVerdict = (
  comparison: Compare.Comparison,
): EndpointsVerdict => {
  const rows = comparison.endpoints.filter(row => row.isLoad)
  const count = (verdict: Compare.Verdict) =>
    rows.filter(row => row.p95.verdict === verdict).length
  const counts = [
    ['Worse', count('Worse'), 'slower'],
    ['Better', count('Better'), 'faster'],
    ['NoChange', count('NoChange'), 'same'],
    ['CantTell', count('CantTell'), 'unclear'],
  ] as const
  const nonZero = counts.filter(([, n]) => n > 0)
  // The headline: any slowdown first, then any speed-up, then the rest.
  const head = nonZero[0]
  if (head === undefined) {
    return { value: '–', isWorse: false, note: '' }
  }
  const [verdict, n, word] = head
  return {
    value: `${n} ${word}`,
    isWorse: verdict === 'Worse',
    note:
      n === rows.length
        ? 'every endpoint'
        : nonZero
            .slice(1)
            .map(([, each, eachWord]) => `${each} ${eachWord}`)
            .join(' · '),
  }
}

/** Short labels for what makes the runs less than like for like. */
const WARNING_LABELS: Record<Compare.Warning, string> = {
  DifferentTests: 'different tests',
  DifferentPlans: 'different load plans',
  ChangedLive: 'load changed live',
  DifferentMachines: 'different machines',
}

export const notesOf = (
  baseline: RunInfo,
  current: RunInfo,
  comparison: Compare.Comparison,
): ReadonlyArray<string> => {
  const leftOut = comparison.leftOut.baseline + comparison.leftOut.current
  return [
    ...Compare.warnings([baseline], [current]).map(w => WARNING_LABELS[w]),
    ...(leftOut === 0 ? [] : [`${leftOut} s left out`]),
  ]
}

// THE ROWS

/** One endpoint in both runs. Either side is missing when it only ran once. */
export type ComparedRow = Readonly<{
  endpoint: string
  maybeCurrent: Option.Option<EndpointStats>
  maybeBaseline: Option.Option<EndpointStats>
  maybeComparison: Option.Option<Compare.EndpointComparison>
}>

/** Slower first, then faster, then unclear, then the same. */
const VERDICT_ORDER: Record<Compare.Verdict, number> = {
  Worse: 0,
  Better: 1,
  CantTell: 2,
  NoChange: 3,
}

const byVerdict = Order.mapInput(Order.Number, (row: ComparedRow) =>
  Option.match(row.maybeComparison, {
    onNone: () => 4,
    onSome: compared => VERDICT_ORDER[compared.p95.verdict],
  }),
)

const bySizeOfChange = Order.mapInput(
  Order.flip(Order.Number),
  (row: ComparedRow) =>
    Option.match(row.maybeComparison, {
      onNone: () => -1,
      onSome: compared =>
        Number.isFinite(compared.p95.change)
          ? Math.abs(compared.p95.change)
          : -1,
    }),
)

/** Every endpoint of either run: the slowdowns first, the biggest on top. */
export const compareRows = (
  current: ReadonlyArray<EndpointStats>,
  baseline: ReadonlyArray<EndpointStats>,
  comparison: Compare.Comparison,
): ReadonlyArray<ComparedRow> => {
  const names = Array.dedupe([
    ...current.map(row => row.endpoint),
    ...baseline.map(row => row.endpoint),
  ])
  const find = (rows: ReadonlyArray<EndpointStats>, endpoint: string) =>
    Array.findFirst(rows, row => row.endpoint === endpoint)
  return Array.sort(
    names.map(endpoint => ({
      endpoint,
      maybeCurrent: find(current, endpoint),
      maybeBaseline: find(baseline, endpoint),
      maybeComparison: endpointComparison(comparison, Option.some(endpoint)),
    })),
    Order.combine(byVerdict, bySizeOfChange),
  )
}
