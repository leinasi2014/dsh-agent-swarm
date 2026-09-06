import { Button, IconCloseOutline16, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'
import type { SwarmReadCaptainAnnouncementsV1, SwarmReadCaptainDiagnosticsV1, SwarmReadCaptainMembersV1, SwarmReadTeamsV1 } from '../rpc/read-rpc-contract.js'
import type { TeamDashboardController, TeamDashboardState } from './team-dashboard-controller.js'
import type { TeamDashboardSurfaceCoordinator } from './team-dashboard-surface-coordinator.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import { ManageView, DetailOverlay } from './team-dashboard-detail-content.js'
import { dedupeTeams, enumLabel, type DetailSelection } from './team-dashboard-view-helpers.js'
import { WorkspacePrimary, LegacyTasks, Notices } from './team-dashboard-workbench-views.js'
import { shellCss } from './team-dashboard-workbench-css.js'
export { MemberDetail } from './team-dashboard-detail-content.js'
export { deriveMemberActivity, deriveMemberTone, memberRosterInitial, TEAM_WORKSPACE_WIDE_MIN_WIDTH, teamWorkspaceLayoutForWidth } from './team-dashboard-view-helpers.js'

type WorkspaceView = 'workspace' | 'tasks' | 'notices' | 'manage'

/**
 * Dense single-page Team workbench inspired by dsh-agent-teams' information architecture,
 * while preserving DSH's official Details surface, authority projection and Captain handoff.
 * The hidden `tasks` view is a legacy compatibility seam for older tests/extensions only; the
 * visible navigation is intentionally Workspace / Notices / Manage.
 */
export { shellCss }

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
  const data = state.data?.projection
  const handoff = (): void => {
    if (handoffBusy) return
    setHandoffBusy(true)
    void coordinator.openCaptainChat().catch(() => {}).finally(() => { setHandoffBusy(false) })
  }
  return <div className="swarm-team-workspace" data-swarm-team-layout="workspace">
    <style>{shellCss}</style>
    {data === undefined
      ? <Empty state={state} controller={controller} t={t} />
      : <Workspace
          data={data}
          handoffBusy={handoffBusy}
          localeTag={localeTag}
          descriptionId={descriptionId}
          headingId={headingId}
          state={state}
          t={t}
          teams={state.data?.teams}
          announcements={state.data?.captainAnnouncements}
          diagnostics={state.data?.captainDiagnostics}
          memberAssets={state.data?.captainMembers}
          onCaptainSession={handoff}
          onSelectTeam={teamId => { controller.selectTeam(teamId) }}
          onClose={() => { coordinator.closeAndRestoreFocus() }}
        />}
  </div>
}

function Status({ state, t }: { readonly state: TeamDashboardState; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  if (state.phase === 'ready') return null
  const failed = state.phase === 'error' || state.phase === 'stale'
  const label = state.phase === 'loading' ? t('loading') : state.phase === 'reconnecting' ? t('reconnecting') : state.phase === 'stale' ? t('stale') : t('error')
  return <div className="swarm-team-workspace__status" role={failed ? 'alert' : 'status'} aria-live="polite"><StateDot state={failed ? 'warning' : 'ongoing'} /><span>{label}</span>{state.error === undefined ? null : <span className="swarm-team-workspace__error" title={`${state.error.code}: ${state.error.message}`}><code>{state.error.code}</code><small className="swarm-team-workspace__muted">: {state.error.message}</small></span>}</div>
}

function Empty({ state, controller, t }: { readonly state: TeamDashboardState; readonly controller: TeamDashboardController; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  const failed = state.phase === 'error' || state.phase === 'stale'
  return <section className="swarm-team-workspace__empty-shell" data-swarm-empty-shell>
    <Status state={state} t={t} />
    <section className="swarm-team-workspace__detail-section" data-swarm-empty-state>
      <h4>{failed ? t('error') : t('loading')}</h4>
      {state.error === undefined ? null : <p className="swarm-team-workspace__muted" title={`${state.error.code}: ${state.error.message}`}>{state.error.message}</p>}
    </section>
    <details className="swarm-team-workspace__detail-section"><summary>{t('diagnostics')}</summary><Status state={state} t={t} /></details>
    <div className="swarm-team-workspace__empty-actions">{failed ? <Button variant="outline" onClick={() => { controller.reconnect() }}>{t('retry')}</Button> : null}<Button variant="ghost" onClick={() => { controller.refresh() }}>{t('refresh')}</Button></div>
  </section>
}

function Workspace({ data, handoffBusy, localeTag, descriptionId, headingId, state, t, teams, announcements, diagnostics, memberAssets, onCaptainSession, onSelectTeam, onClose }: {
  readonly data: SwarmHostReadProjectionV1
  readonly handoffBusy: boolean
  readonly localeTag: () => 'zh-CN' | 'en-US'
  readonly descriptionId: string
  readonly headingId: string
  readonly state: TeamDashboardState
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
  readonly teams: SwarmReadTeamsV1 | undefined
  readonly announcements: SwarmReadCaptainAnnouncementsV1 | undefined
  readonly diagnostics: SwarmReadCaptainDiagnosticsV1 | undefined
  readonly memberAssets: SwarmReadCaptainMembersV1 | undefined
  readonly onCaptainSession: () => void
  readonly onSelectTeam: (teamId: string) => void
  readonly onClose: () => void
}) {
  const number = new Intl.NumberFormat(localeTag())
  const visibleTeams = dedupeTeams(teams)
  const boundCaptain = teams?.teams.find(team => team.teamId === data.binding.teamId)
  const goal = boundCaptain?.goal
  const entries = announcements?.state === 'available' ? announcements.entries : []
  const latest = entries.toSorted((left, right) => right.createdAt - left.createdAt)[0]
  const preferredTask = data.tasks.filter(task => ['in_progress', 'submitted', 'verifying'].includes(task.status)).toSorted((left, right) => right.updatedAt - left.updatedAt)[0] ?? data.tasks[0]
  const [view, setView] = useState<WorkspaceView>('workspace')
  const [detail, setDetail] = useState<DetailSelection>()
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>(preferredTask?.id)
  const detailHeadingRef = useRef<HTMLHeadingElement>(null)
  const detailTriggerRef = useRef<HTMLElement | null>(null)
  const detailTriggerSelectionRef = useRef<DetailSelection | undefined>(undefined)

  const captainGenerated = boundCaptain?.identityCard.state === 'generated'
  const captainProfession = captainGenerated && boundCaptain?.profession !== undefined ? boundCaptain.profession : undefined
  const executingCount = data.roster.filter(member => member.phase === 'active' && data.attempts.some(attempt => attempt.memberName === member.name && attempt.phase === 'running')).length
  const subtitleParts = [captainProfession, `${number.format(executingCount)} ${t('subtitle.executing')}`].filter((part): part is string => part !== undefined)
  const viewingCaptain = state.targetSessionId === data.binding.rootSessionId

  const openDetail = (selection: DetailSelection): void => {
    detailTriggerRef.current = document.activeElement as HTMLElement | null
    detailTriggerSelectionRef.current = selection
    setDetail(selection)
  }
  const detailTriggerFor = (selection: DetailSelection | undefined): HTMLElement | undefined => {
    if (selection === undefined) return undefined
    if (selection.kind === 'member') return findDataElement('data-swarm-member-name', selection.name)
    if (selection.kind === 'task') return findDataElement('data-swarm-task-full-detail', selection.id) ?? findDataElement('data-swarm-task-id', selection.id)
    if (selection.kind === 'growth') return document.querySelector<HTMLElement>('[data-swarm-manage-growth] button') ?? undefined
    if (selection.kind === 'overview') return document.querySelector<HTMLElement>('[data-swarm-manage-overview] button') ?? undefined
    return document.querySelector<HTMLElement>('[data-swarm-manage-diagnostics] button') ?? undefined
  }
  const closeDetail = (refocus: boolean): void => {
    setDetail(undefined)
    if (refocus) queueMicrotask(() => {
      const trigger = detailTriggerRef.current
      if (trigger !== null && trigger.isConnected) {
        trigger.focus()
        return
      }
      const rebuilt = detailTriggerFor(detailTriggerSelectionRef.current)
      if (rebuilt !== undefined) {
        rebuilt.focus()
        return
      }
      const selectedTab = document.querySelector<HTMLElement>('[data-swarm-view-tabs] [role="tab"][aria-selected="true"]:not(.swarm-team-workspace__compat-task-tab)')
      if (selectedTab !== null) { selectedTab.focus(); return }
      document.querySelector<HTMLElement>('[data-swarm-view-tab="workspace"]')?.focus()
    })
  }

  useLayoutEffect(() => { if (detail !== undefined) detailHeadingRef.current?.focus() }, [detail])
  useLayoutEffect(() => {
    if (detail === undefined) return
    const gone = (detail.kind === 'member' && !data.roster.some(member => member.name === detail.name))
      || (detail.kind === 'task' && !data.tasks.some(task => task.id === detail.id))
    if (gone) closeDetail(true)
  }, [data, detail])
  useLayoutEffect(() => {
    if (selectedTaskId !== undefined && data.tasks.some(task => task.id === selectedTaskId)) return
    setSelectedTaskId(preferredTask?.id)
  }, [data.tasks, preferredTask?.id, selectedTaskId])

  const visibleTabs = [
    { id: 'workspace' as const, label: t('tabs.workspace') },
    { id: 'notices' as const, label: t('announcements') },
    { id: 'manage' as const, label: t('manage') },
  ]
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next = index
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % visibleTabs.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + visibleTabs.length) % visibleTabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = visibleTabs.length - 1
    else return
    event.preventDefault()
    const nextTab = visibleTabs[next]!.id
    setView(nextTab)
    queueMicrotask(() => { document.querySelector<HTMLElement>(`[data-swarm-view-tab="${nextTab}"]`)?.focus() })
  }

  return <section className="swarm-team-workspace__pane">
    <header className="swarm-team-workspace__pane-head">
      <div className="swarm-team-workspace__truncate">
        <div className="swarm-team-workspace__title-row">
          <h2 className="swarm-team-workspace__title" id={headingId} title={data.team.name}>{data.team.name}</h2>
          {visibleTeams.length > 1 ? <select className="swarm-team-workspace__team-switcher" aria-label={t('switchTeam')} value={data.binding.teamId} data-swarm-team-switcher onChange={event => { if (event.target.value !== data.binding.teamId) onSelectTeam(event.target.value) }}>
            {visibleTeams.map(team => <option key={team.teamId} value={team.teamId}>{team.name}</option>)}
          </select> : null}
          <span className="swarm-team-workspace__phase-pill" data-swarm-team-phase>{enumLabel(data.team.phase, t)}</span>
        </div>
        <p className="swarm-team-workspace__subtitle" id={descriptionId}>{subtitleParts.join(' · ')}</p>
        <p className="swarm-team-workspace__subtitle">{t('description')}</p>
      </div>
      <Button size="sm" variant="toolbar" aria-label={t('close')} title={t('close')} onClick={onClose}><IconCloseOutline16 /></Button>
    </header>

    <div className="swarm-team-workspace__public-bar" data-swarm-public-bar>
      <section className="swarm-team-workspace__public-card" data-swarm-goal-card data-swarm-goal-state={goal?.state ?? 'loading'}>
        <span className="swarm-team-workspace__public-title">{t('goal')}</span>
        {goal === undefined ? <span className="swarm-team-workspace__public-content swarm-team-workspace__unavailable">{t('loading')}</span>
          : goal.state === 'generated' ? <span className="swarm-team-workspace__public-content" data-swarm-goal-text title={goal.text}>{goal.text}</span>
            : <span className="swarm-team-workspace__public-content swarm-team-workspace__unavailable" data-swarm-goal-not-set>{t('goalNotSet')}</span>}
      </section>
      <section className="swarm-team-workspace__public-card" data-swarm-announcement-preview>
        <span className="swarm-team-workspace__public-title">{t('announcement.latest')}</span>
        {announcements === undefined ? <span className="swarm-team-workspace__public-content swarm-team-workspace__unavailable">{t('loading')}</span>
          : announcements.state === 'available' ? latest === undefined ? <span className="swarm-team-workspace__public-content swarm-team-workspace__unavailable" data-swarm-announcements-empty>{t('announcementsEmpty')}</span>
            : <span className="swarm-team-workspace__public-content" title={latest.text}>{latest.text}</span>
            : <span className="swarm-team-workspace__public-content swarm-team-workspace__unavailable">{t('announcementsUnavailable')}</span>}
      </section>
      {data.team.phase === 'staged' ? <section className="swarm-team-workspace__public-card" data-swarm-staged-plan data-swarm-staged-plan-state="pending">
        <span className="swarm-team-workspace__public-title">{t('stagedPlan.title')}</span>
        <span className="swarm-team-workspace__public-content" data-swarm-staged-plan-summary>{t('stagedPlan.summary', { members: data.team.plan?.members ?? 0, tasks: data.team.plan?.tasks ?? 0 })}</span>
        <span className="swarm-team-workspace__public-content swarm-team-workspace__muted" data-swarm-staged-plan-hint>{t('stagedPlan.hint')}</span>
      </section> : null}
      {data.pendingInteractions.length > 0 ? <section className="swarm-team-workspace__public-card" data-swarm-attention>
        <span className="swarm-team-workspace__public-title">{t('attention.title')}</span>
        <span className="swarm-team-workspace__public-content">{number.format(data.pendingInteractions.length)}</span>
        {data.pendingInteractions.slice(0, 3).map(item => <span key={item.requestId} className="swarm-team-workspace__public-content" data-swarm-attention-row={item.requestId}>{t('attention.row', { intent: item.intent, target: item.targetRef ?? item.targetKind })}</span>)}
      </section> : null}
    </div>

    <div className="swarm-team-workspace__view-tabs" role="tablist" aria-label={t('tabs.label')} data-swarm-view-tabs>
      <button type="button" role="tab" id="swarm-tab-workspace" aria-selected={view === 'workspace'} aria-controls="swarm-panel-workspace" tabIndex={view === 'workspace' ? 0 : -1} data-swarm-view-tab="workspace" onKeyDown={event => { onTabKeyDown(event, 0) }} onClick={() => { setView('workspace') }}>{t('tabs.workspace')}</button>
      <button type="button" role="tab" className="swarm-team-workspace__compat-task-tab" id="swarm-tab-tasks" aria-selected={view === 'tasks'} aria-controls="swarm-panel-tasks" tabIndex={-1} data-swarm-view-tab="tasks" onClick={() => { setView('tasks') }}>{t('tasks')}</button>
      <button type="button" role="tab" id="swarm-tab-notices" aria-selected={view === 'notices'} aria-controls="swarm-panel-notices" tabIndex={view === 'notices' ? 0 : -1} data-swarm-view-tab="notices" onKeyDown={event => { onTabKeyDown(event, 1) }} onClick={() => { setView('notices') }}>{t('announcements')}</button>
      <button type="button" role="tab" id="swarm-tab-manage" aria-selected={view === 'manage'} aria-controls="swarm-panel-manage" tabIndex={view === 'manage' ? 0 : -1} data-swarm-view-tab="manage" onKeyDown={event => { onTabKeyDown(event, 2) }} onClick={() => { setView('manage') }}>{t('manage')}</button>
    </div>

    <main className="swarm-team-workspace__pane-body">
      <Status state={state} t={t} />
      <div className="swarm-team-workspace__view-shell" data-detail-open={detail === undefined ? 'false' : 'true'}>
        {view === 'workspace' ? <WorkspacePrimary data={data} number={number} boundCaptain={boundCaptain} memberAssets={memberAssets} handoffBusy={handoffBusy} viewingCaptain={viewingCaptain} selectedTaskId={selectedTaskId} onSelectTask={setSelectedTaskId} onCaptainSession={onCaptainSession} onOpenMember={name => { openDetail({ kind: 'member', name }) }} onOpenTask={id => { openDetail({ kind: 'task', id }) }} t={t} /> : null}
        {view === 'tasks' ? <LegacyTasks data={data} number={number} selectedTaskId={selectedTaskId} onSelectTask={setSelectedTaskId} onOpenTask={id => { openDetail({ kind: 'task', id }) }} t={t} /> : null}
        {view === 'notices' ? <Notices entries={entries} announcements={announcements} number={number} localeTag={localeTag} t={t} /> : null}
        {view === 'manage' ? <div role="tabpanel" id="swarm-panel-manage" aria-labelledby="swarm-tab-manage" data-swarm-panel="manage"><ManageView data={data} memberAssets={memberAssets} number={number} onManageViaCaptain={onCaptainSession} onOpenDetail={openDetail} t={t} /></div> : null}
      </div>
      {detail === undefined ? null : <DetailOverlay
        detail={detail}
        data={data}
        localeTag={localeTag}
        number={number}
        headingRef={detailHeadingRef}
        memberAssets={memberAssets}
        diagnostics={diagnostics}
        onClose={() => { closeDetail(true) }}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); closeDetail(true) } }}
        t={t}
      />}
    </main>
  </section>
}

function findDataElement(attribute: string, value: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>(`[${attribute}]`)].find(element => element.getAttribute(attribute) === value)
}
