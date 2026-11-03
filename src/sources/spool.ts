/**
 * Spool Source kind and plugin entry, exported as `./spool-watch`: local programs hand the agent requests as JSON files in
 * an incoming folder and read its replies as JSON files in a reply folder.
 */
import type { Context } from '@deepseek-ai/cordis'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { isoTime, key, threadKey, type OutboundMessage, type ThreadRef, type Trigger } from '../core/index.ts'
import { feishuChatLink } from './feishu-channel.ts'
import { health, sourceContext, type SourceContext, type SourceHost } from './host.ts'
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
/** Where a sender's replies go: the reply folder, a Feishu chat, or both. */
const ReplyTarget = z.enum(['json', 'feishu', 'both'])
const SenderSchema = z.object({
  id: Slug,
  /** `person` for a program that relays what a person asked, whose messages may be explicit requests; `bot` for one acting on its own. */
  kind: z.enum(['person', 'bot']).default('bot'),
  /** The business a request belongs to when the request does not name one. */
  business: z.string().trim().regex(/^([a-z0-9][a-z0-9-]*)?$/).default(''),
  /** Where replies go for this sender; `json` is the reply folder alone. */
  reply: ReplyTarget.default('json'),
  /** The Feishu chat that receives replies when `reply` is `feishu` or `both`; empty when replies stay in the folder. */
  notifyChat: z.string().trim().regex(/^(oc_[a-zA-Z0-9]+)?$/, 'A Feishu chat id').default(''),
}).strict()
  .refine(sender => sender.reply === 'json' || !!sender.notifyChat, 'A Feishu chat id is required when replies go to Feishu')
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
export function spoolTrigger(message: SpoolMessage, sender: Pick<SpoolSender, 'kind' | 'business' | 'reply' | 'notifyChat'>, outDir: string, now: Date): Trigger {
  const root = message.thread ?? message.id
  const thread = { source: SPOOL, id: `${message.conversation}/${root}` }
  const person = sender.kind === 'person'
  const business = message.business || sender.business
  return {
    id: key(SPOOL, message.sender, message.id), source: SPOOL, threads: [thread],
    actor: { source: SPOOL, id: message.sender }, human: person,
    ...message.addressed ? { addressed: 'direct' as const } : {},
    at: message.at ? isoTime(message.at) : now.toISOString(), text: message.text,
    // The address records where this request's replies go while it is open: the folder and/or the Feishu chat.
    channel: { source: SPOOL, thread: threadKey(thread), address: { conversation: message.conversation, root, message: message.id,
      sender: message.sender, ...outDir ? { dir: join(outDir, message.conversation) } : {},
      ...sender.reply !== 'json' ? { reply: sender.reply, notifyChat: sender.notifyChat } : {} } },
    ...message.url ? { url: message.url } : {},
    meta: { conversation: message.conversation, sender: message.sender, root, messageId: message.id, ...business ? { business } : {},
      ...message.type ? { type: message.type } : {}, ...message.repo ? { repo: message.repo } : {} },
  }
}
/** Makes a live Ticket follow a Thread for context; the runtime supplies it so a Source can bind a thread it created. */
export type FollowThread = (ticketId: string, thread: ThreadRef) => boolean
/**
 * Writes a reply as `<outDir>/<conversation>/<message id>.json`, once; the program on the other side reads and removes it.
 * A sender may instead send its replies to a Feishu chat, or to both places: a Feishu reply is a new bot message, because a
 * request has no Feishu message to answer in a thread. The message id keys both deliveries, so a retry writes and posts once.
 * After posting, the Ticket follows the thread that message started, so a person's answer there reaches the Executor without
 * anyone forwarding it. An acknowledgement is the program's bookkeeping, so it stays in the reply folder.
 */
export async function sendSpool(host: Pick<SourceContext, 'commands'> | undefined, message: OutboundMessage,
  follow?: FollowThread, now = new Date()): Promise<'sent' | 'gone'> {
  const { conversation, root, message: replyTo, dir, notifyChat, reply } = message.channel.address
  if (!Id.safeParse(message.id).success) throw new Error(`The spool reply id ${message.id} is not a file name`)
  const route = reply === 'feishu' || reply === 'both' ? reply : 'json'
  const toPerson = message.kind === 'reply' && route !== 'json' && !!notifyChat
  // A reply goes to the folder unless the sender chose the chat alone; other messages are always the program's.
  const toFolder = !!dir && (message.kind !== 'reply' || route !== 'feishu')
  // The person is told before the file is written: a broken reply folder does not hold back a reply written for that person.
  if (toPerson) {
    if (!host) throw new Error('A spool reply to a Feishu chat needs the deployment commands')
    const sent = await host.commands.lark<{ message_id?: string; chat_id?: string }>(
      ['im', '+messages-send', '--chat-id', notifyChat, '--markdown', message.text, '--idempotency-key', message.id])
    // The message is its thread's root; a Feishu Thread key is `<chat>:<root message>`. Results often go out after the
    // Ticket ended, when there is nothing left to follow; any other failure keeps the receipt pending so the send retries.
    if (follow && message.ticketId && sent?.message_id) {
      const chat = sent.chat_id || notifyChat
      try { follow(message.ticketId, { source: 'feishu', id: `${chat}:${sent.message_id}` }) }
      catch (error) {
        const code = (error as { code?: unknown }).code
        if (code !== 'ticketEnded' && code !== 'unknownTicket') throw error
      }
    }
  }
  if (!toFolder) return toPerson ? 'sent' : 'gone'
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
      hint: { zh: '绝对路径。读过的文件移进 .done，格式不对的移进 .bad；读不了的留在原地并在 health 里计为 failing。程序应先写临时文件再改名，避免半截 JSON 被读到。',
        en: 'An absolute path. Read files move into .done, files that are not a valid request into .bad; unreadable ones stay and count as failing. A program should write a temporary file and rename it, so half-written JSON is never read.' } },
    { key: 'outDir', type: 'text', label: { zh: '回复目录', en: 'Reply folder' },
      hint: { zh: '绝对路径。回复写成 <对话>/<消息 id>.json，程序读取后自行删除。',
        en: 'An absolute path. Replies are written as <conversation>/<message id>.json; the program reads and removes them.' } },
    { key: 'senders', type: 'rows', label: { zh: '发送者', en: 'Senders' },
      hint: { zh: '“转达人的请求”的发送者可以发起明确请求；“程序自己”的发送者只能成为推断的候选。身份在这里固定，程序改不了。回复到可选回复目录、飞书会话或两者；选飞书时填 chat_id，消息以机器人新消息发出，确认（ack）仍只写目录。',
        en: 'A sender that "Relays a person" may originate explicit requests; one acting for "Itself" can only become an inferred candidate. The identity is fixed here, not by the program. Replies may go to the reply folder, a Feishu chat, or both; a Feishu chat is a chat id, replies are new bot messages, and acknowledgements stay in the folder.' },
      columns: [
        { key: 'id', type: 'text', label: { zh: '发送者 id', en: 'Sender id' }, pattern: '[a-z0-9][a-z0-9\\-]*' },
        { key: 'kind', type: 'select', label: { zh: '代表', en: 'Acts for' }, options: [
          { value: 'person', label: { zh: '转达人的请求', en: 'Relays a person' } }, { value: 'bot', label: { zh: '程序自己', en: 'Itself' } }] },
        { key: 'reply', type: 'select', label: { zh: '回复到', en: 'Reply to' }, options: [
          { value: 'json', label: { zh: '回复目录', en: 'JSON folder' } }, { value: 'feishu', label: { zh: '飞书会话', en: 'Feishu chat' } },
          { value: 'both', label: { zh: '两者', en: 'Both' } }] },
        { key: 'notifyChat', type: 'text', label: { zh: '飞书 chat_id', en: 'Feishu chat id' }, pattern: 'oc_[a-zA-Z0-9]+', optional: true },
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
    send: sendSpool,
    // A reply whose sender chose Feishu alone has no file to open; its link opens the chat instead.
    link: (address, links) => address.reply === 'feishu' && address.notifyChat
      ? { url: feishuChatLink(links.feishu?.brand ?? 'feishu', address.notifyChat), label: { zh: '飞书会话', en: 'Feishu chat' } }
      : { url: fileUrl(address.dir ?? ''),
        label: { zh: `投递目录对话 ${address.conversation ?? ''}`.trim(), en: `Spool conversation ${address.conversation ?? ''}`.trim() } },
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
/** The Source kind, with the runtime's context-follow operation used by the Feishu reply path (absent in a bare host). */
export function spoolKindWith(follow?: FollowThread): SourceKind<SpoolConfig> {
  return { ...spoolKind, channel: { ...spoolKind.channel!, send: (host, message) => sendSpool(host, message, follow) } }
}
/**
 * The running app declares `engine` publicly but `SourceHost` does not, and a Source context has no follow operation, so
 * the plugin reads that one operation defensively: without it, replies still go out, just without the automatic answer loop.
 */
type FollowHost = SourceHost & { engine?: { followForContext?: (ticketId: string, thread: ThreadRef) => boolean } }
export const name = 'dsh-superagent-spool'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  const host = ctx.orchestrator as FollowHost
  const follow: FollowThread | undefined = typeof host.engine?.followForContext === 'function'
    ? (ticketId, thread) => host.engine!.followForContext!(ticketId, thread) : undefined
  const kind = spoolKindWith(follow)
  ctx.effect(() => ctx.orchestrator.sources.register(kind), 'spool: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, kind)
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
        const extra = [round.duplicates ? `${round.duplicates} duplicates` : '', round.unreadable ? `${round.unreadable} unreadable` : '',
          round.failed ? `${round.failed} failing` : ''].filter(Boolean).join(', ')
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
 * Hands each request file to the Engine, then moves it into `.done`; a file that is not a request moves into `.bad`. A file
 * that cannot be read is left in place and counted as failing; the other files are still read, so one bad file never blocks
 * the folder. Only a `readdir` failure throws the round.
 */
export async function readSpool(ctx: SourceContext, config: SpoolConfig, now: Date): Promise<{ received: number; duplicates: number; unreadable: number; failed: number }> {
  const round = { received: 0, duplicates: 0, unreadable: 0, failed: 0 }
  const names = await readdir(config.inDir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  for (const name of names.filter(item => item.endsWith('.json') && !item.startsWith('.')).sort()) {
    const file = join(config.inDir, name)
    let value: unknown
    try {
      value = await readJson(file)
    } catch {
      // Permission, I/O or a directory named like a request: leave it and try again next round.
      round.failed += 1
      continue
    }
    const parsed = SpoolMessageSchema.safeParse(value)
    if (!parsed.success) { round.unreadable += 1; await moveInto(file, join(config.inDir, '.bad')); continue }
    const sender = config.senders.find(item => item.id === parsed.data.sender) ?? { kind: 'bot' as const, business: '', reply: 'json' as const, notifyChat: '' }
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
 * The JSON value a file holds, or undefined when its text is not JSON. A read error (EACCES, EISDIR, EMFILE, …) throws, so
 * `readSpool` counts that file as failing and leaves it for the next round.
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
