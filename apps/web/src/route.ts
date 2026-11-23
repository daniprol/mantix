/**
 * ROUTE: every page of the dashboard has its own URL, so the browser's
 * back and forward buttons, reloads and shared links all work.
 *
 *   /                                   New run
 *   /runs                               Runs (the history)
 *   /runs/:runId                        One run, live or finished
 *   /runs/:runId/endpoints/:endpoint    One endpoint of that run
 *   /compare                            Pick two runs
 *   /compare/:runId/:baselineId         Two runs, one drawn over the other
 *   /compare/:runId/:baselineId/endpoints/:endpoint
 *
 * Foldkit idea: a router is a "biparser". The same definition parses a URL
 * into a Route and prints a Route back into a URL, so links can never point
 * at a path the parser does not understand.
 *
 * A shareable report (`mantix report`) is the same app in one HTML file.
 * There the pages live after the "#", see `Mode` at the end.
 */
import { Effect, Option, Schema, pipe } from 'effect'
import { Route } from 'foldkit'
import {
  ParseError,
  defineRouteUnion,
  literal,
  param,
  slash,
  string,
} from 'foldkit/route'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import type { Url } from 'foldkit/url'

import { ReportDetail } from '@mantix/api'

export const AppRoute = defineRouteUnion({
  NewRun: {},
  Runs: {},
  Run: { runId: Schema.String },
  RunEndpoint: { runId: Schema.String, endpoint: Schema.String },
  PickCompare: {},
  Compare: { runId: Schema.String, baselineId: Schema.String },
  CompareEndpoint: {
    runId: Schema.String,
    baselineId: Schema.String,
    endpoint: Schema.String,
  },
  NotFound: { path: Schema.String },
})
export type AppRoute = typeof AppRoute.Type

/**
 * An endpoint such as "GET /cart/:id" holds a space and slashes, so it
 * travels as one percent-encoded path segment.
 */
const endpointSegment = param(
  'endpoint',
  segment =>
    Effect.try({
      try: () => ({ endpoint: decodeURIComponent(segment) }),
      catch: () =>
        new ParseError({
          message: 'Expected an encoded endpoint',
          expected: 'endpoint',
          actual: segment,
        }),
    }),
  ({ endpoint }: { readonly endpoint: string }) => encodeURIComponent(endpoint),
)

export const newRunRouter = pipe(Route.root, Route.mapTo(AppRoute.NewRun))

export const runsRouter = pipe(literal('runs'), Route.mapTo(AppRoute.Runs))

export const runRouter = pipe(
  literal('runs'),
  slash(string('runId')),
  Route.mapTo(AppRoute.Run),
)

export const runEndpointRouter = pipe(
  literal('runs'),
  slash(string('runId')),
  slash(literal('endpoints')),
  slash(endpointSegment),
  Route.mapTo(AppRoute.RunEndpoint),
)

export const pickCompareRouter = pipe(
  literal('compare'),
  Route.mapTo(AppRoute.PickCompare),
)

export const compareRouter = pipe(
  literal('compare'),
  slash(string('runId')),
  slash(string('baselineId')),
  Route.mapTo(AppRoute.Compare),
)

export const compareEndpointRouter = pipe(
  literal('compare'),
  slash(string('runId')),
  slash(string('baselineId')),
  slash(literal('endpoints')),
  slash(endpointSegment),
  Route.mapTo(AppRoute.CompareEndpoint),
)

// The most specific routers come first: oneOf takes the first match.
const routeParser = Route.oneOf(
  runEndpointRouter,
  runRouter,
  runsRouter,
  compareEndpointRouter,
  compareRouter,
  pickCompareRouter,
  newRunRouter,
)

const urlToAppRoute = Route.parseUrlWithFallback(routeParser, AppRoute.NotFound)

/** The runs a route shows: the run first, then the baseline it is compared with. */
export const runIdsOf = (route: AppRoute): ReadonlyArray<string> =>
  AppRoute.match(route, {
    NewRun: () => [],
    Runs: () => [],
    Run: ({ runId }) => [runId],
    RunEndpoint: ({ runId }) => [runId],
    PickCompare: () => [],
    Compare: ({ runId, baselineId }) => [runId, baselineId],
    CompareEndpoint: ({ runId, baselineId }) => [runId, baselineId],
    NotFound: () => [],
  })

// REPORTS

/**
 * How this copy of the app is addressed.
 *
 * - Dashboard: served by `mantix ui`, every page has a real path.
 * - Report: one HTML file, often opened straight from disk, where the
 *   browser won't let the path change. Its pages live after the "#"
 *   (report.html#/runs/abc), and only the runs inside the file exist.
 */
export const Mode = defineTaggedUnion({
  Dashboard: {},
  Report: {
    /** The runs in the file; the first is the one it opens on. */
    runIds: Schema.NonEmptyArray(Schema.String),
    detail: ReportDetail,
  },
})
export type Mode = typeof Mode.Type

/** A link to a page, written the way this copy of the app is addressed. */
export const href = (mode: Mode, path: string): string =>
  mode._tag === 'Report' ? `#${path}` : path

/**
 * The page a URL shows. In a report, a page about runs the file doesn't
 * hold (or a page that needs the server, like New run) opens the report's
 * own run instead.
 */
export const routeFromUrl = (mode: Mode, url: Url): AppRoute =>
  Mode.match(mode, {
    Dashboard: () => urlToAppRoute(url),
    Report: ({ runIds }) => {
      const route = urlToAppRoute(
        modifyFields(url, {
          pathname: () => Option.getOrElse(url.hash, () => '/'),
          hash: () => Option.none(),
        }),
      )
      const shown = runIdsOf(route)
      return shown.length > 0 && shown.every(id => runIds.includes(id))
        ? route
        : AppRoute.Run({ runId: runIds[0] })
    },
  })
