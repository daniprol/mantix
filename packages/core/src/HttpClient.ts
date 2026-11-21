/**
 * The HTTP client handed to scenarios.
 *
 * Decision D4 in the proposal: Effect runs the orchestra, the request path
 * stays thin. There is one core function, `send`, written with plain
 * Promises over undici. It is exposed two ways:
 *
 * - `makeHttp` gives the Promise `Http` interface used by `scenario()`.
 * - `makeEffectHttp` gives the `EffectHttp` interface used by
 *   `scenario.effect()`. Each call is wrapped in `Effect.promise`, which
 *   hands us an AbortSignal that fires when the fiber is interrupted, so
 *   interrupting an Effect really cancels the request on the wire.
 *
 * Every request is recorded exactly once, then resolves with the response
 * or rejects with `RequestFailed`.
 */

import { Effect, Exit } from 'effect'
import { STATUS_CODES } from 'node:http'
import { Agent, request } from 'undici'

import { toSeconds } from './Duration.ts'
import type { Recorder } from './Recorder.ts'
import {
  type EffectHttp,
  type Http,
  type HttpResponse,
  RequestFailed,
  type RequestOptions,
} from './Scenario.ts'
import type { StandardSchemaV1 } from './StandardSchema.ts'

/** Default request timeout, in ms. */
export const DEFAULT_TIMEOUT_MS = 10_000

/**
 * One keep-alive connection pool for the whole run. Reusing connections
 * matters: opening a new TCP connection per request would measure the
 * handshake, not the server.
 */
export const makeAgent = (): Agent =>
  new Agent({
    keepAliveTimeout: 10_000,
    // Plenty of sockets per origin so the pool is not our bottleneck.
    connections: 1024,
    pipelining: 1,
  })

/** Everything a request needs that is the same for a whole scenario. */
export interface ClientConfig {
  readonly agent: Agent
  readonly recorder: Recorder
  /** Monotonic time in ms. Comes from Effect's Clock, so tests can fake it. */
  readonly now: () => number
  readonly baseUrl: string | undefined
  readonly headers: Readonly<Record<string, string>> | undefined
  readonly timeoutMs: number
}

/**
 * Timing for one iteration, used for the coordinated-omission correction
 * (decision D1).
 *
 * In the open model an iteration has an intended start: the moment the
 * schedule said it should begin. If it began late, the first request pays
 * for that delay: its corrected latency is measured from the intended start.
 * Later requests in the same iteration were not delayed by the schedule, so
 * their corrected latency equals the uncorrected one. Requests sent in
 * parallel with the first one (Promise.all) share its delay.
 *
 * In the closed model `intendedStart` is undefined: a VU starts its next
 * iteration when the last one ends, so intended and actual start are equal.
 */
export interface IterationTiming {
  readonly intendedStart: number | undefined
  /** The delay the first request saw, once it has started. */
  firstDelay: number | undefined
  /** Set when the first request has finished; later ones get no delay. */
  firstDone: boolean
}

export const makeTiming = (intendedStart?: number): IterationTiming => ({
  intendedStart,
  firstDelay: undefined,
  firstDone: false,
})

/** Fill `:name` placeholders. A missing value is a bug in the test. */
const fillParams = (path: string, params: RequestOptions['params']): string =>
  params === undefined
    ? path
    : path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (match, name: string) => {
        const value = params[name]
        if (value === undefined) {
          // Leave things like "http://host:8080" alone: only names we were
          // given a value for are placeholders.
          return match
        }
        return encodeURIComponent(String(value))
      })

const buildUrl = (
  config: ClientConfig,
  path: string,
  options: RequestOptions<unknown>,
): string => {
  const filled = fillParams(path, options.params)
  const absolute = /^https?:\/\//.test(filled)
  if (!absolute && config.baseUrl === undefined) {
    throw new Error(
      `Request to "${path}" has no host. Set baseUrl on the scenario or use a full URL.`,
    )
  }
  const url = new URL(
    absolute ? filled : config.baseUrl!.replace(/\/$/, '') + filled,
  )
  if (options.query !== undefined) {
    for (const [key, value] of Object.entries(options.query)) {
      url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}

/** undici gives header values as string | string[]; flatten them. */
const flattenHeaders = (
  headers: Record<string, string | Array<string> | undefined>,
): Record<string, string> => {
  const flat: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      flat[key] = Array.isArray(value) ? value.join(', ') : value
    }
  }
  return flat
}

const defaultOk = (status: number): boolean => status >= 200 && status < 400

/** A readable one-line description of the first schema issue. */
const describeIssues = (
  issues: ReadonlyArray<StandardSchemaV1.Issue>,
): string => {
  const first = issues[0]
  if (first === undefined) {
    return 'Response did not match the schema'
  }
  let path = '$'
  for (const segment of first.path ?? []) {
    const key = typeof segment === 'object' ? segment.key : segment
    path += typeof key === 'number' ? `[${key}]` : `.${String(key)}`
  }
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : ''
  return `${path}: ${first.message}${more}`
}

/**
 * The run was stopped or the fiber interrupted while the request was in
 * flight. This is not a server failure, so it is never recorded.
 */
export class RequestCancelled extends Error {
  readonly _tag = 'RequestCancelled'
  constructor() {
    super('Request cancelled because the run stopped')
    this.name = 'RequestCancelled'
  }
}

/**
 * Send one request, record it, and return the response or throw
 * `RequestFailed`. `signal` cancels the request without recording it.
 */
export const send = async <Body>(
  config: ClientConfig,
  timing: IterationTiming,
  method: string,
  path: string,
  options: RequestOptions<Body>,
  signal: AbortSignal | undefined,
): Promise<HttpResponse<Body>> => {
  const endpoint = options.name ?? `${method} ${path}`
  // Bad input (a missing baseUrl, say) throws here, before anything is
  // recorded: it is a ScriptError, not a request failure.
  const url = buildUrl(config, path, options)
  const headers: Record<string, string> = {
    ...config.headers,
    ...options.headers,
  }
  let body: string | Uint8Array | undefined = options.body
  if (options.json !== undefined) {
    body = JSON.stringify(options.json)
    headers['content-type'] ??= 'application/json'
  }

  // One AbortController per request, fired by the timeout or by `signal`.
  // (A listener we remove afterwards is cheaper than AbortSignal.any and
  // cannot leak.)
  const controller = new AbortController()
  let timedOut = false
  const timeoutMs =
    options.timeout === undefined
      ? config.timeoutMs
      : toSeconds(options.timeout) * 1000
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onCancel = (): void => controller.abort()
  signal?.addEventListener('abort', onCancel, { once: true })

  const start = config.now()
  // Coordinated-omission correction: see IterationTiming.
  let delay = 0
  if (timing.intendedStart !== undefined && !timing.firstDone) {
    timing.firstDelay ??= Math.max(0, start - timing.intendedStart)
    delay = timing.firstDelay
  }

  const finish = (
    status: number | undefined,
    error: { kind: RequestFailed['kind']; message: string } | undefined,
  ): void => {
    const latencyMs = config.now() - start
    timing.firstDone = true
    config.recorder.recordRequest({
      endpoint,
      latencyMs,
      correctedMs: latencyMs + delay,
      status,
      error,
    })
  }

  const fail = (
    kind: RequestFailed['kind'],
    message: string,
    status?: number,
  ): RequestFailed => {
    finish(status, { kind, message })
    return new RequestFailed({
      kind,
      endpoint,
      message,
      ...(status === undefined ? {} : { status }),
    })
  }

  try {
    let status: number
    let responseHeaders: Record<string, string>
    let text: string
    try {
      const response = await request(url, {
        method: method as 'GET',
        headers,
        body: body ?? null,
        signal: controller.signal,
        dispatcher: config.agent,
      })
      status = response.statusCode
      responseHeaders = flattenHeaders(response.headers)
      text = await response.body.text()
    } catch (cause) {
      if (timedOut) {
        throw fail('Timeout', `No response within ${timeoutMs} ms`)
      }
      if (signal?.aborted === true) {
        throw new RequestCancelled()
      }
      throw fail('Transport', transportMessage(cause))
    }

    const ok = (options.okStatus ?? defaultOk)(status)
    if (!ok) {
      throw fail(
        'HttpStatus',
        `${status} ${STATUS_CODES[status] ?? 'Unknown status'}`,
        status,
      )
    }

    let parsed: unknown = text
    const contentType = responseHeaders['content-type'] ?? ''
    if (contentType.includes('json') && text.length > 0) {
      try {
        parsed = JSON.parse(text)
      } catch {
        if (options.expect !== undefined) {
          throw fail(
            'SchemaMismatch',
            'Response body is not valid JSON',
            status,
          )
        }
      }
    }

    if (
      options.expect !== undefined &&
      Math.random() < (options.validateSample ?? 1)
    ) {
      let result = options.expect['~standard'].validate(parsed)
      if (result instanceof Promise) result = await result
      if (result.issues !== undefined) {
        throw fail('SchemaMismatch', describeIssues(result.issues), status)
      }
      parsed = result.value
    }

    finish(status, undefined)
    return { status, headers: responseHeaders, body: parsed as Body, text }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onCancel)
  }
}

/** A short message for a network error, without any request details. */
const transportMessage = (cause: unknown): string => {
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code
    const inner = (cause as { cause?: { code?: unknown } }).cause?.code
    const label = typeof code === 'string' ? code : inner
    return typeof label === 'string'
      ? `${label}: ${cause.message}`
      : cause.message
  }
  return String(cause)
}

/**
 * The Promise client for one iteration (or for setup/teardown).
 * `signal` cancels every request it sends, e.g. when the run stops.
 */
export const makeHttp = (
  config: ClientConfig,
  timing: IterationTiming,
  signal: AbortSignal | undefined,
): Http => {
  const call =
    (method: string) =>
    <Body>(path: string, options?: RequestOptions<Body>) =>
      send<Body>(config, timing, method, path, options ?? {}, signal)
  return {
    get: call('GET'),
    post: call('POST'),
    put: call('PUT'),
    patch: call('PATCH'),
    delete: call('DELETE'),
    request: (method, path, options) =>
      send(config, timing, method.toUpperCase(), path, options ?? {}, signal),
  }
}

/**
 * The Effect client. `Effect.promise` passes its own AbortSignal to the
 * promise and aborts it when the fiber is interrupted, so `Effect.timeout`,
 * `Effect.race` or stopping the run cancel the request itself.
 */
export const makeEffectHttp = (
  config: ClientConfig,
  timing: IterationTiming,
): EffectHttp => {
  const call = <Body>(
    method: string,
    path: string,
    options: RequestOptions<Body> | undefined,
  ): Effect.Effect<HttpResponse<Body>, RequestFailed> =>
    Effect.promise(signal =>
      send<Body>(config, timing, method, path, options ?? {}, signal).then(
        response => Exit.succeed(response),
        error => {
          // RequestFailed is the typed error. Anything else (a bad path,
          // say) is rethrown, so it becomes a defect: a ScriptError.
          if (error instanceof RequestFailed) return Exit.fail(error)
          throw error
        },
      ),
    ).pipe(
      // An Exit is itself an Effect, so flattening turns the value we
      // returned into the request's success or typed failure.
      Effect.flatten,
    )
  const method =
    (name: string) =>
    <Body>(path: string, options?: RequestOptions<Body>) =>
      call<Body>(name, path, options)
  return {
    get: method('GET'),
    post: method('POST'),
    put: method('PUT'),
    patch: method('PATCH'),
    delete: method('DELETE'),
    request: (name, path, options) => call(name.toUpperCase(), path, options),
  }
}
