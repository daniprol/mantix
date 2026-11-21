/**
 * Number formatting. Every figure on screen goes through here so units are
 * consistent: one auto-scaled unit, three significant figures, and the unit
 * kept separate so the view can set it smaller and muted.
 */

/** A number split from its unit, e.g. { value: '212', unit: 'ms' }. */
export type Quantity = Readonly<{ value: string; unit: string }>

/** Three significant figures without scientific notation: 0.0412 → "0.0412". */
export const significant = (value: number): string => {
  if (value === 0 || !Number.isFinite(value)) {
    return '0'
  }
  if (Math.abs(value) >= 1000) {
    return grouped(Math.round(value))
  }
  return String(Number(value.toPrecision(3)))
}

/** An integer with thousands separators: 12345 → "12,345". */
export const grouped = (value: number): string =>
  Math.round(value).toLocaleString('en-US')

/** A latency given in milliseconds, scaled to µs, ms or s. */
export const latency = (ms: number): Quantity => {
  if (ms <= 0) {
    return { value: '0', unit: 'ms' }
  }
  if (ms < 1) {
    return { value: significant(ms * 1000), unit: 'µs' }
  }
  // 999.6 ms would round to "1000 ms"; show it as seconds instead.
  if (Number(ms.toPrecision(3)) >= 1000) {
    return { value: significant(ms / 1000), unit: 's' }
  }
  return { value: significant(ms), unit: 'ms' }
}

/** A rate per second: whole numbers from 100 up, three figures below. */
export const rate = (perSecond: number): Quantity => ({
  value: perSecond >= 100 ? grouped(perSecond) : significant(perSecond),
  unit: '/s',
})

/** A share from 0 to 1, as a percentage: 0.0412 → "4.12%". */
export const percent = (fraction: number): Quantity => {
  const value = fraction * 100
  if (value === 0) {
    return { value: '0', unit: '%' }
  }
  if (value < 0.01) {
    return { value: '<0.01', unit: '%' }
  }
  return { value: significant(value), unit: '%' }
}

/** Join a quantity for plain text: "212 ms", "4.12%", "196/s". */
export const text = ({ value, unit }: Quantity): string =>
  unit === 'ms' || unit === 'µs' || unit === 's'
    ? `${value} ${unit}`
    : `${value}${unit}`

/** Seconds as a clock: 83 → "01:23", 3723 → "1:02:03". */
export const clock = (totalSeconds: number): string => {
  const whole = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const seconds = whole % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`
}

/** A span of time in words: 30 → "30 s", 120 → "2 min", 90 → "1 min 30 s". */
export const span = (totalSeconds: number): string => {
  const whole = Math.round(totalSeconds)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const seconds = whole % 60
  const parts = [
    hours > 0 ? `${hours} h` : '',
    minutes > 0 ? `${minutes} min` : '',
    seconds > 0 || whole === 0 ? `${seconds} s` : '',
  ]
  return parts.filter(part => part !== '').join(' ')
}

/** Parse a duration typed by a person: "90", "90s", "2m", "1.5 min", "1h". */
export const parseSpan = (input: string): number | undefined => {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(s|sec|m|min|h)?\s*$/i.exec(input)
  if (match === null) {
    return undefined
  }
  const amount = Number(match[1])
  const unit = (match[2] ?? 's').toLowerCase()
  const factor = unit.startsWith('h') ? 3600 : unit.startsWith('m') ? 60 : 1
  const seconds = Math.round(amount * factor)
  return seconds > 0 ? seconds : undefined
}
