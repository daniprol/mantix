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
  inside,
  role,
  scene,
  text,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import { MountTimeline } from './charts/timeline.ts'
import { SyncTimeline } from './commands.ts'
import { Span } from './domain/span.ts'
import {
  baselineRun,
  finishedRun,
  makeSecond,
  modelWithRuns,
  readyModel,
  runningRun,
} from './fixture.ts'
import { Message } from './message.ts'
import { AppRoute } from './route.ts'
import { update } from './update.ts'
import { view } from './view/index.ts'

/** The timeline mounts, then update hands it its data. */
const acknowledgeTimeline = [
  Mount.resolve(MountTimeline, Message.SucceededMountTimeline()),
  Command.resolve(SyncTimeline, Message.CompletedSyncTimeline()),
] as const

const seconds = [
  makeSecond(0, { ms: 40 }),
  makeSecond(1, { ms: 60, failed: 4 }),
  makeSecond(2, { ms: 30, endpoint: 'GET /products/:sku' }),
]

describe('New run', () => {
  test('shows the load inputs, the checks and one primary action', () => {
    scene(
      { update, view },
      given(readyModel),
      ...acknowledgeTimeline,
      expect(role('textbox', { name: 'Rate' })).toExist(),
      expect(role('textbox', { name: 'Duration' })).toExist(),
      expect(text('p99 < 250ms')).toExist(),
      expect(role('button', { name: /Start run/ })).toExist(),
    )
  })

  test('the sidebar names every section; Live is not a link with nothing running', () => {
    scene(
      { update, view },
      given(readyModel),
      ...acknowledgeTimeline,
      expect(role('link', { name: 'New run' })).toHaveAttr(
        'aria-current',
        'page',
      ),
      expect(role('link', { name: 'Runs' })).toExist(),
      expect(role('link', { name: 'Compare' })).toExist(),
      expect(role('link', { name: /Live/ })).toBeAbsent(),
    )
  })

  test('the theme switch shows the current choice', () => {
    scene(
      { update, view },
      given({ ...readyModel, theme: 'Dark' }),
      ...acknowledgeTimeline,
      inside(
        role('group', { name: 'Theme' }),
        expect(role('button', { name: 'Dark' })).toHaveAttr(
          'aria-pressed',
          'true',
        ),
        expect(role('button', { name: 'System' })).toHaveAttr(
          'aria-pressed',
          'false',
        ),
      ),
    )
  })
})

describe('a finished run', () => {
  const model = modelWithRuns(AppRoute.Run({ runId: finishedRun.id }), [
    [finishedRun, seconds],
    [baselineRun, seconds],
  ])

  test('shows its status, checks, figures and endpoints', () => {
    scene(
      { update, view },
      given(model),
      ...acknowledgeTimeline,
      expect(text('1 of 2 checks passed', { exact: false })).toExist(),
      expect(role('table', { name: 'Checks' })).toContainText('p99 < 250ms'),
      expect(text('p95 latency')).toExist(),
      expect(role('region', { name: 'Endpoints' })).toContainText(
        'All requests',
      ),
      expect(role('link', { name: /\/checkout/ })).toHaveAttr(
        'href',
        `/runs/${finishedRun.id}/endpoints/POST%20%2Fcheckout`,
      ),
      inside(
        role('banner'),
        expect(role('link', { name: 'Compare' })).toHaveAttr(
          'href',
          `/compare/${finishedRun.id}/${baselineRun.id}`,
        ),
      ),
    )
  })

  test('a range dragged on the timeline becomes the span', () => {
    scene(
      { update, view },
      given(model),
      ...acknowledgeTimeline,
      expect(role('region', { name: 'Endpoints' })).toContainText('Whole run'),
    )
    scene(
      { update, view },
      given({ ...model, span: Span.Range({ from: 0, to: 2 }) }),
      ...acknowledgeTimeline,
      expect(role('region', { name: 'Endpoints' })).toContainText(
        '00:00 – 00:02',
      ),
      expect(role('button', { name: '00:00 – 00:02' })).toHaveAttr(
        'aria-pressed',
        'true',
      ),
    )
  })
})

describe('a live run', () => {
  test('offers Stop and the Now span, and Live links to it', () => {
    scene(
      { update, view },
      given(
        modelWithRuns(AppRoute.Run({ runId: runningRun.id }), [
          [runningRun, seconds],
        ]),
      ),
      ...acknowledgeTimeline,
      expect(role('button', { name: 'Stop' })).toExist(),
      expect(role('button', { name: 'Now' })).toHaveAttr(
        'aria-pressed',
        'true',
      ),
      expect(role('link', { name: /Live/ })).toHaveAttr('aria-current', 'page'),
      click(role('button', { name: 'Whole run' })),
      expect(role('button', { name: 'Whole run' })).toHaveAttr(
        'aria-pressed',
        'true',
      ),
    )
  })
})

describe('comparing two runs', () => {
  test('the list shows both p95s and the change', () => {
    scene(
      { update, view },
      given(
        modelWithRuns(
          AppRoute.Compare({
            runId: finishedRun.id,
            baselineId: baselineRun.id,
          }),
          [
            [finishedRun, seconds],
            [baselineRun, seconds],
          ],
        ),
      ),
      ...acknowledgeTimeline,
      expect(role('region', { name: 'Endpoints' })).toContainText('baseline'),
      expect(role('region', { name: 'Endpoints' })).toContainText('this run'),
      expect(role('region', { name: 'Endpoints' })).toContainText('same'),
      expect(role('link', { name: 'Change runs' })).toExist(),
    )
  })
})

describe('an endpoint', () => {
  test('has a back arrow and a breadcrumb to its run, and its failures', () => {
    scene(
      { update, view },
      given(
        modelWithRuns(
          AppRoute.RunEndpoint({
            runId: finishedRun.id,
            endpoint: 'POST /checkout',
          }),
          [[finishedRun, seconds]],
        ),
      ),
      ...acknowledgeTimeline,
      expect(role('link', { name: 'Back' })).toHaveAttr(
        'href',
        `/runs/${finishedRun.id}`,
      ),
      expect(role('navigation', { name: 'Breadcrumb' })).toContainText(
        '/checkout',
      ),
      expect(role('region', { name: 'Failures' })).toContainText(
        '503 Service Unavailable',
      ),
      expect(role('region', { name: 'Status codes' })).toContainText('503'),
    )
  })

  test('in a comparison, the back arrow returns to the comparison', () => {
    scene(
      { update, view },
      given(
        modelWithRuns(
          AppRoute.CompareEndpoint({
            runId: finishedRun.id,
            baselineId: baselineRun.id,
            endpoint: 'POST /checkout',
          }),
          [
            [finishedRun, seconds],
            [baselineRun, seconds],
          ],
        ),
      ),
      ...acknowledgeTimeline,
      expect(role('link', { name: 'Back' })).toHaveAttr(
        'href',
        `/compare/${finishedRun.id}/${baselineRun.id}`,
      ),
      expect(role('region', { name: 'Percentiles' })).toContainText('baseline'),
    )
  })
})
