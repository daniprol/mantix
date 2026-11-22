/**
 * The recorder: where every finished request and iteration is counted.
 *
 * It is plain mutable TypeScript on purpose. It sits on the hot path (it is
 * called once per request), so it only bumps counters and adds values to
 * histograms. Once per second the runner calls `snapshot`, which turns the
 * counters into one immutable `Second` (the data atom, decision D2) and
 * starts the next second from zero.
 */
import {
  type ErrorKind,
  type GeneratorHealth,
  Histogram,
  type IterationTrace,
  type Phase,
  type SchemaDiff,
  type Second,
  fingerprint,
} from '@mantix/api'

/**
 * Example errors kept per second. The first example of every fingerprint
 * is always kept (up to MAX_FINGERPRINTS of them), so a rare error is
 * never crowded out; after that each fingerprint gets at most
 * MAX_PER_FINGERPRINT, and the second at most MAX_ERROR_SAMPLES.
 */
const MAX_ERROR_SAMPLES = 10
const MAX_PER_FINGERPRINT = 2
const MAX_FINGERPRINTS = 20
/** Error messages are cut to this length so one huge body can't bloat a Second. */
const MAX_MESSAGE_LENGTH = 300

/** One finished request, as the HTTP client reports it. */
export interface RequestRecord {
  /** Method plus route template, e.g. "GET /cart/:id". */
  readonly endpoint: string
  /** Set when the request came from setup or teardown, not the load. */
  readonly phase?: Phase | undefined
  /** From the actual send to the end of the response body, in ms. */
  readonly latencyMs: number
  /** From the intended start to the end of the response body, in ms. */
  readonly correctedMs: number
  /** The HTTP status, when a response arrived. */
  readonly status?: number | undefined
  /** Set when the request failed. */
  readonly error?:
    | {
        readonly kind: ErrorKind
        readonly message: string
        readonly diff?: SchemaDiff | undefined
      }
    | undefined
}

/** Per-endpoint numbers for the second that is currently open. */
interface EndpointCounters {
  readonly phase: Phase | undefined
  requests: number
  readonly latency: Histogram.Recorder
  readonly uncorrected: Histogram.Recorder
  readonly statuses: Map<string, number>
  readonly errors: Map<string, number>
}

const bump = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1)
}

export class Recorder {
  private endpoints = new Map<string, EndpointCounters>()
  private samples: Array<Second['errorSamples'][number]> = []
  private sampleKeys = new Set<string>()
  /** Errors per fingerprint this second, and examples kept of each. */
  private fingerprints = new Map<string, number>()
  private samplesPerFingerprint = new Map<string, number>()

  // Iteration counters for the open second.
  private offered = 0
  private started = 0
  private dropped = 0
  private completed = 0
  private failed = 0
  private lateStart = 0
  private slowest: IterationTrace | undefined

  /**
   * Iterations running right now. Unlike the counters above this is a
   * level, not a count per second, so `snapshot` does not reset it.
   */
  inFlight = 0

  /** Record one finished request (successful or not). */
  recordRequest(record: RequestRecord): void {
    let counters = this.endpoints.get(record.endpoint)
    if (counters === undefined) {
      counters = {
        phase: record.phase,
        requests: 0,
        latency: new Histogram.Recorder(),
        uncorrected: new Histogram.Recorder(),
        statuses: new Map(),
        errors: new Map(),
      }
      this.endpoints.set(record.endpoint, counters)
    }
    counters.requests++
    // Histograms hold whole microseconds.
    counters.uncorrected.record(record.latencyMs * 1000)
    counters.latency.record(record.correctedMs * 1000)
    if (record.status !== undefined) {
      bump(counters.statuses, String(record.status))
    }
    if (record.error !== undefined) {
      bump(counters.errors, record.error.kind)
      this.sample(
        record.endpoint,
        record.error.kind,
        record.error.message,
        record.error.diff === undefined ? {} : { diff: record.error.diff },
      )
    }
  }

  /**
   * Count an error under its fingerprint and maybe keep it as an example
   * (see MAX_ERROR_SAMPLES). Callers must never pass header values or
   * secrets.
   */
  sample(
    endpoint: string,
    kind: ErrorKind,
    message: string,
    extra: { readonly diff?: SchemaDiff; readonly location?: string } = {},
  ): void {
    const short =
      message.length > MAX_MESSAGE_LENGTH
        ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…`
        : message
    const error = { endpoint, kind, message: short, ...extra }
    const fp = fingerprint(error)
    this.fingerprints.set(fp, (this.fingerprints.get(fp) ?? 0) + 1)

    const kept = this.samplesPerFingerprint.get(fp) ?? 0
    const keepFirst =
      kept === 0 && this.samplesPerFingerprint.size < MAX_FINGERPRINTS
    const keepMore =
      kept > 0 &&
      kept < MAX_PER_FINGERPRINT &&
      this.samples.length < MAX_ERROR_SAMPLES
    if (!keepFirst && !keepMore) return
    // The exact same message twice adds nothing.
    const key = `${fp}\u0000${short}`
    if (this.sampleKeys.has(key)) return
    this.sampleKeys.add(key)
    this.samplesPerFingerprint.set(fp, kept + 1)
    this.samples.push({ ...error, fingerprint: fp })
  }

  /** The schedule wanted an iteration to start. */
  iterationOffered(): void {
    this.offered++
  }

  /** An offered iteration could not start because every VU was busy. */
  iterationDropped(): void {
    this.dropped++
  }

  /**
   * An iteration started, `lateMs` after its scheduled time (open model).
   * Late starts mean Mantix could not keep up with its own schedule.
   */
  iterationStarted(lateMs = 0): void {
    this.started++
    this.inFlight++
    if (lateMs > this.lateStart) this.lateStart = lateMs
  }

  /** An iteration finished; keep it if it is the slowest this second. */
  offerTrace(trace: IterationTrace): void {
    if (this.slowest === undefined || trace.duration > this.slowest.duration) {
      this.slowest = trace
    }
  }

  /** The latest an iteration started this second, in ms. */
  get lateStartMs(): number {
    return this.lateStart
  }

  /** An iteration ended. Interrupted iterations count as neither outcome. */
  iterationEnded(outcome: 'completed' | 'failed' | 'interrupted'): void {
    this.inFlight--
    if (outcome === 'completed') this.completed++
    else if (outcome === 'failed') this.failed++
  }

  /** True when nothing at all happened since the last snapshot. */
  get isEmpty(): boolean {
    return (
      this.endpoints.size === 0 &&
      this.offered === 0 &&
      this.started === 0 &&
      this.completed === 0 &&
      this.failed === 0 &&
      this.samples.length === 0 &&
      this.fingerprints.size === 0
    )
  }

  /**
   * Close second `t`: return everything recorded since the last snapshot
   * as one `Second`, and start counting the next one from zero.
   */
  snapshot(
    t: number,
    gauges: {
      readonly target: number
      readonly vus: number
      readonly loopLagMs: number
      readonly generator?: GeneratorHealth
    },
  ): Second {
    const endpoints = [...this.endpoints.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([endpoint, counters]) => ({
        endpoint,
        ...(counters.phase === undefined ? {} : { phase: counters.phase }),
        requests: counters.requests,
        latency: counters.latency.snapshot(),
        uncorrected: counters.uncorrected.snapshot(),
        statuses: Object.fromEntries(counters.statuses),
        errors: Object.fromEntries(counters.errors),
      }))
    const second: Second = {
      t,
      target: gauges.target,
      offered: this.offered,
      started: this.started,
      dropped: this.dropped,
      completed: this.completed,
      failed: this.failed,
      inFlight: this.inFlight,
      vus: gauges.vus,
      loopLagMs: gauges.loopLagMs,
      ...(gauges.generator === undefined
        ? {}
        : { generator: gauges.generator }),
      endpoints,
      errorSamples: this.samples,
      ...(this.slowest === undefined ? {} : { slowest: this.slowest }),
      ...(this.fingerprints.size === 0
        ? {}
        : { fingerprints: Object.fromEntries(this.fingerprints) }),
    }
    // Start the next second. New maps are simpler than clearing the old
    // ones, and the old ones now belong to the Second we just returned.
    this.endpoints = new Map()
    this.samples = []
    this.sampleKeys = new Set()
    this.fingerprints = new Map()
    this.samplesPerFingerprint = new Map()
    this.offered = 0
    this.started = 0
    this.dropped = 0
    this.completed = 0
    this.failed = 0
    this.lateStart = 0
    this.slowest = undefined
    return second
  }
}
