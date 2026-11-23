import { Option } from 'effect'
import { describe, expect, it } from 'vitest'

import type { RunInfo } from '@mantix/api'

import { pickBaseline, pickCurrent } from '../src/CompareCommand.ts'

const run = (
  id: string,
  startedAt: number,
  context: Partial<NonNullable<RunInfo['context']>> = {},
  testName = 'checkout',
): RunInfo => ({
  id,
  testName,
  status: 'finished',
  startedAt,
  endedAt: startedAt + 60_000,
  duration: 60,
  plan: [],
  thresholds: [],
  journal: [],
  context: {
    project: 'shop',
    mantixVersion: '0.0.0',
    machine: { hostname: 'laptop', os: 'linux x64', node: '22.19.0' },
    ...context,
  },
})

const repeat = (group: string, index: number) => ({
  repeat: { group, index, of: 3 },
})

// Newest first, as the history lists them.
const runs = [
  run('r6', 6, repeat('g2', 3)),
  run('r5', 5, repeat('g2', 2)),
  run('r4', 4, repeat('g2', 1)),
  run('r3', 3, { label: 'before' }),
  run('o1', 2, {}, 'other test'),
  run('r2', 2, { git: { commit: 'abc1234', branch: 'main', dirty: false } }),
  run('r1', 1, { git: { commit: 'def5678', branch: 'main', dirty: false } }),
]

const ids = (side: ReturnType<typeof pickCurrent>) =>
  typeof side === 'string' ? side : side.map(each => each.id)

describe('picking the runs to compare', () => {
  it('takes the newest run with its whole repeat group', () => {
    expect(ids(pickCurrent(runs, Option.none()))).toEqual(['r6', 'r5', 'r4'])
  })

  it('compares with the run before, of the same test', () => {
    const current = pickCurrent(runs, Option.some('r3')) as Array<RunInfo>
    expect(ids(current)).toEqual(['r3'])
    expect(
      ids(pickBaseline(runs, current, Option.none(), Option.none())),
    ).toEqual(['r2'])
  })

  it('finds runs by label, branch and commit', () => {
    const current = pickCurrent(runs, Option.none()) as Array<RunInfo>
    const baseline = (selector: string, count = Option.none<number>()) =>
      ids(pickBaseline(runs, current, Option.some(selector), count))
    expect(baseline('label:before')).toEqual(['r3'])
    expect(baseline('commit:def')).toEqual(['r1'])
    expect(baseline('branch:main', Option.some(2))).toEqual(['r2', 'r1'])
  })

  it('says plainly when nothing matches', () => {
    expect(pickCurrent([], Option.none())).toContain('No finished runs')
    expect(pickCurrent(runs, Option.some('label:nope'))).toContain(
      'No finished run matches "label:nope"',
    )
  })
})
