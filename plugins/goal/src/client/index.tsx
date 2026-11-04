/** Browser half: a left-sidebar entry and its 定时 Goal page. */
import { GoalPage } from './page.tsx'
import { en, zh } from './locales.ts'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

const NS = 'dshSuperagentGoal'
const PANEL = 'dsh-superagent-goal'

interface SlotRegistration {
  inject(name: string, factory: () => unknown): void
  register(spec: Record<string, unknown>, component: unknown): () => void
}

interface ClientContext {
  readonly slots: SlotRegistration
  readonly locale: {
    register(namespace: string, locale: string, dictionary: Record<string, string>): () => void
    bind(namespace: string): Translate<string>
  }
  readonly layout: { selectPanel(id: string): void }
  effect(factory: () => unknown, label?: string): void
}

function GoalIcon({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="8.6" r="4.9" />
    <path d="M8 5.7v2.9l1.9 1.1" />
    <path d="M8 1.4v1.4M8 14.4v-1.4M1.4 8.6H2.8M13.2 8.6h1.4" opacity=".6" />
  </svg>
}

/** The Superagent panel's own sessionStorage location key; its settings route has a source focus. */
const SUPERAGENT_ROUTE_KEY = 'dsh-superagent/route'

/** Open the Superagent panel on Settings → Sources → spool; the goal page never edits those values. */
function openSpoolSettings(ctx: ClientContext): void {
  try {
    sessionStorage.setItem(SUPERAGENT_ROUTE_KEY, JSON.stringify({
      route: { page: 'settings', query: { group: 'source', source: 'spool' } },
      stack: [],
      group: 'source',
    }))
  } catch {
    // Storage is a convenience; the panel switch below still works without it.
  }
  try { ctx.layout.selectPanel('dsh-superagent') } catch { /* the Superagent panel is not mounted */ }
}

export const inject = ['slots', 'locale', 'layout']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const disposeZh = ctx.locale.register(NS, 'zh', zh)
    const disposeEn = ctx.locale.register(NS, 'en', en)
    return () => { disposeZh(); disposeEn() }
  }, 'dsh-superagent-goal: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: PANEL, locale: NS, inject: () => ({}) },
    (props: { t?: Translate<string> }) => <GoalPage t={props.t ?? t} openSpool={() => openSpoolSettings(ctx)} />,
  ))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: PANEL, order: 12, label: () => t('panel'), locale: NS },
    GoalIcon,
  ))
}
