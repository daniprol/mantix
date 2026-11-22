/**
 * The version of Mantix, from one place: this package's package.json.
 *
 * It is imported as a JSON module rather than read from disk at run time.
 * From source, Node loads the file next to `src/`. In the npm package,
 * tsdown bundles the CLI and inlines the JSON, so the version is part of
 * the bundle and no path has to be worked out from `import.meta.url`.
 */
import pkg from '../package.json' with { type: 'json' }

export const MANTIX_VERSION: string = pkg.version
