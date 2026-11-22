/**
 * MESSAGE: facts that happened, named in the past tense.
 *
 * Foldkit idea: a Message never says what to do ("StartRun"); it says what
 * happened ("ClickedStart"). `update` decides what that means.
 */
import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { UrlRequest } from 'foldkit/navigation'
import { Url } from 'foldkit/url'

import { RunInfo, Second, TestInfo } from '@mantix/api'

export const Message = defineMessageUnion({
  // Moving between pages (Foldkit routing).
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url },
  CompletedNavigate: {},

  // Loading the test file's description from the server.
  SucceededLoadTest: { test: TestInfo },
  FailedLoadTest: { error: Schema.String },
  ClickedRetryConnect: {},

  // The run history, and the runs on screen.
  SucceededFetchHistory: { runs: Schema.Array(RunInfo) },
  FailedFetchHistory: { error: Schema.String },
  SucceededLoadRun: { run: RunInfo, seconds: Schema.Array(Second) },
  FailedLoadRun: { runId: Schema.String, error: Schema.String },

  // Starting and stopping.
  ClickedStart: {},
  PressedEnter: {},
  SucceededStartRun: { run: RunInfo },
  FailedStartRun: { error: Schema.String },
  ClickedStop: {},
  SucceededStopRun: { run: RunInfo },
  FailedStopRun: { error: Schema.String },
  ClickedDismissError: {},
  UpdatedLoadInput: { value: Schema.String },
  UpdatedDurationInput: { value: Schema.String },

  // The live stream (from the Subscription).
  ReceivedSecond: { runId: Schema.String, second: Second },
  ReceivedRunUpdate: { run: RunInfo },
  CompletedFollowRun: { runId: Schema.String },
  FailedFollowRun: { runId: Schema.String, error: Schema.String },
  ClickedReconnect: {},

  // Reading the results.
  ClickedNow: {},
  ClickedWholeRun: {},
  SelectedRange: { from: Schema.Finite, to: Schema.Finite },

  // Choosing two runs to compare.
  SelectedCompareRun: { runId: Schema.String },
  SelectedCompareBaseline: { runId: Schema.String },
  ClickedCompare: {},

  // The timeline chart (Mount + Command).
  SucceededMountTimeline: {},
  FailedMountTimeline: { reason: Schema.String },
  CompletedSyncTimeline: {},
})
export type Message = typeof Message.Type
