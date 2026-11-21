/**
 * Colours for canvas drawing, read from the CSS tokens in styles.css so the
 * charts follow light and dark mode exactly like the rest of the page.
 */

export type Palette = Readonly<{
  paper: string
  ink: string
  ink2: string
  ink3: string
  hairline: string
  heat: string
  accent: string
  danger: string
  lag: string
}>

const token = (styles: CSSStyleDeclaration, name: string): string =>
  styles.getPropertyValue(name).trim()

export const readPalette = (element: Element): Palette => {
  const styles = getComputedStyle(element)
  return {
    paper: token(styles, '--paper'),
    ink: token(styles, '--ink'),
    ink2: token(styles, '--ink-2'),
    ink3: token(styles, '--ink-3'),
    hairline: token(styles, '--hairline'),
    heat: token(styles, '--heat'),
    accent: token(styles, '--accent'),
    danger: token(styles, '--danger'),
    lag: token(styles, '--lag'),
  }
}

export const SANS = "'Geist Variable', ui-sans-serif, system-ui, sans-serif"
export const MONO = "'Geist Mono Variable', ui-monospace, monospace"
