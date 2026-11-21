/**
 * The site is served from a sub-path on GitHub Pages
 * (https://daniprol.github.io/mantix/), so internal links need that prefix.
 * Astro exposes it as import.meta.env.BASE_URL.
 */
export const withBase = (path: string): string =>
  path.startsWith('/') && !path.startsWith('//')
    ? `${import.meta.env.BASE_URL.replace(/\/$/, '')}${path}`
    : path
