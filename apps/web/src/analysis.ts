/**
 * What the page on screen analyses, resolved from the route and the runs
 * loaded so far. The views and the timeline both read it, so they always
 * agree on which run, which baseline, which endpoint and which seconds.
 */
import { Array, Option, Record, pipe } from 'effect'

import type {
  Control,
  JournalEntry,
  RunInfo,
  ScenarioInfo,
  Second,
  ThresholdResult,
} from '@mantix/api'

import type { LatencyLimit, TimelineInput } from './charts/store.ts'
import { readLoadForm } from './domain/adjust.ts'
import { applyOverrides, planDuration } from './domain/plan.ts'
import { effectiveSpan } from './domain/span.ts'
import { focusSeconds, isOver } from './domain/stats.ts'
import { plannedEnd, stagedControl } from './domain/steer.ts'
import * as Threshold from './domain/threshold.ts'
import { type LoadedRun, type Model, TestState } from './model.ts'
import { AppRoute } from './route.ts'

/** A run, or one endpoint of it, ready to draw. */
export type Analysis = Readonly<{
  current: LoadedRun
  maybeBaseline: Option.Option<LoadedRun>
  maybeEndpoint: Option.Option<string>
}>

export const loadedRun = (
  model: Model,
  runId: string,
): Option.Option<LoadedRun> =>
  pipe(
    Record.get(model.runs, runId),
    Option.flatMap(data =>
      data._tag === 'Loaded' ? Option.some(data) : Option.none(),
    ),
  )

const analyse = (
  model: Model,
  runId: string,
  maybeBaselineId: Option.Option<string>,
  maybeEndpoint: Option.Option<string>,
): Option.Option<Analysis> =>
  Option.flatMap(loadedRun(model, runId), current =>
    Option.match(maybeBaselineId, {
      onNone: () =>
        Option.some({ current, maybeBaseline: Option.none(), maybeEndpoint }),
      onSome: baselineId =>
        Option.map(loadedRun(model, baselineId), baseline => ({
          current,
          maybeBaseline: Option.some(baseline),
          maybeEndpoint,
        })),
    }),
  )

/** The analysis for the route on screen, once its runs have loaded. */
export const analysisOf = (model: Model): Option.Option<Analysis> =>
  AppRoute.match(model.route, {
    Run: ({ runId }) => analyse(model, runId, Option.none(), Option.none()),
    RunEndpoint: ({ runId, endpoint }) =>
      analyse(model, runId, Option.none(), Option.some(endpoint)),
    Compare: ({ runId, baselineId }) =>
      analyse(model, runId, Option.some(baselineId), Option.none()),
    CompareEndpoint: ({ runId, baselineId, endpoint }) =>
      analyse(model, runId, Option.some(baselineId), Option.some(endpoint)),
    NewRun: () => Option.none(),
    Runs: () => Option.none(),
    PickCompare: () => Option.none(),
    NotFound: () => Option.none(),
  })

/** A run's Seconds, or only one endpoint's part of them. */
export const secondsOf = (
  loaded: LoadedRun,
  maybeEndpoint: Option.Option<string>,
): ReadonlyArray<Second> =>
  Option.match(maybeEndpoint, {
    onNone: () => loaded.seconds,
    onSome: endpoint => focusSeconds(loaded.seconds, endpoint),
  })

/** The checks to list: every check on a run page, its own on an endpoint page. */
export const checksFor = (
  run: RunInfo,
  maybeEndpoint: Option.Option<string>,
): ReadonlyArray<ThresholdResult> =>
  Option.match(maybeEndpoint, {
    onNone: () => run.thresholds,
    onSome: endpoint => run.thresholds.filter(t => t.endpoint === endpoint),
  })

/** The checks measured on exactly these requests: the ones a chart can draw. */
const ownChecks = (
  run: RunInfo,
  maybeEndpoint: Option.Option<string>,
): ReadonlyArray<ThresholdResult> =>
  run.thresholds.filter(
    t => t.endpoint === Option.getOrUndefined(maybeEndpoint),
  )

/** The first latency threshold among some checks, to draw as a limit. */
const latencyLimit = (
  checks: ReadonlyArray<Readonly<{ expression: string; passed: boolean }>>,
): Option.Option<LatencyLimit> =>
  Array.findFirst(checks, check =>
    pipe(
      Threshold.parse(check.expression),
      Option.filter(t => t.metric !== 'errors' && t.metric !== 'rps'),
      Option.map(t => ({
        metric: t.metric,
        ms: t.limit,
        failed: !check.passed,
      })),
    ),
  )

export const isRatePlan = (plan: ReadonlyArray<ScenarioInfo>): boolean =>
  plan.every(scenario => scenario.plan.model === 'rate')

/**
 * Can this page steer its run? Only a live run's own page: not a
 * comparison, and not one endpoint (which has no plan of its own).
 */
export const isSteerable = (analysis: Analysis): boolean =>
  !isOver(analysis.current.run) &&
  Option.isNone(analysis.maybeBaseline) &&
  Option.isNone(analysis.maybeEndpoint)

/** The change being typed, if this page can steer its run. */
export const stagedOf = (
  model: Model,
  analysis: Analysis,
): Option.Option<Control> =>
  isSteerable(analysis) ? stagedControl(model.steerForm) : Option.none()

/**
 * How many seconds a run takes on the timeline. A finished run: what it
 * took. A live one: until its planned end, which pauses, spikes and the
 * change being typed can move.
 */
const runLength = (
  loaded: LoadedRun,
  maybeStaged: Option.Option<Control> = Option.none(),
): number => {
  const now = loaded.seconds.length
  return isOver(loaded.run)
    ? Math.max(loaded.run.duration, now)
    : Math.max(
        now,
        Math.ceil(
          plannedEnd(loaded.run.plan, loaded.run.journal, now, maybeStaged),
        ),
      )
}

/** The length of the timeline's clock: the longer of the runs on it. */
export const timelineLength = (model: Model, analysis: Analysis): number =>
  Math.max(
    runLength(analysis.current, stagedOf(model, analysis)),
    Option.match(analysis.maybeBaseline, {
      onNone: () => 0,
      onSome: baseline => runLength(baseline),
    }),
  )

const analysisInput = (model: Model, analysis: Analysis): TimelineInput => {
  const { current, maybeBaseline, maybeEndpoint } = analysis
  const isEndpoint = Option.isSome(maybeEndpoint)
  const span = effectiveSpan(model.span, !isOver(current.run))
  return {
    duration: timelineLength(model, analysis),
    topTrack: isEndpoint ? 'Throughput' : 'Load',
    plan: isEndpoint ? [] : current.run.plan,
    journal: current.run.journal,
    maybeStaged: stagedOf(model, analysis),
    isRate: isRatePlan(current.run.plan),
    current: secondsOf(current, maybeEndpoint),
    maybeBaseline: Option.map(maybeBaseline, baseline =>
      secondsOf(baseline, maybeEndpoint),
    ),
    isLive: !isOver(current.run),
    maybeLimit: latencyLimit(ownChecks(current.run, maybeEndpoint)),
    maybeRange: span._tag === 'Range' ? Option.some(span) : Option.none(),
  }
}

/** The plan the New run page would start, with the typed overrides. */
const plannedScenarios = (model: Model): ReadonlyArray<ScenarioInfo> =>
  TestState.match(model.test, {
    Connecting: () => [],
    Unreachable: () => [],
    Loaded: ({ test }) => {
      const { overrides } = readLoadForm(model.loadForm, test)
      return test.scenarios.map(scenario => ({
        ...scenario,
        plan: applyOverrides(scenario.plan, overrides),
      }))
    },
  })

/** One shared empty list, so the plan's input stays the same between updates. */
const NO_SECONDS: ReadonlyArray<Second> = []
const NO_JOURNAL: ReadonlyArray<JournalEntry> = []

const planInput = (model: Model): Option.Option<TimelineInput> =>
  TestState.match(model.test, {
    Connecting: () => Option.none(),
    Unreachable: () => Option.none(),
    Loaded: ({ test }) => {
      const plan = plannedScenarios(model)
      const input: TimelineInput = {
        duration: Math.max(
          1,
          ...plan.map(
            scenario => scenario.startAfter + planDuration(scenario.plan),
          ),
        ),
        topTrack: 'Load',
        plan,
        journal: NO_JOURNAL,
        maybeStaged: Option.none(),
        isRate: isRatePlan(test.scenarios),
        current: NO_SECONDS,
        maybeBaseline: Option.none(),
        isLive: false,
        maybeLimit: latencyLimit(
          test.thresholds.map(expression => ({ expression, passed: true })),
        ),
        maybeRange: Option.none(),
      }
      return Option.some(input)
    },
  })

/** What the timeline should draw for the Model, if the page has one. */
export const timelineInput = (model: Model): Option.Option<TimelineInput> =>
  model.route._tag === 'NewRun'
    ? planInput(model)
    : Option.map(analysisOf(model), analysis => analysisInput(model, analysis))

/** Finished runs, newest first: what can be compared. */
export const finishedRuns = (model: Model): ReadonlyArray<RunInfo> =>
  model.history._tag === 'Loaded' ? model.history.runs.filter(isOver) : []

/**
 * The two runs the Compare page will open: what was picked, else the
 * newest finished run against the one before it.
 */
export const comparePair = (
  model: Model,
): Option.Option<readonly [string, string]> => {
  const runs = finishedRuns(model)
  const maybeRunId = Option.orElse(model.comparePick.maybeRunId, () =>
    Option.map(Array.get(runs, 0), run => run.id),
  )
  const maybeBaselineId = Option.orElse(model.comparePick.maybeBaselineId, () =>
    Option.map(
      Array.findFirst(runs, run => !Option.contains(maybeRunId, run.id)),
      run => run.id,
    ),
  )
  return Option.filter(
    Option.all([maybeRunId, maybeBaselineId]),
    ([runId, baselineId]) => runId !== baselineId,
  )
}
