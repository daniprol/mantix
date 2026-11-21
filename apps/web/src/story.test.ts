/**
 * Story tests drive `update` with Messages and check the Model and the
 * Commands it asks for. No browser, no server: update is pure.
 */
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'

import { FetchRuns, StartRun, StopRun, SyncTimeline } from './commands.ts'
import { verdict } from './domain/verdict.ts'
import { makeSecond, readyModel, runningRun, watchingModel } from './fixture.ts'
import { Message } from './message.ts'
import { update } from './update.ts'

const finishedRun = {
  ...runningRun,
  status: 'finished' as const,
  endedAt: runningRun.startedAt + 150_000,
  thresholds: [
    { expression: 'p99 < 250ms', actual: 412, passed: false },
    { expression: 'errors < 1%', actual: 0.2, passed: true },
  ],
}

describe('a run from start to verdict', () => {
  test('start, receive seconds, finish with a failed threshold', () => {
    story(
      update,
      given(readyModel),
      message(Message.ClickedStart()),
      model(next => expect(next.runState._tag).toBe('Starting')),
      Command.resolve(StartRun, Message.SucceededStartRun({ run: runningRun })),
      Command.resolve(SyncTimeline, Message.CompletedSyncTimeline()),
      model(next => {
        expect(next.runState._tag).toBe('Watching')
        expect(next.window).toBe('Recent')
      }),
      message(Message.ReceivedSecond({ second: makeSecond(0, { ms: 40 }) })),
      Command.resolve(SyncTimeline, Message.CompletedSyncTimeline()),
      message(Message.ReceivedSecond({ second: makeSecond(1, { ms: 420 }) })),
      Command.resolve(SyncTimeline, Message.CompletedSyncTimeline()),
      model(next => {
        expect(
          next.runState._tag === 'Watching' && next.runState.seconds,
        ).toHaveLength(2)
      }),
      message(Message.ReceivedRunUpdate({ run: finishedRun })),
      Command.expectHas(FetchRuns),
      Command.resolve(SyncTimeline, Message.CompletedSyncTimeline()),
      Command.resolve(
        FetchRuns,
        Message.SucceededFetchRuns({ runs: [finishedRun] }),
      ),
      message(Message.CompletedFollowRun()),
      model(next => {
        expect(next.runState._tag).toBe('Watching')
        if (next.runState._tag === 'Watching') {
          expect(next.runState.feed._tag).toBe('Ended')
          expect(verdict(next.runState.run, 2).headline).toBe(
            'Failed: p99 was 412 ms, limit 250 ms',
          )
        }
      }),
    )
  })

  test('the start overrides come from the Adjust load inputs', () => {
    story(
      update,
      given(readyModel),
      message(Message.UpdatedLoadInput({ value: '300' })),
      message(Message.UpdatedDurationInput({ value: '2m' })),
      message(Message.PressedEnter()),
      Command.expectExact(
        StartRun({ overrides: { rate: 300, duration: 120 } }),
      ),
      Command.resolve(StartRun, Message.FailedStartRun({ error: 'x' })),
    )
  })

  test('invalid input opens the disclosure instead of starting', () => {
    story(
      update,
      given(readyModel),
      message(Message.UpdatedLoadInput({ value: 'lots' })),
      message(Message.ClickedStart()),
      Command.expectNone(),
      model(next => {
        expect(next.runState._tag).toBe('NoRun')
        expect(next.adjust.isOpen).toBe(true)
      }),
    )
  })

  test('a Second sent twice (after a reconnect) is kept once', () => {
    const second = makeSecond(0, { ms: 40 })
    story(
      update,
      given(watchingModel(runningRun, [second])),
      message(Message.ReceivedSecond({ second })),
      Command.resolve(SyncTimeline, Message.CompletedSyncTimeline()),
      model(next => {
        expect(
          next.runState._tag === 'Watching' && next.runState.seconds,
        ).toHaveLength(1)
      }),
    )
  })
})

describe('stopping', () => {
  test('Stop asks the server once and shows the stopped run', () => {
    const stopped = { ...runningRun, status: 'stopped' as const }
    story(
      update,
      given(watchingModel(runningRun, [makeSecond(0, { ms: 40 })])),
      message(Message.ClickedStop()),
      Command.expectExact(StopRun({ runId: 'run-1' })),
      model(next => {
        expect(next.runState._tag === 'Watching' && next.runState.stop).toBe(
          'Requested',
        )
      }),
      Command.resolve(StopRun, Message.SucceededStopRun({ run: stopped })),
      Command.resolve(SyncTimeline, Message.CompletedSyncTimeline()),
      model(next => {
        expect(
          next.runState._tag === 'Watching' && next.runState.run.status,
        ).toBe('stopped')
      }),
    )
  })
})

describe('failures', () => {
  test('a failed start returns to Ready with a calm message', () => {
    story(
      update,
      given(readyModel),
      message(Message.ClickedStart()),
      Command.resolve(
        StartRun,
        Message.FailedStartRun({
          error: 'Another run is still going. Stop it first.',
        }),
      ),
      model(next => {
        expect(next.runState._tag).toBe('NoRun')
        expect(next.maybeActionError._tag).toBe('Some')
      }),
      message(Message.ClickedDismissError()),
      model(next => expect(next.maybeActionError._tag).toBe('None')),
    )
  })

  test('a broken stream can be reconnected', () => {
    story(
      update,
      given(watchingModel(runningRun, [])),
      message(Message.FailedFollowRun({ error: 'Network error' })),
      model(next => {
        expect(
          next.runState._tag === 'Watching' && next.runState.feed._tag,
        ).toBe('Lost')
      }),
      message(Message.ClickedReconnect()),
      model(next => {
        if (next.runState._tag === 'Watching') {
          expect(next.runState.feed._tag).toBe('Following')
          expect(next.runState.connection).toBe(1)
        }
      }),
    )
  })
})
