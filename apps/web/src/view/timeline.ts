/**
 * The timeline section: track names in the gutter, and the host element
 * where the Mount draws the charts (charts/timeline.ts). The gutter is
 * plain HTML so the names are real text, sized to match each track.
 */
import type { Html, HtmlBuilder } from 'foldkit/html'

import {
  GUTTER,
  TIME_ROOM,
  TRACK_HEIGHTS,
  X_AXIS_ROOM,
} from '../charts/layout.ts'
import type { TopTrack } from '../charts/store.ts'
import { MountTimeline } from '../charts/timeline.ts'
import type { Message } from '../message.ts'

export type TrackLabels = Readonly<{
  topTrack: TopTrack
  /** "iterations /s", "virtual users"... */
  topNote: string
  /** "All requests", "POST /checkout", "p95"... */
  latencyNote: string
}>

const trackName = (
  name: string,
  note: string,
  height: number,
  paddingTop: number,
  hasRule: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Class(`flex flex-col ${hasRule ? 'border-t border-hairline' : ''}`),
      h.Style({ height: `${height}px`, 'padding-top': `${paddingTop}px` }),
    ],
    [
      h.span([h.Class('text-[13px] font-medium text-ink')], [name]),
      note === ''
        ? h.empty
        : h.span([h.Class('num truncate text-[12px] text-ink-2')], [note]),
    ],
  )

/** `overlay` goes over the timeline, e.g. the steering controls. */
export const timelineView = (
  labels: TrackLabels,
  h: HtmlBuilder<Message>,
  overlay: Html = h.empty,
): Html =>
  h.section(
    [
      h.Class('relative mt-8 grid'),
      h.Style({ 'grid-template-columns': `${GUTTER}px minmax(0, 1fr)` }),
      h.AriaLabel('Timeline'),
    ],
    [
      h.div(
        [h.Class('min-w-0')],
        [
          trackName(
            labels.topTrack,
            labels.topNote,
            TIME_ROOM + TRACK_HEIGHTS.top,
            TIME_ROOM,
            false,
            h,
          ),
          trackName(
            'Latency',
            labels.latencyNote,
            TRACK_HEIGHTS.latency + 1,
            10,
            true,
            h,
          ),
          trackName(
            'Errors',
            '',
            TRACK_HEIGHTS.errors + X_AXIS_ROOM + 1,
            10,
            true,
            h,
          ),
        ],
      ),
      h.div([
        h.Class('relative min-w-0'),
        h.Role('img'),
        h.AriaLabel(
          'Load, latency and errors over time. Drag across to select a range.',
        ),
        h.OnMount(MountTimeline()),
      ]),
      overlay,
    ],
  )
