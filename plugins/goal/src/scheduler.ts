/**
 * The scheduler: every five seconds it reads `goals.json` and, for each enabled
 * entry whose next cron minute has arrived, writes one Spool wake. A missed
 * minute is skipped, never replayed; a failed write is recorded and the next
 * occurrence is scheduled normally.
 */
import { nextRunAt } from './cron.ts'
import type { GoalStore } from './store.ts'
import { transportOf, writeWake, type Wake } from './spool.ts'
import { GoalError, type Goal, type GoalsFile, type OrchestratorHost } from './types.ts'

const TICK_MS = 5_000

export interface LastRun {
  at: string
  id?: string
  error?: string
}

interface NextRun {
  cron: string
  at: number | null
}

export interface SchedulerHost {
  readonly orchestrator: OrchestratorHost
  info(message: string): void
  warn(message: string): void
}

/** Scheduling state for the panel: the in-memory last attempt, not a run table. */
export class GoalScheduler {
  private timer: NodeJS.Timeout | undefined
  private busy = false
  private stopped = false
  private readonly next = new Map<string, NextRun>()
  private readonly last = new Map<string, LastRun>()
  private problem: string | undefined

  constructor(
    private readonly store: GoalStore,
    private readonly host: SchedulerHost,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    this.stopped = false
    void this.tick()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  lastOf(id: string): LastRun | undefined {
    return this.last.get(id)
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    if (message !== this.problem) {
      this.problem = message
      this.host.warn(`goal scheduler: ${message}`)
    }
  }

  private async load(): Promise<{ file: GoalsFile; common: string } | undefined> {
    try {
      const file = await this.store.read()
      const common = await this.store.readCommon()
      this.problem = undefined
      return { file, common }
    } catch (error) {
      this.report(error)
      return undefined
    }
  }

  async tick(): Promise<void> {
    if (this.busy || this.stopped) return
    this.busy = true
    try {
      const loaded = await this.load()
      if (!loaded) return
      const now = this.now()
      if (!loaded.file.enabled) {
        // A paused scheduler does not queue missed minutes; re-enabling starts from now.
        this.next.clear()
        return
      }
      const ids = new Set(loaded.file.goals.map(goal => goal.id))
      for (const id of this.next.keys()) if (!ids.has(id)) this.next.delete(id)
      for (const goal of loaded.file.goals) {
        if (!goal.enabled) { this.next.delete(goal.id); continue }
        const scheduled = this.next.get(goal.id)
        if (!scheduled || scheduled.cron !== goal.cron) {
          this.next.set(goal.id, { cron: goal.cron, at: nextRunAt(goal.cron, now) })
          continue
        }
        if (scheduled.at !== null && now.getTime() >= scheduled.at) {
          await this.fire(goal, loaded.common, now)
          this.next.set(goal.id, { cron: goal.cron, at: nextRunAt(goal.cron, this.now()) })
        }
      }
    } finally {
      this.busy = false
    }
  }

  private async fire(goal: Goal, common: string, now: Date): Promise<void> {
    const transport = transportOf(this.host.orchestrator)
    if (!transport.configured) {
      this.last.set(goal.id, { at: now.toISOString(), error: 'the Spool Source has no incoming folder' })
      return
    }
    if (!transport.enabled) {
      this.last.set(goal.id, { at: now.toISOString(), error: 'the Spool Source is off' })
      return
    }
    if (!transport.senderReady) {
      this.last.set(goal.id, { at: now.toISOString(), error: 'the Spool sender goal must be configured as a person' })
      return
    }
    try {
      const wake = await writeWake(transport.inDir, goal, common, now)
      this.last.set(goal.id, { at: now.toISOString(), id: wake.id })
      this.host.info(`goal scheduler: wrote ${wake.id} for ${goal.id}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.last.set(goal.id, { at: now.toISOString(), error: message })
      this.report(error)
    }
  }

  /** Write a wake immediately without changing the next scheduled minute. */
  async runNow(id: string): Promise<Wake> {
    const file = await this.store.read()
    const goal = file.goals.find(item => item.id === id)
    if (!goal) throw new GoalError(404, `goal not found: ${id}`)
    const transport = transportOf(this.host.orchestrator)
    if (!transport.configured) throw new GoalError(409, 'the Spool Source has no incoming folder')
    if (!transport.enabled) throw new GoalError(409, 'the Spool Source is off')
    if (!transport.senderReady) throw new GoalError(409, 'the Spool sender goal must be configured as a person')
    const common = await this.store.readCommon()
    const now = this.now()
    const wake = await writeWake(transport.inDir, goal, common, now)
    this.last.set(goal.id, { at: now.toISOString(), id: wake.id })
    return wake
  }
}
