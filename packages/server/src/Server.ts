import { Effect, Layer } from 'effect'
import { HttpRouter, HttpServerResponse, HttpStaticServer } from 'effect/http'
import { HttpApiBuilder } from 'effect/http-api'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The HTTP server behind `mantix ui`: the MantixApi under /api, and the
 * dashboard's static files everywhere else.
 *
 * The handlers are thin: each one asks the `Runs` service and returns its
 * answer. HttpApiBuilder checks at compile time that every endpoint in
 * MantixApi has a handler with the right types.
 */
import { NodeHttpServer } from '@effect/platform-node'
import { MantixApi } from '@mantix/api'

import { DevEvents } from './DevEvents.ts'
import { Runs } from './Runs.ts'

const TestHandlers = HttpApiBuilder.group(
  MantixApi,
  'test',
  Effect.fn(function* (handlers) {
    const runs = yield* Runs
    return handlers.handle('get', () => runs.test)
  }),
)

const RunsHandlers = HttpApiBuilder.group(
  MantixApi,
  'runs',
  Effect.fn(function* (handlers) {
    const runs = yield* Runs
    return handlers.handleAll({
      start: ({ payload }) =>
        runs.start(payload).pipe(
          // A bad test is caught at startup, so this would be our bug.
          Effect.catchTag('InvalidTest', error => Effect.die(error)),
        ),
      list: ({ query }) => runs.list(query),
      get: ({ params }) => runs.get(params.id),
      seconds: ({ params }) => runs.seconds(params.id),
      control: ({ params, payload }) => runs.control(params.id, payload),
      stop: ({ params }) => runs.stop(params.id),
      events: ({ params }) => runs.events(params.id),
    })
  }),
)

const DevHandlers = HttpApiBuilder.group(
  MantixApi,
  'dev',
  Effect.fn(function* (handlers) {
    const dev = yield* DevEvents
    return handlers.handle('events', () => Effect.succeed(dev.events))
  }),
)

/** The HTTP API under /api, without the dashboard files. */
export const ApiRoutes = HttpApiBuilder.layer(MantixApi, {
  openapiPath: '/api/openapi.json',
}).pipe(Layer.provide([TestHandlers, RunsHandlers, DevHandlers]))

/**
 * Where the built dashboard lives. In the published package it is copied
 * next to the bundle (`dist/web`); in this repo it is `apps/web/dist`.
 */
export const findWebRoot = (): string | undefined => {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, 'web'),
    join(here, '..', '..', '..', 'apps', 'web', 'dist'),
  ]
  return candidates.find(dir => existsSync(join(dir, 'index.html')))
}

/** The dashboard files, served as a single-page app. */
const webRoutes = (webRoot: string | undefined) =>
  webRoot === undefined
    ? HttpRouter.add(
        'GET',
        '/',
        HttpServerResponse.text(
          'The Mantix dashboard has not been built yet. Run `pnpm --filter @mantix/web build`, then start mantix ui again.',
        ),
      )
    : HttpStaticServer.layer({ root: webRoot, spa: true })

/** The whole server as one Layer. Launch it with `Layer.launch`. */
export const serverLayer = (options: {
  readonly port: number
  readonly webRoot: string | undefined
}) =>
  HttpRouter.serve(Layer.mergeAll(ApiRoutes, webRoutes(options.webRoot))).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { port: options.port })),
  )
