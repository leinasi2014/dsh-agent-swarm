import { useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  Button,
  IconRefreshOutline16,
  Pill,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'
import type { TeamDashboardController, TeamDashboardState } from './team-dashboard-controller.js'
import type { TeamDashboardSurfaceCoordinator, TeamDashboardView } from './team-dashboard-surface-coordinator.js'
import { TEAM_DASHBOARD_NS, type TeamDashboardKey } from './team-dashboard-locales.js'

export function TeamDashboardContent({ controller, coordinator, descriptionId, headingId, localeTag, state, t }: {
  readonly controller: TeamDashboardController
  readonly coordinator: TeamDashboardSurfaceCoordinator
  readonly descriptionId: string
  readonly headingId: string
  readonly localeTag: () => 'zh-CN' | 'en-US'
  readonly state: TeamDashboardState
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const [handoffBusy, setHandoffBusy] = useState(false)
  const surface = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot)
  const handoff = (): void => {
    if (handoffBusy) return
    setHandoffBusy(true)
    void coordinator.openCaptainChat()
      .catch(() => { /* The controller publishes the fail-closed stale/error state. */ })
      .finally(() => { setHandoffBusy(false) })
  }
  return <>
    <header data-swarm-team-header>
      <div data-swarm-team-heading>
        <h2 id={headingId}>{t('title')}</h2>
        <p id={descriptionId}>{t('description')}</p>
      </div>
      <button
        type="button"
        data-swarm-team-close
        aria-label={t('close')}
        onClick={() => { coordinator.closeAndRestoreFocus() }}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </header>
    <ViewSwitch active={surface.view} select={view => { coordinator.selectView(view) }} t={t} />
    <div data-swarm-team-body data-swarm-team-view={surface.view}>
      <div data-swarm-team-stack>
        <Status state={state} t={t} />
        {state.data === undefined
          ? <EmptyState state={state} t={t} controller={controller} />
          : <Dashboard data={state.data.projection} active={surface.view} localeTag={localeTag} t={t} />}
      </div>
    </div>
    <footer data-swarm-team-footer>
      <Button size="sm" variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => { controller.refresh() }}>
        {t('refresh')}
      </Button>
      <Button size="sm" variant="primary" disabled={state.data === undefined || handoffBusy} onClick={handoff}>
        {handoffBusy ? t('openingChat') : t('openChat')}
      </Button>
    </footer>
  </>
}

function ViewSwitch({ active, select, t }: {
  active: TeamDashboardView
  select: (tab: TeamDashboardView) => void
  t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const tabs: readonly TeamDashboardView[] = ['overview', 'members', 'work', 'diagnostics']
  return (
    <nav aria-label={t('tabs.label')} data-swarm-team-tabs>
      {tabs.map(tab => (
        <Button key={tab} size="sm" variant="ghost" aria-pressed={active === tab} onClick={() => { select(tab) }}>
          {t(`tabs.${tab}`)}
        </Button>
      ))}
    </nav>
  )
}

function Status({ state, t }: { state: TeamDashboardState; t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  if (state.phase === 'ready') return null
  const failed = state.phase === 'error' || state.phase === 'stale'
  const label = state.phase === 'loading' ? t('loading')
    : state.phase === 'reconnecting' ? t('reconnecting')
      : state.phase === 'stale' ? t('stale') : t('error')
  return (
    <div role={failed ? 'alert' : 'status'} data-swarm-team-row>
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

function Dashboard({ data, active, localeTag, t }: {
  data: SwarmHostReadProjectionV1
  active: TeamDashboardView
  localeTag: () => 'zh-CN' | 'en-US'
  t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const number = new Intl.NumberFormat(localeTag())
  if (active === 'members') {
    return (
      <Section heading={`${t('members')} (${number.format(data.totals.roster)})`}>
        <Rows empty={t('empty')} rows={data.roster.map(member => ({
            key: member.name, primary: member.name, secondary: member.role, state: enumLabel(member.phase, t),
        }))} />
      </Section>
    )
  }
  if (active === 'work') {
    return (
      <div data-swarm-team-stack>
        <Section heading={`${t('tasks')} (${number.format(data.totals.tasks)})`}>
          <Rows empty={t('empty')} rows={data.tasks.map(task => ({
            key: task.id,
            primary: task.subject,
            secondary: task.ownerName === undefined
              ? (task.blockedBy.length === 0 ? task.id : t('blocked', { count: number.format(task.blockedBy.length) }))
              : t('owner', { name: task.ownerName }),
            state: enumLabel(task.status, t),
          }))} />
        </Section>
        <Section heading={`${t('attempts')} (${number.format(data.totals.attempts)})`}>
          <Rows empty={t('empty')} rows={data.attempts.map(attempt => ({
            key: attempt.id,
            primary: attempt.memberName ?? attempt.taskId,
            secondary: t('generation', { generation: number.format(attempt.generation) }),
            state: enumLabel(attempt.phase, t),
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
  return <Overview data={data} localeTag={localeTag} t={t} />
}

function Overview({ data, localeTag, t }: {
  data: SwarmHostReadProjectionV1
  localeTag: () => 'zh-CN' | 'en-US'
  t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const number = new Intl.NumberFormat(localeTag())
  return (
    <div data-swarm-team-stack>
      <div data-swarm-team-summary>
        <Stat value={number.format(data.totals.roster)} label={t('members')} />
        <Stat value={number.format(data.totals.tasks)} label={t('tasks')} />
        <Stat value={number.format(data.totals.pendingInteractions)} label={t('interactions')} />
      </div>
      <Section heading={data.team.name}>
        <Fact label={t('status')} value={enumLabel(data.team.phase, t)} />
        <Fact label={t('revision')} value={number.format(data.team.revision)} />
        <Fact label={t('updated')} value={new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }).format(data.team.updatedAt)} />
      </Section>
      <Section heading={t('budget')}>
        <Fact label={t('usedTokens')} value={limit(data.budget.usedTokens, data.budget.tokenLimit, number)} />
        <Fact label={t('usedRequests')} value={limit(data.budget.usedRequests, data.budget.requestLimit, number)} />
        <Fact label={t('usedRetries')} value={limit(data.budget.usedRetries, data.budget.retryLimit, number)} />
      </Section>
      <Section heading={`${t('interactions')} (${number.format(data.totals.pendingInteractions)})`}>
        <Rows empty={t('empty')} rows={data.pendingInteractions.map(interaction => ({
          key: interaction.requestId,
          primary: interaction.intent,
          secondary: t('target', { kind: enumLabel(interaction.targetKind, t) }),
          state: enumLabel(interaction.status, t),
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
          <span data-swarm-team-row-copy>
            <span title={item.primary}>{item.primary}</span>
            <span data-swarm-team-muted>{item.secondary}</span>
          </span>
          <span data-swarm-team-muted>{item.state}</span>
        </li>
      ))}
    </ul>
  )
}

function limit(used: number, maximum: number | undefined, format: Intl.NumberFormat): string {
  return maximum === undefined ? format.format(used) : `${format.format(used)} / ${format.format(maximum)}`
}

type WireEnum = SwarmHostReadProjectionV1['team']['phase']
  | SwarmHostReadProjectionV1['roster'][number]['phase']
  | SwarmHostReadProjectionV1['tasks'][number]['status']
  | SwarmHostReadProjectionV1['attempts'][number]['phase']
  | SwarmHostReadProjectionV1['pendingInteractions'][number]['status']
  | SwarmHostReadProjectionV1['pendingInteractions'][number]['targetKind']

const WIRE_ENUM_KEYS = {
  active: 'enum.active', archived: 'enum.archived', provisioning: 'enum.provisioning', failed: 'enum.failed', removed: 'enum.removed',
  pending: 'enum.pending', in_progress: 'enum.in_progress', submitted: 'enum.submitted', verifying: 'enum.verifying',
  completed: 'enum.completed', cancelled: 'enum.cancelled', running: 'enum.running', accepted: 'enum.accepted',
  rejected: 'enum.rejected', stale: 'enum.stale', acknowledged: 'enum.acknowledged', captain: 'enum.captain',
  team: 'enum.team', member: 'enum.member', task: 'enum.task',
} as const satisfies Record<WireEnum, TeamDashboardKey>

function enumLabel(value: WireEnum, t: TranslateNS<typeof TEAM_DASHBOARD_NS>): string {
  return t(WIRE_ENUM_KEYS[value])
}
