/**
 * The HTTP contract between the Mantix server and the dashboard.
 *
 * This file is the single source of truth: the server implements it with
 * HttpApiBuilder, and the Foldkit app calls it through a typed client made
 * by HttpApiClient. Rename a field here and TypeScript points at every place
 * that needs to change, on both sides.
 *
 * Everything lives under /api so the dashboard can be served from /.
 */
import { Schema } from 'effect'
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from 'effect/http-api'

import { RunEvent, RunInfo, RunOverrides, TestInfo } from './Run.ts'

/** Returned when a run id does not exist. */
export class RunNotFound extends Schema.TaggedError<RunNotFound>()(
  'RunNotFound',
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

/** Returned when starting a run while another one is still going. */
export class RunAlreadyActive extends Schema.TaggedError<RunAlreadyActive>()(
  'RunAlreadyActive',
  { id: Schema.String },
  { httpApiStatus: 409 },
) {}

/** The test file the server was started with. */
export class TestGroup extends HttpApiGroup.make('test').add(
  HttpApiEndpoint.get('get', '/test', { success: TestInfo }),
) {}

export class RunsGroup extends HttpApiGroup.make('runs')
  .add(
    // Start a run of the loaded test.
    HttpApiEndpoint.post('start', '/runs', {
      payload: RunOverrides,
      success: RunInfo,
      error: RunAlreadyActive,
    }),
    // Every run since the server started, newest first.
    HttpApiEndpoint.get('list', '/runs', {
      success: Schema.Array(RunInfo),
    }),
    HttpApiEndpoint.get('get', '/runs/:id', {
      params: { id: Schema.String },
      success: RunInfo,
      error: RunNotFound,
    }),
    // Stop a run early. Requests in flight are cancelled.
    HttpApiEndpoint.post('stop', '/runs/:id/stop', {
      params: { id: Schema.String },
      success: RunInfo,
      error: RunNotFound,
    }),
    // The live stream. It first replays every Second so far, then sends new
    // ones as they close, and ends once the run is over. One message per
    // second; `RunUpdated` arrives whenever status or thresholds change.
    HttpApiEndpoint.get('events', '/runs/:id/events', {
      params: { id: Schema.String },
      success: HttpApiSchema.StreamSse({
        data: RunEvent,
        keepAlive: '15 seconds',
      }),
      error: RunNotFound,
    }),
  )
  .annotateMerge(OpenApi.annotations({ title: 'Runs' })) {}

export class MantixApi extends HttpApi.make('mantix')
  .add(TestGroup)
  .add(RunsGroup)
  .prefix('/api')
  .annotateMerge(OpenApi.annotations({ title: 'Mantix API' })) {}
