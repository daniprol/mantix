/**
 * The run journal: every live change to a run, in order (decision D3).
 *
 * Turning the rate dial, adding a spike, pausing or pinning a moment never
 * mutates the run directly. Each one becomes a `JournalEntry`, and the
 * engine reads the load it should generate from the plan plus the journal
 * (see Steering.ts). That keeps a steered run reproducible: the plan and
 * the journal together say exactly what happened, and the same entries are
 * drawn as flags on everyone's timeline.
 */
import { Schema } from 'effect'

/**
 * Hold a new load level from now until the end of the plan.
 *
 * `target` is in the plan's unit: iterations/s for `rate.*` scenarios,
 * virtual users for `vus.*` ones (the same unit as `Second.target`).
 * Without `scenario`, the target is the total for the whole run and is
 * shared between the running scenarios in proportion to their current
 * load. With `scenario`, it applies to that one only.
 */
export const RateControl = Schema.TaggedStruct('Rate', {
  target: Schema.Finite,
  /** Seconds to ramp from the current level to `target`. Default 0. */
  over: Schema.optionalKey(Schema.Finite),
  scenario: Schema.optionalKey(Schema.String),
})
export type RateControl = typeof RateControl.Type

/**
 * A temporary surge: multiply the load by `factor` for `duration` seconds,
 * ramping in and out over `ramp` seconds (inside the duration), then go
 * back to whatever the plan and the dial say.
 */
export const SpikeControl = Schema.TaggedStruct('Spike', {
  factor: Schema.Finite,
  duration: Schema.Finite,
  /** Seconds to ramp in and to ramp out. Default 3, at most half the duration. */
  ramp: Schema.optionalKey(Schema.Finite),
  scenario: Schema.optionalKey(Schema.String),
})
export type SpikeControl = typeof SpikeControl.Type

/**
 * Stop starting new iterations. Requests already in flight finish
 * normally. The plan's clock stops too, so the remaining plan is not lost:
 * it carries on from the same point after `Resume`, without a catch-up
 * burst, and the run ends later by the time spent paused.
 */
export const PauseControl = Schema.TaggedStruct('Pause', {})
export type PauseControl = typeof PauseControl.Type

export const ResumeControl = Schema.TaggedStruct('Resume', {})
export type ResumeControl = typeof ResumeControl.Type

/** Mark this moment with a note, e.g. "deploy started". Changes nothing. */
export const PinControl = Schema.TaggedStruct('Pin', {
  note: Schema.String,
})
export type PinControl = typeof PinControl.Type

/** What the dashboard (or any client) posts to `/runs/:id/controls`. */
export const Control = Schema.Union([
  RateControl,
  SpikeControl,
  PauseControl,
  ResumeControl,
  PinControl,
])
export type Control = typeof Control.Type

/** One applied control. */
export const JournalEntry = Schema.Struct({
  /** 1, 2, 3...: the order controls were applied in. */
  seq: Schema.Finite,
  /** When it was applied, in seconds since the run started (wall time). */
  at: Schema.Finite,
  control: Control,
})
export type JournalEntry = typeof JournalEntry.Type
