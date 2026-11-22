/**
 * Colours for canvas drawing, read from the CSS tokens in styles.css so the
 * charts use exactly the colours of the rest of the page, in light and dark.
 */

export type Palette = Readonly<{
  paper: string
  ink: string
  ink2: string
  ink3: string
  hairline: string
  heat: string
  accent: string
  accentInk: string
  danger: string
  lag: string
}>

/**
 * A token's colour as the page shows it now. The tokens are `light-dark()`
 * pairs, which a canvas can't parse, so a hidden probe element resolves
 * each one to a plain colour.
 */
const resolver = (element: Element) => {
  const probe = document.createElement('span')
  probe.hidden = true
  element.append(probe)
  const styles = getComputedStyle(probe)
  return {
    token: (name: string): string => {
      probe.style.color = `var(${name})`
      return styles.color
    },
    done: () => probe.remove(),
  }
}

export const readPalette = (element: Element): Palette => {
  const { token, done } = resolver(element)
  const palette = {
    paper: token('--paper'),
    ink: token('--ink'),
    ink2: token('--ink-2'),
    ink3: token('--ink-3'),
    hairline: token('--hairline'),
    heat: token('--heat'),
    accent: token('--accent'),
    accentInk: token('--accent-ink'),
    danger: token('--danger'),
    lag: token('--lag'),
  }
  done()
  return palette
}

/**
 * Call `onChange` whenever the page's colours change: the system switches
 * between light and dark, or the theme switch sets `data-theme`. Returns
 * the cleanup.
 */
export const watchColours = (onChange: () => void): (() => void) => {
  const system = matchMedia('(prefers-color-scheme: dark)')
  system.addEventListener('change', onChange)
  const choice = new MutationObserver(onChange)
  choice.observe(document.documentElement, { attributeFilter: ['data-theme'] })
  return () => {
    system.removeEventListener('change', onChange)
    choice.disconnect()
  }
}

export const MONO = "'Geist Mono Variable', ui-monospace, monospace"
