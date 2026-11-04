/** The panel API: read state, create/update/delete goals, save the shared prompt, and run one goal now. */
import { nextRunAt } from './cron.ts'
import type { GoalScheduler } from './scheduler.ts'
import type { GoalStore, GoalInput } from './store.ts'
import { GoalError, type Goal, type GoalsFile } from './types.ts'
import type { TransportState } from './spool.ts'

export const ROUTE = '/dsh-superagent-goal'

export interface ApiResult {
  status: number
  body: unknown
}

export interface GoalView extends Goal {
  nextRun: number | null
  last: { at: string; id?: string; error?: string } | null
}

export interface StateView {
  now: string
  enabled: boolean
  commonPrompt: string
  goals: GoalView[]
  transport: TransportState
}

function objectBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new GoalError(400, 'the request body must be a JSON object')
  }
  return body as Record<string, unknown>
}

/** The HTTP-facing API, separated from Node's IncomingMessage so tests can call it directly. */
export class GoalApi {
  constructor(
    private readonly store: GoalStore,
    private readonly scheduler: Pick<GoalScheduler, 'lastOf' | 'runNow'>, 
    private readonly transport: () => TransportState,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async state(): Promise<StateView> {
    const file: GoalsFile = await this.store.read()
    const commonPrompt = await this.store.readCommon()
    const now = this.now()
    const goals: GoalView[] = file.goals.map(goal => ({
      ...goal,
      nextRun: file.enabled && goal.enabled ? nextRunAt(goal.cron, now) : null,
      last: this.scheduler.lastOf(goal.id) ?? null,
    }))
    return { now: now.toISOString(), enabled: file.enabled, commonPrompt, goals, transport: this.transport() }
  }

  /** Dispatch one request below {@link ROUTE}; `path` starts with `/`. */
  async handle(method: string, path: string, body: unknown): Promise<ApiResult> {
    try {
      return await this.dispatch(method, path, body)
    } catch (error) {
      if (error instanceof GoalError) return { status: error.status, body: { error: error.message } }
      throw error
    }
  }

  private async dispatch(method: string, path: string, body: unknown): Promise<ApiResult> {
    let parts: string[]
    try {
      parts = path.split('/').filter(Boolean).map(part => decodeURIComponent(part))
    } catch {
      throw new GoalError(400, 'the path is not valid percent-encoding')
    }
    const verb = method.toUpperCase()
    if (parts.length === 1 && parts[0] === 'state') {
      if (verb !== 'GET') throw new GoalError(400, 'GET required')
      return { status: 200, body: await this.state() }
    }
    if (parts.length === 1 && parts[0] === 'settings') {
      if (verb !== 'PUT') throw new GoalError(400, 'PUT required')
      await this.store.saveSettings(objectBody(body))
      return { status: 200, body: await this.state() }
    }
    if (parts[0] === 'goals') {
      if (parts.length === 1) {
        if (verb !== 'POST') throw new GoalError(400, 'POST required')
        const goal = await this.store.create(objectBody(body) as GoalInput)
        return { status: 201, body: { goal } }
      }
      const id = parts[1] as string
      if (parts.length === 2) {
        if (verb === 'PUT') {
          const goal = await this.store.update(id, objectBody(body) as GoalInput)
          return { status: 200, body: { goal } }
        }
        if (verb === 'DELETE') {
          await this.store.remove(id)
          return { status: 200, body: { ok: true } }
        }
        throw new GoalError(400, 'PUT or DELETE required')
      }
      if (parts.length === 3 && parts[2] === 'run') {
        if (verb !== 'POST') throw new GoalError(400, 'POST required')
        const wake = await this.scheduler.runNow(id)
        return { status: 200, body: { ok: true, id: wake.id, thread: wake.thread } }
      }
    }
    throw new GoalError(404, 'unknown route')
  }
}
