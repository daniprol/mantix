import { ConfigProvider, Effect, Option } from 'effect'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { NodeServices } from '@effect/platform-node'

import {
  gatherContext,
  labelFlag,
  parseGitStatus,
  projectName,
} from '../src/RunContext.ts'
import { MANTIX_VERSION } from '../src/Version.ts'

// Git hooks (our pre-push runs these tests) set GIT_DIR and friends, which
// would point every git call below at this repository instead of the
// temporary ones. Each test file runs in its own worker, so this is local.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('GIT_')) delete process.env[key]
}

let folder: string | undefined
const tempFolder = () => {
  folder = mkdtempSync(join(tmpdir(), 'mantix-context-'))
  return folder
}
afterEach(() => {
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true })
  folder = undefined
})

/** Run git in `cwd` with a throwaway identity. */
const git = (cwd: string, ...args: Array<string>) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    { cwd, encoding: 'utf8' },
  ).trim()

describe('gatherContext', () => {
  it('records the project, commit, branch and dirty state in a repository', async () => {
    const repo = tempFolder()
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'package.json'), '{ "name": "shop-api" }')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'first')
    const commit = git(repo, 'rev-parse', 'HEAD')
    mkdirSync(join(repo, 'load'))

    // From a subfolder: the package.json at the repository root counts.
    const clean = await Effect.runPromise(
      gatherContext({ cwd: join(repo, 'load'), label: ' v2.3 ' }),
    )
    expect(clean).toMatchObject({
      project: 'shop-api',
      git: { commit, branch: 'main', dirty: false },
      mantixVersion: MANTIX_VERSION,
      label: 'v2.3',
    })
    expect(clean.machine.hostname).not.toBe('')

    // An untracked file is not "dirty"; a changed tracked file is.
    writeFileSync(join(repo, 'notes.txt'), 'untracked')
    const untracked = await Effect.runPromise(gatherContext({ cwd: repo }))
    expect(untracked.git?.dirty).toBe(false)
    writeFileSync(join(repo, 'package.json'), '{ "name": "shop-api2" }')
    const dirty = await Effect.runPromise(gatherContext({ cwd: repo }))
    expect(dirty.git?.dirty).toBe(true)
    expect(dirty.project).toBe('shop-api2')
  })

  it('leaves git out, and uses the folder name, outside a repository', async () => {
    const plain = tempFolder()
    const context = await Effect.runPromise(
      gatherContext({ cwd: plain, label: '' }),
    )
    expect(context.git).toBeUndefined()
    expect(context.label).toBeUndefined()
    expect(context.project).toBe(basename(plain))
  })
})

describe('projectName', () => {
  it('prefers the nearest package.json, then the repository folder', () => {
    const repo = tempFolder()
    mkdirSync(join(repo, 'packages', 'web'), { recursive: true })
    // No package.json anywhere: the repository's folder name.
    expect(projectName(join(repo, 'packages', 'web'), repo)).toBe(
      basename(repo),
    )
    writeFileSync(join(repo, 'package.json'), '{ "name": "monorepo" }')
    writeFileSync(
      join(repo, 'packages', 'web', 'package.json'),
      '{ "name": "@shop/web" }',
    )
    expect(projectName(join(repo, 'packages', 'web'), repo)).toBe('@shop/web')
    expect(projectName(join(repo, 'packages'), repo)).toBe('monorepo')
  })
})

describe('parseGitStatus', () => {
  it('reads a detached HEAD and a repository without commits', () => {
    expect(
      parseGitStatus('# branch.oid abc123\n# branch.head (detached)\n'),
    ).toEqual({ commit: 'abc123', dirty: false })
    expect(
      parseGitStatus('# branch.oid (initial)\n# branch.head main\n'),
    ).toBeUndefined()
  })
})

describe('--label', () => {
  // Parse the flag the way the CLI does, with a given environment.
  const parse = (flags: Record<string, Array<string>>, env = {}) =>
    Effect.runPromise(
      labelFlag.parse({ arguments: [], flags }).pipe(
        Effect.map(([, label]) => label),
        Effect.provide([
          NodeServices.layer,
          ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
        ]),
      ),
    )

  it('falls back to MANTIX_LABEL, and the flag wins over it', async () => {
    expect(await parse({})).toEqual(Option.none())
    expect(await parse({}, { MANTIX_LABEL: 'from env' })).toEqual(
      Option.some('from env'),
    )
    expect(
      await parse({ label: ['from flag'] }, { MANTIX_LABEL: 'from env' }),
    ).toEqual(Option.some('from flag'))
  })
})
