/**
 * Telling runs apart: when they started, and on which branch and commit.
 */
import type { RunInfo } from '@mantix/api'

/** "22 Nov 14:32" */
export const startedAt = (run: RunInfo): string => {
  const date = new Date(run.startedAt)
  const day = date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  })
  const time = date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  return `${day} ${time}`
}

/** "feat/cart-cache a3f9c1e", with a star for uncommitted changes. */
export const gitOf = (run: RunInfo): string => {
  const git = run.context?.git
  if (git === undefined) {
    return ''
  }
  const commit = `${git.commit.slice(0, 7)}${git.dirty ? '*' : ''}`
  return git.branch === undefined ? commit : `${git.branch} ${commit}`
}

/** How long it ran, in seconds. */
export const ranFor = (run: RunInfo, secondsSeen: number): number =>
  run.endedAt === null
    ? secondsSeen
    : Math.round((run.endedAt - run.startedAt) / 1000)
