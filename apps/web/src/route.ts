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
 */
import { Effect, Schema, pipe } from 'effect'
import { Route } from 'foldkit'
import {
  ParseError,
  defineRouteUnion,
  literal,
  param,
  slash,
  string,
} from 'foldkit/route'

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

export const urlToAppRoute = Route.parseUrlWithFallback(
  routeParser,
  AppRoute.NotFound,
)

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
