/**
 * The scenario API: what people write in a test file.
 *
 * There are two front doors onto one engine:
 *
 * - `scenario({...})` takes ordinary async functions. No Effect knowledge is
 *   needed, and it gets every dashboard, statistics and CI feature.
 * - `scenario.effect({...})` has the same shape, but the iteration returns an
 *   Effect and `http` methods return Effects. It adds clean cancellation,
 *   typed errors, retries with Schedule, and testing with TestClock.
 *
 * Inside Mantix both end up as the same Effect, so neither is second class.
 */
import type { Effect } from 'effect'

import type { DurationInput } from './Duration.ts'
import type { LoadModel } from './Load.ts'
import type { StandardSchemaV1 } from './StandardSchema.ts'
import type { ThresholdInput } from './Thresholds.ts'

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface RequestOptions<Body = unknown> {
  /**
   * Values for `:name` placeholders in the path. The endpoint keeps its
   * template as its name, so `/orders/:id` is one row in the results, not
   * one row per order.
   */
  readonly params?: Readonly<Record<string, string | number>>
  /** Query string values. */
  readonly query?: Readonly<Record<string, string | number | boolean>>
  readonly headers?: Readonly<Record<string, string>>
  /** A JSON body. Sets content-type to application/json. */
  readonly json?: unknown
  /** A raw body. */
  readonly body?: string | Uint8Array
  /** Override the endpoint name shown in results. */
  readonly name?: string
  /**
   * Validate the JSON response with any Standard Schema library (Effect
   * Schema, Zod, Valibot, ArkType...). A mismatch is recorded as a
   * SchemaMismatch error, separate from HTTP failures.
   */
  readonly expect?: StandardSchemaV1<unknown, Body>
  /**
   * Validate only a fraction of responses (0..1) to save generator CPU.
   * Default 1 (validate every response).
   */
  readonly validateSample?: number
  /**
   * Which statuses count as success. Default: 200 to 399.
   */
  readonly okStatus?: (status: number) => boolean
  /** Give up after this long and record a Timeout. Default: the scenario's. */
  readonly timeout?: DurationInput
}

export interface HttpResponse<Body = unknown> {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  /** The parsed JSON body (validated when `expect` was given), else the text. */
  readonly body: Body
  /** The raw body text. */
  readonly text: string
}

/**
 * The promise-based HTTP client handed to async scenarios.
 *
 * When a request fails (transport error, timeout, a status outside
 * `okStatus`, or a schema mismatch) the failure is recorded once and the
 * promise rejects with a `RequestFailed` error, which ends the iteration.
 * Catch it if you want the iteration to carry on.
 */
export interface Http {
  readonly get: <Body = unknown>(
    path: string,
    options?: RequestOptions<Body>,
  ) => Promise<HttpResponse<Body>>
  readonly post: <Body = unknown>(
    path: string,
    options?: RequestOptions<Body>,
  ) => Promise<HttpResponse<Body>>
  readonly put: <Body = unknown>(
    path: string,
    options?: RequestOptions<Body>,
  ) => Promise<HttpResponse<Body>>
  readonly patch: <Body = unknown>(
    path: string,
    options?: RequestOptions<Body>,
  ) => Promise<HttpResponse<Body>>
  readonly delete: <Body = unknown>(
    path: string,
    options?: RequestOptions<Body>,
  ) => Promise<HttpResponse<Body>>
  readonly request: <Body = unknown>(
    method: string,
    path: string,
    options?: RequestOptions<Body>,
  ) => Promise<HttpResponse<Body>>
}

/** The same client for Effect scenarios: every method returns an Effect. */
export interface EffectHttp {
  readonly get: <Body = unknown>(
    path: string,
    options?: RequestOptions<Body>,
  ) => Effect.Effect<HttpResponse<Body>, RequestFailed>
  readonly post: <Body = unknown>(
    path: string,
    options?: RequestOptions<Body>,
  ) => Effect.Effect<HttpResponse<Body>, RequestFailed>
  readonly put: <Body = unknown>(
    path: string,
    options?: RequestOptions<Body>,
  ) => Effect.Effect<HttpResponse<Body>, RequestFailed>
  readonly patch: <Body = unknown>(
    path: string,
    options?: RequestOptions<Body>,
  ) => Effect.Effect<HttpResponse<Body>, RequestFailed>
  readonly delete: <Body = unknown>(
    path: string,
    options?: RequestOptions<Body>,
  ) => Effect.Effect<HttpResponse<Body>, RequestFailed>
  readonly request: <Body = unknown>(
    method: string,
    path: string,
    options?: RequestOptions<Body>,
  ) => Effect.Effect<HttpResponse<Body>, RequestFailed>
}

/**
 * A request failed and has already been recorded. Its `kind` is the error
 * class shown in results.
 */
export class RequestFailed extends Error {
  readonly _tag = 'RequestFailed'
  readonly kind: 'Transport' | 'Timeout' | 'HttpStatus' | 'SchemaMismatch'
  readonly endpoint: string
  readonly status: number | undefined

  constructor(options: {
    readonly kind: RequestFailed['kind']
    readonly endpoint: string
    readonly message: string
    readonly status?: number
  }) {
    super(options.message)
    this.name = 'RequestFailed'
    this.kind = options.kind
    this.endpoint = options.endpoint
    this.status = options.status
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/** What every iteration receives. */
export interface IterationContext<Data, H> {
  readonly http: H
  /** Whatever `setup` returned. */
  readonly data: Data
  /** The virtual user running this iteration, from 1. */
  readonly vu: number
  /** How many iterations this VU has started, from 1. */
  readonly iteration: number
  /**
   * Aborted when the run stops. Mantix's own `http` uses it automatically;
   * pass it to any other library you call so it stops too.
   */
  readonly signal: AbortSignal
}

/** What `setup` and `teardown` receive. */
export interface LifecycleContext<H> {
  readonly http: H
  readonly signal: AbortSignal
}

interface CommonOptions {
  /** Shown everywhere in results. */
  readonly name: string
  /** Prepended to every request path that does not start with http(s)://. */
  readonly baseUrl?: string
  /** How much load to generate over time. See `rate` and `vus`. */
  readonly load: LoadModel
  /**
   * Pass/fail rules checked while the run goes, e.g. "p99 < 250ms",
   * "errors < 1%". A failing threshold makes `mantix run` exit with code 99.
   */
  readonly thresholds?: ReadonlyArray<ThresholdInput>
  /** Headers sent with every request. */
  readonly headers?: Readonly<Record<string, string>>
  /** Default request timeout. Default "10s". */
  readonly timeout?: DurationInput
  /** Wait this long after the run starts before this scenario begins. */
  readonly startAfter?: DurationInput
}

export interface AsyncScenarioOptions<Data> extends CommonOptions {
  /** Runs once before the load starts. Its result is `data` everywhere. */
  readonly setup?: (context: LifecycleContext<Http>) => Promise<Data>
  /** One iteration: a single user's journey. Runs many times. */
  readonly iteration: (context: IterationContext<Data, Http>) => Promise<void>
  /** Runs once after the load stops, even when the run is stopped early. */
  readonly teardown?: (
    context: LifecycleContext<Http> & { readonly data: Data },
  ) => Promise<void>
}

export interface EffectScenarioOptions<Data, E> extends CommonOptions {
  readonly setup?: (
    context: LifecycleContext<EffectHttp>,
  ) => Effect.Effect<Data, E>
  readonly iteration: (
    context: IterationContext<Data, EffectHttp>,
  ) => Effect.Effect<void, E>
  readonly teardown?: (
    context: LifecycleContext<EffectHttp> & { readonly data: Data },
  ) => Effect.Effect<void, E>
}

/** A scenario defined with plain async functions. */
export interface AsyncScenario<Data = unknown> {
  readonly _tag: 'AsyncScenario'
  readonly options: AsyncScenarioOptions<Data>
}

/** A scenario defined with Effects. */
export interface EffectScenario<Data = unknown, E = unknown> {
  readonly _tag: 'EffectScenario'
  readonly options: EffectScenarioOptions<Data, E>
}

// `any` keeps a list of scenarios with different Data types assignable here.
// oxlint-disable-next-line typescript/no-explicit-any
export type Scenario = AsyncScenario<any> | EffectScenario<any, any>

/**
 * What a test file's default export can be: one scenario, or several that
 * run together (use `startAfter` to stagger them).
 */
export type TestDefinition = Scenario | ReadonlyArray<Scenario>

/**
 * Define a scenario with plain async functions.
 *
 * ```ts
 * import { rate, scenario } from 'mantix'
 *
 * export default scenario({
 *   name: 'browse',
 *   baseUrl: 'http://localhost:4200',
 *   load: rate.constant(20, { duration: '30s' }),
 *   thresholds: ['p99 < 250ms', 'errors < 1%'],
 *   iteration: async ({ http }) => {
 *     await http.get('/products/:sku', { params: { sku: 'A1' } })
 *   },
 * })
 * ```
 */
export const scenario: {
  <Data = undefined>(options: AsyncScenarioOptions<Data>): AsyncScenario<Data>
  /** Define a scenario whose iteration is an Effect. */
  readonly effect: <Data = undefined, E = never>(
    options: EffectScenarioOptions<Data, E>,
  ) => EffectScenario<Data, E>
} = Object.assign(
  <Data = undefined>(
    options: AsyncScenarioOptions<Data>,
  ): AsyncScenario<Data> => ({ _tag: 'AsyncScenario', options }),
  {
    effect: <Data = undefined, E = never>(
      options: EffectScenarioOptions<Data, E>,
    ): EffectScenario<Data, E> => ({ _tag: 'EffectScenario', options }),
  },
)

/**
 * Pick one of several iterations at random, by weight, like Locust's
 * weighted tasks. `weighted([[3, browse], [1, buy]])` runs `browse` three
 * times as often as `buy`.
 */
export const weighted = <Context>(
  choices: ReadonlyArray<
    readonly [weight: number, run: (context: Context) => Promise<void>]
  >,
): ((context: Context) => Promise<void>) => {
  const total = choices.reduce((sum, [weight]) => sum + weight, 0)
  if (choices.length === 0 || total <= 0) {
    throw new Error('weighted() needs at least one choice with weight above 0')
  }
  return context => {
    let roll = Math.random() * total
    for (const [weight, run] of choices) {
      roll -= weight
      if (roll < 0) {
        return run(context)
      }
    }
    // Floating-point rounding can leave us here; use the last choice.
    return choices[choices.length - 1]![1](context)
  }
}

/** Normalise a test file's default export to a list of scenarios. */
export const scenariosOf = (test: TestDefinition): ReadonlyArray<Scenario> =>
  Array.isArray(test) ? test : [test as Scenario]
