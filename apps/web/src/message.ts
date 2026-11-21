/**
 * MESSAGE: facts that happened, named in the past tense.
 *
 * Foldkit idea: a Message never says what to do ("StartRun"); it says what
 * happened ("ClickedStart"). `update` decides what that means.
 */
import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'

import { RunInfo, Second, TestInfo } from '@mantix/api'

import { Window } from './model.ts'

export const Message = defineMessageUnion({
  // Loading the test file's description from the server.
  SucceededLoadTest: { test: TestInfo },
  FailedLoadTest: { error: Schema.String },
  ClickedRetryConnect: {},

  // Starting and stopping.
  ClickedStart: {},
  PressedEnter: {},
  SucceededStartRun: { run: RunInfo },
  FailedStartRun: { error: Schema.String },
  ClickedStop: {},
  SucceededStopRun: { run: RunInfo },
  FailedStopRun: { error: Schema.String },
  ClickedNewRun: {},
  ClickedDismissError: {},

  // The live stream (from the Subscription).
  ReceivedSecond: { second: Second },
  ReceivedRunUpdate: { run: RunInfo },
  CompletedFollowRun: {},
  FailedFollowRun: { error: Schema.String },
  ClickedReconnect: {},

  // The "Adjust load" disclosure.
  ClickedAdjustLoad: {},
  UpdatedLoadInput: { value: Schema.String },
  UpdatedDurationInput: { value: Schema.String },
  ClickedUseTestPlan: {},

  // Reading the results.
  SelectedWindow: { window: Window },
  ClickedEndpoint: { endpoint: Schema.String },

  // The timeline chart (Mount + Command).
  SucceededMountTimeline: {},
  FailedMountTimeline: { reason: Schema.String },
  CompletedSyncTimeline: {},

  // Previous runs.
  SucceededFetchRuns: { runs: Schema.Array(RunInfo) },
  FailedFetchRuns: { error: Schema.String },
  ClickedPastRun: { runId: Schema.String },
})
export type Message = typeof Message.Type
