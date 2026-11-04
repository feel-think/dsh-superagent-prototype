/** The Spool transport: read its configured folder and write one goal wake as JSON. */
import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertComposedLength, composeGoalText } from './prompt.ts'
import type { Goal, OrchestratorHost, SpoolConfig } from './types.ts'

/** The stable sender id every goal wake uses; it must exist in the Spool Source's senders. */
export const GOAL_SENDER = 'goal'
/** The Spool conversation folder that receives goal replies; all goals share it. */
export const GOAL_CONVERSATION = 'goal'

export interface TransportState {
  /** The Spool Source is installed and has an incoming folder. */
  configured: boolean
  /** The Source instance is enabled. */
  enabled: boolean
  inDir: string
  /** The `goal` sender exists and is configured as a person (the final design); a bot would only be a candidate. */
  senderReady: boolean
  /** The `goal` sender's configured kind, when it exists. */
  senderKind?: 'person' | 'bot'
  senders: string[]
}

/** Read the Spool Source configuration through the orchestrator service; never writes it. */
export function transportOf(host: Pick<OrchestratorHost, 'sources'>): TransportState {
  const instance = host.sources.instance<SpoolConfig>('spool')
  if (!instance) return { configured: false, enabled: false, inDir: '', senderReady: false, senders: [] }
  const inDir = typeof instance.config.inDir === 'string' ? instance.config.inDir : ''
  const configuredSenders = Array.isArray(instance.config.senders) ? instance.config.senders : []
  const senders = configuredSenders.map(sender => sender.id)
  const goal = configuredSenders.find(sender => sender.id === GOAL_SENDER)
  const senderKind = goal?.kind
  return {
    configured: inDir !== '',
    enabled: instance.enabled,
    inDir,
    senderReady: senderKind === 'person',
    ...senderKind ? { senderKind } : {},
    senders,
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** ISO 8601 with the process's local offset, matching the Spool Source's request format. */
export function isoLocal(date: Date): string {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const absolute = Math.abs(offset)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
}

/** The fixed Thread root of one goal: every wake for it joins the same Spool thread. */
export function goalThread(goal: Pick<Goal, 'id'>): string {
  return `goal-${goal.id}`
}

/** A request id unique per sender and safe as a file name: goal id + millisecond time + random suffix. */
export function wakeId(goal: Pick<Goal, 'id'>, now: Date): string {
  return `goal-${goal.id}-${now.getTime().toString(36)}${randomBytes(2).toString('hex')}`
}

export interface Wake {
  file: string
  id: string
  thread: string
  text: string
}

/**
 * Write one wake into the Spool incoming folder. The fixed `thread` makes the
 * first wake create a Ticket and every later wake follow up on it. The file is
 * written beside the folder and renamed into place, so the Source never reads
 * half-written JSON.
 */
export async function writeWake(inDir: string, goal: Goal, common: string, now: Date): Promise<Wake> {
  const id = wakeId(goal, now)
  const thread = goalThread(goal)
  const text = assertComposedLength(composeGoalText(common, goal), `goal "${goal.name}" plus the shared prompt`)
  const body = {
    id,
    sender: GOAL_SENDER,
    conversation: GOAL_CONVERSATION,
    thread,
    text,
    type: 'goal',
    addressed: true,
    at: isoLocal(now),
  }
  await mkdir(inDir, { recursive: true, mode: 0o700 })
  const target = join(inDir, `${id}.json`)
  const temporary = join(inDir, `.${id}.${process.pid}.${randomBytes(2).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
  return { file: target, id, thread, text }
}
