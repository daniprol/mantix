/**
 * The dashboard as a shareable report: the runs come in the page itself,
 * pages live after the "#", and nothing needs the server.
 */
import { Option } from 'effect'
import { Command, Mount, expect, given, role, scene, text } from 'foldkit/scene'
import { describe, expect as expectValue, test } from 'vitest'

import { type ReportDetail, type Second, secondForReport } from '@mantix/api'

import { MountTimeline } from './charts/timeline.ts'
import { SyncTimeline } from './commands.ts'
import { baselineRun, finishedRun, makeSecond } from './fixture.ts'
import { init } from './init.ts'
import { Message } from './message.ts'
import { AppRoute, Mode, routeFromUrl } from './route.ts'
import { update } from './update.ts'
import { view } from './view/index.ts'

const fileUrl = (hash: string) => ({
  protocol: 'file:',
  host: '',
  port: Option.none(),
  pathname: '/home/dani/report.html',
  search: Option.none(),
  hash: hash === '' ? Option.none() : Option.some(hash),
})

/** One failure whose message says more than its group's description. */
const refused = (second: Second): Second => ({
  ...second,
  errorSamples: [
    ...second.errorSamples,
    {
      endpoint: 'POST /checkout',
      kind: 'Transport',
      message: 'connect ECONNREFUSED 10.0.3.7:5432',
    },
  ],
})

const seconds = [
  makeSecond(0, { ms: 40 }),
  refused(makeSecond(1, { ms: 60, failed: 4 })),
]

const reportModel = (hash: string, detail: ReportDetail = 'Summary') =>
  init(
    {
      theme: 'System',
      maybeReport: Option.some({
        version: 1,
        detail,
        runs: [
          {
            run: finishedRun,
            seconds: seconds.map(second => secondForReport(second, detail)),
          },
        ],
      }),
    },
    fileUrl(hash),
  ).model

const acknowledgeTimeline = [
  Mount.resolve(MountTimeline, Message.SucceededMountTimeline()),
  Command.resolve(SyncTimeline, Message.CompletedSyncTimeline()),
] as const

describe('opening a report', () => {
  test('has every run already, and opens on the first', () => {
    const result = init(
      {
        theme: 'System',
        maybeReport: Option.some({
          version: 1,
          detail: 'Summary',
          runs: [{ run: finishedRun, seconds }],
        }),
      },
      fileUrl(''),
    )
    // Nothing to fetch: no server is needed.
    expectValue(result.commands).toBeUndefined()
    expectValue(result.model.route).toEqual(
      AppRoute.Run({ runId: finishedRun.id }),
    )
    expectValue(result.model.runs[finishedRun.id]?._tag).toBe('Loaded')
  })

  test('reads the page from the hash', () => {
    const mode = Mode.Report({ runIds: [finishedRun.id], detail: 'Summary' })
    expectValue(
      routeFromUrl(
        mode,
        fileUrl(`/runs/${finishedRun.id}/endpoints/POST%20%2Fcheckout`),
      ),
    ).toEqual(
      AppRoute.RunEndpoint({
        runId: finishedRun.id,
        endpoint: 'POST /checkout',
      }),
    )
    // A run the file doesn't hold, or a page that needs the server.
    for (const hash of [`/runs/${baselineRun.id}`, '/', '/compare']) {
      expectValue(routeFromUrl(mode, fileUrl(hash))).toEqual(
        AppRoute.Run({ runId: finishedRun.id }),
      )
    }
  })
})

describe('a report on screen', () => {
  test('shows the run, with links after the "#" and nothing to start or steer', () => {
    scene(
      { update, view },
      given(reportModel('')),
      ...acknowledgeTimeline,
      expect(text('1 of 2 checks passed', { exact: false })).toExist(),
      expect(role('link', { name: /\/checkout/ })).toHaveAttr(
        'href',
        `#/runs/${finishedRun.id}/endpoints/POST%20%2Fcheckout`,
      ),
      expect(role('navigation', { name: 'Sections' })).not.toExist(),
      expect(role('button', { name: 'Run again' })).not.toExist(),
      expect(role('link', { name: 'Compare' })).not.toExist(),
    )
  })

  test('a summary report leaves out what the errors said', () => {
    const page = `/runs/${finishedRun.id}/endpoints/POST%20%2Fcheckout`
    scene(
      { update, view },
      given(reportModel(page, 'Summary')),
      ...acknowledgeTimeline,
      expect(role('region', { name: 'Failures' })).toContainText(
        'connect ECONNREFUSED N.N:N',
      ),
      expect(text('connect ECONNREFUSED 10.0.3.7:5432')).not.toExist(),
    )
    scene(
      { update, view },
      given(reportModel(page, 'Full')),
      ...acknowledgeTimeline,
      expect(text('connect ECONNREFUSED 10.0.3.7:5432')).toExist(),
    )
  })
})
