/**
 * How `mantix dev` prints one traced iteration: a small waterfall, one
 * line per request, then any errors in plain words.
 *
 *   ↻ checkout.ts · checkout-flow · 4 requests in 182 ms
 *     GET /products/:sku    200     12 ms  ▕██                    ▏
 *     POST /cart            200     45 ms  ▕  ██████              ▏
 *     ✗ SchemaMismatch GET /cart/:id: $.items[0].price: Expected number · received "19.99"
 */
import { styleText } from 'node:util'

import type { ErrorSample, ProbeResult, RequestSpan } from '@mantix/api'

const BAR_WIDTH = 32

const paint = (style: Parameters<typeof styleText>[0], text: string) =>
  styleText(style, text)

const ms = (value: number): string =>
  value < 10 ? `${value.toFixed(1)} ms` : `${Math.round(value)} ms`

/** A bar placed where the request happened within the iteration. */
const bar = (span: RequestSpan, total: number): string => {
  const scale = total > 0 ? BAR_WIDTH / total : 0
  const offset = Math.min(BAR_WIDTH - 1, Math.round(span.start * scale))
  const length = Math.max(
    1,
    Math.min(BAR_WIDTH - offset, Math.round(span.duration * scale)),
  )
  return `▕${' '.repeat(offset)}${'█'.repeat(length)}${' '.repeat(BAR_WIDTH - offset - length)}▏`
}

const errorLine = (error: ErrorSample): string => {
  const where = error.kind === 'ScriptError' ? '' : ` ${error.endpoint}`
  const extra =
    error.diff !== undefined
      ? ` · received ${error.diff.received || error.diff.receivedType}`
      : error.location !== undefined
        ? ` · ${error.location}`
        : ''
  const note =
    error.kind === 'ScriptError' ? paint('dim', ' (your test code)') : ''
  return `    ${paint('red', '✗')} ${error.kind}${where}: ${error.message}${extra}${note}`
}

/** The lines for one scenario's traced iteration. */
export const probeReport = (file: string, result: ProbeResult): string => {
  const head = `  ${paint('cyan', '↻')} ${file} · ${result.scenario}`
  if (result.setupError !== undefined) {
    return `${head}\n    ${paint('red', '✗')} setup failed: ${result.setupError}`
  }
  const trace = result.trace
  if (trace === undefined) return head
  const spans = trace.spans
  const requests = `${spans.length} ${spans.length === 1 ? 'request' : 'requests'}`
  const verdict =
    trace.outcome === 'completed' ? paint('green', '✓') : paint('red', '✗')
  const lines = [`${head} · ${requests} in ${ms(trace.duration)} ${verdict}`]
  const width = Math.max(0, ...spans.map(s => s.endpoint.length))
  for (const span of spans) {
    const status =
      span.status === undefined ? '   ' : String(span.status).padStart(3)
    lines.push(
      `    ${span.endpoint.padEnd(width)}  ${span.error === undefined ? status : paint('red', status)}  ${ms(span.duration).padStart(8)}  ${paint('dim', bar(span, trace.duration))}`,
    )
  }
  for (const error of result.errors) lines.push(errorLine(error))
  return lines.join('\n')
}
