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
    expect(second.errorSamples).toMatchObject([
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

  it('keeps a few distinct samples per problem', () => {
    const recorder = new Recorder()
    for (let i = 0; i < 20; i++) {
      // "message 0".."message 6" are one problem once numbers are blanked.
      recorder.sample('GET /a', 'Transport', `message ${i % 7}`)
      recorder.sample('GET /a', 'Timeout', 'same')
    }
    const { errorSamples, fingerprints } = recorder.snapshot(0, gauges)
    expect(errorSamples.map(s => s.message)).toEqual([
      'message 0',
      'same',
      'message 1',
    ])
    expect(Object.values(fingerprints ?? {})).toEqual([20, 20])
  })

  it('keeps the latest iteration start of the second', () => {
    const recorder = new Recorder()
    recorder.iterationStarted(3)
    recorder.iterationStarted(40)
    recorder.iterationStarted(7)
    expect(recorder.lateStartMs).toBe(40)
    recorder.snapshot(0, gauges)
    expect(recorder.lateStartMs).toBe(0)
  })

  it('never lets a noisy error crowd out a rare one', () => {
    const recorder = new Recorder()
    for (let i = 0; i < 500; i++) {
      recorder.sample('POST /checkout', 'HttpStatus', '503 Service Unavailable')
      recorder.sample('GET /cart/:id', 'Transport', `ECONNRESET ${i}`)
    }
    recorder.sample('POST /checkout', 'ScriptError', 'boom', {
      location: 'checkout.ts:42',
    })
    const second = recorder.snapshot(0, gauges)
    const counts = Object.values(second.fingerprints ?? {}).sort(
      (a, b) => a - b,
    )
    // Numbers in messages are blanked, so the resets are one problem.
    expect(counts).toEqual([1, 500, 500])
    expect(second.errorSamples.map(s => s.kind)).toContain('ScriptError')
    expect(second.errorSamples.length).toBeLessThanOrEqual(10)
  })
})
