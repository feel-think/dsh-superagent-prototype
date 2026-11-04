/** Persistence for `goals.json` and the shared prompt, with atomic writes and serialized mutations. */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cronProblem } from './cron.ts'
import { assertComposedLength, composeGoalText } from './prompt.ts'
import { GoalError, type Goal, type GoalsFile } from './types.ts'

const MAX_GOALS = 100
const MAX_NAME = 80
const MAX_CRON = 120
/** Each prompt field is capped at 10K; the composed text is checked against the Spool 20K limit too. */
const MAX_PROMPT = 10_000
const MAX_COMMON = 10_000

function emptyFile(): GoalsFile {
  return { version: 1, enabled: true, goals: [] }
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new GoalError(400, `${field} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new GoalError(400, `${field} cannot be empty`)
  if (trimmed.length > max) throw new GoalError(400, `${field} cannot exceed ${max} characters`)
  return trimmed
}

/** Like {@link text}, but an empty value is allowed (the shared prompt may be cleared). */
function freeText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new GoalError(400, `${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new GoalError(400, `${field} cannot exceed ${max} characters`)
  return trimmed
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new GoalError(400, `${field} must be a boolean`)
  return value
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('the file must contain a JSON object')
  }
  return value as Record<string, unknown>
}

function parseGoal(value: unknown): Goal {
  const item = record(value)
  const id = typeof item.id === 'string' && /^g-[a-z0-9]{4,32}$/.test(item.id) ? item.id : ''
  if (!id) throw new Error('a goal has an invalid id')
  const name = text(item.name, 'name', MAX_NAME)
  const cron = text(item.cron, 'cron', MAX_CRON)
  const problem = cronProblem(cron)
  if (problem) throw new Error(`the goal ${id} has an invalid cron: ${problem}`)
  const prompt = text(item.prompt, 'prompt', MAX_PROMPT)
  const createdAt = typeof item.createdAt === 'string' ? item.createdAt : ''
  const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt : createdAt
  if (!createdAt) throw new Error(`the goal ${id} has no createdAt`)
  if (typeof item.enabled !== 'boolean') throw new Error(`the goal ${id} has no boolean enabled`)
  return { id, name, cron, prompt, enabled: item.enabled, createdAt, updatedAt }
}

/** Validate a stored file; throws an Error describing the first problem. */
export function parseGoalsFile(value: unknown): GoalsFile {
  const file = record(value)
  if (file.version !== 1) throw new Error('unsupported goals.json version')
  if (typeof file.enabled !== 'boolean') throw new Error('goals.json enabled must be a boolean')
  if (!Array.isArray(file.goals)) throw new Error('goals.json goals must be an array')
  if (file.goals.length > MAX_GOALS) throw new Error(`goals.json cannot hold more than ${MAX_GOALS} goals`)
  const goals = file.goals.map(parseGoal)
  if (new Set(goals.map(goal => goal.id)).size !== goals.length) throw new Error('goals.json has duplicate goal ids')
  return { version: 1, enabled: file.enabled, goals }
}

export interface GoalInput {
  name?: unknown
  cron?: unknown
  prompt?: unknown
  enabled?: unknown
}

function normalizeInput(input: GoalInput, base?: Goal): Pick<Goal, 'name' | 'cron' | 'prompt' | 'enabled'> {
  const name = input.name === undefined && base ? base.name : text(input.name, 'name', MAX_NAME)
  const cron = input.cron === undefined && base ? base.cron : text(input.cron, 'cron', MAX_CRON)
  const problem = cronProblem(cron)
  if (problem) throw new GoalError(400, `cron is invalid: ${problem}`)
  const prompt = input.prompt === undefined && base ? base.prompt : text(input.prompt, 'prompt', MAX_PROMPT)
  const enabled = input.enabled === undefined ? base?.enabled ?? true : boolean(input.enabled, 'enabled')
  return { name, cron, prompt, enabled }
}

function newId(existing: readonly Goal[]): string {
  for (;;) {
    const id = `g-${randomBytes(4).toString('hex')}`
    if (!existing.some(goal => goal.id === id)) return id
  }
}

async function atomicWrite(path: string, body: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  try {
    await writeFile(temporary, body, { mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

/**
 * The files under one directory: `goals.json` and `common.md`.
 * Mutations are serialized, so two panel requests cannot clobber each other.
 * `defaultCommon` is the data-file default copied into a missing `common.md`;
 * no prompt text lives in TypeScript.
 */
export class GoalStore {
  readonly file: string
  readonly common: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(readonly directory: string, private readonly defaultCommon: string) {
    this.file = join(directory, 'goals.json')
    this.common = join(directory, 'common.md')
  }

  /** Create the directory and seed missing files, without overwriting existing ones. */
  async ensure(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await this.serial(async () => {
      try {
        const goals = await this.readFile()
        if (goals.missing) await atomicWrite(this.file, `${JSON.stringify(emptyFile(), null, 2)}\n`)
      } catch (error) {
        // A corrupt file is reported by the panel; startup must not overwrite it.
        if (!(error instanceof GoalError)) throw error
      }
      const common = await readFile(this.common, 'utf8').then(value => value, error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (common === undefined) await atomicWrite(this.common, this.defaultCommon)
    })
  }

  private async serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async readFile(): Promise<GoalsFile & { missing?: true }> {
    const body = await readFile(this.file, 'utf8').then(value => value, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (body === undefined) return { ...emptyFile(), missing: true }
    try {
      return parseGoalsFile(JSON.parse(body))
    } catch (error) {
      throw new GoalError(500, `goals.json cannot be read: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async read(): Promise<GoalsFile & { missing?: true }> {
    return this.readFile()
  }

  async readCommon(): Promise<string> {
    const body = await readFile(this.common, 'utf8').then(value => value, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    return (body === undefined ? this.defaultCommon : body).replace(/\n$/, '')
  }

  async create(input: GoalInput): Promise<Goal> {
    return this.serial(async () => {
      const file = await this.readFile()
      if (file.goals.length >= MAX_GOALS) throw new GoalError(409, `goals.json cannot hold more than ${MAX_GOALS} goals`)
      const fields = normalizeInput(input)
      assertComposedLength(composeGoalText(await this.readCommon(), fields), `goal "${fields.name}" plus the shared prompt`)
      const at = new Date().toISOString()
      const goal: Goal = { id: newId(file.goals), ...fields, createdAt: at, updatedAt: at }
      file.goals.push(goal)
      await this.write(file)
      return goal
    })
  }

  async update(id: string, input: GoalInput): Promise<Goal> {
    return this.serial(async () => {
      const file = await this.readFile()
      const index = file.goals.findIndex(goal => goal.id === id)
      if (index < 0) throw new GoalError(404, `goal not found: ${id}`)
      const goal = file.goals[index] as Goal
      const fields = normalizeInput(input, goal)
      assertComposedLength(composeGoalText(await this.readCommon(), fields), `goal "${fields.name}" plus the shared prompt`)
      const updated: Goal = { ...goal, ...fields, updatedAt: new Date().toISOString() }
      file.goals[index] = updated
      await this.write(file)
      return updated
    })
  }

  async remove(id: string): Promise<void> {
    return this.serial(async () => {
      const file = await this.readFile()
      const index = file.goals.findIndex(goal => goal.id === id)
      if (index < 0) throw new GoalError(404, `goal not found: ${id}`)
      file.goals.splice(index, 1)
      await this.write(file)
    })
  }

  async saveSettings(input: { enabled?: unknown; commonPrompt?: unknown }): Promise<void> {
    return this.serial(async () => {
      if (input.commonPrompt === undefined && input.enabled === undefined) return
      const file = await this.readFile()
      if (input.commonPrompt !== undefined) {
        const prompt = freeText(input.commonPrompt, 'commonPrompt', MAX_COMMON)
        for (const goal of file.goals) {
          assertComposedLength(composeGoalText(prompt, goal), `goal "${goal.name}" plus the shared prompt`)
        }
        await atomicWrite(this.common, `${prompt}\n`)
      }
      if (input.enabled !== undefined) {
        file.enabled = boolean(input.enabled, 'enabled')
        await this.write(file)
      }
    })
  }

  private async write(file: GoalsFile): Promise<void> {
    await atomicWrite(this.file, `${JSON.stringify({ version: 1, enabled: file.enabled, goals: file.goals }, null, 2)}\n`)
  }
}
