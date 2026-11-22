/**
 * UPDATE: given the Model and a Message, return the next Model and any
 * Commands to run.
 *
 * Foldkit idea: update is a pure function. It never calls the server or
 * touches the page; it only describes what should happen. That is why the
 * Story tests can check the whole start → run → verdict flow without a
 * browser.
 */
import { Array, Option } from 'effect'
import type { Command, Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import type { RunInfo, Second } from '@mantix/api'

import {
  FetchRuns,
  LoadTest,
  StartRun,
  StopRun,
  SyncTimeline,
} from './commands.ts'
import { isValid, readAdjust } from './domain/adjust.ts'
import { isOver } from './domain/stats.ts'
import { Message } from './message.ts'
import { Feed, type Model, RunState, TestState } from './model.ts'

type UpdateReturn = Update.Return<Model, Message>

/** Put a Second in its place by `t`. A replay after reconnecting may resend some. */
const upsertSecond = (
  seconds: ReadonlyArray<Second>,
  second: Second,
): ReadonlyArray<Second> => {
  const last = Array.last(seconds)
  if (Option.isNone(last) || second.t > last.value.t) {
    return Array.append(seconds, second)
  }
  return Array.some(seconds, existing => existing.t === second.t)
    ? Array.map(seconds, existing =>
        existing.t === second.t ? second : existing,
      )
    : Array.sort(Array.append(seconds, second), (a: Second, b: Second) =>
        a.t < b.t ? -1 : a.t > b.t ? 1 : 0,
      )
}

/** Watch a run from its first second, following its live stream. */
const watch = (run: RunInfo): RunState =>
  RunState.Watching({
    run,
    seconds: [],
    feed: Feed.Following(),
    connection: 0,
    stop: 'NotRequested',
  })

const isStartable = (model: Model): boolean =>
  model.test._tag === 'Loaded' &&
  RunState.match(model.runState, {
    NoRun: () => true,
    Starting: () => false,
    Watching: ({ run }) => isOver(run),
  })

const start = (model: Model): UpdateReturn => {
  if (model.test._tag !== 'Loaded' || !isStartable(model)) {
    return { model }
  }
  const read = readAdjust(model.adjust, model.test.test)
  if (!isValid(read)) {
    return {
      model: modifyFields(model, {
        adjust: adjust => modifyFields(adjust, { isOpen: () => true }),
      }),
    }
  }
  return {
    model: modifyFields(model, {
      runState: () => RunState.Starting(),
      maybeActionError: () => Option.none(),
    }),
    commands: [StartRun({ overrides: read.overrides })],
  }
}

/** Apply a change to the run on screen, if there is one. */
const withWatching = (
  model: Model,
  f: (watching: typeof RunState.Watching.Type) => Readonly<{
    watching: typeof RunState.Watching.Type
    commands?: ReadonlyArray<Command.Command<Message>>
  }>,
): UpdateReturn => {
  if (model.runState._tag !== 'Watching') {
    return { model }
  }
  const next = f(model.runState)
  return {
    model: modifyFields(model, { runState: () => next.watching }),
    ...(next.commands === undefined ? {} : { commands: next.commands }),
  }
}

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    SucceededLoadTest: ({ test }) => ({
      model: modifyFields(model, { test: () => TestState.Loaded({ test }) }),
    }),

    FailedLoadTest: ({ error }) => ({
      model: modifyFields(model, {
        test: () => TestState.Unreachable({ error }),
      }),
    }),

    ClickedRetryConnect: () => ({
      model: modifyFields(model, { test: () => TestState.Connecting() }),
      commands: [LoadTest(), FetchRuns()],
    }),

    ClickedStart: () => start(model),

    // Enter starts a run, but only from the Ready screen.
    PressedEnter: () =>
      model.runState._tag === 'NoRun' ? start(model) : { model },

    SucceededStartRun: ({ run }) => ({
      model: modifyFields(model, {
        runState: () => watch(run),
        window: () => 'Recent',
        maybeExpandedEndpoint: () => Option.none(),
      }),
      commands: [SyncTimeline({ run, seconds: [] })],
    }),

    FailedStartRun: ({ error }) => ({
      model: modifyFields(model, {
        runState: () => RunState.NoRun(),
        maybeActionError: () => Option.some(error),
      }),
    }),

    ClickedStop: () =>
      withWatching(model, watching =>
        isOver(watching.run) || watching.stop === 'Requested'
          ? { watching }
          : {
              watching: modifyFields(watching, { stop: () => 'Requested' }),
              commands: [StopRun({ runId: watching.run.id })],
            },
      ),

    SucceededStopRun: ({ run }) =>
      withWatching(model, watching => {
        const next = modifyFields(watching, { run: () => run })
        return {
          watching: next,
          commands: [SyncTimeline({ run, seconds: next.seconds })],
        }
      }),

    FailedStopRun: ({ error }) => {
      const stopped = withWatching(model, watching => ({
        watching: modifyFields(watching, { stop: () => 'NotRequested' }),
      }))
      return {
        model: modifyFields(stopped.model, {
          maybeActionError: () => Option.some(error),
        }),
      }
    },

    ClickedNewRun: () => ({
      model: modifyFields(model, {
        runState: () => RunState.NoRun(),
        maybeActionError: () => Option.none(),
      }),
    }),

    ClickedDismissError: () => ({
      model: modifyFields(model, { maybeActionError: () => Option.none() }),
    }),

    ReceivedSecond: ({ second }) =>
      withWatching(model, watching => {
        const seconds = upsertSecond(watching.seconds, second)
        return {
          watching: modifyFields(watching, { seconds: () => seconds }),
          commands: [SyncTimeline({ run: watching.run, seconds })],
        }
      }),

    ReceivedRunUpdate: ({ run }) =>
      withWatching(model, watching => {
        const justEnded = !isOver(watching.run) && isOver(run)
        return {
          watching: modifyFields(watching, { run: () => run }),
          commands: [
            SyncTimeline({ run, seconds: watching.seconds }),
            ...(justEnded ? [FetchRuns()] : []),
          ],
        }
      }),

    CompletedFollowRun: () =>
      withWatching(model, watching => ({
        watching: modifyFields(watching, {
          feed: () =>
            isOver(watching.run)
              ? Feed.Ended()
              : Feed.Lost({ error: 'The live stream stopped early.' }),
        }),
      })),

    FailedFollowRun: ({ error }) =>
      withWatching(model, watching => ({
        watching: modifyFields(watching, { feed: () => Feed.Lost({ error }) }),
      })),

    ClickedReconnect: () =>
      withWatching(model, watching => ({
        watching: modifyFields(watching, {
          feed: () => Feed.Following(),
          connection: connection => connection + 1,
        }),
      })),

    ClickedAdjustLoad: () => ({
      model: modifyFields(model, {
        adjust: adjust => modifyFields(adjust, { isOpen: isOpen => !isOpen }),
      }),
    }),

    UpdatedLoadInput: ({ value }) => ({
      model: modifyFields(model, {
        adjust: adjust => modifyFields(adjust, { load: () => value }),
      }),
    }),

    UpdatedDurationInput: ({ value }) => ({
      model: modifyFields(model, {
        adjust: adjust => modifyFields(adjust, { duration: () => value }),
      }),
    }),

    ClickedUseTestPlan: () => ({
      model: modifyFields(model, {
        adjust: adjust =>
          modifyFields(adjust, { load: () => '', duration: () => '' }),
      }),
    }),

    SelectedWindow: ({ window }) => ({
      model: modifyFields(model, { window: () => window }),
    }),

    ClickedEndpoint: ({ endpoint }) => ({
      model: modifyFields(model, {
        maybeExpandedEndpoint: current =>
          Option.contains(current, endpoint)
            ? Option.none()
            : Option.some(endpoint),
      }),
    }),

    // The chart just appeared: give it what we have so far.
    SucceededMountTimeline: () =>
      model.runState._tag === 'Watching'
        ? {
            model,
            commands: [
              SyncTimeline({
                run: model.runState.run,
                seconds: model.runState.seconds,
              }),
            ],
          }
        : { model },

    FailedMountTimeline: () => ({ model }),

    CompletedSyncTimeline: () => ({ model }),

    // If a run is already going (say, the page was reloaded), show it.
    SucceededFetchRuns: ({ runs }) =>
      Option.match(
        model.runState._tag === 'NoRun'
          ? Array.findFirst(runs, run => !isOver(run))
          : Option.none(),
        {
          onNone: () => ({
            model: modifyFields(model, { pastRuns: () => runs }),
          }),
          onSome: active => ({
            model: modifyFields(model, {
              pastRuns: () => runs,
              runState: () => watch(active),
            }),
          }),
        },
      ),

    // Previous runs are a nice extra; if the list fails, we just don't show it.
    FailedFetchRuns: () => ({ model }),

    ClickedPastRun: ({ runId }) =>
      Option.match(
        Array.findFirst(model.pastRuns, run => run.id === runId),
        {
          onNone: () => ({ model }),
          onSome: run => ({
            model: modifyFields(model, {
              runState: () => watch(run),
              maybeExpandedEndpoint: () => Option.none(),
            }),
          }),
        },
      ),
  })
