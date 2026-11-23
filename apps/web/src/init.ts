/**
 * INIT: the first Model, and the Commands to run at start-up.
 *
 * Foldkit idea: with routing, init receives the URL the page was opened
 * at, so a reload or a shared link lands on the same page. Flags are what
 * the page knows before the app starts (the saved theme, and in a report
 * file the runs inside it): entry.ts reads them, so init itself stays pure.
 */
import { Option, Schema } from 'effect'
import type { Runtime } from 'foldkit'
import { modifyFields } from 'foldkit/struct'
import type { Url } from 'foldkit/url'

import { type RunInfo, Report, type TestInfo } from '@mantix/api'

import { FetchHistory, LoadTest } from './commands.ts'
import type { Message } from './message.ts'
import { History, type Model, TestState, initialModel } from './model.ts'
import { Mode, routeFromUrl, runIdsOf } from './route.ts'
import { Theme } from './theme.ts'
import { loadRuns, loaded } from './update.ts'

export const Flags = Schema.Struct({
  theme: Theme,
  maybeReport: Schema.Option(Report),
})
export type Flags = typeof Flags.Type

/**
 * A report carries runs, not the test file. The test is described from
 * its first run: only the New run page needs more, and a report has none.
 */
const testOf = (run: RunInfo): TestInfo => ({
  file: run.testName,
  name: run.testName,
  scenarios: run.plan,
  thresholds: run.thresholds.map(threshold => threshold.expression),
  duration: run.duration,
})

/**
 * A report holds everything up front: the test, the runs and their
 * Seconds. So nothing is fetched, and no server is needed.
 */
const reportModel = (
  report: Report,
  url: Url,
  theme: Flags['theme'],
): Model => {
  const [first, ...rest] = report.runs
  const mode = Mode.Report({
    runIds: [first.run.id, ...rest.map(each => each.run.id)],
    detail: report.detail,
  })
  return modifyFields(initialModel(routeFromUrl(mode, url), theme), {
    mode: () => mode,
    test: () => TestState.Loaded({ test: testOf(first.run) }),
    history: () => History.Loaded({ runs: report.runs.map(each => each.run) }),
    runs: () =>
      Object.fromEntries(
        report.runs.map(each => [each.run.id, loaded(each.run, each.seconds)]),
      ),
  })
}

export const init: Runtime.RoutingApplicationInit<Model, Message, Flags> = (
  flags: Flags,
  url: Url,
) =>
  Option.match(flags.maybeReport, {
    onSome: report => ({ model: reportModel(report, url, flags.theme) }),
    onNone: () => {
      const route = routeFromUrl(Mode.Dashboard(), url)
      const withRuns = loadRuns(
        initialModel(route, flags.theme),
        runIdsOf(route),
      )
      return {
        model: withRuns.model,
        commands: [LoadTest(), FetchHistory(), ...(withRuns.commands ?? [])],
      }
    },
  })
