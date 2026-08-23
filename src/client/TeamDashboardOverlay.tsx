import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import {
  Button,
  IconRefreshOutline16,
  Pill,
  StateDot,
  useAnchoredPosition,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'
import type { TeamDashboardController, TeamDashboardState } from './team-dashboard-controller.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import TEAM_DASHBOARD_STYLES from './team-dashboard-styles.js'

export interface TeamDashboardOverlayInjected {
  readonly anchorRef: RefObject<HTMLSpanElement>
  readonly controller: TeamDashboardController
  readonly openCaptainChat: () => Promise<void>
}

export type TeamDashboardOverlayProps = PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof TEAM_DASHBOARD_NS>
  & TeamDashboardOverlayInjected

type DashboardTab = 'overview' | 'members' | 'work' | 'diagnostics'

/** Non-modal anchored Peek Card; the official Chat remains visible and interactive. */
export function TeamDashboardOverlay({ anchorRef, controller, openCaptainChat, t }: TeamDashboardOverlayProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [handoffBusy, setHandoffBusy] = useState(false)
  const [tab, setTab] = useState<DashboardTab>('overview')
  const cardRef = useRef<HTMLElement>(null)
  const headingId = useId()
  const descriptionId = useId()
  const position = useAnchoredPosition({ open: state.open, anchorRef, panelRef: cardRef, gap: 8, margin: 16 })

  const closeAndRestoreFocus = (): void => {
    const trigger = anchorRef.current?.querySelector<HTMLButtonElement>('[data-swarm-team-trigger]')
    controller.close()
    queueMicrotask(() => { trigger?.focus() })
  }

  useEffect(() => {
    if (!state.open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      closeAndRestoreFocus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [controller, state.open])

  useEffect(() => {
    if (!state.open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (cardRef.current?.contains(target) === true || anchorRef.current?.contains(target) === true) return
      controller.close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown) }
  }, [anchorRef, controller, state.open])

  useEffect(() => () => { controller.close() }, [controller])
  useEffect(() => { if (!state.open) setTab('overview') }, [state.open])

  const handoff = (): void => {
    if (handoffBusy) return
    setHandoffBusy(true)
    void openCaptainChat()
      .catch(() => { /* The controller publishes the fail-closed stale/error state. */ })
      .finally(() => { setHandoffBusy(false) })
  }

  return (
    <>
      <style>{TEAM_DASHBOARD_STYLES}</style>
      {state.open && (
        <div data-swarm-team-layer style={{ pointerEvents: 'none' }}>
          <aside
            ref={cardRef}
            id="swarm-team-peek-card"
            role="complementary"
            aria-labelledby={headingId}
            aria-describedby={descriptionId}
            data-swarm-team-card
            data-swarm-team-dashboard
            data-phase={state.phase}
            data-presentation={state.presentation ?? 'expanded'}
            style={{ ...position, visibility: position === null ? 'hidden' : 'visible' }}
          >
            {state.presentation === 'compact'
              ? <CompactCard state={state} headingId={headingId} descriptionId={descriptionId} t={t} />
              : <>
                <header data-swarm-team-header>
                  <div data-swarm-team-heading>
                    <h2 id={headingId}>{t('title')}</h2>
                    <p id={descriptionId}>{t('description')}</p>
                  </div>
                </header>
                <Tabs active={tab} select={setTab} t={t} />
                <main data-swarm-team-body>
                  <div data-swarm-team-stack>
                    <Status state={state} t={t} />
                    {state.data === undefined
                      ? <EmptyState state={state} t={t} controller={controller} />
                      : <Dashboard data={state.data.projection} active={tab} t={t} />}
                  </div>
                </main>
                <footer data-swarm-team-footer>
                  <Button size="sm" variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => { controller.refresh() }}>
                    {t('refresh')}
                  </Button>
                  <Button size="sm" variant="primary" disabled={state.data === undefined || handoffBusy} onClick={handoff}>
                    {handoffBusy ? t('openingChat') : t('openChat')}
                  </Button>
                </footer>
              </>}
          </aside>
        </div>
      )}
    </>
  )
}

function CompactCard({ state, headingId, descriptionId, t }: {
  state: TeamDashboardState
  headingId: string
  descriptionId: string
  t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const data = state.data?.projection
  return (
    <div data-swarm-team-compact>
      <div data-swarm-team-heading>
        <h2 id={headingId}>{data?.team.name ?? t('title')}</h2>
        <p id={descriptionId}>{data?.team.phase ?? compactPhase(state, t)}</p>
      </div>
      <div data-swarm-team-compact-stats>
        <Stat value={data === undefined ? '—' : String(data.totals.roster)} label={t('members')} />
        <Stat value={data === undefined ? '—' : String(data.totals.tasks)} label={t('tasks')} />
        <Stat value={data === undefined ? '—' : String(data.totals.pendingInteractions)} label={t('interactions')} />
      </div>
    </div>
  )
}

function compactPhase(state: TeamDashboardState, t: TranslateNS<typeof TEAM_DASHBOARD_NS>): string {
  if (state.phase === 'loading') return t('loading')
  if (state.phase === 'reconnecting') return t('reconnecting')
  if (state.phase === 'stale') return t('stale')
  if (state.phase === 'error') return t('error')
  return state.phase
}

function Tabs({ active, select, t }: {
  active: DashboardTab
  select: (tab: DashboardTab) => void
  t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const tabs: readonly DashboardTab[] = ['overview', 'members', 'work', 'diagnostics']
  return (
    <div role="tablist" aria-label={t('tabs.label')} data-swarm-team-tabs>
      {tabs.map(tab => (
        <button key={tab} type="button" role="tab" aria-selected={active === tab} onClick={() => { select(tab) }}>
          {t(`tabs.${tab}`)}
        </button>
      ))}
    </div>
  )
}

function Status({ state, t }: { state: TeamDashboardState; t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  if (state.phase === 'ready') return null
  const failed = state.phase === 'error' || state.phase === 'stale'
  const label = state.phase === 'loading' ? t('loading')
    : state.phase === 'reconnecting' ? t('reconnecting')
      : state.phase === 'stale' ? t('stale') : t('error')
  return (
    <div role={failed ? 'alert' : 'status'} aria-live="polite" data-swarm-team-row>
      <span><StateDot state={failed ? 'warning' : 'ongoing'} /> {label}</span>
      {state.error === undefined ? null : <code title={state.error.message}>{state.error.code}</code>}
    </div>
  )
}

function EmptyState({ state, t, controller }: {
  state: TeamDashboardState
  t: TranslateNS<typeof TEAM_DASHBOARD_NS>
  controller: TeamDashboardController
}) {
  if (state.phase !== 'error') return null
  return <Button variant="outline" onClick={() => { controller.reconnect() }}>{t('retry')}</Button>
}

function Dashboard({ data, active, t }: {
  data: SwarmHostReadProjectionV1
  active: DashboardTab
  t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  if (active === 'members') {
    return (
      <Section heading={`${t('members')} (${String(data.totals.roster)})`}>
        <Rows empty={t('empty')} rows={data.roster.map(member => ({
          key: member.name, primary: member.name, secondary: member.role, state: member.phase,
        }))} />
      </Section>
    )
  }
  if (active === 'work') {
    return (
      <div data-swarm-team-stack>
        <Section heading={`${t('tasks')} (${String(data.totals.tasks)})`}>
          <Rows empty={t('empty')} rows={data.tasks.map(task => ({
            key: task.id,
            primary: task.subject,
            secondary: task.ownerName === undefined
              ? (task.blockedBy.length === 0 ? task.id : t('blocked', { count: task.blockedBy.length }))
              : t('owner', { name: task.ownerName }),
            state: task.status,
          }))} />
        </Section>
        <Section heading={`${t('attempts')} (${String(data.totals.attempts)})`}>
          <Rows empty={t('empty')} rows={data.attempts.map(attempt => ({
            key: attempt.id,
            primary: attempt.memberName ?? attempt.taskId,
            secondary: t('generation', { generation: attempt.generation }),
            state: attempt.phase,
          }))} />
        </Section>
      </div>
    )
  }
  if (active === 'diagnostics') {
    return (
      <div data-swarm-team-stack>
        <Section heading={t('capabilities')}>
          <div data-swarm-team-pills>
            {data.capabilities.map(capability => (
              <Pill key={capability.capability} active={capability.state === 'available'}>
                {capability.capability}: {t(capability.state)}
              </Pill>
            ))}
          </div>
        </Section>
        <details data-swarm-team-diagnostics>
          <summary>{t('trustDetails')}</summary>
          <p data-swarm-team-muted>{t('trust')}</p>
        </details>
      </div>
    )
  }
  return <Overview data={data} t={t} />
}

function Overview({ data, t }: { data: SwarmHostReadProjectionV1; t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  return (
    <div data-swarm-team-stack>
      <div data-swarm-team-summary>
        <Stat value={String(data.totals.roster)} label={t('members')} />
        <Stat value={String(data.totals.tasks)} label={t('tasks')} />
        <Stat value={String(data.totals.pendingInteractions)} label={t('interactions')} />
      </div>
      <Section heading={data.team.name}>
        <Fact label={t('status')} value={data.team.phase} />
        <Fact label={t('revision')} value={String(data.team.revision)} />
        <Fact label={t('updated')} value={new Date(data.team.updatedAt).toLocaleString()} />
      </Section>
      <Section heading={t('budget')}>
        <Fact label={t('usedTokens')} value={limit(data.budget.usedTokens, data.budget.tokenLimit)} />
        <Fact label={t('usedRequests')} value={limit(data.budget.usedRequests, data.budget.requestLimit)} />
        <Fact label={t('usedRetries')} value={limit(data.budget.usedRetries, data.budget.retryLimit)} />
      </Section>
      <Section heading={`${t('interactions')} (${String(data.totals.pendingInteractions)})`}>
        <Rows empty={t('empty')} rows={data.pendingInteractions.map(interaction => ({
          key: interaction.requestId,
          primary: interaction.intent,
          secondary: t('target', { kind: interaction.targetKind }),
          state: interaction.status,
        }))} />
      </Section>
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return <div data-swarm-team-stat><strong>{value}</strong><span>{label}</span></div>
}

function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return <section data-swarm-team-section><h3>{heading}</h3>{children}</section>
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div data-swarm-team-row><span data-swarm-team-muted>{label}</span><span>{value}</span></div>
}

function Rows({ empty, rows }: {
  empty: string
  rows: readonly { readonly key: string; readonly primary: string; readonly secondary: string; readonly state: string }[]
}) {
  if (rows.length === 0) return <span data-swarm-team-muted>{empty}</span>
  return (
    <ul data-swarm-team-list>
      {rows.map(item => (
        <li key={item.key} data-swarm-team-row>
          <span title={item.primary}>{item.primary}</span>
          <span data-swarm-team-muted title={item.secondary}>{item.state}</span>
        </li>
      ))}
    </ul>
  )
}

function limit(used: number, maximum: number | undefined): string {
  return maximum === undefined ? String(used) : `${String(used)} / ${String(maximum)}`
}
