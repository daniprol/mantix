/**
 * UPDATE: given the Model and a Message, return the next Model and any
 * Commands to run.
 *
 * Foldkit idea: update is a pure function. It never calls the server or
 * touches the page; it only describes what should happen. That is why the
 * Story tests can check the whole start → run → verdict flow without a
 * browser.
 */
import { Array, Option, Record } from 'effect'
import type { Update } from 'foldkit'
import { UrlRequest } from 'foldkit/navigation'
import { modifyFields } from 'foldkit/struct'
import { toString as urlToString } from 'foldkit/url'

import type { RunInfo, Second } from '@mantix/api'

import {
  analysisOf,
  comparePair,
  loadedRun,
  timelineInput,
} from './analysis.ts'
import type { TimelineInput } from './charts/store.ts'
import {
  FetchHistory,
  LoadExternal,
  LoadRun,
  LoadTest,
  NavigateInternal,
  StartRun,
  StopRun,
  SyncTimeline,
} from './commands.ts'
import { isValid, readLoadForm } from './domain/adjust.ts'
import { Span } from './domain/span.ts'
import { isOver } from './domain/stats.ts'
import { Message } from './message.ts'
import {
  Feed,
  History,
  Launch,
  type LoadedRun,
  type Model,
  RunData,
  TestState,
} from './model.ts'
import {
  AppRoute,
  compareRouter,
  runIdsOf,
  runRouter,
  urlToAppRoute,
} from './route.ts'

type UpdateReturn = Update.Return<Model, Message>

// RUNS

/** Put a Second in its place by `t`. A replay after reconnecting resends some. */
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

/** A run with its Seconds so far. A live one follows its stream. */
const loaded = (run: RunInfo, seconds: ReadonlyArray<Second>): RunData =>
  RunData.Loaded({
    run,
    seconds,
    feed: isOver(run) ? Feed.Ended() : Feed.Following(),
    connection: 0,
    stop: 'NotRequested',
  })

/** Change a loaded run, if the dashboard has it. */
const modifyRun = (
  model: Model,
  runId: string,
  change: (run: LoadedRun) => LoadedRun,
): Model =>
  Option.match(loadedRun(model, runId), {
    onNone: () => model,
    onSome: run =>
      modifyFields(model, {
        runs: runs => Record.set(runs, runId, change(run)),
      }),
  })

/** Start loading every run in `runIds` that the dashboard doesn't have yet. */
export const loadRuns = (
  model: Model,
  runIds: ReadonlyArray<string>,
): UpdateReturn => {
  const missing = Array.dedupe(runIds).filter(id => !Record.has(model.runs, id))
  return {
    model: modifyFields(model, {
      runs: runs =>
        missing.reduce(
          (all, id) => Record.set(all, id, RunData.Loading()),
          runs,
        ),
    }),
    commands: missing.map(runId => LoadRun({ runId })),
  }
}

/** The live run on screen, if there is one. */
const liveRunOnScreen = (model: Model): Option.Option<LoadedRun> =>
  Option.flatMap(analysisOf(model), ({ current }) =>
    isOver(current.run) ? Option.none() : Option.some(current),
  )

// STARTING

const start = (model: Model): UpdateReturn => {
  if (model.test._tag !== 'Loaded' || model.launch._tag === 'Starting') {
    return { model }
  }
  const read = readLoadForm(model.loadForm, model.test.test)
  if (!isValid(read)) {
    return { model }
  }
  return {
    model: modifyFields(model, {
      launch: () => Launch.Starting(),
      maybeActionError: () => Option.none(),
    }),
    commands: [StartRun({ overrides: read.overrides })],
  }
}

// ROUTES

const changeRoute = (model: Model, route: AppRoute): UpdateReturn => {
  const sameRuns = runIdsOf(model.route).join(' ') === runIdsOf(route).join(' ')
  const moved = modifyFields(model, {
    route: () => route,
    // A new run (or pair of runs) starts with "Now"; drilling into one of
    // its endpoints and back keeps what was selected.
    span: span => (sameRuns ? span : Span.Now()),
  })
  return loadRuns(moved, runIdsOf(route))
}

// THE TIMELINE

const sameRange = (
  a: TimelineInput['maybeRange'],
  b: TimelineInput['maybeRange'],
) =>
  Option.getOrNull(a)?.from === Option.getOrNull(b)?.from &&
  Option.getOrNull(a)?.to === Option.getOrNull(b)?.to

/** Would the timeline draw anything different? Cheap: arrays by reference. */
const sameInput = (a: TimelineInput, b: TimelineInput): boolean =>
  a.current === b.current &&
  Option.getOrNull(a.maybeBaseline) === Option.getOrNull(b.maybeBaseline) &&
  a.duration === b.duration &&
  a.topTrack === b.topTrack &&
  a.isRate === b.isRate &&
  a.isLive === b.isLive &&
  JSON.stringify(a.plan) === JSON.stringify(b.plan) &&
  JSON.stringify(Option.getOrNull(a.maybeLimit)) ===
    JSON.stringify(Option.getOrNull(b.maybeLimit)) &&
  sameRange(a.maybeRange, b.maybeRange)

/**
 * The timeline follows the Model: whenever what it should draw changes,
 * hand it the new data. Doing it here, once, means no Message handler can
 * forget to.
 */
const syncTimeline = (before: Model, result: UpdateReturn): UpdateReturn => {
  const next = timelineInput(result.model)
  const previous = timelineInput(before)
  const isSame = Option.match(Option.all([previous, next]), {
    onNone: () => true,
    onSome: ([a, b]) => sameInput(a, b),
  })
  if (isSame || Option.isNone(next)) {
    return result
  }
  return {
    model: result.model,
    commands: [...(result.commands ?? []), SyncTimeline({ input: next.value })],
  }
}

// UPDATE

const step = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedLink: ({ request }) =>
      UrlRequest.match<UpdateReturn>(request, {
        Internal: ({ url }) => ({
          model,
          commands: [NavigateInternal({ url: urlToString(url) })],
        }),
        External: ({ href }) => ({
          model,
          commands: [LoadExternal({ href })],
        }),
      }),

    ChangedUrl: ({ url }) => changeRoute(model, urlToAppRoute(url)),

    CompletedNavigate: () => ({ model }),

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
      commands: [LoadTest(), FetchHistory()],
    }),

    // A run still going (say, the page was reloaded) is loaded straight
    // away, so the sidebar can show its clock.
    SucceededFetchHistory: ({ runs }) =>
      loadRuns(
        modifyFields(model, { history: () => History.Loaded({ runs }) }),
        runs.filter(run => !isOver(run)).map(run => run.id),
      ),

    FailedFetchHistory: ({ error }) => ({
      model: modifyFields(model, { history: () => History.Failed({ error }) }),
    }),

    SucceededLoadRun: ({ run, seconds }) => ({
      model: modifyFields(model, {
        runs: runs => Record.set(runs, run.id, loaded(run, seconds)),
      }),
    }),

    FailedLoadRun: ({ runId, error }) => ({
      model: modifyFields(model, {
        runs: runs => Record.set(runs, runId, RunData.Failed({ error })),
      }),
    }),

    ClickedStart: () => start(model),

    // Enter starts a run, but only from the New run page.
    PressedEnter: () =>
      model.route._tag === 'NewRun' ? start(model) : { model },

    SucceededStartRun: ({ run }) => ({
      model: modifyFields(model, {
        runs: runs => Record.set(runs, run.id, loaded(run, [])),
        launch: () => Launch.Idle(),
      }),
      commands: [
        NavigateInternal({ url: runRouter({ runId: run.id }) }),
        FetchHistory(),
      ],
    }),

    FailedStartRun: ({ error }) => ({
      model: modifyFields(model, {
        launch: () => Launch.Idle(),
        maybeActionError: () => Option.some(error),
      }),
    }),

    ClickedStop: () =>
      Option.match(liveRunOnScreen(model), {
        onNone: () => ({ model }),
        onSome: live =>
          live.stop === 'Requested'
            ? { model }
            : {
                model: modifyRun(model, live.run.id, run =>
                  modifyFields(run, { stop: () => 'Requested' }),
                ),
                commands: [StopRun({ runId: live.run.id })],
              },
      }),

    SucceededStopRun: ({ run }) => ({
      model: modifyRun(model, run.id, live =>
        modifyFields(live, { run: () => run }),
      ),
    }),

    FailedStopRun: ({ error }) => {
      const stopped = Option.match(liveRunOnScreen(model), {
        onNone: () => model,
        onSome: live =>
          modifyRun(model, live.run.id, run =>
            modifyFields(run, { stop: () => 'NotRequested' }),
          ),
      })
      return {
        model: modifyFields(stopped, {
          maybeActionError: () => Option.some(error),
        }),
      }
    },

    ClickedDismissError: () => ({
      model: modifyFields(model, { maybeActionError: () => Option.none() }),
    }),

    UpdatedLoadInput: ({ value }) => ({
      model: modifyFields(model, {
        loadForm: form => modifyFields(form, { load: () => value }),
      }),
    }),

    UpdatedDurationInput: ({ value }) => ({
      model: modifyFields(model, {
        loadForm: form => modifyFields(form, { duration: () => value }),
      }),
    }),

    ReceivedSecond: ({ runId, second }) => ({
      model: modifyRun(model, runId, run =>
        modifyFields(run, {
          seconds: seconds => upsertSecond(seconds, second),
        }),
      ),
    }),

    ReceivedRunUpdate: ({ run }) => {
      const wasLive = Option.exists(
        loadedRun(model, run.id),
        known => !isOver(known.run),
      )
      return {
        model: modifyRun(model, run.id, known =>
          modifyFields(known, { run: () => run }),
        ),
        commands: wasLive && isOver(run) ? [FetchHistory()] : [],
      }
    },

    CompletedFollowRun: ({ runId }) => ({
      model: modifyRun(model, runId, run =>
        modifyFields(run, {
          feed: () =>
            isOver(run.run)
              ? Feed.Ended()
              : Feed.Lost({ error: 'The live stream stopped early.' }),
        }),
      ),
    }),

    FailedFollowRun: ({ runId, error }) => ({
      model: modifyRun(model, runId, run =>
        modifyFields(run, { feed: () => Feed.Lost({ error }) }),
      ),
    }),

    ClickedReconnect: () =>
      Option.match(liveRunOnScreen(model), {
        onNone: () => ({ model }),
        onSome: live => ({
          model: modifyRun(model, live.run.id, run =>
            modifyFields(run, {
              feed: () => Feed.Following(),
              connection: connection => connection + 1,
            }),
          ),
        }),
      }),

    ClickedNow: () => ({
      model: modifyFields(model, { span: () => Span.Now() }),
    }),

    ClickedWholeRun: () => ({
      model: modifyFields(model, { span: () => Span.WholeRun() }),
    }),

    SelectedRange: ({ from, to }) => ({
      model: modifyFields(model, { span: () => Span.Range({ from, to }) }),
    }),

    SelectedCompareRun: ({ runId }) => ({
      model: modifyFields(model, {
        comparePick: pick =>
          modifyFields(pick, { maybeRunId: () => Option.some(runId) }),
      }),
    }),

    SelectedCompareBaseline: ({ runId }) => ({
      model: modifyFields(model, {
        comparePick: pick =>
          modifyFields(pick, { maybeBaselineId: () => Option.some(runId) }),
      }),
    }),

    ClickedCompare: () =>
      Option.match(comparePair(model), {
        onNone: () => ({ model }),
        onSome: ([runId, baselineId]) => ({
          model,
          commands: [
            NavigateInternal({ url: compareRouter({ runId, baselineId }) }),
          ],
        }),
      }),

    // The chart just appeared: give it what we have so far.
    SucceededMountTimeline: () => ({
      model,
      commands: Option.match(timelineInput(model), {
        onNone: () => [],
        onSome: input => [SyncTimeline({ input })],
      }),
    }),

    FailedMountTimeline: () => ({ model }),

    CompletedSyncTimeline: () => ({ model }),
  })

export const update = (model: Model, message: Message): UpdateReturn =>
  syncTimeline(model, step(model, message))
