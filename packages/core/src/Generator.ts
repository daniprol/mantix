/**
 * Watching the load generator itself.
 *
 * If Mantix is too busy to keep its own schedule, the latencies it records
 * include its own delays, not just the server's. So once a second we
 * measure how Mantix was doing and mark the second as untrusted when it
 * was struggling. The dashboard hatches those stretches.
 *
 * Plain mutable TypeScript with Node's perf_hooks, like the Recorder: it
 * is read once per second and costs almost nothing in between.
 */
import {
  PerformanceObserver,
  monitorEventLoopDelay,
  performance,
} from 'node:perf_hooks'

import { type GeneratorHealth, generatorIssues } from '@mantix/api'

const round1 = (x: number): number => Math.round(x * 10) / 10

export class GeneratorMonitor {
  // The event-loop delay histogram: how late timers fire.
  private readonly loopDelay = monitorEventLoopDelay({ resolution: 10 })
  private gcMs = 0
  private readonly gcObserver = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) this.gcMs += entry.duration
  })
  private cpu = process.cpuUsage()
  private wall = performance.now()

  start(): void {
    this.loopDelay.enable()
    this.gcObserver.observe({ entryTypes: ['gc'] })
    this.cpu = process.cpuUsage()
    this.wall = performance.now()
  }

  stop(): void {
    this.loopDelay.disable()
    this.gcObserver.disconnect()
  }

  /**
   * How the last second went, then start measuring the next one.
   * `lateStartMs` comes from the recorder (it sees every iteration start).
   */
  sample(lateStartMs: number): {
    readonly loopLagMs: number
    readonly health: GeneratorHealth
  } {
    const loopLagMs =
      this.loopDelay.max > 0 ? round1(this.loopDelay.max / 1e6) : 0
    this.loopDelay.reset()

    // CPU time used since the last sample, over wall time passed.
    const used = process.cpuUsage(this.cpu)
    const now = performance.now()
    const wallMs = Math.max(1, now - this.wall)
    const cpuPercent = round1(((used.user + used.system) / 1000 / wallMs) * 100)
    this.cpu = process.cpuUsage()
    this.wall = now

    const measured = {
      cpuPercent,
      gcMs: round1(this.gcMs),
      heapMb: round1(process.memoryUsage().heapUsed / 1024 / 1024),
      lateStartMs: round1(lateStartMs),
    }
    this.gcMs = 0
    return {
      loopLagMs,
      health: {
        ...measured,
        issues: generatorIssues({ ...measured, loopLagMs }),
      },
    }
  }
}
