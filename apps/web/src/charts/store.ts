/**
 * Where live chart objects live: outside the Model.
 *
 * uPlot instances are mutable, imperative objects, so they can't go in the
 * Model (which must be plain, immutable data). The Mount that creates a chart
 * registers it here under a host id; the SyncTimeline Command looks it up and
 * hands it the latest data. This mirrors Foldkit's charting example.
 */
import { Option } from 'effect'

import type { RunInfo, Second } from '@mantix/api'

export type TimelineData = Readonly<{
  run: RunInfo
  seconds: ReadonlyArray<Second>
}>

/** What a mounted timeline exposes to the rest of the app. */
export type TimelineHandle = Readonly<{
  update: (data: TimelineData) => void
}>

/** The dashboard has one timeline; this names it in the store. */
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
