import { Button, IconCloseOutline16, IconRefreshOutline16, Pill, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'
import type { TeamDashboardController, TeamDashboardState } from './team-dashboard-controller.js'
import type { TeamDashboardSurfaceCoordinator, TeamDashboardView } from './team-dashboard-surface-coordinator.js'
import { TEAM_DASHBOARD_NS, type TeamDashboardKey } from './team-dashboard-locales.js'

const stack = { display: 'grid', gap: 12, minWidth: 0 } as const
const card = { padding: 12, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-base)' } as const
const row = { display: 'flex', justifyContent: 'space-between', gap: 8, minWidth: 0 } as const
const muted = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } as const

/** Read-only body rendered exclusively in the public Details slot. */
export function TeamDashboardContent({ controller, coordinator, descriptionId, headingId, localeTag, state, t }: {
  readonly controller: TeamDashboardController
  readonly coordinator: TeamDashboardSurfaceCoordinator
  readonly descriptionId: string
  readonly headingId: string
  readonly localeTag: () => 'zh-CN' | 'en-US'
  readonly state: TeamDashboardState
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const view = coordinator.getSnapshot().view
  return <div style={{ display: 'grid', gridTemplateRows: 'auto auto minmax(0, 1fr) auto', height: '100%', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)' }}>
    <header style={{ ...row, alignItems: 'flex-start', padding: 20, borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
      <div><h2 id={headingId} style={{ margin: 0 }}>{t('title')}</h2><p id={descriptionId} style={{ ...muted, margin: '6px 0 0' }}>{t('description')}</p></div>
      <Button size="sm" variant="toolbar" aria-label={t('close')} title={t('close')}
        onClick={() => { coordinator.closeAndRestoreFocus() }}><IconCloseOutline16 /></Button>
    </header>
    <nav aria-label={t('tabs.label')} style={{ display: 'flex', gap: 4, padding: 12, borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
      {(['overview', 'members', 'tasks', 'details'] as const).map(tab => <Button key={tab} size="sm" variant="ghost"
        aria-pressed={view === tab} onClick={() => { coordinator.selectView(tab) }}>{t(`tabs.${tab}`)}</Button>)}
    </nav>
    <main style={{ overflow: 'auto', padding: 16 }}><div style={stack}>
      <Status state={state} t={t} />
      {state.data === undefined ? <Empty state={state} controller={controller} t={t} /> : <Dashboard data={state.data.projection} view={view} localeTag={localeTag} t={t} />}
    </div></main>
    <footer style={{ ...row, padding: 12, borderTop: '1px solid var(--dsw-alias-border-l2)' }}>
      <Button size="sm" variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => { controller.refresh() }}>{t('refresh')}</Button>
    </footer>
  </div>
}

function Status({ state, t }: { state: TeamDashboardState; t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  if (state.phase === 'ready') return null
  const failed = state.phase === 'error' || state.phase === 'stale'
  const label = state.phase === 'loading' ? t('loading') : state.phase === 'reconnecting' ? t('reconnecting') : state.phase === 'stale' ? t('stale') : t('error')
  return <div role={failed ? 'alert' : 'status'} aria-live="polite" style={{ ...row, justifyContent: 'flex-start' }}><StateDot state={failed ? 'warning' : 'ongoing'} /><span>{label}</span>{state.error === undefined ? null : <code title={state.error.message}>{state.error.code}</code>}</div>
}
function Empty({ state, controller, t }: { state: TeamDashboardState; controller: TeamDashboardController; t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  return state.phase === 'error' ? <Button variant="outline" onClick={() => { controller.reconnect() }}>{t('retry')}</Button> : null
}
function Dashboard({ data, view, localeTag, t }: { data: SwarmHostReadProjectionV1; view: TeamDashboardView; localeTag: () => 'zh-CN' | 'en-US'; t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  const number = new Intl.NumberFormat(localeTag())
  if (view === 'members') return <Section heading={`${t('members')} (${number.format(data.totals.roster)})`}><Rows empty={t('empty')} rows={data.roster.map(member => ({ key: member.name, primary: member.name, secondary: member.role, state: enumLabel(member.phase, t) }))} /></Section>
  if (view === 'tasks') return <div style={stack}><Section heading={`${t('tasks')} (${number.format(data.totals.tasks)})`}><Rows empty={t('empty')} rows={data.tasks.map(task => ({ key: task.id, primary: task.subject, secondary: task.ownerName ?? task.id, state: enumLabel(task.status, t) }))} /></Section><Section heading={`${t('attempts')} (${number.format(data.totals.attempts)})`}><Rows empty={t('empty')} rows={data.attempts.map(attempt => ({ key: attempt.id, primary: attempt.memberName ?? attempt.taskId, secondary: t('generation', { generation: number.format(attempt.generation) }), state: enumLabel(attempt.phase, t) }))} /></Section></div>
  if (view === 'details') return <div style={stack}><Section heading={t('capabilities')}><div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{data.capabilities.map(capability => <Pill key={capability.capability} active={capability.state === 'available'}>{capability.capability}: {t(capability.state)}</Pill>)}</div></Section><Section heading={t('trustDetails')}><p style={{ ...muted, margin: 0 }}>{t('trust')}</p></Section></div>
  return <div style={stack}><div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>{[[data.totals.roster, 'members'], [data.totals.tasks, 'tasks'], [data.totals.pendingInteractions, 'interactions']].map(([value, label]) => <div key={String(label)} style={card}><strong>{number.format(value as number)}</strong><div style={muted}>{t(label as 'members' | 'tasks' | 'interactions')}</div></div>)}</div><Section heading={data.team.name}><Fact label={t('status')} value={enumLabel(data.team.phase, t)} /><Fact label={t('revision')} value={number.format(data.team.revision)} /><Fact label={t('updated')} value={new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }).format(data.team.updatedAt)} /></Section><Section heading={t('budget')}><Fact label={t('usedTokens')} value={limit(data.budget.usedTokens, data.budget.tokenLimit, number)} /><Fact label={t('usedRequests')} value={limit(data.budget.usedRequests, data.budget.requestLimit, number)} /><Fact label={t('usedRetries')} value={limit(data.budget.usedRetries, data.budget.retryLimit, number)} /></Section><Section heading={`${t('interactions')} (${number.format(data.totals.pendingInteractions)})`}><Rows empty={t('empty')} rows={data.pendingInteractions.map(item => ({ key: item.requestId, primary: item.intent, secondary: enumLabel(item.targetKind, t), state: enumLabel(item.status, t) }))} /></Section></div>
}
function Section({ heading, children }: { heading: string; children: ReactNode }) { return <section style={card}><h3 style={{ margin: '0 0 8px', fontSize: 14 }}>{heading}</h3>{children}</section> }
function Fact({ label, value }: { label: string; value: string }) { return <div style={row}><span style={muted}>{label}</span><span>{value}</span></div> }
function Rows({ empty, rows }: { empty: string; rows: readonly { readonly key: string; readonly primary: string; readonly secondary: string; readonly state: string }[] }) { return rows.length === 0 ? <span style={muted}>{empty}</span> : <ul style={{ display: 'grid', gap: 8, margin: 0, padding: 0, listStyle: 'none' }}>{rows.map(item => <li key={item.key} style={row}><span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }} title={item.primary}>{item.primary}<small style={{ ...muted, display: 'block' }}>{item.secondary}</small></span><span style={muted}>{item.state}</span></li>)}</ul> }
type WireEnum = SwarmHostReadProjectionV1['team']['phase'] | SwarmHostReadProjectionV1['roster'][number]['phase'] | SwarmHostReadProjectionV1['tasks'][number]['status'] | SwarmHostReadProjectionV1['attempts'][number]['phase'] | SwarmHostReadProjectionV1['pendingInteractions'][number]['status'] | SwarmHostReadProjectionV1['pendingInteractions'][number]['targetKind']
const enumKey = Object.freeze({ active: 'enum.active', archived: 'enum.archived', provisioning: 'enum.provisioning', failed: 'enum.failed', removed: 'enum.removed', pending: 'enum.pending', in_progress: 'enum.in_progress', submitted: 'enum.submitted', verifying: 'enum.verifying', completed: 'enum.completed', cancelled: 'enum.cancelled', running: 'enum.running', accepted: 'enum.accepted', rejected: 'enum.rejected', stale: 'enum.stale', acknowledged: 'enum.acknowledged', captain: 'enum.captain', team: 'enum.team', member: 'enum.member', task: 'enum.task' } as const satisfies Record<WireEnum, TeamDashboardKey>)
function enumLabel(value: WireEnum, t: TranslateNS<typeof TEAM_DASHBOARD_NS>): string { return t(enumKey[value]) }
function limit(used: number, maximum: number | undefined, number: Intl.NumberFormat): string { return maximum === undefined ? number.format(used) : `${number.format(used)} / ${number.format(maximum)}` }
