import { describe, expect, it } from 'vitest'

import { Recorder } from '../src/Recorder.ts'

const gauges = { target: 10, vus: 3, loopLagMs: 1.5 }

describe('Recorder', () => {
  it('aggregates one second and then starts from zero', () => {
    const recorder = new Recorder()
    recorder.iterationOffered()
    recorder.iterationOffered()
    recorder.iterationDropped()
    recorder.iterationStarted()
    recorder.recordRequest({
      endpoint: 'GET /a',
      latencyMs: 10,
      correctedMs: 12,
      status: 200,
    })
    recorder.recordRequest({
      endpoint: 'GET /a',
      latencyMs: 30,
      correctedMs: 30,
      status: 503,
      error: { kind: 'HttpStatus', message: '503 Service Unavailable' },
    })
    recorder.iterationEnded('failed')
    recorder.iterationStarted() // still running at the end of the second

    const second = recorder.snapshot(0, gauges)
    expect(second).toMatchObject({
      t: 0,
      target: 10,
      vus: 3,
      loopLagMs: 1.5,
      offered: 2,
      dropped: 1,
      started: 2,
      completed: 0,
      failed: 1,
      inFlight: 1,
    })
    const [endpoint] = second.endpoints
    expect(endpoint).toMatchObject({
      endpoint: 'GET /a',
      requests: 2,
      statuses: { '200': 1, '503': 1 },
      errors: { HttpStatus: 1 },
    })
    expect(endpoint!.uncorrected.min).toBe(10_000)
    expect(endpoint!.latency.min).toBe(12_000)
    expect(second.errorSamples).toEqual([
      {
        endpoint: 'GET /a',
        kind: 'HttpStatus',
        message: '503 Service Unavailable',
      },
    ])

    // The next second starts empty, but in-flight iterations carry over.
    recorder.iterationEnded('completed')
    const next = recorder.snapshot(1, gauges)
    expect(next).toMatchObject({ completed: 1, inFlight: 0, endpoints: [] })
  })

  it('keeps at most five distinct error samples per second', () => {
    const recorder = new Recorder()
    for (let i = 0; i < 20; i++) {
      recorder.sample('GET /a', 'Timeout', `message ${i % 7}`)
      recorder.sample('GET /a', 'Timeout', 'same')
    }
    const { errorSamples } = recorder.snapshot(0, gauges)
    expect(errorSamples).toHaveLength(5)
    expect(new Set(errorSamples.map(s => s.message)).size).toBe(5)
  })
})
