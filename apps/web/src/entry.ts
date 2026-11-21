/**
 * Boots the app in the browser. Everything else is pure definitions, so
 * tests can import them without starting a runtime.
 */
import { Runtime } from 'foldkit'

import { init } from './init.ts'
import { Message } from './message.ts'
import { Model } from './model.ts'
import { subscriptions } from './subscriptions.ts'
import { update } from './update.ts'
import { view } from './view/index.ts'

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  subscriptions,
  container: document.getElementById('root'),
  devTools: {
    Message,
    // One of each arrives every second while a run is live. Keeping them
    // out of DevTools history keeps time travel useful.
    excludeFromHistory: [
      'ReceivedSecond',
      'ReceivedRunUpdate',
      'CompletedSyncTimeline',
    ],
  },
})

Runtime.run(application)
