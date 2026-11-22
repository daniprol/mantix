/**
 * Light, dark, or whatever the system uses.
 *
 * The colours themselves live in styles.css: every token is a CSS
 * `light-dark()` pair, and the page's `color-scheme` picks one side. With
 * no choice saved, `color-scheme: light dark` follows the system on its own,
 * no JavaScript needed. Choosing Light or Dark sets `data-theme` on <html>,
 * which pins `color-scheme`. index.html applies the saved choice before the
 * first paint, so a dark page never flashes white.
 *
 * Effect idea: localStorage can throw (private windows, blocked storage),
 * so each access is an `Effect.try`, and a failure falls back to System
 * instead of breaking the page.
 */
import { Effect, Option, Schema } from 'effect'

export const Theme = Schema.Literals(['System', 'Light', 'Dark'])
export type Theme = typeof Theme.Type

/** The localStorage key. index.html reads the same key before first paint. */
const STORAGE_KEY = 'mantix-theme'

/** The value of `data-theme` on <html>: none for System. */
const attributeOf = (theme: Theme): Option.Option<string> =>
  theme === 'System' ? Option.none() : Option.some(theme.toLowerCase())

/** The saved choice, or System when there is none (or storage is blocked). */
export const savedTheme: Effect.Effect<Theme> = Effect.try(() =>
  localStorage.getItem(STORAGE_KEY),
).pipe(
  Effect.map(saved =>
    Option.getOrElse(
      Schema.decodeUnknownOption(Theme)(saved),
      (): Theme => 'System',
    ),
  ),
  Effect.orElseSucceed((): Theme => 'System'),
)

/** Show the page in this theme and remember it for the next visit. */
export const applyTheme = (theme: Theme): Effect.Effect<void> =>
  Effect.sync(() =>
    Option.match(attributeOf(theme), {
      onNone: () => document.documentElement.removeAttribute('data-theme'),
      onSome: value =>
        document.documentElement.setAttribute('data-theme', value),
    }),
  ).pipe(
    Effect.andThen(
      Effect.try(() =>
        theme === 'System'
          ? localStorage.removeItem(STORAGE_KEY)
          : localStorage.setItem(STORAGE_KEY, theme),
      ),
    ),
    // A browser that blocks storage still gets the theme for this visit.
    Effect.ignore,
  )
