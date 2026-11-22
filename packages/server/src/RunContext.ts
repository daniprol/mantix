/**
 * Run context: where a run came from. The project, the git commit and
 * branch, the Mantix version, the machine and an optional label are saved
 * with every run, so runs can be told apart and compared later.
 *
 * It is gathered here, in the CLI, and handed to the engine through
 * RunOptions, so the engine never touches git or the file system. Nothing
 * in here may fail or slow a run down: each git call has a short timeout,
 * and anything that goes wrong just leaves that part out.
 */
import { Config, Effect, Option } from 'effect'
import { Flag } from 'effect/cli'
import { execFile } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { arch, hostname, platform } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

import type { RunContext } from '@mantix/api'

import { MANTIX_VERSION } from './Version.ts'

/**
 * `--label`, shared by run, ui and dev. Like the history flags, the flag
 * wins over the MANTIX_LABEL variable. Under ui and dev, every run started
 * from that dashboard gets the same label.
 */
export const labelFlag = Flag.String('label').pipe(
  Flag.withDescription(
    'A note saved with each run, e.g. "v2.3 on staging" (env MANTIX_LABEL)',
  ),
  Flag.withFallbackConfig(Config.String('MANTIX_LABEL')),
  Flag.optional,
)

/** Long enough for a big repository, short enough that nobody waits. */
const GIT_TIMEOUT_MS = 1000

const execFileAsync = promisify(execFile)

/**
 * Run a git command in `cwd`: its output, or None when git is missing,
 * the folder is not a repository, or git takes too long. `Effect.option`
 * turns any failure into None, because no git is not an error. The
 * AbortSignal from tryPromise kills git if the effect is interrupted.
 */
const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.tryPromise(signal =>
    execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, signal }),
  ).pipe(
    Effect.map(({ stdout }) => stdout.trim()),
    Effect.option,
  )

type GitInfo = NonNullable<RunContext['git']>

/**
 * Commit, branch and dirty flag from `git status --porcelain=v2 --branch`:
 *
 *   # branch.oid 30db12ef...       ("(initial)" before the first commit)
 *   # branch.head main             ("(detached)" on a detached HEAD)
 *   1 .M N... ... src/app.ts       (one line per changed file)
 */
export const parseGitStatus = (output: string): GitInfo | undefined => {
  let commit: string | undefined
  let branch: string | undefined
  let dirty = false
  for (const line of output.split('\n')) {
    if (line.startsWith('# branch.oid ')) commit = line.slice(13)
    else if (line.startsWith('# branch.head ')) branch = line.slice(14)
    else if (line !== '' && !line.startsWith('#')) dirty = true
  }
  // No commit yet: nothing to point at.
  if (commit === undefined || commit === '(initial)') return undefined
  return {
    commit,
    ...(branch === undefined || branch === '(detached)' ? {} : { branch }),
    dirty,
  }
}

/** The `name` in a package.json, if the file exists and has one. */
const packageName = (file: string): string | undefined => {
  try {
    const { name } = JSON.parse(readFileSync(file, 'utf8')) as {
      readonly name?: unknown
    }
    return typeof name === 'string' && name !== '' ? name : undefined
  } catch {
    return undefined
  }
}

/**
 * The project's name:
 * 1. the `name` in the nearest package.json, looking in `cwd` and then
 *    each parent folder up to the git repository's root (never above it,
 *    and only `cwd` itself outside a repository);
 * 2. else the repository's folder name;
 * 3. else the name of `cwd`.
 */
export const projectName = (
  cwd: string,
  gitRoot: string | undefined,
): string => {
  // git prints the real path, so compare it with the real path of cwd.
  const top = gitRoot ?? realpathSync(cwd)
  let dir = realpathSync(cwd)
  while (true) {
    const name = packageName(join(dir, 'package.json'))
    if (name !== undefined) return name
    const parent = dirname(dir)
    if (dir === top || parent === dir) break
    dir = parent
  }
  return basename(top)
}

/**
 * Gather the context of a run that is about to start. Never fails: the
 * two git calls run at the same time, and either may come back empty.
 */
export const gatherContext = Effect.fn('gatherContext')(function* (
  options: {
    readonly cwd?: string | undefined
    readonly label?: string | undefined
  } = {},
) {
  const cwd = options.cwd ?? process.cwd()
  const [root, status] = yield* Effect.all(
    [
      git(cwd, ['rev-parse', '--show-toplevel']),
      // Untracked files do not count as dirty (like `git describe
      // --dirty`): the history file itself would otherwise always be one.
      // --no-optional-locks: never block a git command you run yourself.
      git(cwd, [
        '--no-optional-locks',
        'status',
        '--porcelain=v2',
        '--branch',
        '--untracked-files=no',
      ]),
    ],
    { concurrency: 'unbounded' },
  )
  const gitInfo = Option.getOrUndefined(Option.map(status, parseGitStatus))
  const label = options.label?.trim()
  const context: RunContext = {
    project: projectName(cwd, Option.getOrUndefined(root)),
    ...(gitInfo === undefined ? {} : { git: gitInfo }),
    mantixVersion: MANTIX_VERSION,
    machine: {
      hostname: hostname(),
      os: `${platform()} ${arch()}`,
      node: process.versions.node,
    },
    ...(label === undefined || label === '' ? {} : { label }),
  }
  return context
})
