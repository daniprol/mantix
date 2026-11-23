/**
 * Steering a live run from the dashboard: reading the change being typed
 * into a Control, and reading a run's journal back for the screen.
 *
 * The meaning of every control lives in `@mantix/api` (Steering.ts): the
 * engine and the dashboard call the same `steer` and `plannedPath`, so the
 * dotted line ahead of the playhead is exactly what the engine will do.
 */
import { Match, Option } from 'effect'

import {
  type Control,
  type JournalEntry,
  type ScenarioInfo,
  plannedPath,
} from '@mantix/api'

import { SteerForm } from '../model.ts'
import * as Format from './format.ts'
import { parseSpan } from './format.ts'

/** The spike a new "Add spike" form starts with: double, for 30 seconds. */
export const DEFAULT_SPIKE = { factor: '2', duration: '30' } as const

/** True while the run is paused: its last Pause has no Resume yet. */
export const isPaused = (journal: ReadonlyArray<JournalEntry>): boolean => {
  const last = journal.findLast(
    entry => entry.control._tag === 'Pause' || entry.control._tag === 'Resume',
  )
  return last?.control._tag === 'Pause'
}

/**
 * "Now" for steering questions, in whole seconds since the run started.
 * The stream's last Second can lag a control that was just applied, and
 * `plannedPath` must start at or after every entry (or it would read an
 * open pause as one that never ends), so take the later of the two.
 */
export const steerNow = (
  secondsSeen: number,
  journal: ReadonlyArray<JournalEntry>,
): number => Math.ceil(Math.max(secondsSeen, ...journal.map(e => e.at)))

/**
 * When the run will end, in seconds since it started. While paused nobody
 * knows, so this says "if it resumed right now", the same guess the dotted
 * line makes.
 */
export const plannedEnd = (
  plan: ReadonlyArray<ScenarioInfo>,
  journal: ReadonlyArray<JournalEntry>,
  now: number,
  maybeStaged: Option.Option<Control> = Option.none(),
): number =>
  plan.length === 0
    ? now
    : plannedPath(plan, journal, steerNow(now, journal), {
        ...Option.match(maybeStaged, {
          onNone: () => ({}),
          onSome: staged => ({ staged }),
        }),
      }).end

/** A plain number typed by a person, or undefined. */
const parseNumber = (text: string): number | undefined => {
  const trimmed = text.trim()
  const value = Number(trimmed)
  return trimmed === '' || !Number.isFinite(value) ? undefined : value
}

/** "30", "30s", "1m" as seconds; empty or "0" means no ramp. */
const parseRamp = (text: string): number | undefined =>
  text.trim() === '' || parseNumber(text) === 0 ? 0 : parseSpan(text)

/** Each field of the form: is what was typed usable? */
export type FieldCheck = Readonly<{ first: boolean; second: boolean }>

export const checkForm = (form: SteerForm): FieldCheck =>
  SteerForm.match(form, {
    Closed: () => ({ first: true, second: true }),
    Spike: ({ factor, duration }) => {
      const value = parseNumber(factor)
      return {
        first: value !== undefined && value > 0 && value <= 100,
        second: parseSpan(duration) !== undefined,
      }
    },
    Rate: ({ target, over }) => {
      const value = parseNumber(target)
      return {
        first: value !== undefined && value >= 0 && value <= 1e6,
        second: parseRamp(over) !== undefined,
      }
    },
  })

/**
 * The Control the open form describes, once both fields make sense. It is
 * "staged": drawn on the timeline, but not sent until Apply.
 */
export const stagedControl = (form: SteerForm): Option.Option<Control> => {
  const check = checkForm(form)
  if (!check.first || !check.second) {
    return Option.none()
  }
  return SteerForm.match(form, {
    Closed: () => Option.none(),
    Spike: ({ factor, duration }) =>
      Option.some<Control>({
        _tag: 'Spike',
        factor: Number(factor),
        duration: parseSpan(duration) ?? 0,
      }),
    Rate: ({ target, over }) => {
      const ramp = parseRamp(over) ?? 0
      return Option.some<Control>({
        _tag: 'Rate',
        target: Number(target),
        // No ramp means "jump now", which is the server's default.
        ...(ramp > 0 ? { over: ramp } : {}),
      })
    },
  })
}

/** "×2 30 s", "400 /s", "paused": the small label at a change's flag. */
export const controlLabel = (control: Control, isRate: boolean): string =>
  Match.valueTags(control, {
    Spike: ({ factor, duration }) => `×${factor} ${Format.span(duration)}`,
    Rate: ({ target }) =>
      isRate
        ? Format.text(Format.rate(target))
        : `${Format.grouped(target)} VUs`,
    Pause: () => 'paused',
    Resume: () => '',
    Pin: ({ note }) => (note.length > 24 ? `${note.slice(0, 23)}…` : note),
  })
