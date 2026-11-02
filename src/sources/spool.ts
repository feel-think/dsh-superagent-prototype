/**
 * Spool Source kind and plugin entry, exported as `./spool-watch`: local programs hand the agent requests as JSON files in
 * an incoming folder and read its replies as JSON files in a reply folder.
 */
import type { Context } from '@deepseek-ai/cordis'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { isoTime, key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { pause } from './poll.ts'

/** The stable Source id; it appears in Trigger `source`, Thread keys, the `source:spool` settings block and the Source Policy. */
export const SPOOL = 'spool'
/** A sender, business or type id: a lowercase word that stays readable in a Thread key and a Policy row. */
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
/** Empty while not configured, or an absolute path. */
const AbsolutePath = z.string().trim().regex(/^(\/.*)?$/, 'An absolute path')
/** A request id or Thread root: one path segment, safe as a reply file name. */
const Id = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/)
/** A conversation id: one folder name under the reply folder, never `.` or `..`. */
const ConversationId = z.string().regex(/^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,80}$/)
/** A page people open from the panel; only web links, not a `javascript:` or `file:` scheme. */
const WebUrl = z.url().refine(value => /^https?:$/.test(new URL(value).protocol), 'An http(s) URL')
const SenderSchema = z.object({
  id: Slug,
  /** `person` for a program that relays what a person asked, whose messages may be explicit requests; `bot` for one acting on its own. */
  kind: z.enum(['person', 'bot']).default('bot'),
  /** The business a request belongs to when the request does not name one. */
  business: z.string().trim().regex(/^([a-z0-9][a-z0-9-]*)?$/).default(''),
}).strict()
const SpoolConfigSchema = z.object({
  inDir: AbsolutePath.default(''),
  outDir: AbsolutePath.default(''),
  senders: z.array(SenderSchema)
    .refine(senders => new Set(senders.map(sender => sender.id)).size === senders.length, 'Duplicate sender ids')
    .default([]),
  pollSeconds: z.number().int().min(2).max(600).default(5),
}).strict()
export type SpoolConfig = z.infer<typeof SpoolConfigSchema>
export type SpoolSender = SpoolConfig['senders'][number]
/** One request file as a program writes it. Unknown fields are ignored, so a program may add its own bookkeeping. */
export const SpoolMessageSchema = z.looseObject({
  /** Unique per sender; reusing it is a duplicate request, not a new one. */
  id: Id,
  sender: Slug,
  conversation: ConversationId.default('default'),
  /** The request that began this exchange; later messages naming it join its Thread and follow up on its Ticket. */
  thread: Id.optional(),
  text: z.string().trim().min(1).max(20000),
  business: z.string().regex(/^([a-z0-9][a-z0-9-]*)?$/).optional(),
  type: z.string().regex(/^([a-z0-9-]{1,30})?$/).optional(),
  /** Absolute path of a local repository the request is about, for the Executor's environment. */
  repo: AbsolutePath.optional(),
  at: z.iso.datetime({ offset: true }).optional(),
  /** Whether the request is addressed to the agent; false makes a person's message an unaddressed admission case. */
  addressed: z.boolean().default(true),
  url: WebUrl.optional(),
})
export type SpoolMessage = z.infer<typeof SpoolMessageSchema>
/**
 * One request file as a Trigger. Its Thread is the conversation and the message that began the exchange, so later messages
 * naming it follow up. A person's program makes explicit requests; a program acting for itself is at most an inferred candidate.
 */
export function spoolTrigger(message: SpoolMessage, sender: Pick<SpoolSender, 'kind' | 'business'>, outDir: string, now: Date): Trigger {
  const root = message.thread ?? message.id
  const thread = { source: SPOOL, id: `${message.conversation}/${root}` }
  const person = sender.kind === 'person'
  const business = message.business || sender.business
  return {
    id: key(SPOOL, message.sender, message.id), source: SPOOL, threads: [thread],
    actor: { source: SPOOL, id: message.sender }, human: person,
    ...message.addressed ? { addressed: 'direct' as const } : {},
    at: message.at ? isoTime(message.at) : now.toISOString(), text: message.text,
    channel: { source: SPOOL, thread: threadKey(thread), address: { conversation: message.conversation, root, message: message.id,
      sender: message.sender, ...outDir ? { dir: join(outDir, message.conversation) } : {} } },
    ...message.url ? { url: message.url } : {},
    meta: { conversation: message.conversation, sender: message.sender, root, messageId: message.id, ...business ? { business } : {},
      ...message.type ? { type: message.type } : {}, ...message.repo ? { repo: message.repo } : {} },
  }
}
/**
 * Writes a reply as `<outDir>/<conversation>/<message id>.json`, once; the program on the other side reads and removes it.
 * A request received while no reply folder was set has nowhere to be answered, so its replies are dropped as `gone`.
 */
export async function sendSpool(_host: unknown, message: OutboundMessage, now = new Date()): Promise<'sent' | 'gone'> {
  const { conversation, root, message: replyTo, dir } = message.channel.address
  if (!dir) return 'gone'
  if (!Id.safeParse(message.id).success) throw new Error(`The spool reply id ${message.id} is not a file name`)
  await mkdir(dir, { recursive: true })
  const body = JSON.stringify({ id: message.id, kind: message.kind, conversation: conversation ?? '', thread: root ?? '', replyTo: replyTo ?? '',
    ticket: message.ticketId ?? null, text: message.text, at: now.toISOString() }, null, 2)
  const target = join(dir, `${message.id}.json`)
  // Write a temporary file and rename it into place, so a program never reads a half-written reply. An existing target is an
  // earlier attempt's complete reply, which a retry leaves as it is.
  const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(temporary, `${body}\n`)
  try {
    if (!await stat(target).then(() => true, () => false)) await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
  return 'sent'
}
export const spoolKind: SourceKind<SpoolConfig> = {
  kind: SPOOL,
  title: { zh: '投递目录', en: 'Spool' },
  description: { zh: '本机程序把请求写成 JSON 文件放进收取目录，回复以 JSON 文件写进回复目录；发送者要在名单上。',
    en: 'Local programs drop requests as JSON files into the incoming folder and read replies as JSON files from the reply folder; senders must be listed.' },
  schema: SpoolConfigSchema,
  fields: [
    { key: 'inDir', type: 'text', label: { zh: '收取目录', en: 'Incoming folder' },
      hint: { zh: '绝对路径。读过的文件移进 .done，读不了的移进 .bad。程序应先写临时文件再改名，避免半截 JSON 被读到。',
        en: 'An absolute path. Read files move into .done, unreadable ones into .bad. A program should write a temporary file and rename it, so half-written JSON is never read.' } },
    { key: 'outDir', type: 'text', label: { zh: '回复目录', en: 'Reply folder' },
      hint: { zh: '绝对路径。回复写成 <对话>/<消息 id>.json，程序读取后自行删除。',
        en: 'An absolute path. Replies are written as <conversation>/<message id>.json; the program reads and removes them.' } },
    { key: 'senders', type: 'rows', label: { zh: '发送者', en: 'Senders' },
      hint: { zh: '“转达人的请求”的发送者可以发起明确请求；“程序自己”的发送者只能成为推断的候选。身份在这里固定，程序改不了。',
        en: 'A sender that "Relays a person" may originate explicit requests; one acting for "Itself" can only become an inferred candidate. The identity is fixed here, not by the program.' },
      columns: [
        { key: 'id', type: 'text', label: { zh: '发送者 id', en: 'Sender id' }, pattern: '[a-z0-9][a-z0-9\\-]*' },
        { key: 'kind', type: 'select', label: { zh: '代表', en: 'Acts for' }, options: [
          { value: 'person', label: { zh: '转达人的请求', en: 'Relays a person' } }, { value: 'bot', label: { zh: '程序自己', en: 'Itself' } }] },
        { key: 'business', type: 'text', label: { zh: '默认业务', en: 'Default business' }, optional: true }] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 2, max: 600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } }],
  health: [SPOOL],
  scope({ meta }, config) {
    const sender = config.senders.find(item => item.id === meta.sender)
    return sender ? { listened: true, observed: true, row: sender.id } : { listened: false, reason: 'sender_not_listed' }
  },
  channel: {
    // A reply goes only to a listed sender's conversation, inside the reply folder the Source is configured with.
    allowed: (address, config) => config.senders.some(item => item.id === address.sender) && (!address.dir || inside(config.outDir, address.dir)),
    send: (host, message) => sendSpool(host, message),
    link: address => ({ url: fileUrl(address.dir ?? ''),
      label: { zh: `投递目录对话 ${address.conversation ?? ''}`.trim(), en: `Spool conversation ${address.conversation ?? ''}`.trim() } }),
  },
  find: query => ({ threads: /^spool:\S+$/.test(query.trim()) ? [query.trim()] : [], terms: [] }),
  policy: {
    unnamed: { person: { zh: '转达人的发送者', en: 'Person-relaying sender' }, bot: { zh: '程序发送者', en: 'Program sender' } },
    schema: z.object({
      allowed: z.array(z.object({ id: Slug, name: z.string().trim().max(100).optional() }).strict())
        .refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length, 'Duplicate sender ids').default([]),
      bots: z.array(z.object({ id: Slug, name: z.string().trim().max(100).optional() }).strict())
        .refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length, 'Duplicate sender ids').optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders who may originate work' },
        hint: { zh: '只对“转达人的请求”的发送者有效；程序自己的发送者不会成为明确请求。',
          en: 'Applies to senders that relay a person; a program acting for itself never makes an explicit request.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '发送者 id', en: 'Sender id' } },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'bots', type: 'rows', label: { zh: '消息可以成为候选的程序', en: 'Programs whose messages may become candidates' },
        hint: { zh: '“程序自己”的发送者在名单上时，它的消息成为推断的候选，按规则评估；它不能发起明确的请求，也不能停止工单。',
          en: 'A sender acting for itself on this list produces inferred candidates, assessed by the rules; it never makes an explicit request or stops a Ticket.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '发送者 id', en: 'Sender id' } },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单里“转达人的请求”的发送者，消息里 addressed 为 true（默认）。',
      en: 'A sender on the list that relays a person sends a message with addressed true, the default.' },
    rows(stored) {
      const config = SpoolConfigSchema.safeParse(stored)
      // A relaying person's message can fall in any admission cell depending on whether it is on the allowed list and addressed;
      // a program's message is decided by the bots list, never by this table.
      return (config.success ? config.data.senders : []).map(sender => ({ id: sender.id, label: sender.id,
        note: sender.kind === 'person' ? { zh: '转达人的请求', en: 'Relays a person' } : { zh: '程序自己', en: 'Itself' },
        cells: sender.kind === 'person'
          ? { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true }
          : { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } }))
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_SPOOL_SENDER', description: { zh: '接下工单的投递目录发送者；工单不是从投递目录来的时为空',
        en: 'The spool sender that started the Ticket; empty when the Ticket did not start in the spool' } },
      { key: 'DSH_SUPERAGENT_SPOOL_CONVERSATION', description: { zh: '接下工单的投递目录对话；工单不是从投递目录来的时为空',
        en: 'The spool conversation that started the Ticket; empty when the Ticket did not start in the spool' } },
      { key: 'DSH_SUPERAGENT_SPOOL_BUSINESS', description: { zh: '请求或发送者写明的业务 id；没写时为空',
        en: 'The business the request or its sender names; empty when none is named' } },
      { key: 'DSH_SUPERAGENT_SPOOL_TYPE', description: { zh: '请求写明的工作类型；没写时为空',
        en: 'The kind of work the request names; empty when none is named' } },
      { key: 'DSH_SUPERAGENT_SPOOL_REPO', description: { zh: '请求写明的本地仓库绝对路径；没写时为空',
        en: 'Absolute path of the local repository the request names; empty when none is named' } },
    ],
    values: ({ trigger }) => {
      const text = (name: string): string => trigger?.source === SPOOL && typeof trigger.meta[name] === 'string' ? trigger.meta[name] : ''
      return { DSH_SUPERAGENT_SPOOL_SENDER: text('sender'), DSH_SUPERAGENT_SPOOL_CONVERSATION: text('conversation'),
        DSH_SUPERAGENT_SPOOL_BUSINESS: text('business'), DSH_SUPERAGENT_SPOOL_TYPE: text('type'), DSH_SUPERAGENT_SPOOL_REPO: text('repo') }
    },
  },
}
export const name = 'dsh-superagent-spool'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(spoolKind), 'spool: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, spoolKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as Source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(SPOOL, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then the Source reads nothing.
  if (!ctx.configured()) { ctx.report(SPOOL, health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<SpoolConfig>(SPOOL)
    const at = new Date()
    if (!config) ctx.report(SPOOL, health('paused', 'sourceOff'))
    else if (!config.inDir) ctx.report(SPOOL, health('paused', 'spoolNoInDir'))
    else {
      try {
        const round = await readSpool(ctx, config, at)
        failures = 0
        const extra = [round.duplicates ? `${round.duplicates} duplicates` : '', round.unreadable ? `${round.unreadable} unreadable` : '']
          .filter(Boolean).join(', ')
        ctx.report(SPOOL, { state: 'ready', at: at.toISOString(), detail: `${round.received} requests read${extra ? `, ${extra}` : ''}` })
      } catch (error) {
        failures += 1
        // One failed read is retried on the next round; three in a row need a person.
        if (!signal.aborted && failures >= 3) ctx.report(SPOOL, health('error', 'pollFailures', { count: String(failures), error: String(error) }))
      }
    }
    await pause((config?.pollSeconds ?? 5) * 1000, signal)
  }
}
/**
 * Hands each request file to the Engine, then moves it into `.done`; a file that is not a request moves into `.bad`. A read
 * error throws and leaves the file in place, so the next round retries it and health shows a failed poll.
 */
export async function readSpool(ctx: SourceContext, config: SpoolConfig, now: Date): Promise<{ received: number; duplicates: number; unreadable: number }> {
  const round = { received: 0, duplicates: 0, unreadable: 0 }
  const names = await readdir(config.inDir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  for (const name of names.filter(item => item.endsWith('.json') && !item.startsWith('.')).sort()) {
    const file = join(config.inDir, name)
    const parsed = SpoolMessageSchema.safeParse(await readJson(file))
    if (!parsed.success) { round.unreadable += 1; await moveInto(file, join(config.inDir, '.bad')); continue }
    const sender = config.senders.find(item => item.id === parsed.data.sender) ?? { kind: 'bot' as const, business: '' }
    const trigger = spoolTrigger(parsed.data, sender, config.outDir, now)
    // An unlisted sender's request is still received, so the panel shows it as filtered with the reason.
    const result = await ctx.receive(trigger)
    if (result === 'stored') round.received += 1
    else if (result === 'duplicate') round.duplicates += 1
    await moveInto(file, join(config.inDir, '.done'))
    ctx.threads.describe(threadKey(trigger.threads[0]!), { label: parsed.data.conversation,
      facts: { conversation: { value: parsed.data.conversation }, sender: { value: parsed.data.sender } } })
  }
  return round
}
/**
 * The JSON value a file holds, or undefined when its text is not JSON. A read error (EACCES, EISDIR, EMFILE, …) throws, so the
 * round retries instead of moving a request that could not be read into `.bad`.
 */
async function readJson(file: string): Promise<unknown> {
  const text = await readFile(file, 'utf8')
  try { return JSON.parse(text) as unknown } catch { return undefined }
}
/** Moves `file` into `dir`, created when missing, keeping its name; a name already taken there gets a numeric suffix. */
async function moveInto(file: string, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const name = basename(file), extension = extname(name), stem = name.slice(0, name.length - extension.length)
  for (let attempt = 0; ; attempt++) {
    const target = join(dir, attempt ? `${stem}.${attempt}${extension}` : name)
    const taken = await stat(target).then(() => true, () => false)
    if (!taken) { await rename(file, target); return target }
  }
}
/** True when `path` is absolute and lies inside `root` once `..` is resolved, so an address names no folder outside the reply folder. */
function inside(root: string, path: string): boolean {
  if (!root || !isAbsolute(path)) return false
  const rest = relative(resolve(root), resolve(path))
  return rest !== '' && !rest.startsWith('..') && !isAbsolute(rest) && !rest.split(sep).includes('..')
}
/** A `file://` address of an absolute path, for links people open. */
const fileUrl = (path: string): string => path ? pathToFileURL(path).href : ''
