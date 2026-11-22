/**
 * What the timeline draws, and where live chart objects live: outside the
 * Model.
 *
 * uPlot instances are mutable, imperative objects, so they can't go in the
 * Model (which must be plain, immutable data). The Mount that creates a
 * chart registers it here under a host id; the SyncTimeline Command looks it
 * up and hands it a `TimelineInput`. This mirrors Foldkit's charting example.
 */
import { Option, Schema } from 'effect'

import { ScenarioInfo, Second } from '@mantix/api'

/** A latency threshold, drawn as a dashed line. */
export const LatencyLimit = Schema.Struct({
  /** Which percentile the limit is on: "p95", "p99"... */
  metric: Schema.String,
  ms: Schema.Finite,
  failed: Schema.Boolean,
})
export type LatencyLimit = typeof LatencyLimit.Type

/**
 * The top track. "Load" is what the plan asks for: iterations/s (open
 * model) or virtual users (closed model), planned against achieved. One
 * endpoint has no plan of its own, so its top track is "Throughput":
 * requests/s.
 */
export const TopTrack = Schema.Literals(['Load', 'Throughput'])
export type TopTrack = typeof TopTrack.Type

export const TimelineInput = Schema.Struct({
  /** Length of the x axis, in seconds. */
  duration: Schema.Finite,
  topTrack: TopTrack,
  /** The planned load, drawn dotted. Empty for an endpoint. */
  plan: Schema.Array(ScenarioInfo),
  /** True for the open model (iterations/s), false for VUs. */
  isRate: Schema.Boolean,
  current: Schema.Array(Second),
  /** The run compared against, drawn in gray under this one. */
  maybeBaseline: Schema.Option(Schema.Array(Second)),
  isLive: Schema.Boolean,
  maybeLimit: Schema.Option(LatencyLimit),
  /** The stretch selected by dragging, drawn as a light wash. */
  maybeRange: Schema.Option(
    Schema.Struct({ from: Schema.Finite, to: Schema.Finite }),
  ),
})
export type TimelineInput = typeof TimelineInput.Type

/** What a mounted timeline exposes to the rest of the app. */
export type TimelineHandle = Readonly<{
  update: (input: TimelineInput) => void
}>

/** The dashboard shows one timeline at a time; this names it in the store. */
export const TIMELINE_HOST_ID = 'timeline'

const timelines = new Map<string, TimelineHandle>()

export const registerTimeline = (
  hostId: string,
  timeline: TimelineHandle,
): void => {
  timelines.set(hostId, timeline)
}

export const unregisterTimeline = (
  hostId: string,
  timeline: TimelineHandle,
): void => {
  if (timelines.get(hostId) === timeline) {
    timelines.delete(hostId)
  }
}

export const findTimeline = (hostId: string): Option.Option<TimelineHandle> =>
  Option.fromNullishOr(timelines.get(hostId))
