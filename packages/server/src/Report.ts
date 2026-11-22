/**
 * What `mantix run` prints: one line per second while the run goes, and a
 * summary table at the end.
 *
 * Pure functions from data to strings, so they are easy to test and to
 * change. Colour comes from node:util `styleText`, which already turns
 * itself off for NO_COLOR, FORCE_COLOR=0 and output that is not a terminal.
 */
import { styleText } from 'node:util'

import {
  type GeneratorIssue,
  Histogram,
  type RunInfo,
  type RunSummary,
  type Second,
} from '@mantix/api'

type Style = Parameters<typeof styleText>[0]

const paint = (style: Style, text: string): string => styleText(style, text)

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const oneDecimal = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

/** A latency in ms, with about three significant figures and one unit. */
export const formatMs = (ms: number): string => {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`
  if (ms >= 100) return `${ms.toFixed(0)} ms`
  if (ms >= 10) return `${ms.toFixed(1)} ms`
  return `${ms.toFixed(2)} ms`
}

const percent = (fraction: number): string =>
  `${(fraction * 100).toFixed(fraction > 0 && fraction < 0.001 ? 2 : 1)}%`

/** "1:05" style elapsed time; seconds only below a minute. */
const elapsed = (seconds: number): string =>
  seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

/**
 * The once-per-second line, e.g.
 *   12s   2,003 req/s   iter 1,000/s of 1,000   p99 23.4 ms   err 0.4%
 * `model` decides whether the target is a rate or a number of VUs.
 */
export const secondLine = (
  second: Second,
  model: 'rate' | 'vus' | 'mixed',
): string => {
  let requests = 0
  let errors = 0
  for (const part of second.endpoints) {
    requests += part.requests
    for (const count of Object.values(part.errors)) errors += count
  }
  const latency = Histogram.mergeAll(second.endpoints.map(e => e.latency))
  const p99 =
    latency.count === 0
      ? '–'
      : formatMs(Histogram.percentile(latency, 0.99) / 1000)
  const target = integer.format(Math.round(second.target))
  const load =
    model === 'vus'
      ? `vus ${second.vus} of ${target}`
      : `iter ${integer.format(second.started)}/s of ${target}`
  const errorRate = requests === 0 ? 0 : errors / requests
  const parts = [
    paint('dim', elapsed(second.t + 1).padStart(6)),
    `${integer.format(requests).padStart(7)} req/s`,
    load.padEnd(22),
    `p99 ${p99.padStart(9)}`,
    paint(
      errorRate > 0 ? 'red' : 'dim',
      `err ${percent(errorRate).padStart(6)}`,
    ),
  ]
  if (second.dropped > 0) {
    parts.push(paint('yellow', `dropped ${integer.format(second.dropped)}`))
  }
  // The generator itself was too busy: these numbers are less trustworthy.
  const issues = second.generator?.issues ?? []
  if (issues.length > 0) {
    parts.push(
      paint('yellow', `untrusted: ${issues.map(issueLabel).join(', ')}`),
    )
  } else if (second.loopLagMs >= 50) {
    parts.push(paint('yellow', `loop lag ${second.loopLagMs.toFixed(0)} ms`))
  }
  return parts.join('   ')
}

/** Short words for why a second is not trusted. */
const issueLabel = (issue: GeneratorIssue): string =>
  ({
    LoopLag: 'loop lag',
    LateStarts: 'late starts',
    Cpu: 'cpu',
    Gc: 'gc',
  })[issue]

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
        return i === 0 ? cell + pad : pad + cell
      })
      .join('  '),
  )
}

// Colour codes take no space on screen, so measure without them.
const visibleLength = (text: string): number =>
  // oxlint-disable-next-line no-control-regex
  text.replace(/\u001b\[[0-9;]*m/g, '').length

const statusVerdict: Record<RunInfo['status'], string> = {
  running: 'RUNNING',
  finished: 'FINISHED',
  stopped: 'STOPPED early',
  aborted: 'ABORTED by a threshold',
  crashed: 'CRASHED',
}

/** Did the run pass? Used for the verdict and the exit code. */
export const passed = (run: RunInfo): boolean =>
  run.status !== 'crashed' &&
  run.status !== 'aborted' &&
  run.thresholds.every(t => t.passed)

/** Format a threshold's measured value in the unit it was written in. */
const thresholdActual = (expression: string, actual: number): string => {
  if (/^\s*errors/.test(expression)) return `${actual.toFixed(2)}%`
  if (/^\s*rps/.test(expression)) return `${oneDecimal.format(actual)}/s`
  return formatMs(actual)
}

/** The end-of-run report. */
export const summaryReport = (
  summary: RunSummary,
  seconds: ReadonlyArray<Second>,
): string => {
  const { run, total, endpoints } = summary
  const lines: Array<string> = ['']

  const header = [
    'endpoint',
    'req',
    'req/s',
    'p50',
    'p95',
    'p99',
    'max',
    'errors',
  ]
  const row = (stats: RunSummary['total'], bold: boolean): Array<string> => {
    const cells = [
      stats.endpoint,
      integer.format(stats.requests),
      oneDecimal.format(stats.rps),
      formatMs(stats.latency.p50),
      formatMs(stats.latency.p95),
      formatMs(stats.latency.p99),
      formatMs(stats.latency.max),
      stats.errors === 0
        ? '0'
        : paint(
            'red',
            `${integer.format(stats.errors)} (${percent(stats.errorRate)})`,
          ),
    ]
    return bold ? cells.map(cell => paint('bold', cell)) : cells
  }
  const rows = [
    header.map(cell => paint('dim', cell)),
    ...endpoints.map(stats => row(stats, false)),
  ]
  if (endpoints.length > 1) rows.push(row(total, true))
  if (endpoints.length === 0) {
    lines.push('  No requests were made.')
  } else {
    lines.push(...table(rows).map(line => `  ${line}`))
    lines.push(
      paint(
        'dim',
        `  Latency is measured from each request's intended start. Uncorrected p99: ${formatMs(total.uncorrected.p99)}.`,
      ),
    )
  }

  // Iterations that could not start are a result, not a detail.
  if (summary.iterations.dropped > 0) {
    lines.push(
      paint(
        'yellow',
        `  ${integer.format(summary.iterations.dropped)} iterations dropped: every VU was busy (raise maxVus, or the target is saturated).`,
      ),
    )
  }

  // A few distinct example errors from the whole run.
  const examples = new Map<string, number>()
  for (const second of seconds) {
    for (const sample of second.errorSamples) {
      const key = `${sample.kind}  ${sample.endpoint}  ${sample.message}`
      examples.set(key, (examples.get(key) ?? 0) + 1)
    }
  }
  if (examples.size > 0) {
    lines.push('', '  Errors (examples)')
    for (const [text] of [...examples.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)) {
      lines.push(`    ${paint('red', '•')} ${text}`)
    }
  }

  if (run.thresholds.length > 0) {
    lines.push('', '  Thresholds')
    const thresholdRows = run.thresholds.map(t => [
      t.passed ? paint('green', '✓') : paint('red', '✗'),
      t.endpoint === undefined
        ? t.expression
        : `${t.endpoint}: ${t.expression}`,
      paint('dim', `actual ${thresholdActual(t.expression, t.actual)}`),
    ])
    // Left-align the expression column too.
    for (const cells of thresholdRows) {
      const width = Math.max(...thresholdRows.map(r => visibleLength(r[1]!)))
      lines.push(`    ${cells[0]} ${cells[1]!.padEnd(width)}  ${cells[2]}`)
    }
  }

  lines.push('', `  ${verdict(summary)}`, '')
  return lines.join('\n')
}

/** One line that says how it went. */
const verdict = (summary: RunSummary): string => {
  const { run } = summary
  const failed = run.thresholds.filter(t => !t.passed).length
  const facts = `${integer.format(summary.total.requests)} requests in ${summary.seconds} s`
  if (run.status === 'crashed') {
    return paint(['red', 'bold'], `✗ CRASHED: ${run.error ?? 'unknown error'}`)
  }
  if (!passed(run)) {
    const why =
      run.status === 'aborted'
        ? statusVerdict.aborted
        : `${failed} of ${run.thresholds.length} thresholds failed`
    return `${paint(['red', 'bold'], '✗ FAILED')}  ${why} · ${facts}`
  }
  const status =
    run.status === 'finished' ? '' : ` (${statusVerdict[run.status]})`
  const checks =
    run.thresholds.length === 0
      ? 'no thresholds set'
      : `all ${run.thresholds.length} thresholds met`
  return `${paint(['green', 'bold'], '✓ PASSED')}${status}  ${checks} · ${facts}`
}
