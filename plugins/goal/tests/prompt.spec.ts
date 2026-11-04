import { describe, expect, it } from 'vitest'
import { assertComposedLength, composeGoalText, MAX_TEXT } from '../src/prompt.ts'
import { GoalError } from '../src/types.ts'

describe('goal text', () => {
  it('joins the shared and entry prompts under the goal name', () => {
    const text = composeGoalText('SHARED', { name: '每日', prompt: 'ENTRY' })
    expect(text).toBe('定时 Goal：每日\n\nSHARED\n\nENTRY\n')
  })

  it('omits the separator when the shared prompt is empty', () => {
    expect(composeGoalText('', { name: '每日', prompt: 'ENTRY' })).toBe('定时 Goal：每日\n\nENTRY\n')
  })

  it('refuses text over the Spool request limit', () => {
    expect(() => assertComposedLength('a'.repeat(MAX_TEXT))).not.toThrow()
    expect(() => assertComposedLength('a'.repeat(MAX_TEXT + 1))).toThrow(GoalError)
  })
})
