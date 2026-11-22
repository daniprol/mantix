/**
 * Request phases (blocked, waiting, download) from undici's diagnostics
 * channels, for the iteration waterfall.
 *
 * undici publishes events as a request moves along: created, headers sent
 * on a socket, response headers received. We only need to link those
 * events to *our* request. undici creates its Request object synchronously
 * inside our `request()` call, so `send` sets `pending` just before the
 * call and clears it straight after; the "create" listener picks it up and
 * remembers it for that Request object (in a WeakMap, so nothing leaks).
 *
 * If undici ever creates the Request later (say the pool was full and the
 * request waited in a queue), `pending` is empty by then and that request
 * simply has no phases. The waterfall still shows its total time.
 */
import { subscribe } from 'node:diagnostics_channel'
import { performance } from 'node:perf_hooks'

/** The moments we learn about one request, in performance.now() ms. */
export interface PhaseClock {
  created?: number
  sent?: number
  firstByte?: number
  /** True when the request went out on a socket we had not seen before. */
  newSocket?: boolean
}

let pending: PhaseClock | undefined
const byRequest = new WeakMap<object, PhaseClock>()
const seenSockets = new WeakSet<object>()
let listening = false

/** Start listening to undici. Safe to call many times. */
export const listenToPhases = (): void => {
  if (listening) return
  listening = true
  subscribe('undici:request:create', message => {
    const { request } = message as { request: object }
    if (pending === undefined) return
    pending.created = performance.now()
    byRequest.set(request, pending)
  })
  subscribe('undici:client:sendHeaders', message => {
    const { request, socket } = message as { request: object; socket: object }
    const clock = byRequest.get(request)
    if (clock === undefined) return
    clock.sent = performance.now()
    clock.newSocket = !seenSockets.has(socket)
    seenSockets.add(socket)
  })
  subscribe('undici:request:headers', message => {
    const { request } = message as { request: object }
    const clock = byRequest.get(request)
    if (clock !== undefined) clock.firstByte = performance.now()
  })
}

/**
 * Run `start` (which must call undici's `request()` synchronously) with
 * `clock` as the request being created.
 */
export const withPhaseClock = <A>(clock: PhaseClock, start: () => A): A => {
  pending = clock
  try {
    return start()
  } finally {
    pending = undefined
  }
}

/** Turn the moments into phase durations, if we saw all of them. */
export const phasesOf = (
  clock: PhaseClock,
  end: number,
):
  | {
      readonly blocked: number
      readonly waiting: number
      readonly download: number
    }
  | undefined => {
  const { created, sent, firstByte } = clock
  if (created === undefined || sent === undefined || firstByte === undefined) {
    return undefined
  }
  const round = (ms: number) => Math.round(ms * 100) / 100
  return {
    blocked: round(sent - created),
    waiting: round(firstByte - sent),
    download: round(Math.max(0, end - firstByte)),
  }
}
