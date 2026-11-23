/**
 * Stretches of a run to draw differently on the timeline: hatched where
 * the numbers should not be trusted, shaded where the run was paused.
 *
 * Nothing is dropped from the data. The dashboard keeps every Second and
 * marks these stretches so people know how to read them.
 */
import type { JournalEntry } from './Journal.ts'
import type { GeneratorHealth, GeneratorIssue, Second } from './Second.ts'

/** Above these, the generator was struggling. */
export const GENERATOR_LIMITS = {
  /** Worst event-loop delay in a second, ms. */
  loopLagMs: 100,
  /** Latest iteration start compared to its schedule, ms. */
  lateStartMs: 50,
  /** CPU used by the Mantix process, % of one core. */
  cpuPercent: 90,
  /** Garbage-collection pauses in a second, ms. */
  gcMs: 100,
} as const

/** Which limits a second went over. Empty means it can be trusted. */
export const generatorIssues = (
  health: Omit<GeneratorHealth, 'issues'> & { readonly loopLagMs: number },
): Array<GeneratorIssue> => {
  const issues: Array<GeneratorIssue> = []
  if (health.loopLagMs > GENERATOR_LIMITS.loopLagMs) issues.push('LoopLag')
  if (health.lateStartMs > GENERATOR_LIMITS.lateStartMs) {
    issues.push('LateStarts')
  }
  if (health.cpuPercent > GENERATOR_LIMITS.cpuPercent) issues.push('Cpu')
  if (health.gcMs > GENERATOR_LIMITS.gcMs) issues.push('Gc')
  return issues
}

/**
 * Why a second should not be trusted; empty when it can be. Seconds
 * recorded before Mantix measured its own health fall back to the
 * event-loop delay alone.
 */
export const issuesOf = (second: Second): ReadonlyArray<GeneratorIssue> =>
  second.generator?.issues ??
  (second.loopLagMs > GENERATOR_LIMITS.loopLagMs ? ['LoopLag'] : [])

/** A run of consecutive seconds, `from` inclusive, `to` exclusive. */
export interface Stretch {
  readonly from: number
  readonly to: number
}

export interface UntrustedStretch extends Stretch {
  /** Every reason seen in the stretch. */
  readonly issues: ReadonlyArray<GeneratorIssue>
}

/** Join consecutive untrusted seconds into stretches, for the hatching. */
export const untrustedStretches = (
  seconds: ReadonlyArray<Second>,
): Array<UntrustedStretch> => {
  const stretches: Array<{
    from: number
    to: number
    issues: Set<GeneratorIssue>
  }> = []
  for (const second of seconds) {
    const issues = issuesOf(second)
    if (issues.length === 0) continue
    const last = stretches.at(-1)
    if (last !== undefined && last.to === second.t) {
      last.to = second.t + 1
      for (const issue of issues) last.issues.add(issue)
    } else {
      stretches.push({
        from: second.t,
        to: second.t + 1,
        issues: new Set(issues),
      })
    }
  }
  return stretches.map(s => ({ from: s.from, to: s.to, issues: [...s.issues] }))
}

/**
 * The paused stretches of a run, in wall seconds since it started, from
 * its journal. A pause still going ends at `now`.
 */
export const pausedStretches = (
  journal: ReadonlyArray<JournalEntry>,
  now: number,
): Array<Stretch> => {
  const stretches: Array<Stretch> = []
  let pausedAt: number | undefined
  for (const { at, control } of journal) {
    if (control._tag === 'Pause' && pausedAt === undefined) pausedAt = at
    if (control._tag === 'Resume' && pausedAt !== undefined) {
      stretches.push({ from: pausedAt, to: at })
      pausedAt = undefined
    }
  }
  if (pausedAt !== undefined) stretches.push({ from: pausedAt, to: now })
  return stretches
}
