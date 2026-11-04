import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GoalStore } from '../src/store.ts'
import { GoalError, type Goal } from '../src/types.ts'
import type { OrchestratorHost, SourceInstance } from '../src/types.ts'
import { GOAL_CONVERSATION, GOAL_SENDER, goalThread, isoLocal, transportOf, wakeId, writeWake } from '../src/spool.ts'

const dirs: string[] = []

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'goal-spool-'))
  dirs.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('Spool transport', () => {
  it('reads the Spool incoming folder and sender list without editing them', () => {
    const host: OrchestratorHost = {
      stateDir: '/tmp/state',
      sources: {
        instance: <C extends Record<string, unknown>>(id: string) => (id === 'spool'
          ? { id: 'spool', kind: 'spool', enabled: true, config: { inDir: '/tmp/in', senders: [{ id: 'goal', kind: 'person' }, { id: 'x-watch' }] } }
          : undefined) as SourceInstance<C> | undefined,
      },
    }
    expect(transportOf(host)).toEqual({ configured: true, enabled: true, inDir: '/tmp/in', senderReady: true, senderKind: 'person', senders: ['goal', 'x-watch'] })
  })

  it('reports missing configuration and sender', () => {
    const host: OrchestratorHost = { stateDir: '/tmp/state', sources: { instance: <C extends Record<string, unknown>>() => undefined as SourceInstance<C> | undefined } }
    expect(transportOf(host)).toMatchObject({ configured: false, senderReady: false })
  })

  it('refuses a goal sender that still acts as a bot', () => {
    const host: OrchestratorHost = {
      stateDir: '/tmp/state',
      sources: {
        instance: <C extends Record<string, unknown>>(id: string) => (id === 'spool'
          ? { id: 'spool', kind: 'spool', enabled: true, config: { inDir: '/tmp/in', senders: [{ id: 'goal', kind: 'bot' }] } }
          : undefined) as SourceInstance<C> | undefined,
      },
    }
    expect(transportOf(host)).toMatchObject({ configured: true, senderReady: false, senderKind: 'bot' })
  })

  it('builds a stable thread and unique ids', () => {
    const now = new Date(2026, 10, 4, 9, 0, 1)
    expect(goalThread({ id: 'g-abcd1234' })).toBe('goal-g-abcd1234')
    const first = wakeId({ id: 'g-abcd1234' }, now)
    const second = wakeId({ id: 'g-abcd1234' }, now)
    expect(first).toMatch(/^goal-g-abcd1234-[a-z0-9]+$/)
    expect(first).not.toBe(second)
  })

  it('writes a complete request that the Spool Source can consume', async () => {
    const directory = await temporary()
    const store = new GoalStore(join(directory, 'goal'), 'SHARED')
    await store.ensure()
    const goal = await store.create({ name: '每日 AI', cron: '0 9 * * *', prompt: '找值得说的新能力。' })
    const common = await store.readCommon()
    const now = new Date(2026, 10, 4, 9, 0, 5)
    const wake = await writeWake(join(directory, 'spool', 'in'), goal, common, now)
    const payload = JSON.parse(await readFile(wake.file, 'utf8')) as Record<string, unknown>
    expect(payload.sender).toBe(GOAL_SENDER)
    expect(payload.conversation).toBe(GOAL_CONVERSATION)
    expect(payload.thread).toBe(`goal-${goal.id}`)
    expect(payload.id).toBe(wake.id)
    expect(payload.type).toBe('goal')
    expect(payload.addressed).toBe(true)
    expect(payload.at).toBe(isoLocal(now))
    expect(payload.text).toContain('每日 AI')
    expect(payload.text).toContain(common.trim())
    expect(payload.text).toContain('找值得说的新能力。')
  })

  it('refuses a composed request over the Spool limit', async () => {
    const directory = await temporary()
    const goal: Goal = {
      id: 'g-abcdef12', name: 'long', cron: '0 9 * * *', prompt: 'a'.repeat(10_000),
      enabled: true, createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z',
    }
    await expect(writeWake(join(directory, 'spool', 'in'), goal, 'b'.repeat(10_000), new Date(2026, 10, 4, 9, 0)))
      .rejects.toBeInstanceOf(GoalError)
  })
})
