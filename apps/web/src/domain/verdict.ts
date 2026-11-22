/**
 * A run's outcome as data: its status in one word and how its checks went.
 */
import type { RunInfo } from '@mantix/api'

export const STATUS_WORDS: Record<RunInfo['status'], string> = {
  running: 'Running',
  finished: 'Finished',
  stopped: 'Stopped',
  aborted: 'Aborted',
  crashed: 'Crashed',
}

export type Outcome = 'Passed' | 'Failed' | 'NoChecks' | 'Running'

export const outcomeOf = (run: RunInfo): Outcome => {
  if (run.status === 'running') {
    return 'Running'
  }
  if (run.status === 'crashed' || run.thresholds.some(t => !t.passed)) {
    return 'Failed'
  }
  return run.thresholds.length === 0 ? 'NoChecks' : 'Passed'
}

/** "2 of 3 checks passed", or nothing to say when the test set none. */
export const checksSummary = (run: RunInfo): string => {
  const total = run.thresholds.length
  const passed = run.thresholds.filter(t => t.passed).length
  if (total === 0) {
    return ''
  }
  return passed === total
    ? `${total === 1 ? 'Check' : `All ${total} checks`} passed`
    : `${passed} of ${total} checks passed`
}
