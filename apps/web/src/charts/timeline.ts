/**
 * The timeline: a latency chart (heatmap with p50 and p99 drawn on top) and
 * a throughput lane under it, sharing the x axis and the hover cursor.
 *
 * Foldkit idea: Mount. The view puts `OnMount(MountTimeline())` on an empty
 * div. When that div enters the page, Foldkit runs this Mount with the real
 * element; we create the uPlot charts inside `Effect.acquireRelease`, so
 * they are destroyed automatically when the element leaves the page.
 *
 * Data never comes from the view. The SyncTimeline Command (commands.ts)
 * finds the handle in the store and calls `update`.
 */
import { Array, Data, Effect, Option, Queue, Stream } from 'effect'
import { Mount } from 'foldkit'
import uPlot from 'uplot'

import * as Format from '../domain/format.ts'
import { Message } from '../message.ts'
import { MONO, type Palette, SANS, readPalette } from './palette.ts'
import { EMPTY_SERIES, type TimelineSeries, buildSeries } from './series.ts'
import {
  TIMELINE_HOST_ID,
  type TimelineData,
  type TimelineHandle,
  registerTimeline,
  unregisterTimeline,
} from './store.ts'

const LATENCY_HEIGHT = 262
const LANE_HEIGHT = 150
const AXIS_WIDTH = 56
/** Room on the right for the labels written at the end of each line. */
const LABEL_ROOM = 92
const HEAT_ROWS = 48
/** Room above each plot for its title. */
const TITLE_ROOM = 30
const CURSOR_SYNC_KEY = 'mantix-timeline'

// DRAWING HELPERS

type Drawing = {
  series: TimelineSeries
  palette: Palette
}

const px = (u: uPlot, cssPixels: number) => cssPixels * uPlot.pxRatio

/** Fill the columns of seconds that match `test`, full plot height. */
const shadeColumns = (
  u: uPlot,
  series: TimelineSeries,
  test: (index: number) => boolean,
  colour: string,
) => {
  const { ctx } = u
  const { top, height } = u.bbox
  ctx.save()
  ctx.fillStyle = colour
  series.x.forEach(i => {
    if (i > 0 && test(i)) {
      const left = u.valToPos(i - 1, 'x', true)
      const right = u.valToPos(i, 'x', true)
      ctx.fillRect(left, top, right - left, height)
    }
  })
  ctx.restore()
}

const drawLagShading = (u: uPlot, { series, palette }: Drawing) =>
  shadeColumns(
    u,
    series,
    i =>
      Option.match(series.columns[i] ?? Option.none(), {
        onNone: () => false,
        onSome: column => column.lagged,
      }),
    palette.lag,
  )

const drawLiveEdge = (u: uPlot, { series, palette }: Drawing) =>
  Option.map(series.maybeLiveEdge, edge => {
    const { ctx } = u
    const x = Math.round(u.valToPos(edge, 'x', true)) + 0.5
    ctx.save()
    ctx.strokeStyle = palette.accent
    ctx.lineWidth = px(u, 1.5)
    ctx.beginPath()
    ctx.moveTo(x, u.bbox.top)
    ctx.lineTo(x, u.bbox.top + u.bbox.height)
    ctx.stroke()
    ctx.restore()
  })

/** The latency heatmap: one column per second, one row per latency band. */
const drawHeatmap = (u: uPlot, { series, palette }: Drawing) => {
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
  const { ctx } = u
  ctx.save()
  ctx.fillStyle = palette.heat
  grids.forEach((maybeRows, i) =>
    Option.map(maybeRows, rows => {
      const left = u.valToPos(i - 1, 'x', true)
      const right = u.valToPos(i, 'x', true)
      rows.forEach((count, row) => {
        if (count === 0) {
          return
        }
        const bottom = u.valToPos(
          10 ** (logLow + (row / HEAT_ROWS) * (logHigh - logLow)),
          'y',
          true,
        )
        const top = u.valToPos(
          10 ** (logLow + ((row + 1) / HEAT_ROWS) * (logHigh - logLow)),
          'y',
          true,
        )
        // Log scale for colour too, so rare slow requests stay visible.
        ctx.globalAlpha =
          0.06 + 0.64 * (Math.log1p(count) / Math.log1p(busiest)) ** 1.6
        ctx.fillRect(left, top, right - left + 0.5, bottom - top + 0.5)
      })
    }),
  )
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
  // Then keep them inside the plot, so none sits on the x axis labels,
  // pushing neighbours up instead.
  const bottom = u.bbox.top + u.bbox.height - px(u, 5)
  ;[...sorted].reverse().forEach((label, index, fromBottom) => {
    const below = fromBottom[index - 1]
    const isNear =
      below !== undefined && Math.abs(label.x - below.x) < px(u, 90)
    const limit = isNear ? Math.min(bottom, below.y - gap) : bottom
    label.y = Math.min(label.y, limit)
  })
  ctx.save()
  ctx.font = `500 ${px(u, 11)}px ${SANS}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  // A halo in the page colour keeps labels readable over lines.
  ctx.lineWidth = px(u, 4)
  ctx.lineJoin = 'round'
  ctx.strokeStyle = palette.paper
  sorted.forEach(label => {
    ctx.strokeText(label.text, label.x + px(u, 6), label.y)
    ctx.fillStyle = label.colour
    ctx.fillText(label.text, label.x + px(u, 6), label.y)
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
        x: u.valToPos(index, 'x', true),
        y: u.valToPos(value, 'y', true),
        value,
      })
}

const drawLaneTitle = (u: uPlot, title: string, palette: Palette) => {
  const { ctx } = u
  ctx.save()
  ctx.font = `500 ${px(u, 11)}px ${SANS}`
  ctx.fillStyle = palette.ink2
  ctx.textAlign = 'left'
  ctx.textBaseline = 'bottom'
  ctx.fillText(title, 0, u.bbox.top - px(u, 10))
  ctx.restore()
}

const drawLatencyOverlays = (u: uPlot, drawing: Drawing) => {
  const { series, palette } = drawing
  const { ctx } = u
  const maybeLimitLabel = Option.map(series.maybeLimit, limit => {
    const y = Math.round(u.valToPos(limit.ms, 'y', true)) + 0.5
    const colour = limit.failed ? palette.danger : palette.ink3
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
      text: `limit ${Format.text(Format.latency(limit.ms))}`,
      x: u.bbox.left + u.bbox.width,
      y,
      colour,
    }
  })
  const labels = [
    Option.map(lastPoint(u, series.p99), point => ({
      text: `p99 ${Format.text(Format.latency(point.value))}`,
      x: point.x,
      y: point.y,
      colour: palette.ink,
    })),
    Option.map(lastPoint(u, series.p50), point => ({
      text: `p50 ${Format.text(Format.latency(point.value))}`,
      x: point.x,
      y: point.y,
      colour: palette.ink2,
    })),
    maybeLimitLabel,
  ]
  drawEndLabels(u, palette, Array.getSomes(labels))
  drawLaneTitle(u, 'Latency', palette)
}

/** "33.3/s" for the open model, "50" (users) for the closed one. */
const loadText = (series: TimelineSeries, value: number): string =>
  series.isRate ? Format.text(Format.rate(value)) : Format.grouped(value)

const drawLaneOverlays = (u: uPlot, drawing: Drawing) => {
  const { series, palette } = drawing
  const { ctx } = u
  // Errors: a red tick per second at the foot of the lane, taller for a
  // larger share of failed requests.
  ctx.save()
  ctx.fillStyle = palette.danger
  series.columns.forEach((column, i) =>
    Option.map(column, ({ errors, requests }) => {
      if (errors === 0) {
        return
      }
      const share = requests === 0 ? 1 : errors / requests
      const height = px(u, 3 + 13 * Math.min(1, share * 20))
      const centre = u.valToPos(i - 0.5, 'x', true)
      const width = px(u, 2)
      ctx.fillRect(
        centre - width / 2,
        u.bbox.top + u.bbox.height - height,
        width,
        height,
      )
    }),
  )
  ctx.restore()
  const labels = [
    Option.map(lastPoint(u, series.achieved), point => ({
      text: `${loadText(series, point.value)} achieved`,
      x: point.x,
      y: point.y,
      colour: palette.ink,
    })),
    Option.map(lastPoint(u, series.target), point => ({
      text: 'planned',
      x: point.x,
      y: point.y,
      colour: palette.ink3,
    })),
  ]
  drawEndLabels(u, palette, Array.getSomes(labels))
  drawLaneTitle(
    u,
    series.isRate ? 'Load · iterations/s' : 'Load · virtual users',
    palette,
  )
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
  size: AXIS_WIDTH,
  gap: 6,
  font: axisFont,
  stroke: () => palette().ink3,
  grid: { stroke: () => palette().hairline, width: 1 },
  ticks: { show: false },
  ...options,
})

// THE CHARTS

const cursor = (): uPlot.Cursor => ({
  sync: { key: CURSOR_SYNC_KEY },
  y: false,
  points: { show: false },
  drag: { x: false, y: false },
})

type Charts = Readonly<{ latency: uPlot; lane: uPlot }>

const createCharts = (
  latencyHost: HTMLElement,
  laneHost: HTMLElement,
  width: number,
  current: () => Drawing,
  onHover: (index: number | null) => void,
): Charts => {
  const palette = () => current().palette
  const hover = (u: uPlot) => onHover(u.cursor.idx ?? null)
  const latency = new uPlot(
    {
      width,
      height: LATENCY_HEIGHT,
      padding: [TITLE_ROOM, LABEL_ROOM, 6, 0],
      legend: { show: false },
      cursor: cursor(),
      scales: {
        x: { time: false, range: (_u, min, max) => [min, max] },
        y: {
          distr: 3,
          range: () => [...current().series.latencyRange],
        },
      },
      axes: [
        { show: false },
        yAxis(palette, {
          splits: latencySplits,
          // uPlot hides labels between powers of ten on a log axis; keep them.
          filter: (_u, splits) => splits,
          values: (_u, values) =>
            values.map(value =>
              value === null ? '' : Format.text(Format.latency(value)),
            ),
        }),
      ],
      series: [
        {},
        {
          stroke: () => palette().ink2,
          width: 1.25,
          spanGaps: false,
          points: { show: false },
        },
        {
          stroke: () => palette().ink,
          width: 1.75,
          spanGaps: false,
          points: { show: false },
        },
      ],
      hooks: {
        // drawAxes runs after the grid and before the lines, so the
        // heatmap sits between them.
        drawAxes: [
          u => drawHeatmap(u, current()),
          u => drawLagShading(u, current()),
        ],
        draw: [
          u => drawLatencyOverlays(u, current()),
          u => drawLiveEdge(u, current()),
        ],
        setCursor: [hover],
      },
    },
    [[], [], []],
    latencyHost,
  )
  const lane = new uPlot(
    {
      width,
      height: LANE_HEIGHT,
      padding: [TITLE_ROOM, LABEL_ROOM, 6, 0],
      legend: { show: false },
      cursor: cursor(),
      scales: {
        x: { time: false, range: (_u, min, max) => [min, max] },
        y: { range: (_u, _min, max) => [0, Math.max(1, max * 1.15)] },
      },
      axes: [
        {
          font: axisFont,
          stroke: () => palette().ink3,
          grid: { show: false },
          ticks: { show: false },
          size: 28,
          gap: 4,
          space: 64,
          incrs: [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600],
          values: (_u, values) => values.map(Format.clock),
        },
        yAxis(palette, {
          space: 32,
          values: (_u, values) =>
            values.map(value => loadText(current().series, value)),
        }),
      ],
      series: [
        {},
        {
          stroke: () => palette().ink3,
          width: 1.25,
          dash: [4, 4],
          spanGaps: true,
          points: { show: false },
        },
        {
          stroke: () => palette().ink,
          width: 1.5,
          spanGaps: false,
          points: { show: false },
        },
      ],
      hooks: {
        drawClear: [u => drawLagShading(u, current())],
        draw: [
          u => drawLaneOverlays(u, current()),
          u => drawLiveEdge(u, current()),
        ],
        setCursor: [hover],
      },
    },
    [[], [], []],
    laneHost,
  )
  return { latency, lane }
}

/** "00:42  p50 41.2 ms  p99 212 ms  196/s  2 errors" for the hovered second. */
const readoutText = (series: TimelineSeries, index: number | null): string =>
  index === null || index === 0
    ? ''
    : Option.match(series.columns[index] ?? Option.none(), {
        onNone: () => '',
        onSome: column =>
          [
            Format.clock(index),
            column.p50 === null
              ? ''
              : `p50 ${Format.text(Format.latency(column.p50))}`,
            column.p99 === null
              ? ''
              : `p99 ${Format.text(Format.latency(column.p99))}`,
            `${Format.rate(column.requests).value} req/s`,
            column.errors === 0
              ? 'no errors'
              : `${Format.grouped(column.errors)} ${column.errors === 1 ? 'error' : 'errors'}`,
            column.lagged ? 'Mantix overloaded' : '',
          ]
            .filter(part => part !== '')
            .join('   '),
      })

/** Build the DOM, charts and listeners for one timeline host element. */
const createTimeline = (
  element: HTMLElement,
): TimelineHandle & {
  destroy: () => void
} => {
  const readout = document.createElement('div')
  readout.className = 'timeline-readout'
  const latencyHost = document.createElement('div')
  const laneHost = document.createElement('div')
  element.append(readout, latencyHost, laneHost)

  let data: TimelineData | undefined
  let drawing: Drawing = { series: EMPTY_SERIES, palette: readPalette(element) }
  let scheduled = false
  const current = (): Drawing => drawing

  const charts = createCharts(
    latencyHost,
    laneHost,
    Math.max(320, element.clientWidth),
    current,
    index => {
      readout.textContent = readoutText(current().series, index)
    },
  )

  const draw = () => {
    scheduled = false
    if (data === undefined) {
      return
    }
    const series = buildSeries(data)
    drawing = { series, palette: readPalette(element) }
    charts.latency.setData([series.x, series.p50, series.p99])
    charts.lane.setData([series.x, series.target, series.achieved])
  }

  // Coalesce bursts (a reconnect replays every Second) into one frame.
  const schedule = () => {
    if (!scheduled) {
      scheduled = true
      requestAnimationFrame(draw)
    }
  }

  const resize = new ResizeObserver(() => {
    const width = Math.max(320, element.clientWidth)
    charts.latency.setSize({ width, height: LATENCY_HEIGHT })
    charts.lane.setSize({ width, height: LANE_HEIGHT })
  })
  resize.observe(element)

  // Repaint with the other palette when the system theme flips, and once
  // the web fonts have loaded so labels use Geist.
  const scheme = matchMedia('(prefers-color-scheme: dark)')
  scheme.addEventListener('change', schedule)
  void document.fonts.ready.then(schedule)

  return {
    update: next => {
      data = next
      schedule()
    },
    destroy: () => {
      scheme.removeEventListener('change', schedule)
      resize.disconnect()
      charts.latency.destroy()
      charts.lane.destroy()
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

export const MountTimeline = Mount.defineStream('MountTimeline', {
  messages: [Message.SucceededMountTimeline, Message.FailedMountTimeline],
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
              const timeline = createTimeline(element)
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
