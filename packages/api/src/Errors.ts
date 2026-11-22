/**
 * Error fingerprints: grouping thousands of failures into the handful of
 * problems behind them.
 *
 * Two errors get the same fingerprint when they are the same problem: the
 * same kind, on the same endpoint, with the same message once the parts
 * that change every time (ids, numbers, quoted values) are blanked out.
 * A schema mismatch is grouped by the path with list indexes blanked, so
 * `$.items[3].price` and `$.items[7].price` are one problem.
 *
 * The engine stamps each error with its fingerprint and counts them per
 * second (`Second.fingerprints`). `groupErrors` turns any list of Seconds
 * into groups, so the Errors screen works for the whole run or for any
 * window someone brushes on the timeline. Pure functions, safe in the
 * browser.
 */
import { Schema } from 'effect'

import {
  ErrorKind,
  type ErrorSample,
  SchemaDiff,
  type Second,
} from './Second.ts'

/** Examples kept from the start, the end, and spread over the middle. */
const KEEP = 3

/**
 * Blank out what changes from one occurrence to the next: quoted values,
 * long hex ids and UUIDs, and numbers.
 */
export const normalizeMessage = (message: string): string =>
  message
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"…"')
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      'ID',
    )
    .replace(/\b[0-9a-f]{12,}\b/gi, 'ID')
    .replace(/\d+(\.\d+)?/g, 'N')

/** `$.items[3].price` → `$.items[*].price`. */
export const pathPattern = (path: string): string =>
  path.replace(/\[\d+\]/g, '[*]')

/** What identifies the problem, in words. Also the group's subtitle. */
export const errorDetail = (sample: {
  readonly kind: ErrorKind
  readonly message: string
  readonly diff?: SchemaDiff | undefined
  readonly location?: string | undefined
}): string => {
  switch (sample.kind) {
    // A status line or a timeout is already the same every time.
    case 'HttpStatus':
    case 'Timeout':
      return sample.message
    case 'SchemaMismatch':
      return sample.diff === undefined
        ? normalizeMessage(sample.message)
        : `${pathPattern(sample.diff.path)}: ${normalizeMessage(sample.diff.expected)} (received ${sample.diff.receivedType})`
    case 'ScriptError':
      return sample.location === undefined
        ? normalizeMessage(sample.message)
        : `${normalizeMessage(sample.message)} at ${sample.location}`
    default:
      return normalizeMessage(sample.message)
  }
}

/**
 * FNV-1a, a tiny well-known string hash. It only has to keep a few
 * hundred distinct problems apart, not be secure.
 */
const hash = (text: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** A short id for the problem behind an error, e.g. "1x9k3tq". */
export const fingerprint = (sample: {
  readonly endpoint: string
  readonly kind: ErrorKind
  readonly message: string
  readonly diff?: SchemaDiff | undefined
  readonly location?: string | undefined
}): string =>
  hash(`${sample.kind}\u0000${sample.endpoint}\u0000${errorDetail(sample)}`)

/** One example of a grouped error, with the second it happened in. */
export const ErrorExample = Schema.Struct({
  t: Schema.Finite,
  message: Schema.String,
  diff: Schema.optionalKey(SchemaDiff),
  location: Schema.optionalKey(Schema.String),
})
export type ErrorExample = typeof ErrorExample.Type

/** Every occurrence of one problem. */
export const ErrorGroup = Schema.Struct({
  fingerprint: Schema.String,
  kind: ErrorKind,
  endpoint: Schema.String,
  /** The first message seen, as it arrived: "503 Service Unavailable". */
  title: Schema.String,
  /** What the occurrences have in common: "$.items[*].price: expected number, received string". */
  detail: Schema.String,
  count: Schema.Finite,
  /** First and last second it happened in. */
  firstSeen: Schema.Finite,
  lastSeen: Schema.Finite,
  /**
   * The first few examples, the last few, and a few spread over the
   * middle, oldest first. A noisy error can never push out a rare one,
   * because each group keeps its own.
   */
  examples: Schema.Array(ErrorExample),
})
export type ErrorGroup = typeof ErrorGroup.Type

interface Building {
  readonly fingerprint: string
  readonly kind: ErrorKind
  readonly endpoint: string
  readonly title: string
  readonly detail: string
  count: number
  firstSeen: number
  lastSeen: number
  readonly first: Array<ErrorExample>
  readonly last: Array<ErrorExample>
  readonly middle: Array<ErrorExample>
  /** Examples seen after `first` filled up, for the reservoir. */
  seen: number
}

const exampleOf = (t: number, sample: ErrorSample): ErrorExample => ({
  t,
  message: sample.message,
  ...(sample.diff === undefined ? {} : { diff: sample.diff }),
  ...(sample.location === undefined ? {} : { location: sample.location }),
})

/**
 * Keep the first KEEP examples, the last KEEP, and KEEP chosen evenly at
 * random from everything in between (reservoir sampling). The "random"
 * choice is a hash of the group and the count, so the same Seconds always
 * give the same examples and the screen does not flicker.
 */
const keep = (group: Building, example: ErrorExample): void => {
  if (group.first.length < KEEP) {
    group.first.push(example)
    return
  }
  group.last.push(example)
  if (group.last.length <= KEEP) return
  // The oldest of the "last" examples moves to the middle reservoir.
  const moved = group.last.shift()!
  group.seen++
  if (group.middle.length < KEEP) {
    group.middle.push(moved)
    return
  }
  const slot =
    parseInt(hash(`${group.fingerprint}:${group.seen}`), 36) % group.seen
  if (slot < KEEP) group.middle[slot] = moved
}

/**
 * Group the errors in some Seconds by fingerprint, most frequent first.
 * Seconds recorded before fingerprints existed are grouped from their
 * samples, each sample counting once.
 */
export const groupErrors = (
  seconds: ReadonlyArray<Second>,
): Array<ErrorGroup> => {
  const groups = new Map<string, Building>()
  for (const second of seconds) {
    const samples = second.errorSamples.map(sample => ({
      sample,
      fp: sample.fingerprint ?? fingerprint(sample),
    }))
    // Counts per fingerprint: exact when recorded, else one per sample.
    const counts: Record<string, number> = { ...second.fingerprints }
    if (second.fingerprints === undefined) {
      for (const { fp } of samples) counts[fp] = (counts[fp] ?? 0) + 1
    }
    for (const [fp, count] of Object.entries(counts)) {
      let group = groups.get(fp)
      if (group === undefined) {
        const first = samples.find(s => s.fp === fp)?.sample
        // The engine always keeps one sample per fingerprint per second,
        // so this only happens with hand-made data.
        if (first === undefined) continue
        group = {
          fingerprint: fp,
          kind: first.kind,
          endpoint: first.endpoint,
          title: first.message,
          detail: errorDetail(first),
          count: 0,
          firstSeen: second.t,
          lastSeen: second.t,
          first: [],
          last: [],
          middle: [],
          seen: 0,
        }
        groups.set(fp, group)
      }
      group.count += count
      group.firstSeen = Math.min(group.firstSeen, second.t)
      group.lastSeen = Math.max(group.lastSeen, second.t)
    }
    for (const { sample, fp } of samples) {
      const group = groups.get(fp)
      if (group !== undefined) keep(group, exampleOf(second.t, sample))
    }
  }
  return [...groups.values()]
    .map(group => ({
      fingerprint: group.fingerprint,
      kind: group.kind,
      endpoint: group.endpoint,
      title: group.title,
      detail: group.detail,
      count: group.count,
      firstSeen: group.firstSeen,
      lastSeen: group.lastSeen,
      examples: [...group.first, ...group.middle, ...group.last].sort(
        (a, b) => a.t - b.t,
      ),
    }))
    .sort((a, b) => b.count - a.count)
}
