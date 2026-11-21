/**
 * INIT: the first Model, and the Commands to run at start-up.
 */
import type { Runtime } from 'foldkit'

import { FetchRuns, LoadTest } from './commands.ts'
import type { Message } from './message.ts'
import { type Model, initialModel } from './model.ts'

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: initialModel,
  commands: [LoadTest(), FetchRuns()],
})
