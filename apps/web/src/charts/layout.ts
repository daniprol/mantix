/**
 * The page's columns, shared by the timeline and the endpoint list so the
 * two read as one aligned object: the list's curves sit exactly under the
 * timeline's plot, and its numbers under the timeline's end labels.
 *
 *   | gutter: labels | axis | plot ................ | right: numbers |
 */

/** Track names on the timeline, endpoint names in the list. */
export const GUTTER = 190
/** The timeline's y-axis values. */
export const AXIS = 56
/** End labels on the timeline, number columns in the list. */
export const RIGHT = 216

/** The CSS grid both use: gutter, axis, plot, right. */
export const COLUMNS = `${GUTTER}px ${AXIS}px minmax(0, 1fr) ${RIGHT}px`

/** Heights of the three tracks, in CSS pixels. */
export const TRACK_HEIGHTS = {
  top: 104,
  latency: 196,
  errors: 64,
} as const

/** Room above the top track for the playhead's time and the range. */
export const TIME_ROOM = 20
/** Room under the errors track for the time axis. */
export const X_AXIS_ROOM = 26
