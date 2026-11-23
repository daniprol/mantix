/**
 * What `mantix compare` prints: a table per metric with the baseline, this
 * run, the verdict on the change and the range it most likely lies in.
 *
 * Pure functions from data to strings, like Report.ts. The verdicts come
 * from `Compare` in @mantix/api, the same code the dashboard uses, so the
 * terminal and the dashboard always agree.
 */
import { styleText } from 'node:util'

import type { Compare, RunInfo } from '@mantix/api'

import { contextLine, formatMs } from './Report.ts'

type Style = Parameters<typeof styleText>[0]

const paint = (style: Style, text: string): string => styleText(style, text)

// ---------------------------------------------------------------------------
// Regression rules: `--fail-on-regression p95:+10%,errors:+0.5%`

/** Fail when `metric` is confidently worse by more than `limit`. */
export interface RegressionRule {
  readonly metric: Compare.Metric
  /** Latency: a relative change (0.1 = 10%). Errors: a rate difference (0.005 = 0.5 points). */
  readonly limit: number
}

/** Parse "p95:+10%,errors:+0.5%", or say what is wrong with it. */
export const parseRules = (
  text: string,
): ReadonlyArray<RegressionRule> | string => {
  const rules: Array<RegressionRule> = []
  for (const part of text.split(',')) {
    const match =
      /^\s*(p50|p95|p99|errors)\s*:\s*\+?(\d+(?:\.\d+)?)\s*%\s*$/.exec(part)
    if (match === null) {
      return `Could not read "${part.trim()}". Write it like p95:+10% or errors:+0.5%.`
    }
    rules.push({
      metric: match[1] as Compare.Metric,
      limit: Number(match[2]) / 100,
    })
  }
  return rules
}

export interface Regression {
  readonly endpoint: string
  readonly rule: RegressionRule
  readonly change: Compare.Change
}

/**
 * Every rule an endpoint (or all requests together) breaks. Only a
 * confident "slower" counts: "unclear" never fails a build.
 */
export const regressionsOf = (
  comparison: Compare.Comparison,
  rules: ReadonlyArray<RegressionRule>,
): ReadonlyArray<Regression> =>
  [comparison.total, ...comparison.endpoints.filter(row => row.isLoad)].flatMap(
    row =>
      rules.flatMap(rule => {
        const change = row[rule.metric]
        return change.verdict === 'Worse' && change.change > rule.limit
          ? [{ endpoint: row.endpoint, rule, change }]
          : []
      }),
  )

// ---------------------------------------------------------------------------
// Words

/** "+12", "−3", "0": a number with its sign. */
const signed = (value: number): string =>
  value > 0 ? `+${value}` : value < 0 ? `−${-value}` : '0'

/** A change as a number of percent (latency) or percentage points (errors). */
const number = (metric: Compare.Metric, change: number): string =>
  signed(
    metric === 'errors'
      ? Number((change * 100).toFixed(2))
      : Math.round(change * 100),
  )

const unit = (metric: Compare.Metric): string =>
  metric === 'errors' ? ' pts' : '%'

/** "+12%", or "+0.14 pts" for errors. */
const amount = (metric: Compare.Metric, change: number): string =>
  `${number(metric, change)}${unit(metric)}`

const limitText = (rule: RegressionRule): string =>
  amount(rule.metric, rule.limit)

/** "12% slower", "same", "unclear", "too few": the same words as the dashboard. */
export const verdictWord = (change: Compare.Change): string => {
  switch (change.verdict) {
    case 'Worse':
    case 'Better':
      return change.metric === 'errors'
        ? amount('errors', change.change)
        : `${Math.round(Math.abs(change.change) * 100)}% ${change.verdict === 'Worse' ? 'slower' : 'faster'}`
    case 'NoChange':
      return 'same'
    case 'CantTell':
      return change.reason === 'Noisy'
        ? 'unclear'
        : change.reason === 'TooShort'
          ? 'too short'
          : 'too few'
  }
}

const verdictStyle: Record<Compare.Verdict, Style> = {
  Worse: 'red',
  Better: 'green',
  NoChange: 'dim',
  CantTell: 'dim',
}

const rangeText = (change: Compare.Change): string => {
  if (change.range === undefined) return ''
  const { low, high } = change.range
  // "+22 to +38%": one unit at the end, like the dashboard.
  return `${number(change.metric, low)} to ${amount(change.metric, high)}`
}

const valueText = (change: Compare.Change, value: number): string =>
  change.metric === 'errors'
    ? `${(value * 100).toFixed(value > 0 && value < 0.001 ? 2 : 1)}%`
    : formatMs(value)

const WARNINGS: Record<Compare.Warning, string> = {
  DifferentTests: 'These are runs of different tests.',
  DifferentPlans:
    'The load plans differ, so the runs were not under the same load.',
  ChangedLive: 'The load was changed live during a run.',
  DifferentMachines: 'The runs were made on different machines.',
}

// ---------------------------------------------------------------------------
// The report

/** Pad cells so the columns line up; the first column is left aligned. */
const table = (rows: ReadonlyArray<ReadonlyArray<string>>): Array<string> => {
  const widths: Array<number> = []
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell))
    })
  }
  return rows.map(row =>
    row
      .map((cell, i) => {
        const pad = ' '.repeat(widths[i]! - visibleLength(cell))
        // The verdict and range columns read left to right.
        return i === 0 || i >= 3 ? cell + pad : pad + cell
      })
      .join('   ')
      .trimEnd(),
  )
}

// Colour codes take no space on screen, so measure without them.
const visibleLength = (text: string): number =>
  // oxlint-disable-next-line no-control-regex
  text.replace(/\u001b\[[0-9;]*m/g, '').length

const when = (run: RunInfo): string =>
  new Date(run.startedAt).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })

/** "1a2b3c4d  23 Nov, 17:40 · main @ 3f9c1e2", or "3 runs, …" for a group. */
const sideLine = (runs: ReadonlyArray<RunInfo>): string => {
  const newest = runs[0]!
  const ids =
    runs.length === 1
      ? newest.id
      : `${runs.length} runs (${runs.map(run => run.id).join(', ')})`
  return [ids, when(newest), contextLine(newest.context)]
    .filter(part => part !== '')
    .join(' · ')
}

const METRICS: ReadonlyArray<Compare.Metric> = ['p95', 'p50', 'p99', 'errors']

export const compareReport = (input: {
  readonly baseline: ReadonlyArray<RunInfo>
  readonly current: ReadonlyArray<RunInfo>
  readonly comparison: Compare.Comparison
  readonly warnings: ReadonlyArray<Compare.Warning>
  readonly rules: ReadonlyArray<RegressionRule>
  readonly regressions: ReadonlyArray<Regression>
}): string => {
  const { comparison } = input
  const rows = [comparison.total, ...comparison.endpoints]
  const lines: Array<string> = [
    '',
    `  ${paint('dim', 'baseline')}  ${sideLine(input.baseline)}`,
    `  ${paint('dim', 'this run')}  ${sideLine(input.current)}`,
  ]

  for (const metric of METRICS) {
    // A p99 needs many requests; leave the table out when no row has them.
    if (rows.every(row => row[metric].reason === 'TooFewRequests')) continue
    const header = [metric, 'baseline', 'this run', 'change', ''].map(cell =>
      paint('dim', cell),
    )
    const body = rows.map(row => {
      const change = row[metric]
      return [
        row.endpoint,
        valueText(change, change.baseline),
        valueText(change, change.current),
        paint(verdictStyle[change.verdict], verdictWord(change)),
        paint('dim', rangeText(change)),
      ]
    })
    lines.push('', ...table([header, ...body]).map(line => `  ${line}`))
  }

  const band = Math.round(comparison.band * 100)
  lines.push(
    '',
    paint(
      'dim',
      `  Ranges hold the change 95% of the time. Under ${band}% (0.1 points for errors) counts as the same.`,
    ),
  )
  for (const warning of input.warnings) {
    lines.push(paint('yellow', `  ! ${WARNINGS[warning]}`))
  }
  const leftOut = comparison.leftOut.baseline + comparison.leftOut.current
  if (leftOut > 0) {
    lines.push(
      paint(
        'yellow',
        `  ! Left out ${leftOut} s where Mantix itself could not keep up.`,
      ),
    )
  }

  if (input.rules.length > 0) {
    lines.push('')
    if (input.regressions.length === 0) {
      lines.push(
        `  ${paint(['green', 'bold'], '✓ NO REGRESSION')}  limits ${input.rules.map(rule => `${rule.metric} ${limitText(rule)}`).join(', ')}`,
      )
    } else {
      for (const { endpoint, rule, change } of input.regressions) {
        lines.push(
          `  ${paint(['red', 'bold'], '✗ REGRESSION')}  ${endpoint} ${rule.metric} ${verdictWord(change)} (${rangeText(change)}), limit ${limitText(rule)}`,
        )
      }
    }
  }
  lines.push('')
  return lines.join('\n')
}
