/**
 * Durations in scenario files can be written as seconds (`30`) or as text
 * (`"500ms"`, `"30s"`, `"2m"`, `"1h"`). Everything inside Mantix uses
 * seconds as plain numbers.
 */

/** A number of seconds, or a string such as "500ms", "30s", "2m", "1h". */
export type DurationInput = number | `${number}${'ms' | 's' | 'm' | 'h'}`

const UNIT_SECONDS = { ms: 0.001, s: 1, m: 60, h: 3600 } as const

/** Turn a DurationInput into seconds. Throws on text it cannot read. */
export const toSeconds = (input: DurationInput): number => {
  if (typeof input === 'number') {
    return input
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)\s*$/.exec(input)
  if (match === null) {
    throw new Error(
      `Cannot read duration "${input}". Use a number of seconds or text like "500ms", "30s", "2m", "1h".`,
    )
  }
  const [, amount, unit] = match
  return Number(amount) * UNIT_SECONDS[unit as keyof typeof UNIT_SECONDS]
}

/** Read a duration typed on the command line: "30s", "2m" or "45". */
export const parseDuration = (text: string): number =>
  /^\s*\d+(?:\.\d+)?\s*$/.test(text)
    ? Number(text)
    : toSeconds(text as DurationInput)
