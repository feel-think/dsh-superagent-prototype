/** Shared types for the goal plugin's server half; no runtime dependency on dsh-superagent. */

/** One scheduled goal entry as stored in `goals.json`. */
export interface Goal {
  id: string
  name: string
  /** Five-field cron expression: minute hour day-of-month month day-of-week. */
  cron: string
  /** The entry's own prompt; composed after the shared prompt on every wake. */
  prompt: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

/** The whole goals file. `enabled` is the panel's master switch. */
export interface GoalsFile {
  version: 1
  enabled: boolean
  goals: Goal[]
}

/** The Spool Source configuration this plugin reads; only fields it uses. */
export interface SpoolConfig {
  inDir: string
  senders: { id: string; kind?: 'person' | 'bot' }[]
  [key: string]: unknown
}

/** A configured Source instance as the orchestrator service reports it. */
export interface SourceInstance<C> {
  id: string
  kind: string
  enabled: boolean
  config: C
}

/**
 * The part of dsh-superagent's `orchestrator` service the plugin uses.
 * Structural, so the plugin stays a separate package instead of importing SA internals.
 */
export interface OrchestratorHost {
  readonly stateDir: string
  readonly sources: {
    instance<C extends Record<string, unknown>>(id: string): SourceInstance<C> | undefined
  }
}

/** Minimal server response surface used by the route tests. */
export interface ResponseLike {
  writeHead(status: number, headers: Record<string, string>): void
  end(body?: string): void
}

/** Minimal request surface used by the route handler. */
export interface RequestLike {
  readonly method?: string
  readonly url?: string
  readonly headers: Record<string, string | string[] | undefined>
  on(event: 'data', listener: (chunk: unknown) => void): void
  on(event: 'end', listener: () => void): void
  on(event: 'error', listener: (error: unknown) => void): void
}

/** An error with a user-facing message and an HTTP status. */
export class GoalError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 500, message: string) {
    super(message)
    this.name = 'GoalError'
  }
}
