import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GoalStore } from '../src/store.ts'
import { GoalScheduler } from '../src/scheduler.ts'
import type { OrchestratorHost, SourceInstance } from '../src/types.ts'

const dirs: string[] = []

async function setup(): Promise<{ directory: string; inDir: string; store: GoalStore; host: OrchestratorHost }> {
  const directory = await mkdtemp(join(tmpdir(), 'goal-scheduler-'))
  dirs.push(directory)
  const inDir = join(directory, 'spool', 'in')
  const store = new GoalStore(join(directory, 'goal'), 'SHARED')
  await store.ensure()
  const host: OrchestratorHost = {
    stateDir: directory,
    sources: {
      instance: <C extends Record<string, unknown>>(id: string) => (id === 'spool'
        ? { id: 'spool', kind: 'spool', enabled: true, config: { inDir, senders: [{ id: 'goal', kind: 'person' }] } }
        : undefined) as SourceInstance<C> | undefined,
    },
  }
  return { directory, inDir, store, host }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('GoalScheduler', () => {
  it('writes one wake at the scheduled minute and not again in that minute', async () => {
    const { inDir, store, host } = await setup()
    const goal = await store.create({ name: '每日 AI', cron: '0 9 * * *', prompt: '找值得说的新能力。' })
    let now = new Date(2026, 10, 4, 8, 59, 30)
    const scheduler = new GoalScheduler(store, { orchestrator: host, info: () => {}, warn: () => {} }, () => now)
    await scheduler.tick()
    expect(await readdir(inDir).catch(() => [])).toEqual([])

    now = new Date(2026, 10, 4, 9, 0, 2)
    await scheduler.tick()
    const names = await readdir(inDir)
    expect(names).toHaveLength(1)
    const payload = JSON.parse(await readFile(join(inDir, names[0] as string), 'utf8')) as Record<string, string>
    expect(payload.sender).toBe('goal')
    expect(payload.conversation).toBe('goal')
    expect(payload.thread).toBe(`goal-${goal.id}`)
    expect(payload.text).toContain('每日 AI')
    expect(payload.text).toContain('找值得说的新能力。')
    expect(scheduler.lastOf(goal.id)?.id).toBe(payload.id)

    await scheduler.tick()
    expect(await readdir(inDir)).toHaveLength(1)
  })

  it('does nothing while the master switch is off, but run now still works', async () => {
    const { inDir, store, host } = await setup()
    const goal = await store.create({ name: '盯竞品', cron: '0 9 * * *', prompt: '看 XX 是否发布。' })
    await store.saveSettings({ enabled: false })
    const now = new Date(2026, 10, 4, 9, 0, 2)
    const scheduler = new GoalScheduler(store, { orchestrator: host, info: () => {}, warn: () => {} }, () => now)
    await scheduler.tick()
    expect(await readdir(inDir).catch(() => [])).toEqual([])
    const wake = await scheduler.runNow(goal.id)
    expect(wake.thread).toBe(`goal-${goal.id}`)
    expect(await readdir(inDir)).toHaveLength(1)
  })

  it('refuses to write when the goal sender acts as a bot', async () => {
    const { directory, inDir, store } = await setup()
    await store.create({ name: '盯竞品', cron: '0 9 * * *', prompt: '看 XX 是否发布。' })
    const host: OrchestratorHost = {
      stateDir: directory,
      sources: {
        instance: <C extends Record<string, unknown>>(id: string) => (id === 'spool'
          ? { id: 'spool', kind: 'spool', enabled: true, config: { inDir, senders: [{ id: 'goal', kind: 'bot' }] } }
          : undefined) as SourceInstance<C> | undefined,
      },
    }
    let now = new Date(2026, 10, 4, 8, 59, 30)
    const scheduler = new GoalScheduler(store, { orchestrator: host, info: () => {}, warn: () => {} }, () => now)
    await scheduler.tick()
    now = new Date(2026, 10, 4, 9, 0, 2)
    await scheduler.tick()
    const goal = (await store.read()).goals[0]
    expect(scheduler.lastOf(goal?.id as string)?.error).toContain('person')
    expect(await readdir(inDir).catch(() => [])).toEqual([])
  })

  it('records a failure when the Spool Source is off', async () => {
    const { directory, store } = await setup()
    const inDir = join(directory, 'spool', 'in')
    await store.create({ name: '盯竞品', cron: '0 9 * * *', prompt: '看 XX 是否发布。' })
    const host: OrchestratorHost = {
      stateDir: directory,
      sources: {
        instance: <C extends Record<string, unknown>>(id: string) => (id === 'spool'
          ? { id: 'spool', kind: 'spool', enabled: false, config: { inDir, senders: [{ id: 'goal', kind: 'person' }] } }
          : undefined) as SourceInstance<C> | undefined,
      },
    }
    let now = new Date(2026, 10, 4, 8, 59, 30)
    const scheduler = new GoalScheduler(store, { orchestrator: host, info: () => {}, warn: () => {} }, () => now)
    await scheduler.tick()
    now = new Date(2026, 10, 4, 9, 0, 2)
    await scheduler.tick()
    const goal = (await store.read()).goals[0]
    expect(goal).toBeDefined()
    expect(scheduler.lastOf(goal?.id as string)?.error).toContain('off')
  })

  it('follows a hand-edited goals file', async () => {
    const { inDir, store, host } = await setup()
    const goal = await store.create({ name: '手改', cron: '0 9 * * *', prompt: 'x' })
    const raw = JSON.parse(await readFile(store.file, 'utf8')) as { goals: { prompt: string }[] }
    raw.goals[0]!.prompt = '手改后的提示词'
    await writeFile(store.file, JSON.stringify(raw))
    let now = new Date(2026, 10, 4, 8, 59, 30)
    const scheduler = new GoalScheduler(store, { orchestrator: host, info: () => {}, warn: () => {} }, () => now)
    await scheduler.tick()
    now = new Date(2026, 10, 4, 9, 0, 2)
    await scheduler.tick()
    const files = await readdir(inDir)
    const payload = JSON.parse(await readFile(join(inDir, files[0] as string), 'utf8')) as { text: string }
    expect(payload.text).toContain('手改后的提示词')
    expect(goal.id).toBeTruthy()
  })
})
