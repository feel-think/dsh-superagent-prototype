import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GoalStore } from '../src/store.ts'
import { GoalApi } from '../src/api.ts'
import type { LastRun } from '../src/scheduler.ts'
import type { Wake } from '../src/spool.ts'

const dirs: string[] = []
const last = new Map<string, LastRun>()

async function api(): Promise<GoalApi> {
  const directory = await mkdtemp(join(tmpdir(), 'goal-api-'))
  dirs.push(directory)
  const store = new GoalStore(directory, 'SHARED')
  await store.ensure()
  return new GoalApi(store, {
    lastOf: id => last.get(id),
    runNow: async (id): Promise<Wake> => {
      last.set(id, { at: '2026-11-04T08:00:00.000Z', id: `wake-${id}` })
      return { file: `/tmp/${id}.json`, id: `wake-${id}`, thread: `goal-${id}`, text: 'wake' }
    },
  }, () => ({ configured: true, enabled: true, inDir: '/tmp/spool/in', senderReady: true, senderKind: 'person', senders: ['goal'] }),
  () => new Date('2026-11-04T08:00:00+08:00'))
}

afterEach(async () => {
  last.clear()
  await Promise.all(dirs.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('GoalApi', () => {
  it('returns the panel state', async () => {
    const goals = await api()
    const result = await goals.handle('GET', '/state', undefined)
    expect(result.status).toBe(200)
    const body = result.body as { enabled: boolean; goals: unknown[]; transport: { senderReady: boolean } }
    expect(body.enabled).toBe(true)
    expect(body.goals).toEqual([])
    expect(body.transport.senderReady).toBe(true)
  })

  it('creates, edits, lists and deletes a goal', async () => {
    const goals = await api()
    const created = await goals.handle('POST', '/goals', { name: '盯竞品', cron: '0 */2 * * *', prompt: '看 XX 是否发布。' })
    expect(created.status).toBe(201)
    const id = (created.body as { goal: { id: string } }).goal.id

    const edited = await goals.handle('PUT', `/goals/${id}`, { enabled: false })
    expect(edited.status).toBe(200)
    expect((edited.body as { goal: { enabled: boolean } }).goal.enabled).toBe(false)

    const state = await goals.handle('GET', '/state', undefined)
    const goalsView = (state.body as { goals: { id: string; enabled: boolean; nextRun: number | null }[] }).goals
    expect(goalsView).toHaveLength(1)
    expect(goalsView[0]?.enabled).toBe(false)
    expect(goalsView[0]?.nextRun).toBeNull()

    const run = await goals.handle('POST', `/goals/${id}/run`, undefined)
    expect(run.status).toBe(200)
    expect((run.body as { id: string }).id).toBe(`wake-${id}`)

    const removed = await goals.handle('DELETE', `/goals/${id}`, undefined)
    expect(removed.status).toBe(200)
    expect(((await goals.handle('GET', '/state', undefined)).body as { goals: unknown[] }).goals).toEqual([])
  })

  it('saves the shared prompt and the master switch', async () => {
    const goals = await api()
    const settings = await goals.handle('PUT', '/settings', { commonPrompt: '共享提示', enabled: false })
    expect(settings.status).toBe(200)
    const body = settings.body as { enabled: boolean; commonPrompt: string }
    expect(body.enabled).toBe(false)
    expect(body.commonPrompt).toBe('共享提示')
  })

  it('rejects unknown routes, wrong methods and bad bodies', async () => {
    const goals = await api()
    expect((await goals.handle('GET', '/nope', undefined)).status).toBe(404)
    expect((await goals.handle('DELETE', '/state', undefined)).status).toBe(400)
    expect((await goals.handle('POST', '/goals', null)).status).toBe(400)
    expect((await goals.handle('POST', '/goals', { name: 'x', cron: 'bad', prompt: 'y' })).status).toBe(400)
  })
})
