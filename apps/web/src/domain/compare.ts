/**
 * Comparing two runs: this run against a baseline, endpoint by endpoint.
 */
import { Array, Option, Order } from 'effect'

import type { EndpointStats } from '@mantix/api'

/** Differences smaller than this are run-to-run noise: "same". */
const SAME_WITHIN = 0.05

/** One endpoint in both runs. Either side is missing when it only ran once. */
export type ComparedRow = Readonly<{
  endpoint: string
  maybeCurrent: Option.Option<EndpointStats>
  maybeBaseline: Option.Option<EndpointStats>
}>

/** The relative change from `before` to `after`: -0.15 is 15% less. */
const relativeChange = (before: number, after: number): number =>
  before === 0 ? 0 : (after - before) / before

/** "35% faster", "12% slower" or "same", for a latency. */
export const latencyChange = (before: number, after: number): string => {
  const change = relativeChange(before, after)
  if (Math.abs(change) < SAME_WITHIN) {
    return 'same'
  }
  const percent = Math.round(Math.abs(change) * 100)
  return change < 0 ? `${percent}% faster` : `${percent}% slower`
}

const p95Change = (row: ComparedRow): number =>
  Option.match(Option.all([row.maybeBaseline, row.maybeCurrent]), {
    onNone: () => -1,
    onSome: ([baseline, current]) =>
      Math.abs(relativeChange(baseline.latency.p95, current.latency.p95)),
  })

const byChangeDescending = Order.mapInput(Order.flip(Order.Number), p95Change)

/** Every endpoint of either run, the biggest p95 change first. */
export const compareRows = (
  current: ReadonlyArray<EndpointStats>,
  baseline: ReadonlyArray<EndpointStats>,
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
    })),
    byChangeDescending,
  )
}
