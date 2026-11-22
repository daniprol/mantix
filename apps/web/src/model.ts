/**
 * MODEL: everything the dashboard knows, as one immutable value.
 *
 * Foldkit idea: the Model is a Schema. States that can't happen together are
 * separate variants of a tagged union (e.g. you can't be "Starting" and
 * "Watching" at once), instead of a handful of booleans.
 *
 * Chart objects (uPlot) are NOT here: see charts/store.ts.
 */
import { Option, Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import { RunInfo, Second, TestInfo } from '@mantix/api'

/** Talking to the Mantix server to learn which test is loaded. */
export const TestState = defineTaggedUnion({
  Connecting: {},
  Unreachable: { error: Schema.String },
  Loaded: { test: TestInfo },
})
export type TestState = typeof TestState.Type

/** The live event stream for the run on screen. */
export const Feed = defineTaggedUnion({
  Following: {},
  Ended: {},
  Lost: { error: Schema.String },
})
export type Feed = typeof Feed.Type

const StopRequest = Schema.Literals(['NotRequested', 'Requested'])
type StopRequest = typeof StopRequest.Type

export const RunState = defineTaggedUnion({
  /** Nothing started yet: the Ready screen. */
  NoRun: {},
  Starting: {},
  /** A run on screen, live or finished. */
  Watching: {
    run: RunInfo,
    seconds: Schema.Array(Second),
    feed: Feed,
    /** Bumped by "Reconnect" so the stream Subscription restarts. */
    connection: Schema.Finite,
    stop: StopRequest,
  },
})
export type RunState = typeof RunState.Type

/** Which seconds the figures and the endpoint table summarise. */
export const Window = Schema.Literals(['Recent', 'WholeRun'])
export type Window = typeof Window.Type

/** The "Adjust load" disclosure. Inputs are kept as typed text. */
export const Adjust = Schema.Struct({
  isOpen: Schema.Boolean,
  load: Schema.String,
  duration: Schema.String,
})
export type Adjust = typeof Adjust.Type

export const Model = Schema.Struct({
  test: TestState,
  runState: RunState,
  adjust: Adjust,
  window: Window,
  maybeExpandedEndpoint: Schema.Option(Schema.String),
  pastRuns: Schema.Array(RunInfo),
  maybeActionError: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

export const initialModel: Model = {
  test: TestState.Connecting(),
  runState: RunState.NoRun(),
  adjust: { isOpen: false, load: '', duration: '' },
  window: 'Recent',
  maybeExpandedEndpoint: Option.none(),
  pastRuns: [],
  maybeActionError: Option.none(),
}
