import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GoalStore } from '../src/store.ts'
import { GoalError } from '../src/types.ts'

const dirs: string[] = []
const DEFAULT_COMMON = 'SHARED PROMPT'

async function store(): Promise<GoalStore> {
  const directory = await mkdtemp(join(tmpdir(), 'goal-store-'))
  dirs.push(directory)
  const result = new GoalStore(directory, DEFAULT_COMMON)
  await result.ensure()
  return result
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

const input = { name: '每日 AI 信息', cron: '0 9 * * *', prompt: '扫 X / GitHub，找值得说的新能力。' }

describe('GoalStore', () => {
  it('creates the files and starts empty', async () => {
    const goals = await store()
    const file = await goals.read()
    expect(file.enabled).toBe(true)
    expect(file.goals).toEqual([])
    expect(await goals.readCommon()).toBe(DEFAULT_COMMON)
    expect(JSON.parse(await readFile(goals.file, 'utf8')).version).toBe(1)
  })

  it('creates, updates and deletes a goal', async () => {
    const goals = await store()
    const created = await goals.create(input)
    expect(created.id).toMatch(/^g-[a-z0-9]{8}$/)
    expect(created.enabled).toBe(true)
    expect(created.prompt).toBe(input.prompt)

    const toggled = await goals.update(created.id, { enabled: false })
    expect(toggled.enabled).toBe(false)
    expect(toggled.name).toBe(input.name)
    expect(toggled.cron).toBe(input.cron)

    const edited = await goals.update(created.id, { name: '新名字', prompt: '新的提示词' })
    expect(edited.name).toBe('新名字')
    expect(edited.prompt).toBe('新的提示词')
    expect(edited.enabled).toBe(false)

    await goals.remove(created.id)
    expect((await goals.read()).goals).toEqual([])
  })

  it('rejects invalid input', async () => {
    const goals = await store()
    await expect(goals.create({ ...input, cron: 'not a cron' })).rejects.toBeInstanceOf(GoalError)
    await expect(goals.create({ ...input, name: '   ' })).rejects.toBeInstanceOf(GoalError)
    await expect(goals.create({ ...input, prompt: '' })).rejects.toBeInstanceOf(GoalError)
    await expect(goals.update('g-00000000', { enabled: true })).rejects.toBeInstanceOf(GoalError)
  })

  it('saves the shared prompt, allows clearing it, and saves the master switch', async () => {
    const goals = await store()
    await goals.saveSettings({ commonPrompt: '共享提示词' })
    expect(await goals.readCommon()).toBe('共享提示词')
    await goals.saveSettings({ commonPrompt: '' })
    expect(await goals.readCommon()).toBe('')
    await goals.saveSettings({ enabled: false })
    expect((await goals.read()).enabled).toBe(false)
  })

  it('caps each prompt at 10K and rejects an over-long composed text', async () => {
    const goals = await store()
    await expect(goals.create({ ...input, prompt: 'a'.repeat(10_001) })).rejects.toBeInstanceOf(GoalError)
    const created = await goals.create({ ...input, prompt: 'a'.repeat(10_000) })
    await expect(goals.saveSettings({ commonPrompt: 'b'.repeat(10_000) }))
      .rejects.toThrow(/exceed|limit|20,?000/i)
    expect((await goals.read()).goals[0]?.id).toBe(created.id)
  })

  it('reports a broken file instead of serving a partial state', async () => {
    const goals = await store()
    await writeFile(goals.file, '{ not json')
    await expect(goals.read()).rejects.toBeInstanceOf(GoalError)
    await writeFile(goals.file, JSON.stringify({ version: 1, enabled: true, goals: [{ id: 'x' }] }))
    await expect(goals.read()).rejects.toBeInstanceOf(GoalError)
  })
})
