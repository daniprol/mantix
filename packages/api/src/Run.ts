/**
 * Schemas that describe a test and its runs. These are shared by the engine,
 * the server, the CLI and the dashboard.
 */
import { Schema } from 'effect'

import { JournalEntry } from './Journal.ts'
import { Second } from './Second.ts'

/**
 * A load plan, drawn on the dashboard as the "planned" line.
 *
 * The plan starts at `start` and moves linearly to each stage's `target`
 * over that stage's `duration` (in seconds). A constant load is a single
 * stage whose target equals `start`.
 */
export const LoadPlan = Schema.Struct({
  /** "rate": open model, iterations per second. "vus": closed model. */
  model: Schema.Literals(['rate', 'vus']),
  start: Schema.Finite,
  stages: Schema.Array(
    Schema.Struct({ duration: Schema.Finite, target: Schema.Finite }),
  ),
})
export type LoadPlan = typeof LoadPlan.Type

/** One scenario in a test file, as the dashboard shows it before a run. */
export const ScenarioInfo = Schema.Struct({
  name: Schema.String,
  plan: LoadPlan,
  /** Seconds after the run starts before this scenario begins. */
  startAfter: Schema.Finite,
})
export type ScenarioInfo = typeof ScenarioInfo.Type

/** The test file that `mantix ui` loaded. */
export const TestInfo = Schema.Struct({
  /** Path of the test file, relative to where Mantix was started. */
  file: Schema.String,
  /** A display name: the scenario name, or the file name for several. */
  name: Schema.String,
  baseUrl: Schema.optionalKey(Schema.String),
  scenarios: Schema.Array(ScenarioInfo),
  /** Threshold expressions, e.g. "p99 < 250ms" or "errors < 1%". */
  thresholds: Schema.Array(Schema.String),
  /** Planned total duration in seconds. */
  duration: Schema.Finite,
})
export type TestInfo = typeof TestInfo.Type

/**
 * Changes a person can make before starting a run from the dashboard.
 * Anything left out keeps the value from the test file.
 */
export const RunOverrides = Schema.Struct({
  /** Constant arrival rate (iterations/s). Replaces the load plan. */
  rate: Schema.optionalKey(Schema.Finite),
  /** Constant number of virtual users. Replaces the load plan. */
  vus: Schema.optionalKey(Schema.Finite),
  /** Total duration in seconds. */
  duration: Schema.optionalKey(Schema.Finite),
})
export type RunOverrides = typeof RunOverrides.Type

/** The outcome of one threshold, e.g. "p99 < 250ms". */
export const ThresholdResult = Schema.Struct({
  /** The expression as written in the test. */
  expression: Schema.String,
  /** The endpoint it applies to, or absent for the whole run. */
  endpoint: Schema.optionalKey(Schema.String),
  /** The measured value, in the expression's unit (ms, %, /s). */
  actual: Schema.Finite,
  passed: Schema.Boolean,
})
export type ThresholdResult = typeof ThresholdResult.Type

/**
 * Where a run is in its life.
 * - running: load is being generated.
 * - finished: the plan completed.
 * - stopped: someone stopped it early.
 * - aborted: a threshold failed and the run was stopped.
 * - crashed: Mantix itself failed (the message says why).
 */
export const RunStatus = Schema.Literals([
  'running',
  'finished',
  'stopped',
  'aborted',
  'crashed',
])
export type RunStatus = typeof RunStatus.Type

/**
 * Where a run came from, so runs can be told apart and compared later:
 * "main @ a1b2c3d vs feature @ d4e5f6a", or the same test in two projects
 * that share one history file. The CLI gathers it when a run starts.
 */
export const RunContext = Schema.Struct({
  /** The project's name: its package.json `name`, else its folder name. */
  project: Schema.String,
  /** Absent when Mantix ran outside a git repository. */
  git: Schema.optionalKey(
    Schema.Struct({
      /** The full SHA of HEAD. */
      commit: Schema.String,
      /** Absent on a detached HEAD. */
      branch: Schema.optionalKey(Schema.String),
      /** True when the working tree had uncommitted changes. */
      dirty: Schema.Boolean,
    }),
  ),
  /** The version of Mantix that ran the test. */
  mantixVersion: Schema.String,
  /** Enough to answer "was this the same machine?", nothing personal. */
  machine: Schema.Struct({
    hostname: Schema.String,
    /** Operating system and CPU, e.g. "linux x64". */
    os: Schema.String,
    /** Node.js version, e.g. "22.19.0". */
    node: Schema.String,
  }),
  /** Free text from `--label`, e.g. "v2.3 on staging". */
  label: Schema.optionalKey(Schema.String),
  /**
   * Set by `mantix run --repeat`: the runs of one repeat share a group,
   * and `mantix compare` treats them as one side.
   */
  repeat: Schema.optionalKey(
    Schema.Struct({
      /** Shared by every run of the repeat. */
      group: Schema.String,
      /** Which run this is, from 1. */
      index: Schema.Finite,
      /** How many runs the repeat has. */
      of: Schema.Finite,
    }),
  ),
})
export type RunContext = typeof RunContext.Type

export const RunInfo = Schema.Struct({
  id: Schema.String,
  testName: Schema.String,
  status: RunStatus,
  /** Epoch milliseconds. */
  startedAt: Schema.Finite,
  /** Epoch milliseconds, or null while running. */
  endedAt: Schema.NullOr(Schema.Finite),
  /** Planned duration in seconds. */
  duration: Schema.Finite,
  plan: Schema.Array(ScenarioInfo),
  /** Threshold results. Updated live while running. */
  thresholds: Schema.Array(ThresholdResult),
  /**
   * Every live change (rate, spike, pause, pin), oldest first. The plan
   * plus the journal say exactly what load was asked for; see Steering.ts.
   */
  journal: Schema.Array(JournalEntry),
  /** Set when status is "crashed". */
  error: Schema.optionalKey(Schema.String),
  /**
   * Project, git commit, label... Optional: runs saved before Mantix
   * recorded it, and runs started straight from the engine, have none.
   */
  context: Schema.optionalKey(RunContext),
})
export type RunInfo = typeof RunInfo.Type

/** What the live stream sends: a new Second, or a change to the run. */
export const RunEvent = Schema.Union([
  Schema.TaggedStruct('Second', { second: Second }),
  Schema.TaggedStruct('RunUpdated', { run: RunInfo }),
])
export type RunEvent = typeof RunEvent.Type
