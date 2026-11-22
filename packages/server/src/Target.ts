/**
 * `--base-url` and `--port`: the two settings people most often change
 * between machines, so each also reads an environment variable.
 *
 * As with the history flags, `withFallbackConfig` reads the variable only
 * when the flag is not given, so a flag always wins.
 */
import { Config } from 'effect'
import { Flag } from 'effect/cli'

import { type Scenario, type TestDefinition, scenariosOf } from '@mantix/core'

/**
 * `--base-url`: send the requests to another server, e.g. staging, without
 * editing the test. Without it, each scenario keeps the `baseUrl` written
 * in the test file.
 */
export const baseUrlFlag = Flag.String('base-url').pipe(
  Flag.withDescription(
    "Send requests here instead of the test's baseUrl (env MANTIX_BASE_URL)",
  ),
  Flag.withFallbackConfig(Config.String('MANTIX_BASE_URL')),
  Flag.optional,
)

/** `--port` for the dashboard of `mantix ui` and `mantix dev`. */
export const portFlag = Flag.Int('port').pipe(
  Flag.withDescription('Port for the dashboard (env MANTIX_PORT)'),
  Flag.withFallbackConfig(Config.Int('MANTIX_PORT')),
  Flag.withDefault(4100),
)

/** A clear message for a base URL that is not a full http(s) URL. */
export const checkBaseUrl = (baseUrl: string): string | undefined => {
  const url = URL.parse(baseUrl)
  return url !== null && (url.protocol === 'http:' || url.protocol === 'https:')
    ? undefined
    : `--base-url must be a full http(s) URL, like https://staging.example.com (got "${baseUrl}").`
}

/**
 * The same test with every scenario pointed at `baseUrl`. Scenarios are
 * plain objects, so copying them with a new option is enough.
 */
export const withBaseUrl = (
  test: TestDefinition,
  baseUrl: string | undefined,
): TestDefinition => {
  if (baseUrl === undefined) return test
  // The spread keeps each scenario's kind (async or Effect); TypeScript
  // can't follow that through a union, hence the `as Scenario`.
  const scenarios = scenariosOf(test).map(
    s => ({ ...s, options: { ...s.options, baseUrl } }) as Scenario,
  )
  return Array.isArray(test) ? scenarios : scenarios[0]!
}
