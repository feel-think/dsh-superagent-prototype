// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoalPage } from '../src/client/page.tsx'

const state = {
  now: '2026-11-04T08:00:00.000Z',
  enabled: true,
  commonPrompt: 'SHARED PROMPT',
  goals: [{
    id: 'g-12345678', name: '每日 AI', cron: '0 9 * * *', prompt: 'ENTRY PROMPT', enabled: true,
    createdAt: '2026-11-04T08:00:00.000Z', updatedAt: '2026-11-04T08:00:00.000Z',
    nextRun: new Date(2026, 10, 5, 9, 0).getTime(), last: null,
  }],
  transport: { configured: true, enabled: true, inDir: '/tmp/spool/in', senderReady: true, senderKind: 'person', senders: ['goal'] },
}

let container: HTMLDivElement
let root: Root | undefined

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  globalThis.fetch = vi.fn(async () => ({
    ok: true, status: 200, json: async () => state,
  })) as unknown as typeof fetch
})

afterEach(() => {
  act(() => root?.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const t = (key: string): string => key

describe('GoalPage', () => {
  it('renders the shared prompt and one goal', async () => {
    root = createRoot(container)
    await act(async () => root?.render(<GoalPage t={t} openSpool={() => {}} />))
    expect(container.textContent).toContain('SHARED PROMPT')
    expect(container.textContent).toContain('每日 AI')
    expect(container.textContent).toContain('0 9 * * *')
    expect(container.textContent).toContain('ENTRY PROMPT')
  })

  it('opens the inline editor with the goal values', async () => {
    root = createRoot(container)
    await act(async () => root?.render(<GoalPage t={t} openSpool={() => {}} />))
    const edit = [...container.querySelectorAll('.sg-row-actions button')].find(button => button.textContent === 'edit')
    expect(edit).toBeTruthy()
    await act(async () => edit?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const inputs = [...container.querySelectorAll('input')]
    expect(inputs.some(input => input.value === '每日 AI')).toBe(true)
    const textarea = container.querySelector('textarea')
    expect((textarea as HTMLTextAreaElement | null)?.value).toBe('ENTRY PROMPT')
  })
})
