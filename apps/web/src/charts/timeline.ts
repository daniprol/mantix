/**
 * The timeline: three tracks over one shared clock.
 *
 *   Load (or Throughput)   planned dotted, achieved solid
 *   Latency                heatmap with p95 and p50 on a log scale
 *   Errors                 red bars; when comparing, the baseline's bars
 *                          hang below the axis, mirrored
 *
 * Foldkit idea: Mount. The view puts `OnMount(MountTimeline())` on an empty
 * div. When that div enters the page, Foldkit runs this Mount with the real
 * element; we create the uPlot charts inside `Effect.acquireRelease`, so
 * they are destroyed automatically when the element leaves the page. The
 * Mount is a stream, so the charts can also send Messages back: dragging
 * across a track sends `SelectedRange`.
 *
 * Data never comes from the view. The SyncTimeline Command (commands.ts)
 * finds the handle in the store and calls `update`.
 */
import { Array, Data, Effect, Option, Queue, Stream } from 'effect'
import { Mount } from 'foldkit'
import uPlot from 'uplot'

import * as Format from '../domain/format.ts'
import { Message } from '../message.ts'
import { AXIS, RIGHT, TIME_ROOM, TRACK_HEIGHTS, X_AXIS_ROOM } from './layout.ts'
import { MONO, type Palette, readPalette, watchColours } from './palette.ts'
import { type TimelineSeries, buildSeries } from './series.ts'
import {
  TIMELINE_HOST_ID,
  type TimelineHandle,
  type TimelineInput,
  registerTimeline,
  unregisterTimeline,
} from './store.ts'

const HEAT_ROWS = 40
const CURSOR_SYNC_KEY = 'mantix-timeline'

type Drawing = Readonly<{ series: TimelineSeries; palette: Palette }>

const px = (u: uPlot, cssPixels: number) => cssPixels * uPlot.pxRatio

// DRAWING HELPERS

/** The canvas x of the start of second `t` (x = t on the axis). */
const xOf = (u: uPlot, t: number) => u.valToPos(t, 'x', true)

const fillColumns = (
  u: uPlot,
  from: number,
  to: number,
  colour: string,
  alpha = 1,
) => {
  const { ctx } = u
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.fillStyle = colour
  ctx.fillRect(
    xOf(u, from),
    u.bbox.top,
    xOf(u, to) - xOf(u, from),
    u.bbox.height,
  )
  ctx.restore()
}

const verticalLine = (u: uPlot, t: number, colour: string, width: number) => {
  const { ctx } = u
  const x = Math.round(xOf(u, t)) + 0.5
  ctx.save()
  ctx.strokeStyle = colour
  ctx.lineWidth = px(u, width)
  ctx.beginPath()
  ctx.moveTo(x, u.bbox.top)
  ctx.lineTo(x, u.bbox.top + u.bbox.height)
  ctx.stroke()
  ctx.restore()
}

/** Seconds where Mantix itself lagged, lightly shaded. */
const drawLagShading = (u: uPlot, { series, palette }: Drawing) =>
  series.columns.forEach((column, i) =>
    Option.map(column, ({ lagged }) => {
      if (lagged) {
        fillColumns(u, i - 1, i, palette.lag)
      }
    }),
  )

/** The selected range: a light amber wash with its two edges. */
const drawRange = (u: uPlot, { series, palette }: Drawing) =>
  Option.map(series.maybeRange, ({ from, to }) => {
    fillColumns(u, from, to, palette.accent, 0.1)
    verticalLine(u, from, palette.accent, 1)
    verticalLine(u, to, palette.accent, 1)
  })

const drawLiveEdge = (u: uPlot, { series, palette }: Drawing) =>
  Option.map(series.maybeLiveEdge, edge =>
    verticalLine(u, edge, palette.accent, 1.5),
  )

const drawText = (
  u: uPlot,
  text: string,
  x: number,
  y: number,
  colour: string,
  align: CanvasTextAlign = 'center',
) => {
  const { ctx } = u
  ctx.save()
  ctx.font = `500 ${px(u, 11)}px ${MONO}`
  ctx.fillStyle = colour
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x, y)
  ctx.restore()
}

/** Above the top track: the playhead's time, or the range's two times. */
const drawTimes = (u: uPlot, { series, palette }: Drawing) => {
  const y = u.bbox.top - px(u, TIME_ROOM / 2)
  Option.map(series.maybeLiveEdge, edge =>
    drawText(u, Format.clock(edge), xOf(u, edge), y, palette.accentInk),
  )
  Option.map(series.maybeRange, ({ from, to }) => {
    drawText(u, Format.clock(from), xOf(u, from), y, palette.accentInk, 'right')
    drawText(u, Format.clock(to), xOf(u, to), y, palette.accentInk, 'left')
  })
}

/** The latency heatmap: one column per second, one row per latency band. */
const drawHeatmap = (u: uPlot, { series, palette }: Drawing) => {
  if (series.hasBaseline) {
    return
  }
  const [low, high] = series.latencyRange
  const logLow = Math.log10(low)
  const logHigh = Math.log10(high)
  const rowOf = (ms: number) =>
    Math.min(
      HEAT_ROWS - 1,
      Math.max(
        0,
        Math.floor(
          ((Math.log10(Math.max(ms, low)) - logLow) / (logHigh - logLow)) *
            HEAT_ROWS,
        ),
      ),
    )
  const grids = series.columns.map(column =>
    Option.map(column, ({ cells }) =>
      cells.reduce(
        (rows, [ms, count]) => {
          rows[rowOf(ms)] = (rows[rowOf(ms)] ?? 0) + count
          return rows
        },
        Array.makeBy(HEAT_ROWS, () => 0),
      ),
    ),
  )
  const busiest = Math.max(1, ...Array.getSomes(grids).flatMap(rows => rows))
  const rowEdge = (row: number) =>
    u.valToPos(
      10 ** (logLow + (row / HEAT_ROWS) * (logHigh - logLow)),
      'y',
      true,
    )
  const { ctx } = u
  ctx.save()
  ctx.fillStyle = palette.heat
  grids.forEach((maybeRows, i) =>
    Option.map(maybeRows, rows => {
      const left = xOf(u, i - 1)
      const right = xOf(u, i)
      rows.forEach((count, row) => {
        if (count === 0) {
          return
        }
        const bottom = rowEdge(row)
        const top = rowEdge(row + 1)
        // Log scale for colour too, so rare slow requests stay visible.
        ctx.globalAlpha =
          0.04 + 0.36 * (Math.log1p(count) / Math.log1p(busiest)) ** 1.4
        ctx.fillRect(left, top, right - left + 0.5, bottom - top + 0.5)
      })
    }),
  )
  ctx.restore()
}

/** When comparing, tint the gap between the two p95 lines. */
const drawGap = (u: uPlot, { series, palette }: Drawing) => {
  if (!series.hasBaseline) {
    return
  }
  const { ctx } = u
  ctx.save()
  ctx.fillStyle = palette.ink3
  ctx.globalAlpha = 0.14
  series.x.forEach(i => {
    const a = series.p95[i]
    const b = series.baselineP95[i]
    const nextA = series.p95[i + 1]
    const nextB = series.baselineP95[i + 1]
    if (a == null || b == null || nextA == null || nextB == null) {
      return
    }
    ctx.beginPath()
    ctx.moveTo(xOf(u, i), u.valToPos(a, 'y', true))
    ctx.lineTo(xOf(u, i + 1), u.valToPos(nextA, 'y', true))
    ctx.lineTo(xOf(u, i + 1), u.valToPos(nextB, 'y', true))
    ctx.lineTo(xOf(u, i), u.valToPos(b, 'y', true))
    ctx.closePath()
    ctx.fill()
  })
  ctx.restore()
}

type EndLabel = { text: string; y: number; colour: string; x: number }

/** Write each label just right of its line's last point, without overlaps. */
const drawEndLabels = (
  u: uPlot,
  palette: Palette,
  labels: ReadonlyArray<EndLabel>,
) => {
  const { ctx } = u
  const gap = px(u, 14)
  const sorted = [...labels].sort((a, b) => a.y - b.y)
  // Push a label down if it would sit on top of the one above it.
  sorted.forEach((label, index) => {
    const previous = sorted[index - 1]
    const isNear =
      previous !== undefined && Math.abs(label.x - previous.x) < px(u, 90)
    if (isNear && label.y - previous.y < gap) {
      label.y = previous.y + gap
    }
  })
  // Then keep them inside the plot, pushing neighbours up instead.
  const bottom = u.bbox.top + u.bbox.height - px(u, 5)
  ;[...sorted].reverse().forEach((label, index, fromBottom) => {
    const below = fromBottom[index - 1]
    const isNear =
      below !== undefined && Math.abs(label.x - below.x) < px(u, 90)
    const limit = isNear ? Math.min(bottom, below.y - gap) : bottom
    label.y = Math.max(u.bbox.top + px(u, 5), Math.min(label.y, limit))
  })
  ctx.save()
  ctx.font = `${px(u, 11)}px ${MONO}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  // A halo in the page colour keeps labels readable over lines.
  ctx.lineWidth = px(u, 4)
  ctx.lineJoin = 'round'
  ctx.strokeStyle = palette.paper
  sorted.forEach(label => {
    ctx.strokeText(label.text, label.x + px(u, 8), label.y)
    ctx.fillStyle = label.colour
    ctx.fillText(label.text, label.x + px(u, 8), label.y)
  })
  ctx.restore()
}

const lastPoint = (
  u: uPlot,
  values: ReadonlyArray<number | null>,
): Option.Option<{ x: number; y: number; value: number }> => {
  const index = values.findLastIndex(value => value !== null)
  const value = values[index]
  return index < 0 || value === null || value === undefined
    ? Option.none()
    : Option.some({
        x: xOf(u, index),
        y: u.valToPos(value, 'y', true),
        value,
      })
}

const endLabel = (
  u: uPlot,
  values: ReadonlyArray<number | null>,
  text: (value: number) => string,
  colour: string,
): Option.Option<EndLabel> =>
  Option.map(lastPoint(u, values), point => ({
    text: text(point.value),
    x: point.x,
    y: point.y,
    colour,
  }))

const latencyText = (ms: number) => Format.text(Format.latency(ms))

const drawLatencyOverlays = (u: uPlot, drawing: Drawing) => {
  const { series, palette } = drawing
  const { ctx } = u
  const maybeLimitLabel = Option.map(series.maybeLimit, limit => {
    const y = Math.round(u.valToPos(limit.ms, 'y', true)) + 0.5
    const colour = limit.failed ? palette.danger : palette.ink2
    ctx.save()
    ctx.strokeStyle = colour
    ctx.lineWidth = px(u, 1)
    ctx.setLineDash([px(u, 2), px(u, 3)])
    ctx.beginPath()
    ctx.moveTo(u.bbox.left, y)
    ctx.lineTo(u.bbox.left + u.bbox.width, y)
    ctx.stroke()
    ctx.restore()
    return {
      text: `${limit.metric} limit ${latencyText(limit.ms)}`,
      x: u.bbox.left + u.bbox.width,
      y,
      colour,
    }
  })
  const labels = series.hasBaseline
    ? [
        endLabel(
          u,
          series.p95,
          value => `p95 ${latencyText(value)}`,
          palette.ink,
        ),
        endLabel(u, series.baselineP95, () => 'baseline', palette.ink2),
      ]
    : [
        endLabel(
          u,
          series.p95,
          value => `p95 ${latencyText(value)}`,
          palette.ink,
        ),
        endLabel(
          u,
          series.p50,
          value => `p50 ${latencyText(value)}`,
          palette.ink2,
        ),
      ]
  drawEndLabels(u, palette, Array.getSomes([...labels, maybeLimitLabel]))
}

/** "33.3 /s" for a rate, "50" (users) for the closed model. */
const loadText = (series: TimelineSeries, value: number): string =>
  series.topTrack === 'Load' && !series.isRate
    ? Format.grouped(value)
    : Format.text(Format.rate(value))

const drawTopOverlays = (u: uPlot, drawing: Drawing) => {
  const { series, palette } = drawing
  drawEndLabels(
    u,
    palette,
    Array.getSomes([
      endLabel(u, series.load, value => loadText(series, value), palette.ink),
      Option.isSome(series.maybeLiveEdge) || series.load.every(v => v === null)
        ? endLabel(u, series.planned, () => 'planned', palette.ink2)
        : Option.none(),
    ]),
  )
}

/** Error bars: this run above the axis, the baseline mirrored below it. */
const drawErrors = (u: uPlot, { series, palette }: Drawing) => {
  const { ctx } = u
  const zero = Math.round(u.valToPos(0, 'y', true)) + 0.5
  ctx.save()
  ctx.strokeStyle = palette.hairline
  ctx.lineWidth = px(u, 1)
  ctx.beginPath()
  ctx.moveTo(u.bbox.left, zero)
  ctx.lineTo(u.bbox.left + u.bbox.width, zero)
  ctx.stroke()
  const bars = (
    columns: TimelineSeries['columns'],
    colour: string,
    direction: 1 | -1,
  ) => {
    ctx.fillStyle = colour
    columns.forEach((column, i) =>
      Option.map(column, ({ errors }) => {
        if (errors === 0) {
          return
        }
        const width = Math.min(px(u, 3), (xOf(u, i) - xOf(u, i - 1)) * 0.6)
        const left = xOf(u, i - 0.5) - width / 2
        const top = u.valToPos(direction * errors, 'y', true)
        // Even a single error gets a visible tick.
        const height = Math.max(px(u, 2), Math.abs(zero - top))
        ctx.fillRect(
          left,
          direction === 1 ? zero - height : zero,
          width,
          height,
        )
      }),
    )
  }
  bars(series.columns, palette.danger, 1)
  if (series.hasBaseline) {
    bars(series.baselineColumns, palette.ink3, -1)
  }
  ctx.restore()
}

// AXES

const axisFont = `${11}px ${MONO}`

const latencySplits = (_u: uPlot, _axis: number, min: number, max: number) =>
  [1, 2, 5]
    .flatMap(step =>
      [-3, -2, -1, 0, 1, 2, 3, 4].map(power => step * 10 ** power),
    )
    .filter(value => value >= min && value <= max)
    .sort((a, b) => a - b)

const yAxis = (
  palette: () => Palette,
  options: Partial<uPlot.Axis>,
): uPlot.Axis => ({
  size: AXIS,
  gap: 8,
  font: axisFont,
  stroke: () => palette().ink2,
  grid: { stroke: () => palette().hairline, width: 1 },
  ticks: { show: false },
  ...options,
})

const xRange: uPlot.Scale['range'] = (_u, min, max) => [min, max]

const line = (
  stroke: () => string,
  width: number,
  extra: Partial<uPlot.Series> = {},
): uPlot.Series => ({
  stroke,
  width,
  spanGaps: false,
  points: { show: false },
  ...extra,
})

// THE CHARTS

type Charts = Readonly<{ top: uPlot; latency: uPlot; errors: uPlot }>

const createCharts = (
  hosts: Readonly<{
    top: HTMLElement
    latency: HTMLElement
    errors: HTMLElement
  }>,
  width: number,
  current: () => Drawing,
  onHover: (index: number | null) => void,
  onSelect: (u: uPlot) => void,
): Charts => {
  const palette = () => current().palette
  const series = () => current().series
  const cursor = (): uPlot.Cursor => ({
    sync: { key: CURSOR_SYNC_KEY },
    y: false,
    points: { show: false },
    drag: { x: true, y: false, setScale: false },
  })
  const common = (u: uPlot) => [
    drawRange(u, current()),
    drawLagShading(u, current()),
  ]
  const hooks = (
    draw: ReadonlyArray<(u: uPlot) => void>,
  ): uPlot.Hooks.Arrays => ({
    drawAxes: [u => void common(u)],
    draw: [...draw, u => void drawLiveEdge(u, current())],
    setCursor: [u => onHover(u.cursor.idx ?? null)],
    setSelect: [onSelect],
  })

  const top = new uPlot(
    {
      width,
      height: TIME_ROOM + TRACK_HEIGHTS.top,
      padding: [TIME_ROOM, RIGHT, 6, 0],
      legend: { show: false },
      cursor: cursor(),
      scales: {
        x: { time: false, range: xRange },
        y: { range: (_u, _min, max) => [0, Math.max(1, max * 1.15)] },
      },
      axes: [
        { show: false },
        yAxis(palette, {
          space: 28,
          values: (_u, values) =>
            values.map(value => loadText(series(), value)),
        }),
      ],
      series: [
        {},
        line(() => palette().ink2, 1.25, { dash: [2, 3], spanGaps: true }),
        line(() => palette().ink3, 1.25),
        line(() => palette().ink, 1.5),
      ],
      hooks: hooks([
        u => drawTopOverlays(u, current()),
        u => drawTimes(u, current()),
      ]),
    },
    [[], [], [], []],
    hosts.top,
  )

  const latency = new uPlot(
    {
      width,
      height: TRACK_HEIGHTS.latency,
      padding: [8, RIGHT, 6, 0],
      legend: { show: false },
      cursor: cursor(),
      scales: {
        x: { time: false, range: xRange },
        y: { distr: 3, range: () => [...series().latencyRange] },
      },
      axes: [
        { show: false },
        yAxis(palette, {
          splits: latencySplits,
          // uPlot hides labels between powers of ten on a log axis; keep them.
          filter: (_u, splits) => splits,
          values: (_u, values) =>
            values.map(value => (value === null ? '' : latencyText(value))),
        }),
      ],
      series: [
        {},
        line(() => palette().ink2, 1.1, { show: true }),
        line(() => palette().ink3, 1.25),
        line(() => palette().ink, 1.75),
      ],
      hooks: {
        ...hooks([u => drawLatencyOverlays(u, current())]),
        // drawAxes runs after the grid and before the lines, so the
        // heatmap and the gap sit between them.
        drawAxes: [
          u => void common(u),
          u => drawHeatmap(u, current()),
          u => drawGap(u, current()),
        ],
      },
    },
    [[], [], [], []],
    hosts.latency,
  )

  const errors = new uPlot(
    {
      width,
      height: TRACK_HEIGHTS.errors + X_AXIS_ROOM,
      padding: [6, RIGHT, 0, 0],
      legend: { show: false },
      cursor: cursor(),
      scales: {
        x: { time: false, range: xRange },
        y: {
          range: () => {
            const most = series().mostErrors
            return series().hasBaseline ? [-most, most] : [0, most]
          },
        },
      },
      axes: [
        {
          font: axisFont,
          stroke: () => palette().ink2,
          grid: { show: false },
          ticks: { show: false },
          size: X_AXIS_ROOM,
          gap: 6,
          space: 72,
          incrs: [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600],
          values: (_u, values) => values.map(Format.clock),
        },
        yAxis(palette, { grid: { show: false }, values: () => [] }),
      ],
      series: [{}],
      hooks: hooks([u => drawErrors(u, current())]),
    },
    [[]],
    hosts.errors,
  )

  return { top, latency, errors }
}

/** "00:42   p95 212 ms   p50 41.2 ms   196 req/s   2 errors" for the hovered second. */
const readoutText = (series: TimelineSeries, index: number | null): string =>
  index === null || index === 0
    ? ''
    : Option.match(series.columns[index] ?? Option.none(), {
        onNone: () => '',
        onSome: column =>
          [
            Format.clock(index - 1),
            column.p95 === null ? '' : `p95 ${latencyText(column.p95)}`,
            column.p50 === null ? '' : `p50 ${latencyText(column.p50)}`,
            `${Format.text(Format.rate(column.requests))}`,
            `${Format.grouped(column.errors)} ${column.errors === 1 ? 'error' : 'errors'}`,
            column.lagged ? 'Mantix overloaded' : '',
          ]
            .filter(part => part !== '')
            .join('   '),
      })

/** Seconds [from, to) covered by a drag, from the chart's selection box. */
const selectedSeconds = (
  u: uPlot,
  length: number,
): Option.Option<{ from: number; to: number }> => {
  const { left, width } = u.select
  if (width < 4) {
    return Option.none()
  }
  const clamp = (t: number) => Math.min(length, Math.max(0, t))
  const from = clamp(Math.floor(u.posToVal(left, 'x')))
  const to = clamp(Math.ceil(u.posToVal(left + width, 'x')))
  return to > from ? Option.some({ from, to }) : Option.none()
}

/** What the tracks show before any data arrives. */
const EMPTY_INPUT: TimelineInput = {
  duration: 60,
  topTrack: 'Load',
  plan: [],
  isRate: true,
  current: [],
  maybeBaseline: Option.none(),
  isLive: false,
  maybeLimit: Option.none(),
  maybeRange: Option.none(),
}

/** Build the DOM, charts and listeners for one timeline host element. */
const createTimeline = (
  element: HTMLElement,
  onRange: (range: { from: number; to: number }) => void,
): TimelineHandle & { destroy: () => void } => {
  const readout = document.createElement('div')
  readout.className = 'timeline-readout'
  const hosts = {
    top: document.createElement('div'),
    latency: document.createElement('div'),
    errors: document.createElement('div'),
  }
  hosts.latency.className = 'timeline-track'
  hosts.errors.className = 'timeline-track'
  element.append(readout, hosts.top, hosts.latency, hosts.errors)

  let input: TimelineInput | undefined
  let drawing: Drawing = {
    series: buildSeries(EMPTY_INPUT),
    palette: readPalette(element),
  }
  let scheduled = false
  const current = (): Drawing => drawing

  const charts = createCharts(
    hosts,
    Math.max(480, element.clientWidth),
    current,
    index => {
      readout.textContent = readoutText(current().series, index)
    },
    u => {
      const length = current().series.x.length - 1
      Option.map(selectedSeconds(u, length), onRange)
      // Our own wash draws the range once the Model has it.
      u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false)
    },
  )
  const all = [charts.top, charts.latency, charts.errors]

  const draw = () => {
    scheduled = false
    if (input === undefined) {
      return
    }
    const series = buildSeries(input)
    drawing = { series, palette: readPalette(element) }
    charts.top.setData([
      series.x,
      series.planned,
      series.baselineLoad,
      series.load,
    ])
    charts.latency.setData([
      series.x,
      series.hasBaseline ? series.x.map(() => null) : series.p50,
      series.baselineP95,
      series.p95,
    ])
    charts.errors.setData([series.x])
  }

  // Coalesce bursts (a reconnect replays every Second) into one frame.
  const schedule = () => {
    if (!scheduled) {
      scheduled = true
      requestAnimationFrame(draw)
    }
  }

  const resize = new ResizeObserver(() => {
    const width = Math.max(480, element.clientWidth)
    all.forEach(chart => chart.setSize({ width, height: chart.height }))
  })
  resize.observe(element)

  // Repaint once the web fonts have loaded, so labels use Geist, and
  // whenever the theme changes, so the canvas takes the new colours.
  void document.fonts.ready.then(schedule)
  const stopWatchingColours = watchColours(schedule)

  return {
    update: next => {
      input = next
      schedule()
    },
    destroy: () => {
      resize.disconnect()
      stopWatchingColours()
      all.forEach(chart => chart.destroy())
      element.replaceChildren()
    },
  }
}

class ChartError extends Data.TaggedError('ChartError')<{
  readonly message: string
}> {}

type MountTimelineMessage =
  | typeof Message.SucceededMountTimeline.Type
  | typeof Message.FailedMountTimeline.Type
  | typeof Message.SelectedRange.Type

export const MountTimeline = Mount.defineStream('MountTimeline', {
  messages: [
    Message.SucceededMountTimeline,
    Message.FailedMountTimeline,
    Message.SelectedRange,
  ],
  execute: ({ element }) =>
    Stream.callback<MountTimelineMessage>(queue =>
      Effect.gen(function* () {
        if (!(element instanceof HTMLElement)) {
          Queue.offerUnsafe(
            queue,
            Message.FailedMountTimeline({ reason: 'Not an HTML element.' }),
          )
          return yield* Effect.never
        }
        // acquireRelease: create the charts now, destroy them when the
        // element leaves the page.
        yield* Effect.acquireRelease(
          Effect.try({
            try: () => {
              const timeline = createTimeline(element, range =>
                Queue.offerUnsafe(queue, Message.SelectedRange(range)),
              )
              registerTimeline(TIMELINE_HOST_ID, timeline)
              return timeline
            },
            catch: error => new ChartError({ message: String(error) }),
          }),
          timeline =>
            Effect.sync(() => {
              unregisterTimeline(TIMELINE_HOST_ID, timeline)
              timeline.destroy()
            }),
        )
        Queue.offerUnsafe(queue, Message.SucceededMountTimeline())
        return yield* Effect.never
      }).pipe(
        Effect.catch(error =>
          Effect.sync(() =>
            Queue.offerUnsafe(
              queue,
              Message.FailedMountTimeline({ reason: error.message }),
            ),
          ),
        ),
      ),
    ),
})
