/**
 * Importing a test file again after it changed, for `mantix dev`.
 *
 * Node caches every module by URL and never forgets it, so importing the
 * same file twice gives the old code. The usual trick is a query string:
 * `checkout.ts?mantix-dev=2` is a new URL, so Node loads it fresh. But the
 * files *it* imports would still come from the cache.
 *
 * So we add a resolve hook (module.registerHooks): when a versioned module
 * imports another file inside the watched folder, the same version is
 * added to that import too. The whole graph of your own files reloads;
 * packages in node_modules, and Mantix itself, stay as they are (that
 * matters: the engine must see the same `RequestFailed` class as your
 * test).
 */
import { registerHooks } from 'node:module'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const QUERY = 'mantix-dev'
let registered = false

/** Version imports inside `root` and below. Call once. */
export const enableFreshImports = (root: string): void => {
  if (registered) return
  registered = true
  const rootUrl = pathToFileURL(resolve(root) + sep).href
  registerHooks({
    resolve: (specifier, context, nextResolve) => {
      const result = nextResolve(specifier, context)
      const parent = context.parentURL
      if (parent === undefined || !parent.startsWith('file:')) return result
      const version = new URL(parent).searchParams.get(QUERY)
      if (
        version === null ||
        !result.url.startsWith(rootUrl) ||
        result.url.includes('/node_modules/')
      ) {
        return result
      }
      const url = new URL(result.url)
      url.searchParams.set(QUERY, version)
      return { ...result, url: url.href }
    },
  })
}

/** The URL to import `file` as version `version`. */
export const freshUrl = (file: string, version: number): string =>
  `${pathToFileURL(resolve(file)).href}?${QUERY}=${version}`
