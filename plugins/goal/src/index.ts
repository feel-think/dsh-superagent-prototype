/**
 * Server half: mount the goal scheduler and its same-origin panel API beside
 * dsh-superagent. The plugin reads the Spool Source configuration through the
 * `orchestrator` service and writes wakes into its incoming folder; it never
 * edits the Spool Source or dsh-superagent's own settings.
 */
import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GoalApi, ROUTE } from './api.ts'
import { GoalScheduler } from './scheduler.ts'
import { GoalStore } from './store.ts'
import { transportOf } from './spool.ts'
import { GoalError, type OrchestratorHost, type RequestLike, type ResponseLike } from './types.ts'

export const name = 'dsh-superagent-goal'
export const inject = ['orchestrator', 'webServer']

const MAX_BODY = 256 * 1024

interface PluginContext extends Context {
  readonly orchestrator: OrchestratorHost
  readonly webServer: {
    readonly port: number
    register(input: { kind: 'prefix'; path: string; handler: (req: RequestLike, res: ResponseLike) => Promise<void> | void }): () => void
  }
}

function header(req: RequestLike, name: string): string {
  const value = req.headers[name]
  return Array.isArray(value) ? value.join(', ') : value ?? ''
}

/** The loopback host check dsh-superagent's own management route uses; it also resists DNS rebinding. */
function loopbackHost(req: RequestLike, port: number): boolean {
  const host = header(req, 'host')
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}

async function readBody(req: RequestLike): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += bytes.length
      if (size > MAX_BODY) {
        reject(new GoalError(400, `request exceeds ${MAX_BODY} bytes`))
        return
      }
      chunks.push(bytes)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) { resolve(undefined); return }
      try { resolve(JSON.parse(text)) } catch { reject(new GoalError(400, 'the request body is not JSON')) }
    })
    req.on('error', error => reject(error))
  })
}

function send(res: ResponseLike, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

/**
 * The panel sends this header, which a cross-site form cannot set and a
 * cross-origin fetch cannot send without a preflight this server never grants.
 * No Origin/Host comparison, so the page also works behind the deployment's
 * reverse proxy.
 */
function panelRequest(req: RequestLike): boolean {
  return header(req, 'x-goal-request') === '1'
}

export async function apply(ctx: PluginContext): Promise<void> {
  // The first-use shared prompt is a data file, not prompt text embedded in TypeScript.
  const defaultCommon = await readFile(new URL('../defaults/common.md', import.meta.url), 'utf8')
  const store = new GoalStore(join(ctx.orchestrator.stateDir, 'goal'), defaultCommon)
  await store.ensure()
  const scheduler = new GoalScheduler(store, {
    orchestrator: ctx.orchestrator,
    info: message => ctx.logger.info(message),
    warn: message => ctx.logger.warn(message),
  })
  const api = new GoalApi(store, scheduler, () => transportOf(ctx.orchestrator))
  const handler = async (req: RequestLike, res: ResponseLike): Promise<void> => {
    try {
      if (!panelRequest(req) || !loopbackHost(req, ctx.webServer.port)) {
        send(res, 403, { error: 'a loopback goal request with the panel header is required' }); return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== ROUTE && !url.pathname.startsWith(`${ROUTE}/`)) {
        send(res, 404, { error: 'unknown route' })
        return
      }
      const path = url.pathname.slice(ROUTE.length) || '/'
      const method = req.method ?? 'GET'
      const body = method === 'POST' || method === 'PUT' ? await readBody(req) : undefined
      const result = await api.handle(method, path, body)
      send(res, result.status, result.body)
    } catch (error) {
      if (error instanceof GoalError) { send(res, error.status, { error: error.message }); return }
      ctx.logger.warn('dsh-superagent-goal: %s', error instanceof Error ? error.message : String(error))
      send(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  ctx.effect(() => {
    scheduler.start()
    return () => scheduler.stop()
  }, 'dsh-superagent-goal: scheduler')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }), 'dsh-superagent-goal: route')
}
