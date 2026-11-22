/**
 * Fake load-test data for the mock server.
 *
 * `simulateSecond` produces one plausible `Second`: a few endpoints with
 * log-normal latencies, a latency spike with some 503s partway through, the
 * odd schema mismatch, and (optionally) a second where the load generator
 * itself lagged. It is deterministic for a given seed, so screenshots are
 * repeatable.
 */
import {
  type EndpointSecond,
  type ErrorSample,
  Histogram,
  type LoadPlan,
  type RunOverrides,
  type Second,
  type TestInfo,
} from '@mantix/api'

export const testInfo: TestInfo = {
  file: 'examples/checkout.ts',
  name: 'checkout-flow',
  baseUrl: 'http://localhost:3000',
  scenarios: [
    {
      name: 'checkout-flow',
      plan: {
        model: 'rate',
        start: 0,
        stages: [
          { duration: 15, target: 200 },
          { duration: 45, target: 200 },
        ],
      },
      startAfter: 0,
    },
  ],
  thresholds: ['p99 < 250ms', 'errors < 1%'],
  duration: 60,
}

/** Apply the dashboard's "Adjust load" overrides to the test's plan. */
export const applyOverrides = (
  plan: LoadPlan,
  overrides: RunOverrides,
): LoadPlan => {
  const planned = plan.stages.reduce((sum, stage) => sum + stage.duration, 0)
  const duration = overrides.duration ?? planned
  if (overrides.rate !== undefined) {
    const rate = overrides.rate
    return { model: 'rate', start: rate, stages: [{ duration, target: rate }] }
  }
  if (overrides.vus !== undefined) {
    const vus = overrides.vus
    return { model: 'vus', start: vus, stages: [{ duration, target: vus }] }
  }
  // Only the duration changed: stretch every stage by the same factor.
  const factor = duration / planned
  return {
    ...plan,
    stages: plan.stages.map(stage => ({
      ...stage,
      duration: stage.duration * factor,
    })),
  }
}

/** The planned load at `t` seconds, by walking the stages. */
const plannedAt = (plan: LoadPlan, t: number): number => {
  let from = plan.start
  let elapsed = 0
  for (const stage of plan.stages) {
    if (t < elapsed + stage.duration) {
      return from + ((stage.target - from) * (t - elapsed)) / stage.duration
    }
    elapsed += stage.duration
    from = stage.target
  }
  return from
}

// A tiny seeded random generator (mulberry32), so runs look the same.
const makeRandom = (seed: number) => {
  let state = seed >>> 0
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let x = state
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

interface Endpoint {
  readonly name: string
  readonly weight: number
  /** Median latency in ms when things are calm. */
  readonly median: number
  /** Spread of the log-normal distribution. */
  readonly sigma: number
}

const ENDPOINTS: ReadonlyArray<Endpoint> = [
  { name: 'GET /products/:sku', weight: 0.4, median: 18, sigma: 0.45 },
  { name: 'GET /cart/:id', weight: 0.25, median: 32, sigma: 0.5 },
  { name: 'POST /cart/items', weight: 0.2, median: 58, sigma: 0.5 },
  { name: 'POST /checkout', weight: 0.15, median: 110, sigma: 0.55 },
]

export interface Simulation {
  readonly duration: number
  readonly plan: LoadPlan
  readonly lag: boolean
  readonly random: () => number
}

export const makeSimulation = (
  plan: LoadPlan,
  duration: number,
  options: { readonly seed: number; readonly lag: boolean },
): Simulation => ({
  duration,
  plan,
  lag: options.lag,
  random: makeRandom(options.seed),
})

/** One sample from a log-normal distribution with the given median. */
const logNormal = (random: () => number, median: number, sigma: number) => {
  // Box-Muller turns two uniform numbers into one normal number.
  const u = Math.max(random(), 1e-9)
  const v = random()
  const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  return median * Math.exp(sigma * normal)
}

export const simulateSecond = (sim: Simulation, t: number): Second => {
  const { random } = sim
  const target = plannedAt(sim.plan, t + 0.5)
  const progress = t / sim.duration
  // The server struggles between 55% and 75% of the run.
  const inSpike = progress >= 0.55 && progress < 0.75
  const spikeStrength = inSpike
    ? Math.sin(((progress - 0.55) / 0.2) * Math.PI)
    : 0
  const lagged = sim.lag && Math.abs(progress - 0.35) < 1 / sim.duration
  // In the closed model the target is a number of users, each doing about
  // eight iterations a second.
  const offered = Math.round(
    sim.plan.model === 'vus' ? target * 8 * (1 - spikeStrength * 0.4) : target,
  )
  const dropped = Math.round(offered * spikeStrength * 0.08)
  const started = offered - dropped

  const endpoints: Array<EndpointSecond> = []
  const errorSamples: Array<ErrorSample> = []
  let failed = 0
  for (const endpoint of ENDPOINTS) {
    const requests = Math.round(
      started * endpoint.weight * (0.9 + random() * 0.2),
    )
    const latency = new Histogram.Recorder()
    const uncorrected = new Histogram.Recorder()
    const statuses: Record<string, number> = {}
    const errors: Record<string, number> = {}
    const slowdown =
      1 + spikeStrength * (endpoint.name === 'POST /checkout' ? 4.5 : 1.2)
    for (let i = 0; i < requests; i++) {
      const sent = logNormal(
        random,
        endpoint.median * slowdown,
        endpoint.sigma + spikeStrength * 0.2,
      )
      // While the server is slow, requests also wait to be sent; the
      // corrected latency counts that wait, the uncorrected one does not.
      const queued =
        spikeStrength * random() * 140 + (lagged ? random() * 120 : 0)
      uncorrected.record(sent * 1000)
      latency.record((sent + queued) * 1000)
      let status = 200
      if (
        endpoint.name === 'POST /checkout' &&
        random() < spikeStrength * 0.07
      ) {
        status = 503
        errors.HttpStatus = (errors.HttpStatus ?? 0) + 1
        if (errorSamples.length < 4) {
          errorSamples.push({
            endpoint: endpoint.name,
            kind: 'HttpStatus',
            message: '503 Service Unavailable',
          })
        }
      } else if (endpoint.name === 'GET /cart/:id' && random() < 0.004) {
        errors.SchemaMismatch = (errors.SchemaMismatch ?? 0) + 1
        if (errorSamples.length < 4) {
          errorSamples.push({
            endpoint: endpoint.name,
            kind: 'SchemaMismatch',
            message: '$.items[3].price: expected number, received "19.99"',
          })
        }
      }
      statuses[status] = (statuses[status] ?? 0) + 1
    }
    failed += Object.values(errors).reduce((a, b) => a + b, 0)
    endpoints.push({
      endpoint: endpoint.name,
      requests,
      latency: latency.snapshot(),
      uncorrected: uncorrected.snapshot(),
      statuses,
      errors,
    })
  }
  const finished = endpoints.reduce((sum, e) => sum + e.requests, 0)
  return {
    t,
    target: Math.round(target),
    offered,
    started,
    dropped,
    completed: finished - failed,
    failed,
    inFlight: Math.round(started * 0.05 * (1 + spikeStrength * 4)),
    vus: Math.round(started * 0.08 * (1 + spikeStrength * 4)),
    loopLagMs: lagged ? 180 + random() * 60 : random() * 4,
    endpoints,
    errorSamples,
  }
}
