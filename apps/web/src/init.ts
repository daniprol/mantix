/**
 * INIT: the first Model, and the Commands to run at start-up.
 *
 * Foldkit idea: with routing, init receives the URL the page was opened
 * at, so a reload or a shared link lands on the same page. Flags are what
 * the page knows before the app starts (here, the saved theme): entry.ts
 * reads them, so init itself stays pure.
 */
import { Schema } from 'effect'
import type { Runtime } from 'foldkit'
import type { Url } from 'foldkit/url'

import { FetchHistory, LoadTest } from './commands.ts'
import type { Message } from './message.ts'
import { type Model, initialModel } from './model.ts'
import { runIdsOf, urlToAppRoute } from './route.ts'
import { Theme } from './theme.ts'
import { loadRuns } from './update.ts'

export const Flags = Schema.Struct({ theme: Theme })
export type Flags = typeof Flags.Type

export const init: Runtime.RoutingApplicationInit<Model, Message, Flags> = (
  flags: Flags,
  url: Url,
) => {
  const route = urlToAppRoute(url)
  const withRuns = loadRuns(initialModel(route, flags.theme), runIdsOf(route))
  return {
    model: withRuns.model,
    commands: [LoadTest(), FetchHistory(), ...(withRuns.commands ?? [])],
  }
}
