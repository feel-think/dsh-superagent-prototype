import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { apply as applySpool, readSpool, sendSpool, spoolKind, spoolTrigger, SpoolMessageSchema, type SpoolConfig }
  from '../src/sources/spool.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const healthOf = new WeakMap<SourceRegistry, HealthBoard>()
function emptyRegistry(): SourceRegistry {
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
  healthOf.set(sources, board)
  return sources
}
function host(overrides: Partial<SourceContextDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'spool-'))
  dirs.push(dir)
  const config: SpoolConfig = { inDir: join(dir, 'in'), outDir: join(dir, 'out'), pollSeconds: 5,
    senders: [{ id: 'relay', kind: 'person', business: 'general' }, { id: 'monitor', kind: 'bot', business: 'ops' }] }
  const store = new Store(join(dir, 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ eval: { mode: 'auto' }, sources: { spool: { enabled: true, config } },
    policy: { sources: { spool: { allowed: [{ id: 'relay' }], bots: [{ id: 'monitor' }] } } } }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  healthOf.set(sources, board)
  sources.register(spoolKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment: testDeployment(), ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  const ctx = sourceContextOf(parts, spoolKind)
  const health = overrides.sources ? healthOf.get(overrides.sources)!.all : board.all
  mkdirSync(config.inDir, { recursive: true })
  return { ...value, ...ctx, ctx, health, store, engine, commands, receive, config, dir, board, sources: parts.sources, assessor }
}
const drop = (dir: string, name: string, body: unknown): void => {
  writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))
}
const request = (fields: Record<string, unknown> = {}) => ({ id: 'm1', sender: 'relay', conversation: 'chief', text: '整理本周的周报', ...fields })
describe('the spool Source', () => {
  it('maps a request to a stable Trigger on its conversation and root, with the sender fixed by configuration', () => {
    const now = new Date('2026-11-02T00:00:00.000Z')
    const trigger = spoolTrigger(SpoolMessageSchema.parse(request({ business: 'content' })), { kind: 'person', business: 'general' },
      '/srv/spool/out', now)
    expect(trigger).toMatchObject({ id: key('spool', 'relay', 'm1'), source: 'spool', threads: [{ source: 'spool', id: 'chief/m1' }],
      actor: { source: 'spool', id: 'relay' }, human: true, addressed: 'direct', at: now.toISOString(), text: '整理本周的周报',
      channel: { source: 'spool', thread: 'spool:chief/m1', address: { conversation: 'chief', root: 'm1', message: 'm1', sender: 'relay',
        dir: '/srv/spool/out/chief' } },
      meta: { conversation: 'chief', sender: 'relay', root: 'm1', messageId: 'm1', business: 'content' } })
    // A follow-up names the root; the sender's default business applies when the request names none, and a program is not a person.
    const followup = spoolTrigger(SpoolMessageSchema.parse(request({ id: 'm2', sender: 'monitor', thread: 'm1', addressed: false })),
      { kind: 'bot', business: 'ops' }, '', now)
    expect(followup).toMatchObject({ id: key('spool', 'monitor', 'm2'), threads: [{ source: 'spool', id: 'chief/m1' }], human: false,
      meta: { root: 'm1', messageId: 'm2', business: 'ops' }, channel: { address: { root: 'm1', message: 'm2' } } })
    expect(followup.addressed).toBeUndefined()
    expect(followup.channel!.address.dir).toBeUndefined()
    // The default conversation is `default`, and a request may carry its own time and URL.
    const plain = spoolTrigger(SpoolMessageSchema.parse({ id: 'm3', sender: 'relay', text: 'hi', at: '2026-11-01T08:00:00+08:00',
      url: 'https://example.com/x', repo: '/srv/code' }), { kind: 'person', business: '' }, '/out', now)
    expect(plain).toMatchObject({ at: '2026-11-01T00:00:00.000Z', url: 'https://example.com/x', threads: [{ id: 'default/m3' }],
      meta: { conversation: 'default', repo: '/srv/code' } })
    expect(plain.meta.business).toBeUndefined()
    // A program that sends an empty business still falls back to the sender's default.
    const empty = spoolTrigger(SpoolMessageSchema.parse(request({ id: 'm4', business: '' })), { kind: 'person', business: 'general' }, '', now)
    expect(empty.meta.business).toBe('general')
    // A conversation names one folder, and a link opens a web page, not a `javascript:` or `file:` scheme.
    expect(() => SpoolMessageSchema.parse(request({ conversation: '..' }))).toThrow()
    expect(() => SpoolMessageSchema.parse(request({ url: 'javascript:alert(1)' }))).toThrow()
  })
  it('reads each request once, filters an unlisted sender, sets aside what is not a request, and moves every file it read', async () => {
    const h = host()
    drop(h.config.inDir, 'a.json', request({ business: 'content' }))
    drop(h.config.inDir, 'b.json', { id: 'm2', sender: 'stranger', text: '帮我做点事' })
    drop(h.config.inDir, 'c.json', '{not json')
    drop(h.config.inDir, 'ignored.txt', 'not a request')
    drop(h.config.inDir, '.hidden.json', request({ id: 'm3' }))
    expect(await readSpool(h.ctx, h.config, new Date('2026-11-02T00:00:00.000Z'))).toEqual({ received: 1, duplicates: 0, unreadable: 1 })
    expect(h.engine.candidate(key('spool', 'relay', 'm1'))?.strength).toBe('explicit')
    expect(h.store.triggers.disposition(key('spool', 'stranger', 'm2'))?.filtered).toEqual({ code: 'sender_not_listed' })
    expect(readdirSync(join(h.config.inDir, '.done')).sort()).toEqual(['a.json', 'b.json'])
    expect(readdirSync(join(h.config.inDir, '.bad'))).toEqual(['c.json'])
    expect(h.store.threads.get('spool:chief/m1')?.meta).toMatchObject({ label: 'chief',
      facts: { conversation: { value: 'chief' }, sender: { value: 'relay' } } })
    // Reusing a request id is a duplicate, and the file is still moved without replacing the first `.done` file.
    drop(h.config.inDir, 'a.json', request({ business: 'content' }))
    expect(await readSpool(h.ctx, h.config, new Date())).toEqual({ received: 0, duplicates: 1, unreadable: 0 })
    expect(readdirSync(join(h.config.inDir, '.done')).sort()).toEqual(['a.1.json', 'a.json', 'b.json'])
    h.store.close()
  })
  it('leaves a request it cannot read in place, so the round fails and retries instead of setting it aside', async () => {
    const h = host()
    // A directory named like a request is an IO error on every platform, like an unreadable file.
    mkdirSync(join(h.config.inDir, 'locked.json'))
    await expect(readSpool(h.ctx, h.config, new Date())).rejects.toThrow()
    expect(readdirSync(h.config.inDir)).toEqual(['locked.json'])
    expect(existsSync(join(h.config.inDir, '.bad'))).toBe(false)
    h.store.close()
  })
  it('admits a program acting for itself only as an inferred candidate of a listed bot', async () => {
    const h = host()
    drop(h.config.inDir, 'alert.json', { id: 'x1', sender: 'monitor', conversation: 'alerts', text: 'site down' })
    expect(await readSpool(h.ctx, h.config, new Date('2026-11-02T00:00:00.000Z'))).toEqual({ received: 1, duplicates: 0, unreadable: 0 })
    const trigger = spoolTrigger(SpoolMessageSchema.parse({ id: 'x1', sender: 'monitor', conversation: 'alerts', text: 'site down' }),
      { kind: 'bot', business: 'ops' }, h.config.outDir, new Date())
    expect(trigger).toMatchObject({ human: false, addressed: 'direct' })
    expect(h.engine.candidate(trigger.id)?.strength).toBe('inferred')
    expect(h.assessor.request).toHaveBeenCalledTimes(1)
    h.store.close()
  })
  it('writes each reply once into its conversation folder, and has nowhere to answer without one', async () => {
    const h = host()
    const dir = join(h.config.outDir, 'chief')
    const message = (address: Record<string, string>, id = 'r1'): OutboundMessage => ({ id, kind: 'reply', text: '周报在 outputs/weekly.md', ticketId: 't1',
      channel: { source: 'spool', thread: 'spool:chief/m1', address } })
    const address = { conversation: 'chief', root: 'm1', message: 'm1', sender: 'relay', dir }
    expect(await sendSpool(undefined, message(address))).toBe('sent')
    expect(await sendSpool(undefined, message(address))).toBe('sent')
    expect(JSON.parse(readFileSync(join(dir, 'r1.json'), 'utf8'))).toMatchObject({ id: 'r1', kind: 'reply', conversation: 'chief', thread: 'm1',
      replyTo: 'm1', ticket: 't1', text: '周报在 outputs/weekly.md' })
    expect(readdirSync(dir)).toEqual(['r1.json'])
    expect(await sendSpool(undefined, message({ conversation: 'chief', sender: 'relay' }))).toBe('gone')
    await expect(sendSpool(undefined, message(address, '../escape'))).rejects.toThrow('not a file name')
    expect(spoolKind.channel!.allowed!(address, h.config)).toBe(true)
    expect(spoolKind.channel!.allowed!({ ...address, dir: '/tmp/elsewhere' }, h.config)).toBe(false)
    expect(spoolKind.channel!.allowed!({ ...address, sender: 'stranger' }, h.config)).toBe(false)
    h.store.close()
  })
  it('explains filtering, policy rows and the variables a Ticket receives', () => {
    const h = host()
    expect(spoolKind.scope!({ meta: { sender: 'stranger' } }, h.config)).toEqual({ listened: false, reason: 'sender_not_listed' })
    expect(spoolKind.scope!({ meta: { sender: 'relay' } }, h.config)).toEqual({ listened: true, observed: true, row: 'relay' })
    expect(h.sources.policyPart('spool')).toEqual({ allowed: [{ id: 'relay' }], bots: [{ id: 'monitor' }], admission: {} })
    expect(spoolKind.policy!.rows!(h.config)).toEqual([
      { id: 'relay', label: 'relay', note: { zh: '转达人的请求', en: 'Relays a person' },
        cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } },
      { id: 'monitor', label: 'monitor', note: { zh: '程序自己', en: 'Itself' },
        cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } },
    ])
    expect(spoolKind.find!('spool:chief/m1')).toEqual({ threads: ['spool:chief/m1'], terms: [] })
    const trigger = spoolTrigger(SpoolMessageSchema.parse(request({ business: 'content', type: 'research', repo: '/srv/code' })),
      { kind: 'person', business: 'general' }, '/out', new Date('2026-11-02T00:00:00.000Z'))
    expect(spoolKind.environment!.values({ deployment: testDeployment(), config: h.config, trigger })).toEqual({
      DSH_SUPERAGENT_SPOOL_SENDER: 'relay', DSH_SUPERAGENT_SPOOL_CONVERSATION: 'chief', DSH_SUPERAGENT_SPOOL_BUSINESS: 'content',
      DSH_SUPERAGENT_SPOOL_TYPE: 'research', DSH_SUPERAGENT_SPOOL_REPO: '/srv/code' })
    expect(spoolKind.environment!.values({ deployment: testDeployment(), config: h.config, trigger: { ...trigger, source: 'github' } }))
      .toMatchObject({ DSH_SUPERAGENT_SPOOL_SENDER: '', DSH_SUPERAGENT_SPOOL_CONVERSATION: '' })
    h.store.close()
  })
  it('registers its kind on apply, waits for setup, and turns a failure escaping its loop into Source health', async () => {
    const sources = emptyRegistry()
    const h = host({ sources, configured: () => false })
    const disposers: (() => unknown)[] = []
    applySpool({ orchestrator: h, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    await vi.waitFor(() => expect(h.health.spool).toMatchObject({ state: 'paused', code: 'setupPending' }))
    expect(sources.kind('spool')).toBe(spoolKind)
    for (const dispose of disposers) await dispose()
    expect(sources.kind('spool')).toBeUndefined()

    const failing = host({ sources: emptyRegistry(), ready: Promise.resolve().then(() => { throw new Error('disk gone') }) })
    const failedDisposers: (() => unknown)[] = []
    applySpool({ orchestrator: failing, effect: (effect: () => () => unknown) => { failedDisposers.push(effect()) } } as never)
    await vi.waitFor(() => expect(failing.health.spool).toMatchObject({ state: 'error', detail: expect.stringContaining('disk gone') }))
    for (const dispose of failedDisposers) await dispose()
    h.store.close(); failing.store.close()
  })
})
