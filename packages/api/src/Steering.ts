/**
 * Steering: the load a run should generate, from its plan plus its journal.
 *
 * This is the one place that defines what the controls mean. The engine
 * asks it "what load right now?" many times a second, and the dashboard
 * asks it "what does the rest of the run look like?" to draw the dashed
 * future path, including a change that is only staged (typed but not yet
 * applied). Both get the same answer because both call the same pure
 * functions, with no Effect and no Node APIs, so it is safe in the browser.
 *
 * Two clocks:
 * - wall time: seconds since the run started, ticking no matter what.
 * - plan time: wall time minus the time spent paused. The plan, rate
 *   ramps and spikes all move on plan time, so pausing freezes them and
 *   resuming carries on from the same point.
 */
import type { Control, JournalEntry } from './Journal.ts'
import { planDuration, targetAt } from './Plan.ts'
import type { ScenarioInfo } from './Run.ts'

/** Spike ramp when none is given, in seconds. */
export const DEFAULT_SPIKE_RAMP = 3
/** Longest pin note, in characters. */
export const MAX_PIN_NOTE = 280

/** A stretch of wall time with no load. `to` is Infinity while it lasts. */
interface Pause {
  readonly from: number
  readonly to: number
}

/** A rate dial change for one scenario, in plan time. */
interface Dial {
  readonly at: number
  readonly from: number
  readonly to: number
  readonly over: number
}

/** A spike for one scenario, in plan time. */
interface Surge {
  readonly at: number
  readonly factor: number
  readonly duration: number
  readonly ramp: number
}

/** A plan and a journal, read once and ready to answer questions. */
export interface Steering {
  /** Plan seconds at wall second `w`: paused time does not count. */
  readonly planTime: (w: number) => number
  /** True when wall second `w` falls inside a pause. */
  readonly isPaused: (w: number) => boolean
  /** The target (rate or VUs) for scenario `i` at wall second `w`. */
  readonly target: (i: number, w: number) => number
  /** The sum over every scenario, the same unit as `Second.target`. */
  readonly total: (w: number) => number
  /** True once scenario `i` has played its whole plan. */
  readonly ended: (i: number, w: number) => boolean
  /** Wall second when the whole plan ends; Infinity while paused. */
  readonly end: number
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))

/** The trapezoid shape of a spike: 0 → 1 → 0, as a multiplier on factor. */
const surgeShape = (surge: Surge, x: number): number => {
  if (x < 0 || x >= surge.duration) return 0
  const ramp = Math.min(surge.ramp, surge.duration / 2)
  if (ramp === 0) return 1
  if (x < ramp) return x / ramp
  if (x > surge.duration - ramp) return (surge.duration - x) / ramp
  return 1
}

/** Which scenarios a control names: one by name, or all of them. */
const scenarioIndexes = (
  plan: ReadonlyArray<ScenarioInfo>,
  name: string | undefined,
): Array<number> =>
  plan.flatMap((s, i) => (name === undefined || s.name === name ? [i] : []))

/**
 * Read a plan and its journal. Entries must be in the order they were
 * applied, which is how the journal stores them.
 */
export const steer = (
  plan: ReadonlyArray<ScenarioInfo>,
  journal: ReadonlyArray<JournalEntry>,
): Steering => {
  const pauses: Array<Pause> = []
  const dials: Array<Array<Dial>> = plan.map(() => [])
  const surges: Array<Array<Surge>> = plan.map(() => [])

  const isPaused = (w: number): boolean =>
    pauses.some(p => p.from <= w && w < p.to)

  const planTime = (w: number): number => {
    let paused = 0
    for (const p of pauses) paused += Math.max(0, Math.min(w, p.to) - p.from)
    return w - paused
  }

  // Scenario i's own clock: plan time minus its `startAfter`.
  const local = (i: number, p: number): number => p - plan[i]!.startAfter
  const running = (i: number, p: number): boolean => {
    const x = local(i, p)
    return x >= 0 && x < planDuration(plan[i]!.plan)
  }

  /** The dialled level for scenario i at plan time p, before spikes. */
  const dialAt = (i: number, p: number): number => {
    if (!running(i, p)) return 0
    // The latest dial change that has happened by p wins.
    let last: Dial | undefined
    for (const dial of dials[i]!) if (dial.at <= p) last = dial
    if (last === undefined) return targetAt(plan[i]!.plan, local(i, p))
    const progress = last.over === 0 ? 1 : clamp01((p - last.at) / last.over)
    return last.from + (last.to - last.from) * progress
  }

  const surgeAt = (i: number, p: number): number =>
    surges[i]!.reduce(
      (factor, s) => factor * (1 + (s.factor - 1) * surgeShape(s, p - s.at)),
      1,
    )

  // Replay the journal in order. Each control is placed on plan time as
  // it was when the control was applied.
  for (const { at, control } of journal) {
    const p = planTime(at)
    switch (control._tag) {
      case 'Pause':
        pauses.push({ from: at, to: Infinity })
        break
      case 'Resume': {
        const open = pauses.at(-1)
        if (open !== undefined && open.to === Infinity) {
          pauses[pauses.length - 1] = { from: open.from, to: at }
        }
        break
      }
      case 'Rate': {
        const targets = scenarioIndexes(plan, control.scenario).filter(i =>
          running(i, p),
        )
        const levels = targets.map(i => dialAt(i, p))
        const sum = levels.reduce((a, b) => a + b, 0)
        targets.forEach((i, k) => {
          // A run-wide target is shared in proportion to the current load,
          // so a 3:1 mix of scenarios stays 3:1.
          const to =
            control.scenario !== undefined
              ? control.target
              : sum > 0
                ? (control.target * levels[k]!) / sum
                : control.target / targets.length
          dials[i]!.push({
            at: p,
            from: levels[k]!,
            to,
            over: control.over ?? 0,
          })
        })
        break
      }
      case 'Spike':
        for (const i of scenarioIndexes(plan, control.scenario)) {
          surges[i]!.push({
            at: p,
            factor: control.factor,
            duration: control.duration,
            ramp: control.ramp ?? DEFAULT_SPIKE_RAMP,
          })
        }
        break
      case 'Pin':
        break
    }
  }

  const target = (i: number, w: number): number => {
    if (isPaused(w)) return 0
    const p = planTime(w)
    return dialAt(i, p) * surgeAt(i, p)
  }

  // The plan ends at plan time `planEnd`; every pause before that pushes
  // the end later in wall time. An open pause means "not known yet".
  const planEnd = Math.max(
    0,
    ...plan.map(s => s.startAfter + planDuration(s.plan)),
  )
  let end = planEnd
  for (const p of pauses) if (p.from <= end) end += p.to - p.from

  return {
    planTime,
    isPaused,
    target,
    total: w => plan.reduce((sum, _, i) => sum + target(i, w), 0),
    ended: (i, w) =>
      planTime(w) >= plan[i]!.startAfter + planDuration(plan[i]!.plan),
    end,
  }
}

/**
 * Check a control before it is applied at wall second `at`. Returns a
 * sentence saying what is wrong, or undefined when it is fine.
 */
export const checkControl = (
  plan: ReadonlyArray<ScenarioInfo>,
  journal: ReadonlyArray<JournalEntry>,
  control: Control,
  at: number,
): string | undefined => {
  const steering = steer(plan, journal)
  const named = (name: string | undefined): string | undefined =>
    name === undefined || plan.some(s => s.name === name)
      ? undefined
      : `There is no scenario named "${name}".`
  switch (control._tag) {
    case 'Rate': {
      if (!(control.target >= 0)) return 'The target must be 0 or more.'
      if (control.over !== undefined && !(control.over >= 0)) {
        return 'The ramp time must be 0 or more.'
      }
      const missing = named(control.scenario)
      if (missing !== undefined) return missing
      const p = steering.planTime(at)
      const anyRunning = scenarioIndexes(plan, control.scenario).some(i => {
        const x = p - plan[i]!.startAfter
        return x >= 0 && x < planDuration(plan[i]!.plan)
      })
      return anyRunning
        ? undefined
        : 'Nothing is running right now, so there is no load to change.'
    }
    case 'Spike':
      if (!(control.factor > 0)) return 'The spike factor must be above 0.'
      if (!(control.duration > 0)) return 'The spike needs a duration.'
      if (control.ramp !== undefined && !(control.ramp >= 0)) {
        return 'The ramp time must be 0 or more.'
      }
      return named(control.scenario)
    case 'Pause':
      return steering.isPaused(at) ? 'The run is already paused.' : undefined
    case 'Resume':
      return steering.isPaused(at) ? undefined : 'The run is not paused.'
    case 'Pin':
      return control.note.length > MAX_PIN_NOTE
        ? `Keep the note under ${MAX_PIN_NOTE} characters.`
        : undefined
  }
}

/** One point of the planned future, for the dashed line on the timeline. */
export interface PathPoint {
  /** Wall seconds since the run started. */
  readonly t: number
  /** Total target at that moment (the unit of `Second.target`). */
  readonly target: number
}

export interface PlannedPath {
  /** From `from` to the planned end, one point every `step` seconds. */
  readonly points: ReadonlyArray<PathPoint>
  /** Wall second when the run will end. */
  readonly end: number
  /**
   * True when the run is (or would be) paused at `from`. Nobody knows
   * when it will resume, so the points show what happens if it resumed
   * right away.
   */
  readonly paused: boolean
}

/**
 * The rest of the run as the journal (plus an optional `staged` control)
 * says it will go, from wall second `from` to the end.
 *
 * Staging is how live changes are previewed: the dashboard passes the
 * change someone is typing as `staged`, draws the returned path, and only
 * posts the control when they confirm.
 */
export const plannedPath = (
  plan: ReadonlyArray<ScenarioInfo>,
  journal: ReadonlyArray<JournalEntry>,
  from: number,
  options: { readonly staged?: Control; readonly step?: number } = {},
): PlannedPath => {
  const step = options.step ?? 1
  let entries: ReadonlyArray<JournalEntry> =
    options.staged === undefined
      ? journal
      : [
          ...journal,
          { seq: journal.length + 1, at: from, control: options.staged },
        ]
  const paused = steer(plan, entries).isPaused(from)
  if (paused) {
    // Pretend it resumes now, so there is still a path to draw.
    entries = [
      ...entries,
      { seq: entries.length + 1, at: from, control: { _tag: 'Resume' } },
    ]
  }
  const steering = steer(plan, entries)
  const points: Array<PathPoint> = []
  for (let t = from; t < steering.end; t += step) {
    points.push({ t, target: steering.total(t) })
  }
  points.push({ t: steering.end, target: 0 })
  return { points, end: steering.end, paused }
}
