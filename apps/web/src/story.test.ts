/**
 * Story tests drive `update` with Messages and check the Model and the
 * Commands it asks for. No browser, no server: update is pure.
 */
import { Option } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'

import {
  ApplyTheme,
  FetchHistory,
  LoadRun,
  NavigateInternal,
  SendControl,
  StartRun,
  StopRun,
  SyncTimeline,
} from './commands.ts'
import {
  baselineRun,
  finishedRun,
  makeSecond,
  modelWithRuns,
  readyModel,
  runningRun,
} from './fixture.ts'
import { Message } from './message.ts'
import { AppRoute, runRouter } from './route.ts'
import { update } from './update.ts'

const urlOf = (pathname: string) => ({
  protocol: 'http:',
  host: 'localhost',
  port: Option.none(),
  pathname,
  search: Option.none(),
  hash: Option.none(),
})

describe('starting a run', () => {
  test('Start asks the server, then opens the run and follows it', () => {
    story(
      update,
      given(readyModel),
      message(Message.ClickedStart()),
      model(next => expect(next.launch._tag).toBe('Starting')),
      Command.resolve(StartRun, Message.SucceededStartRun({ run: runningRun })),
      model(next => {
        expect(next.launch._tag).toBe('Idle')
        expect(next.runs[runningRun.id]?._tag).toBe('Loaded')
      }),
      Command.expectHas(NavigateInternal),
      Command.resolve(NavigateInternal, Message.CompletedNavigate()),
      Command.resolve(
        FetchHistory,
        Message.SucceededFetchHistory({ runs: [] }),
      ),
    )
  })

  test('an invalid rate keeps the run from starting', () => {
    story(
      update,
      given(readyModel),
      message(Message.UpdatedLoadInput({ value: 'lots' })),
      message(Message.ClickedStart()),
      model(next => expect(next.launch._tag).toBe('Idle')),
    )
  })

  test('the typed rate goes to the server', () => {
    story(
      update,
      given(readyModel),
      message(Message.UpdatedLoadInput({ value: '250' })),
      // The planned line on the timeline follows the typed rate.
      Command.resolve(SyncTimeline, Message.CompletedSyncTimeline()),
      message(Message.ClickedStart()),
      Command.expectHas(StartRun),
      Command.resolve(StartRun, Message.FailedStartRun({ error: 'busy' })),
      model(next => {
        expect(next.launch._tag).toBe('Idle')
        expect(next.maybeActionError).toEqual(Option.some('busy'))
      }),
    )
  })
})

describe('a live run', () => {
  const live = modelWithRuns(AppRoute.Run({ runId: runningRun.id }), [
    [runningRun, []],
  ])

  test('seconds arrive, and the timeline gets each one', () => {
    story(
      update,
      given(live),
      message(
        Message.ReceivedSecond({
          runId: runningRun.id,
          second: makeSecond(0, { ms: 40 }),
        }),
      ),
      Command.resolve(SyncTimeline, Message.CompletedSyncTimeline()),
      // A replay after reconnecting resends a Second: it replaces, not adds.
      message(
        Message.ReceivedSecond({
          runId: runningRun.id,
          second: makeSecond(0, { ms: 45 }),
        }),
      ),
      Command.resolve(SyncTimeline, Message.CompletedSyncTimeline()),
      model(next => {
        const data = next.runs[runningRun.id]
        expect(data?._tag === 'Loaded' && data.seconds).toHaveLength(1)
      }),
    )
  })

  test('Stop asks the server and marks the run as stopping', () => {
    story(
      update,
      given(live),
      message(Message.ClickedStop()),
      Command.expectExact(StopRun),
      model(next => {
        const data = next.runs[runningRun.id]
        expect(data?._tag === 'Loaded' && data.stop).toBe('Requested')
      }),
      Command.resolve(StopRun, Message.SucceededStopRun({ run: finishedRun })),
      Command.resolve(SyncTimeline, Message.CompletedSyncTimeline()),
      model(next => {
        const data = next.runs[runningRun.id]
        expect(data?._tag === 'Loaded' && data.run.status).toBe('finished')
      }),
    )
  })
})

describe('steering a live run', () => {
  const live = modelWithRuns(AppRoute.Run({ runId: runningRun.id }), [
    [runningRun, []],
  ])
  const journalOf = (next: typeof live) => {
    const data = next.runs[runningRun.id]
    return data?._tag === 'Loaded' ? data.run.journal : []
  }

  test('Pause sends the control; its entry joins the journal', () => {
    const entry = { seq: 1, at: 0.4, control: { _tag: 'Pause' } } as const
    story(
      update,
      given(live),
      message(Message.ClickedPause()),
      Command.expectExact(SendControl),
      model(next => expect(next.controlRequest).toBe('Sending')),
      Command.resolve(
        SendControl,
        Message.SucceededSendControl({ runId: runningRun.id, entry }),
      ),
      Command.resolve(SyncTimeline, Message.CompletedSyncTimeline()),
      model(next => {
        expect(next.controlRequest).toBe('Idle')
        expect(journalOf(next)).toEqual([entry])
      }),
    )
  })

  test('a spike is staged on the timeline, then applied', () => {
    story(
      update,
      given(live),
      message(Message.ClickedAddSpike()),
      // The staged spike is drawn ahead of the playhead.
      Command.resolve(SyncTimeline, Message.CompletedSyncTimeline()),
      message(Message.UpdatedSpikeFactor({ value: '3' })),
      Command.resolve(SyncTimeline, Message.CompletedSyncTimeline()),
      message(Message.SubmittedChange()),
      Command.expectExact(SendControl),
      Command.resolve(
        SendControl,
        Message.FailedSendControl({ error: 'Nothing is running.' }),
      ),
      // A refused change stays open so it can be fixed.
      model(next => {
        expect(next.steerForm).toEqual({
          _tag: 'Spike',
          factor: '3',
          duration: '30',
        })
        expect(next.maybeActionError).toEqual(
          Option.some('Nothing is running.'),
        )
      }),
    )
  })

  test('a half-typed rate is not sent', () => {
    story(
      update,
      given(live),
      message(Message.ClickedChangeRate()),
      Command.resolve(SyncTimeline, Message.CompletedSyncTimeline()),
      // Nothing sensible to draw any more: the staged line goes away.
      message(Message.UpdatedRateTarget({ value: 'fast' })),
      Command.resolve(SyncTimeline, Message.CompletedSyncTimeline()),
      message(Message.SubmittedChange()),
      Command.expectNone(),
      model(next => expect(next.controlRequest).toBe('Idle')),
    )
  })
})

describe('the theme', () => {
  test('choosing Dark switches the page and remembers it', () => {
    story(
      update,
      given(readyModel),
      message(Message.SelectedTheme({ theme: 'Dark' })),
      model(next => expect(next.theme).toBe('Dark')),
      Command.expectExact(ApplyTheme),
      Command.resolve(ApplyTheme, Message.CompletedApplyTheme()),
    )
  })
})

describe('moving between pages', () => {
  test('opening a run that is not loaded yet loads it', () => {
    story(
      update,
      given(readyModel),
      message(Message.ChangedUrl({ url: urlOf(runRouter({ runId: 'abc' })) })),
      model(next => {
        expect(next.route).toEqual(AppRoute.Run({ runId: 'abc' }))
        expect(next.runs['abc']?._tag).toBe('Loading')
      }),
      Command.resolve(
        LoadRun,
        Message.FailedLoadRun({ runId: 'abc', error: 'gone' }),
      ),
      model(next => expect(next.runs['abc']?._tag).toBe('Failed')),
    )
  })

  test('an endpoint of the same run keeps the selected range', () => {
    const onRun = modelWithRuns(AppRoute.Run({ runId: finishedRun.id }), [
      [finishedRun, [makeSecond(0, { ms: 40 }), makeSecond(1, { ms: 60 })]],
    ])
    story(
      update,
      given(onRun),
      message(Message.SelectedRange({ from: 0, to: 1 })),
      Command.resolve(SyncTimeline, Message.CompletedSyncTimeline()),
      message(
        Message.ChangedUrl({
          url: urlOf(`/runs/${finishedRun.id}/endpoints/POST%20%2Fcheckout`),
        }),
      ),
      Command.resolve(SyncTimeline, Message.CompletedSyncTimeline()),
      model(next => {
        expect(next.route).toEqual(
          AppRoute.RunEndpoint({
            runId: finishedRun.id,
            endpoint: 'POST /checkout',
          }),
        )
        expect(next.span._tag).toBe('Range')
      }),
    )
  })

  test('Compare opens the newest finished run against the one before', () => {
    story(
      update,
      given(
        modelWithRuns(AppRoute.PickCompare(), [
          [finishedRun, []],
          [baselineRun, []],
        ]),
      ),
      message(Message.ClickedCompare()),
      Command.expectExact(NavigateInternal),
      Command.resolve(NavigateInternal, Message.CompletedNavigate()),
    )
  })
})
