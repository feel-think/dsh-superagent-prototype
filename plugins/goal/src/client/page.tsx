/** The 定时 Goal page: master switch, shared prompt, goal list with inline editing, and a link to the Spool settings. */
import { useCallback, useEffect, useState } from 'react'
import { cronProblem } from '../cron.ts'
import type { T } from './locales.ts'
import { CSS } from './styles.ts'

const ROUTE = '/dsh-superagent-goal'

interface LastRun {
  at: string
  id?: string
  error?: string
}

interface GoalView {
  id: string
  name: string
  cron: string
  prompt: string
  enabled: boolean
  createdAt: string
  updatedAt: string
  nextRun: number | null
  last: LastRun | null
}

interface TransportView {
  configured: boolean
  enabled: boolean
  inDir: string
  senderReady: boolean
  senderKind?: 'person' | 'bot'
  senders: string[]
}

interface StateView {
  now: string
  enabled: boolean
  commonPrompt: string
  goals: GoalView[]
  transport: TransportView
}

interface Draft {
  id?: string
  name: string
  cron: string
  prompt: string
  enabled: boolean
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${ROUTE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-goal-request': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  })
  const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string }
  if (!response.ok) throw new RequestError(response.status, data.error ?? `HTTP ${response.status}`)
  return data as T
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function two(value: number): string {
  return String(value).padStart(2, '0')
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** `今天 09:00` / `明天 09:00` / `11-05 09:00` in the browser's local timezone. */
function formatAt(timestamp: number, t: T): string {
  const date = new Date(timestamp)
  const now = new Date()
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const day = sameDay(date, now) ? t('today') : sameDay(date, tomorrow) ? t('tomorrow') : `${two(date.getMonth() + 1)}-${two(date.getDate())}`
  return `${day} ${two(date.getHours())}:${two(date.getMinutes())}`
}

function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: () => void; disabled?: boolean; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
    className={`sg-switch${checked ? ' on' : ''}`} onClick={onChange}><span className="sg-knob" /></button>
}

function GoalEditor({ t, draft, busy, error, onChange, onSave, onCancel, onDelete, onRun }: {
  t: T
  draft: Draft
  busy: boolean
  error: string
  onChange: (next: Draft) => void
  onSave: () => void
  onCancel: () => void
  onDelete?: () => void
  onRun?: () => void
}) {
  const problem = cronProblem(draft.cron)
  return <div className="sg-edit">
    <div className="sg-field-row">
      <label className="sg-field"><span className="sg-label">{t('name')}</span>
        <input className="sg-input" value={draft.name} placeholder={t('namePlaceholder')} disabled={busy}
          onChange={event => onChange({ ...draft, name: event.target.value })} /></label>
      <label className="sg-field"><span className="sg-label">{t('cron')}</span>
        <input className={`sg-input sg-mono${problem ? ' sg-invalid' : ''}`} value={draft.cron} placeholder={t('cronPlaceholder')} disabled={busy}
          onChange={event => onChange({ ...draft, cron: event.target.value })} /></label>
    </div>
    {problem && <p className="sg-hint sg-error-text">{problem}</p>}
    <p className="sg-hint">{t('cronHint')}</p>
    <label className="sg-field"><span className="sg-label">{t('prompt')}</span>
      <textarea className="sg-textarea" value={draft.prompt} placeholder={t('promptPlaceholder')} disabled={busy}
        onChange={event => onChange({ ...draft, prompt: event.target.value })} /></label>
    <p className="sg-hint">{t('promptHint')}</p>
    {error && <p className="sg-hint sg-error-text">{error}</p>}
    <div className="sg-actions">
      {onDelete && <button type="button" className="sg-btn danger" disabled={busy} onClick={onDelete}>{t('delete')}</button>}
      {onRun && <button type="button" className="sg-btn" disabled={busy || !!problem} onClick={onRun}>{busy ? t('running') : t('run')}</button>}
      <span className="sg-spacer" />
      <button type="button" className="sg-btn" disabled={busy} onClick={onCancel}>{t('cancel')}</button>
      <button type="button" className="sg-btn primary" disabled={busy || !!problem || !draft.name.trim() || !draft.prompt.trim()}
        onClick={onSave}>{busy ? t('saving') : t('save')}</button>
    </div>
  </div>
}

export interface GoalPageProps {
  t: T
  openSpool: () => void
}

export function GoalPage({ t, openSpool }: GoalPageProps) {
  const [state, setState] = useState<StateView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [commonDraft, setCommonDraft] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [formError, setFormError] = useState('')

  const load = useCallback(async (quiet = false): Promise<void> => {
    if (!quiet) setLoading(true)
    try {
      const data = await request<StateView>('GET', '/state')
      setState(data)
      setError('')
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(true), 30_000)
    return () => clearInterval(timer)
  }, [load])

  const run = async (key: string, work: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(key)
    setError('')
    setNotice('')
    try { await work() } catch (failure) { setError(messageOf(failure)) } finally { setBusy('') }
  }

  const toggleMaster = (): void => {
    if (!state) return
    void run('master', async () => {
      const data = await request<StateView>('PUT', '/settings', { enabled: !state.enabled })
      setState(data)
      setNotice(t('saved'))
    })
  }

  const toggleGoal = (goal: GoalView): void => {
    void run(`goal:${goal.id}`, async () => {
      await request('PUT', `/goals/${goal.id}`, { enabled: !goal.enabled })
      await load(true)
    })
  }

  const saveCommon = (): void => {
    if (commonDraft === null) return
    void run('common', async () => {
      const data = await request<StateView>('PUT', '/settings', { commonPrompt: commonDraft })
      setState(data)
      setCommonDraft(null)
      setNotice(t('saved'))
    })
  }

  const saveDraft = (): void => {
    if (!draft) return
    setFormError('')
    void run('draft', async () => {
      if (draft.id) await request('PUT', `/goals/${draft.id}`, { name: draft.name, cron: draft.cron, prompt: draft.prompt })
      else await request('POST', '/goals', { name: draft.name, cron: draft.cron, prompt: draft.prompt })
      setDraft(null)
      setNotice(t('saved'))
      await load(true)
    })
  }

  const deleteDraft = (): void => {
    if (!draft?.id) return
    if (!window.confirm(t('deleteConfirm'))) return
    void run('draft', async () => {
      await request('DELETE', `/goals/${draft.id}`)
      setDraft(null)
      setNotice(t('saved'))
      await load(true)
    })
  }

  const runGoal = (goal: GoalView): void => {
    void run(`run:${goal.id}`, async () => {
      await request('POST', `/goals/${goal.id}/run`)
      setNotice(t('runDone'))
      await load(true)
    })
  }

  if (!state) {
    return <div className="sg-page"><style>{CSS}</style><div className="sg-column">
      {error ? <div className="sg-banner error">{t('loadFailed', { message: error })}
        <button type="button" className="sg-btn" onClick={() => void load()}>{t('retry')}</button></div>
        : <p className="sg-hint">{t('loading')}</p>}
    </div></div>
  }

  const warnings: string[] = []
  if (!state.transport.configured) warnings.push(t('noSpool'))
  else if (!state.transport.enabled) warnings.push(t('spoolOff'))
  else if (!state.transport.senders.includes('goal')) warnings.push(t('noSender'))
  else if (!state.transport.senderReady) warnings.push(t('noPersonSender'))
  const senderState = !state.transport.senders.includes('goal') ? t('noSender')
    : !state.transport.senderReady ? t('noPersonSender') : t('senderReady')

  return <div className="sg-page"><style>{CSS}</style><div className="sg-column"><div className="sg-card">
    <div className="sg-head">
      <div>
        <h1 className="sg-title">{t('title')}</h1>
        <p className="sg-intro">{t('intro')}</p>
      </div>
      <div className="sg-master">
        <span>{state.enabled ? t('masterOn') : t('masterOff')}</span>
        <Switch checked={state.enabled} disabled={busy === 'master'} label={t('master')} onChange={toggleMaster} />
      </div>
    </div>
    <div className="sg-flow">{t('flow')}</div>

    {!state.enabled && <div className="sg-banner">{t('pausedBanner')}</div>}
    {warnings.map(warning => <div className="sg-banner" key={warning}>{warning}</div>)}
    {error && <div className="sg-banner error">{t('loadFailed', { message: error })}</div>}
    {notice && <div className="sg-banner success">{notice}</div>}

    <section className="sg-section">
      <div className="sg-section-head">
        <h2 className="sg-section-title">{t('common')}</h2>
        {commonDraft === null && <button type="button" className="sg-btn" onClick={() => setCommonDraft(state.commonPrompt)}>{t('edit')}</button>}
      </div>
      {commonDraft === null
        ? <pre className="sg-preview">{state.commonPrompt || t('commonEmpty')}</pre>
        : <div className="sg-edit">
          <textarea className="sg-textarea" value={commonDraft} disabled={busy === 'common'}
            onChange={event => setCommonDraft(event.target.value)} />
          <div className="sg-actions">
            <span className="sg-spacer" />
            <button type="button" className="sg-btn" disabled={busy === 'common'} onClick={() => setCommonDraft(null)}>{t('cancel')}</button>
            <button type="button" className="sg-btn primary" disabled={busy === 'common'} onClick={saveCommon}>
              {busy === 'common' ? t('saving') : t('save')}</button>
          </div>
        </div>}
      <p className="sg-hint">{t('commonHint')}</p>
    </section>

    <section className="sg-section">
      <div className="sg-section-head">
        <h2 className="sg-section-title">{t('goals')}</h2>
        <button type="button" className="sg-btn" disabled={!!draft}
          onClick={() => { setDraft({ name: '', cron: '0 9 * * *', prompt: '', enabled: true }); setFormError('') }}>
          {t('add')}</button>
      </div>
      {state.goals.length === 0 && !draft && <p className="sg-empty">{t('empty')}</p>}
      <div className="sg-list">
        {state.goals.map(goal => <div className="sg-row" key={goal.id}>
          <Switch checked={goal.enabled} disabled={busy === `goal:${goal.id}` || !!draft} label={goal.name}
            onChange={() => toggleGoal(goal)} />
          <span className={`sg-dot${goal.enabled ? '' : ' off'}`} />
          <div className="sg-row-main">
            <div className="sg-row-title"><span className="sg-name">{goal.name}</span><code className="sg-cron">{goal.cron}</code></div>
            <div className="sg-row-preview">{goal.prompt}</div>
            <div className="sg-row-meta">
              <span>{t('next')} {goal.nextRun === null ? t('never') : formatAt(goal.nextRun, t)}</span>
              <span>{t('last')} {goal.last ? formatAt(Date.parse(goal.last.at), t) : t('noLast')}</span>
              {goal.last?.error && <span className="sg-error-text" title={goal.last.error}>{t('failed')}</span>}
            </div>
            {draft?.id === goal.id && <GoalEditor t={t} draft={draft} busy={busy === 'draft'} error={formError}
              onChange={setDraft} onSave={saveDraft} onCancel={() => { setDraft(null); setFormError('') }} onDelete={deleteDraft}
              onRun={() => runGoal(goal)} />}
          </div>
          <div className="sg-row-actions">
            <button type="button" className="sg-btn" disabled={!!draft}
              onClick={() => { setDraft({ id: goal.id, name: goal.name, cron: goal.cron, prompt: goal.prompt, enabled: goal.enabled }); setFormError('') }}>
              {t('edit')}</button>
            <button type="button" className="sg-btn" disabled={!!draft || busy === `run:${goal.id}`} onClick={() => runGoal(goal)}>
              {busy === `run:${goal.id}` ? t('running') : t('run')}</button>
          </div>
        </div>)}
        {draft && !draft.id && <div className="sg-row">
          <span className="sg-dot off" />
          <div className="sg-row-main">
            <GoalEditor t={t} draft={draft} busy={busy === 'draft'} error={formError} onChange={setDraft}
              onSave={saveDraft} onCancel={() => { setDraft(null); setFormError('') }} />
          </div>
        </div>}
      </div>
    </section>

    <details className="sg-advanced">
      <summary>{t('transportTitle')}</summary>
      <div className="sg-advanced-body">
        <p className="sg-hint">{t('transportHint')}</p>
        <div className="sg-row-meta">
          <span>{t('spoolPath')}: <span className="sg-mono">{state.transport.inDir || t('never')}</span></span>
          <span>{senderState}</span>
        </div>
        <div className="sg-actions">
          <span className="sg-spacer" />
          <button type="button" className="sg-btn" onClick={openSpool}>{t('openSpool')}</button>
        </div>
      </div>
    </details>

    <p className="sg-foot">{t('footer')}</p>
  </div></div></div>
}
