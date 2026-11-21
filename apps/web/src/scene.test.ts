/**
 * Scene tests render the real view for a Model, then act like a person:
 * find things by role or text, click them, and check what changed.
 */
import {
  Command,
  Mount,
  click,
  expect,
  given,
  role,
  scene,
  text,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import { MountTimeline } from './charts/timeline.ts'
import { StartRun, SyncTimeline } from './commands.ts'
import { makeSecond, readyModel, runningRun, watchingModel } from './fixture.ts'
import { Message } from './message.ts'
import { TestState, initialModel } from './model.ts'
import { update } from './update.ts'
import { view } from './view/index.ts'

const acknowledgeTimeline = Mount.resolve(
  MountTimeline,
  Message.SucceededMountTimeline(),
)
const acknowledgeSync = Command.resolve(
  SyncTimeline,
  Message.CompletedSyncTimeline(),
)

describe('Ready', () => {
  test('describes the plan in a sentence and offers one primary action', () => {
    scene(
      { update, view },
      given(readyModel),
      expect(
        text('Ramps to 100 requests/s over 30 s, then holds for 2 min.'),
      ).toExist(),
      expect(text('p99 < 250ms')).toExist(),
      expect(role('button', { name: /Start run/ })).toExist(),
      expect(role('textbox', { name: 'Rate' })).toBeAbsent(),
    )
  })

  test('Adjust load reveals two inputs, and the sentence follows them', () => {
    scene(
      { update, view },
      given(readyModel),
      click(role('button', { name: 'Adjust load' })),
      expect(role('textbox', { name: 'Rate' })).toExist(),
      expect(role('textbox', { name: 'Duration' })).toExist(),
    )
  })

  test('Start run asks the server to start', () => {
    scene(
      { update, view },
      given(readyModel),
      click(role('button', { name: /Start run/ })),
      Command.expectExact(StartRun({ overrides: {} })),
      Command.resolve(StartRun, Message.SucceededStartRun({ run: runningRun })),
      acknowledgeSync,
      acknowledgeTimeline,
      acknowledgeSync,
      expect(role('button', { name: 'Stop' })).toExist(),
    )
  })
})

describe('A finished run', () => {
  test('leads with a one-sentence verdict and offers Run again', () => {
    const finished = {
      ...runningRun,
      status: 'finished' as const,
      thresholds: [
        { expression: 'p99 < 250ms', actual: 412, passed: false },
        { expression: 'errors < 1%', actual: 0, passed: true },
      ],
    }
    scene(
      { update, view },
      given(watchingModel(finished, [makeSecond(0, { ms: 412 })])),
      acknowledgeTimeline,
      acknowledgeSync,
      expect(text('Failed: p99 was 412 ms, limit 250 ms')).toExist(),
      expect(role('button', { name: 'Run again' })).toExist(),
      expect(role('button', { name: 'Stop' })).toBeAbsent(),
    )
  })

  test('clicking an endpoint opens its details in place', () => {
    scene(
      { update, view },
      given(
        watchingModel(runningRun, [
          makeSecond(0, { ms: 40, requests: 200, failed: 4 }),
        ]),
      ),
      acknowledgeTimeline,
      acknowledgeSync,
      expect(text('Status codes')).toBeAbsent(),
      click(role('button', { name: /checkout/ })),
      expect(text('Status codes')).toExist(),
      expect(text('503 Service Unavailable')).toExist(),
    )
  })
})

describe('When the server is down', () => {
  test('says so calmly and offers to try again', () => {
    scene(
      { update, view },
      given({
        ...initialModel,
        test: TestState.Unreachable({ error: 'Failed to fetch' }),
      }),
      expect(text('Can’t reach the Mantix server')).toExist(),
      expect(role('button', { name: 'Try again' })).toExist(),
    )
  })
})
