/** Compose the text of one goal wake: the shared prompt followed by the entry's own prompt. */
import { GoalError, type Goal } from './types.ts'

/** The Spool Source's own request-text limit; the composed text is checked against it before writing. */
export const MAX_TEXT = 20_000

/**
 * The code only joins the two prompts; every step (read OV, judge, choose a
 * channel, avoid repeats) lives in the prompt text. `name` gives the worker a
 * stable label for the wake without turning the prompt into a procedure.
 */
export function composeGoalText(common: string, goal: Pick<Goal, 'name' | 'prompt'>): string {
  const shared = common.trim()
  const own = goal.prompt.trim()
  const body = [shared, own].filter(Boolean).join('\n\n')
  return `定时 Goal：${goal.name}\n\n${body}${body ? '\n' : ''}`
}

/** Refuse a composed text the Spool Source would reject, instead of letting it move the file into `.bad`. */
export function assertComposedLength(text: string, label = 'the prompts'): string {
  if (text.length > MAX_TEXT) {
    throw new GoalError(400, `${label} total ${text.length} characters; the Spool limit is ${MAX_TEXT}`)
  }
  return text
}
