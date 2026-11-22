/**
 * INIT: the first Model, and the Commands to run at start-up.
 *
 * Foldkit idea: with routing, init receives the URL the page was opened
 * at, so a reload or a shared link lands on the same page.
 */
import type { Runtime } from 'foldkit'
import type { Url } from 'foldkit/url'

import { FetchHistory, LoadTest } from './commands.ts'
import type { Message } from './message.ts'
import { type Model, initialModel } from './model.ts'
import { runIdsOf, urlToAppRoute } from './route.ts'
import { loadRuns } from './update.ts'

export const init: Runtime.RoutingApplicationInit<Model, Message> = (
  url: Url,
) => {
  const route = urlToAppRoute(url)
  const withRuns = loadRuns(initialModel(route), runIdsOf(route))
  return {
    model: withRuns.model,
    commands: [LoadTest(), FetchHistory(), ...(withRuns.commands ?? [])],
  }
}
