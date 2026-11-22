/**
 * MODEL: everything the dashboard knows, as one immutable value.
 *
 * Foldkit idea: the Model is a Schema. States that can't happen together are
 * separate variants of a tagged union (a run is Loading, Failed or Loaded,
 * never two at once), instead of a handful of booleans.
 *
 * Chart objects (uPlot) are NOT here: see charts/store.ts.
 */
import { Option, Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import { RunInfo, Second, TestInfo } from '@mantix/api'

import { Span } from './domain/span.ts'
import { AppRoute } from './route.ts'
import { Theme } from './theme.ts'

/** Talking to the Mantix server to learn which test is loaded. */
export const TestState = defineTaggedUnion({
  Connecting: {},
  Unreachable: { error: Schema.String },
  Loaded: { test: TestInfo },
})
export type TestState = typeof TestState.Type

/** The run history, newest first. */
export const History = defineTaggedUnion({
  Loading: {},
  Failed: { error: Schema.String },
  Loaded: { runs: Schema.Array(RunInfo) },
})
export type History = typeof History.Type

/** The live event stream of a running run. */
export const Feed = defineTaggedUnion({
  Following: {},
  Ended: {},
  Lost: { error: Schema.String },
})
export type Feed = typeof Feed.Type

const StopRequest = Schema.Literals(['NotRequested', 'Requested'])
type StopRequest = typeof StopRequest.Type

/** One run and its data, as far as the dashboard has it. */
export const RunData = defineTaggedUnion({
  Loading: {},
  Failed: { error: Schema.String },
  Loaded: {
    run: RunInfo,
    seconds: Schema.Array(Second),
    feed: Feed,
    /** Bumped by "Reconnect" so the stream Subscription restarts. */
    connection: Schema.Finite,
    stop: StopRequest,
  },
})
export type RunData = typeof RunData.Type
export type LoadedRun = typeof RunData.Loaded.Type

/** Starting a run from the New run page. */
export const Launch = defineTaggedUnion({
  Idle: {},
  Starting: {},
})
export type Launch = typeof Launch.Type

/** The load inputs on the New run page, kept as typed text. */
export const LoadForm = Schema.Struct({
  load: Schema.String,
  duration: Schema.String,
})
export type LoadForm = typeof LoadForm.Type

/** The two runs chosen on the Compare page, before pressing Compare. */
const ComparePick = Schema.Struct({
  maybeRunId: Schema.Option(Schema.String),
  maybeBaselineId: Schema.Option(Schema.String),
})
type ComparePick = typeof ComparePick.Type

export const Model = Schema.Struct({
  route: AppRoute,
  test: TestState,
  history: History,
  /** Every run opened so far, by id. Finished runs never change. */
  runs: Schema.Record(Schema.String, RunData),
  /** What the figures and the endpoint list describe. */
  span: Span,
  launch: Launch,
  loadForm: LoadForm,
  comparePick: ComparePick,
  maybeActionError: Schema.Option(Schema.String),
  theme: Theme,
})
export type Model = typeof Model.Type

export const initialModel = (
  route: AppRoute,
  theme: Theme = 'System',
): Model => ({
  route,
  test: TestState.Connecting(),
  history: History.Loading(),
  runs: {},
  span: Span.Now(),
  launch: Launch.Idle(),
  loadForm: { load: '', duration: '' },
  comparePick: {
    maybeRunId: Option.none(),
    maybeBaselineId: Option.none(),
  },
  maybeActionError: Option.none(),
  theme,
})
