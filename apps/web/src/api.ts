/**
 * The typed client for the Mantix server.
 *
 * Effect idea: HttpApiClient.make reads the shared `MantixApi` contract and
 * gives us one typed method per endpoint, e.g. `client.runs.start(...)`.
 * Requests and responses are encoded and decoded with the same Schemas the
 * server uses, so the two sides cannot drift apart.
 */
import { Context, Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { HttpApiClient } from 'effect/http-api'

import { MantixApi } from '@mantix/api'

export class MantixClient extends Context.Service<
  MantixClient,
  HttpApiClient.ForApi<typeof MantixApi>
>()('mantix/MantixClient') {
  /** The dashboard is served by the Mantix server, so we call our own origin. */
  static readonly layer = Layer.effect(
    MantixClient,
    Effect.gen(function* () {
      const origin = yield* Effect.sync(() => window.location.origin)
      return yield* HttpApiClient.make(MantixApi, { baseUrl: origin })
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))
}

/** Turn any failure into one calm sentence for the screen. */
export const describeError = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && '_tag' in error) {
    const tag = String(error._tag)
    if (tag === 'RunAlreadyActive') {
      return 'Another run is still going. Stop it first.'
    }
    if (tag === 'RunNotFound') {
      return 'The server no longer knows this run.'
    }
    // The server explains why it refused a control in one sentence.
    if (tag === 'InvalidControl' && 'message' in error) {
      return String(error.message)
    }
    if (tag === 'HttpClientError' || tag === 'TransportError') {
      return 'Can’t reach the Mantix server.'
    }
  }
  return error instanceof Error ? error.message : String(error)
}
