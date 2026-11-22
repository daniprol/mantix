/**
 * Reading a load plan: how long it lasts and what it asks for at a given
 * moment. Pure functions, shared by the engine and the dashboard.
 */
import type { LoadPlan } from './Run.ts'

/** Total planned duration in seconds. */
export const planDuration = (plan: LoadPlan): number =>
  plan.stages.reduce((total, stage) => total + stage.duration, 0)

/**
 * The planned target (rate or VUs) at `t` seconds into the plan. Between
 * stage boundaries the value moves in a straight line. Before the plan
 * starts and after it ends it returns 0.
 */
export const targetAt = (plan: LoadPlan, t: number): number => {
  if (t < 0) return 0
  let from = plan.start
  let elapsed = 0
  for (const stage of plan.stages) {
    if (t < elapsed + stage.duration) {
      const progress = stage.duration === 0 ? 1 : (t - elapsed) / stage.duration
      return from + (stage.target - from) * progress
    }
    elapsed += stage.duration
    from = stage.target
  }
  return 0
}
