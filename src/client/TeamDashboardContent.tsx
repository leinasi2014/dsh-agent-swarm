import { Button, IconCloseOutline16, IconRefreshOutline16, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'
import type { TeamDashboardController, TeamDashboardState } from './team-dashboard-controller.js'
import type { TeamDashboardSurfaceCoordinator } from './team-dashboard-surface-coordinator.js'
import { TEAM_DASHBOARD_NS, type TeamDashboardKey } from './team-dashboard-locales.js'

type Selection = { readonly kind: 'team' } | { readonly kind: 'member'; readonly name: string } | { readonly kind: 'task'; readonly id: string }
type ListMode = 'members' | 'tasks'

const shellCss = `
[data-swarm-team-dashboard] .swarm-team-workspace { container-type:inline-size; display:grid; grid-template-rows:auto minmax(0,1fr) auto; height:100%; min-width:0; overflow:hidden; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__header, [data-swarm-team-dashboard] .swarm-team-workspace__footer { display:flex; justify-content:space-between; gap:12px; padding:16px 20px; border-color:var(--dsw-alias-border-l2); border-style:solid; }
[data-swarm-team-dashboard] .swarm-team-workspace__header { align-items:flex-start; border-width:0 0 1px; }
[data-swarm-team-dashboard] .swarm-team-workspace__footer { align-items:center; border-width:1px 0 0; }
[data-swarm-team-dashboard] .swarm-team-workspace__title { margin:0; font-size:18px; }
[data-swarm-team-dashboard] .swarm-team-workspace__description, [data-swarm-team-dashboard] .swarm-team-workspace__muted { color:var(--dsw-alias-label-secondary); font-size:12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__description { margin:6px 0 0; }
[data-swarm-team-dashboard] .swarm-team-workspace__body { min-width:0; min-height:0; overflow:auto; padding:12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__status { display:flex; gap:8px; align-items:center; min-width:0; margin:0 0 12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__error { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__columns { display:grid; grid-template-columns:minmax(0,1fr); gap:12px; min-width:0; min-height:100%; }
[data-swarm-team-dashboard] .swarm-team-workspace__column { min-width:0; min-height:0; padding:12px; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background:var(--dsw-alias-bg-base); }
[data-swarm-team-dashboard] .swarm-team-workspace__column-title { margin:0 0 10px; font-size:14px; }
[data-swarm-team-dashboard] .swarm-team-workspace__summary { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
[data-swarm-team-dashboard] .swarm-team-workspace__metric { padding:10px; border-radius:8px; background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__metric strong { display:block; font-size:16px; }
[data-swarm-team-dashboard] .swarm-team-workspace__tabs { display:flex; gap:4px; margin:0 0 10px; }
[data-swarm-team-dashboard] .swarm-team-workspace__rows, [data-swarm-team-dashboard] .swarm-team-workspace__rows > li { min-width:0; max-width:100%; }
[data-swarm-team-dashboard] .swarm-team-workspace__rows { display:grid; gap:8px; margin:0; padding:0; list-style:none; }
[data-swarm-team-dashboard] .swarm-team-workspace__row { display:block; box-sizing:border-box; width:100%; max-width:100%; min-width:0; overflow:hidden; padding:10px; color:inherit; text-align:left; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:transparent; cursor:pointer; }
[data-swarm-team-dashboard] .swarm-team-workspace__row[aria-current="true"] { border-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__row-main, [data-swarm-team-dashboard] .swarm-team-workspace__fact { display:flex; justify-content:space-between; gap:8px; min-width:0; max-width:100%; }
[data-swarm-team-dashboard] .swarm-team-workspace__truncate { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__task-assignee { display:block; min-width:0; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__facts { display:grid; gap:8px; }
[data-swarm-team-dashboard] .swarm-team-workspace__facts dt { color:var(--dsw-alias-label-secondary); }
[data-swarm-team-dashboard] .swarm-team-workspace__facts dd { margin:0; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__diagnostics { margin-top:12px; padding-top:12px; border-top:1px solid var(--dsw-alias-border-l2); }
[data-swarm-team-dashboard] .swarm-team-workspace__diagnostics summary { cursor:pointer; }
[data-swarm-team-dashboard] .swarm-team-workspace__wide-seam { margin:10px 0 0; }
[data-swarm-team-dashboard] .swarm-team-workspace[data-swarm-team-layout="wide"] .swarm-team-workspace__wide-seam { display:none; }
@container (min-width: 720px) { [data-swarm-team-dashboard] .swarm-team-workspace__columns { grid-template-columns:minmax(0,.8fr) minmax(0,1.15fr) minmax(0,1.35fr); } [data-swarm-team-dashboard] .swarm-team-workspace__wide-seam { display:none; } }
`

/** The sole Team UI is a read-only projection in the official Details column. */
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
  const [listMode, setListMode] = useState<ListMode>('members')
  const [selection, setSelection] = useState<Selection>({ kind: 'team' })
  const [workspaceRef, workspaceLayout] = useTeamWorkspaceLayout()
  const handoff = (): void => {
    if (handoffBusy) return
    setHandoffBusy(true)
    void coordinator.openCaptainChat().catch(() => {}).finally(() => { setHandoffBusy(false) })
  }
  return <div className="swarm-team-workspace" data-swarm-team-layout={workspaceLayout} ref={workspaceRef}>
    <style>{shellCss}</style>
    <header className="swarm-team-workspace__header">
      <div><h2 className="swarm-team-workspace__title" id={headingId}>{t('title')}</h2><p className="swarm-team-workspace__description" id={descriptionId}>{t('description')}</p></div>
      <Button size="sm" variant="toolbar" aria-label={t('close')} title={t('close')} onClick={() => { coordinator.closeAndRestoreFocus() }}><IconCloseOutline16 /></Button>
    </header>
    <main className="swarm-team-workspace__body">
      <Status state={state} t={t} />
      {state.data === undefined ? <Empty state={state} controller={controller} t={t} /> : <Workspace data={state.data.projection} layout={workspaceLayout} listMode={listMode} localeTag={localeTag} selection={selection} setListMode={setListMode} setSelection={setSelection} t={t} />}
    </main>
    <footer className="swarm-team-workspace__footer">
      <Button size="sm" variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => { controller.refresh() }}>{t('refresh')}</Button>
      <Button size="sm" variant="primary" disabled={state.data === undefined || handoffBusy} onClick={handoff}>{handoffBusy ? t('openingChat') : t('openChat')}</Button>
    </footer>
  </div>
}

export const TEAM_WORKSPACE_WIDE_MIN_WIDTH = 720
export type TeamWorkspaceLayout = 'compact' | 'wide'

/** The Details container, rather than the browser viewport, chooses the layout branch. */
export function teamWorkspaceLayoutForWidth(width: number): TeamWorkspaceLayout {
  return width >= TEAM_WORKSPACE_WIDE_MIN_WIDTH ? 'wide' : 'compact'
}

function useTeamWorkspaceLayout(): readonly [RefObject<HTMLDivElement>, TeamWorkspaceLayout] {
  const ref = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<TeamWorkspaceLayout>('compact')
  useLayoutEffect(() => {
    const workspace = ref.current
    if (workspace === null || typeof ResizeObserver === 'undefined') return undefined
    const setWidth = (width: number): void => { setLayout(teamWorkspaceLayoutForWidth(width)) }
    setWidth(workspace.getBoundingClientRect().width)
    const observer = new ResizeObserver(entries => {
      const entry = entries.find(candidate => candidate.target === workspace)
      if (entry !== undefined) setWidth(entry.contentRect.width)
    })
    observer.observe(workspace)
    return () => { observer.disconnect() }
  }, [])
  return [ref, layout]
}

function Status({ state, t }: { readonly state: TeamDashboardState; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  if (state.phase === 'ready') return null
  const failed = state.phase === 'error' || state.phase === 'stale'
  const label = state.phase === 'loading' ? t('loading') : state.phase === 'reconnecting' ? t('reconnecting') : state.phase === 'stale' ? t('stale') : t('error')
  return <div className="swarm-team-workspace__status" role={failed ? 'alert' : 'status'} aria-live="polite"><StateDot state={failed ? 'warning' : 'ongoing'} /><span>{label}</span>{state.error === undefined ? null : <span className="swarm-team-workspace__error" title={`${state.error.code}: ${state.error.message}`}><code>{state.error.code}</code><small className="swarm-team-workspace__muted">: {state.error.message}</small></span>}</div>
}

function Empty({ state, controller, t }: { readonly state: TeamDashboardState; readonly controller: TeamDashboardController; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  return state.phase === 'error' ? <Button variant="outline" onClick={() => { controller.reconnect() }}>{t('retry')}</Button> : null
}

function Workspace({ data, layout, listMode, localeTag, selection, setListMode, setSelection, t }: {
  readonly data: SwarmHostReadProjectionV1
  readonly layout: TeamWorkspaceLayout
  readonly listMode: ListMode
  readonly localeTag: () => 'zh-CN' | 'en-US'
  readonly selection: Selection
  readonly setListMode: (mode: ListMode) => void
  readonly setSelection: (selection: Selection) => void
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const number = new Intl.NumberFormat(localeTag())
  return <div className="swarm-team-workspace__columns" aria-label={t('tabs.label')}>
    <section className="swarm-team-workspace__column swarm-team-workspace__overview"><h3 className="swarm-team-workspace__column-title">{t('tabs.overview')}</h3>
      <button className="swarm-team-workspace__row" aria-current={selection.kind === 'team'} onClick={() => { setSelection({ kind: 'team' }) }} type="button"><span className="swarm-team-workspace__row-main"><strong className="swarm-team-workspace__truncate" title={data.team.name}>{data.team.name}</strong><span className="swarm-team-workspace__muted">{enumLabel(data.team.phase, t)}</span></span></button>
      <div className="swarm-team-workspace__summary" style={{ marginTop: 10 }}><Metric label={t('members')} value={number.format(data.totals.roster)} /><Metric label={t('tasks')} value={number.format(data.totals.tasks)} /><Metric label={t('interactions')} value={number.format(data.totals.pendingInteractions)} /><Metric label={t('attempts')} value={number.format(data.totals.attempts)} /></div>{layout === 'compact' ? <p className="swarm-team-workspace__muted swarm-team-workspace__wide-seam">{t('narrowWorkspace')}</p> : null}
    </section>
    <section className="swarm-team-workspace__column"><h3 className="swarm-team-workspace__column-title">{listMode === 'members' ? t('members') : t('tasks')}</h3>
      <nav className="swarm-team-workspace__tabs" aria-label={t('tabs.label')}><Button size="sm" variant="ghost" aria-pressed={listMode === 'members'} onClick={() => { setListMode('members') }}>{t('members')}</Button><Button size="sm" variant="ghost" aria-pressed={listMode === 'tasks'} onClick={() => { setListMode('tasks') }}>{t('tasks')}</Button></nav>
      {listMode === 'members' ? <MemberRows data={data} selection={selection} setSelection={setSelection} t={t} /> : <TaskRows data={data} selection={selection} setSelection={setSelection} t={t} />}
    </section>
    <section className="swarm-team-workspace__column"><h3 className="swarm-team-workspace__column-title">{t('tabs.details')}</h3><Detail data={data} localeTag={localeTag} number={number} selection={selection} t={t} /></section>
  </div>
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) { return <div className="swarm-team-workspace__metric"><strong>{value}</strong><span className="swarm-team-workspace__muted">{label}</span></div> }

function MemberRows({ data, selection, setSelection, t }: { readonly data: SwarmHostReadProjectionV1; readonly selection: Selection; readonly setSelection: (selection: Selection) => void; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  return <ul className="swarm-team-workspace__rows">{data.roster.length === 0 ? <li className="swarm-team-workspace__muted">{t('empty')}</li> : data.roster.map(member => {
    const activity = deriveMemberActivity(data, member.name, member.phase)
    return <li key={member.name}><button className="swarm-team-workspace__row" type="button" aria-current={selection.kind === 'member' && selection.name === member.name} onClick={() => { setSelection({ kind: 'member', name: member.name }) }}><span className="swarm-team-workspace__row-main"><strong className="swarm-team-workspace__truncate" title={member.name}>{member.name}</strong><span className="swarm-team-workspace__muted">{memberActivityLabel(activity, t)}</span></span><small className="swarm-team-workspace__muted swarm-team-workspace__truncate" title={member.role}>{member.role}</small></button></li>
  })}</ul>
}

function TaskRows({ data, selection, setSelection, t }: { readonly data: SwarmHostReadProjectionV1; readonly selection: Selection; readonly setSelection: (selection: Selection) => void; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  return <ul className="swarm-team-workspace__rows">{data.tasks.length === 0 ? <li className="swarm-team-workspace__muted">{t('empty')}</li> : data.tasks.map(task => {
    const owner = task.ownerName ?? t('hostUnavailable')
    const target = task.targetMemberName ?? t('hostUnavailable')
    return <li key={task.id}><button className="swarm-team-workspace__row" type="button" aria-current={selection.kind === 'task' && selection.id === task.id} onClick={() => { setSelection({ kind: 'task', id: task.id }) }}><span className="swarm-team-workspace__row-main"><strong className="swarm-team-workspace__truncate" title={task.subject}>{task.subject}</strong><span className="swarm-team-workspace__muted">{enumLabel(task.status, t)}</span></span><small className="swarm-team-workspace__muted swarm-team-workspace__task-assignee" title={`${t('taskOwner')}: ${owner}`}>{t('taskOwner')}: {owner}</small><small className="swarm-team-workspace__muted swarm-team-workspace__task-assignee" title={`${t('taskTarget')}: ${target}`}>{t('taskTarget')}: {target}</small></button></li>
  })}</ul>
}

function Detail({ data, localeTag, number, selection, t }: { readonly data: SwarmHostReadProjectionV1; readonly localeTag: () => 'zh-CN' | 'en-US'; readonly number: Intl.NumberFormat; readonly selection: Selection; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  if (selection.kind === 'member') {
    const member = data.roster.find(candidate => candidate.name === selection.name)
    if (member === undefined) return <p className="swarm-team-workspace__muted">{t('detailEmpty')}</p>
    const activity = deriveMemberActivity(data, member.name, member.phase)
    return <><Facts rows={[[t('memberStatus'), memberActivityLabel(activity, t)], [t('memberTask'), activity.task?.subject ?? t('memberNone')], [t('memberProvider'), t('hostUnavailable')], [t('memberModel'), t('hostUnavailable')], [t('memberRole'), member.role]]} /><Diagnostics data={data} number={number} t={t} /></>
  }
  if (selection.kind === 'task') {
    const task = data.tasks.find(candidate => candidate.id === selection.id)
    if (task === undefined) return <p className="swarm-team-workspace__muted">{t('detailEmpty')}</p>
    return <><Facts rows={[[t('status'), enumLabel(task.status, t)], [t('taskOwner'), task.ownerName ?? t('hostUnavailable')], [t('taskTarget'), task.targetMemberName ?? t('hostUnavailable')], [t('taskBlocked', { count: number.format(task.blockedBy.length) }), task.blockedBy.length === 0 ? t('empty') : task.blockedBy.join(', ')]]} /><Diagnostics data={data} number={number} t={t} /></>
  }
  return <><Facts rows={[[t('status'), enumLabel(data.team.phase, t)], [t('revision'), number.format(data.team.revision)], [t('updated'), new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }).format(data.team.updatedAt)]]} /><Diagnostics data={data} number={number} t={t} /></>
}

function Facts({ rows }: { readonly rows: readonly (readonly [string, string])[] }) { return <dl className="swarm-team-workspace__facts">{rows.map(([label, value]) => <div className="swarm-team-workspace__fact" key={label}><dt>{label}</dt><dd title={value}>{value}</dd></div>)}</dl> }

function Diagnostics({ data, number, t }: { readonly data: SwarmHostReadProjectionV1; readonly number: Intl.NumberFormat; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  return <details className="swarm-team-workspace__diagnostics"><summary>{t('diagnostics')}</summary><p className="swarm-team-workspace__muted">{t('diagnosticsDescription')}</p><Facts rows={[[t('diagnosticsSession'), data.binding.rootSessionId], [t('diagnosticsRevision'), number.format(data.team.revision)], [t('diagnosticsAttempts'), number.format(data.totals.attempts)], [t('diagnosticsTrace'), t('diagnosticsTraceUnavailable')]]} /></details>
}

export type MemberActivity = {
  readonly task: SwarmHostReadProjectionV1['tasks'][number] | undefined
  readonly attempt: SwarmHostReadProjectionV1['attempts'][number] | undefined
  readonly state: 'running' | 'idle' | 'error' | 'provisioning' | 'removed' | SwarmHostReadProjectionV1['attempts'][number]['phase']
}

/**
 * Derives one member's activity from strictly owned current attempts.  The roster lifecycle is
 * authoritative: a failed, provisioning, or removed member is never presented as running.
 */
export function deriveMemberActivity(data: SwarmHostReadProjectionV1, name: string, phase: SwarmHostReadProjectionV1['roster'][number]['phase']): MemberActivity {
  const currentAttempts = data.tasks.flatMap(task => {
    if (task.currentAttemptId === undefined) return []
    const attempt = data.attempts.find(candidate => candidate.id === task.currentAttemptId && candidate.taskId === task.id && candidate.memberName === name)
    return attempt === undefined ? [] : [{ task, attempt }]
  })
  const newest = currentAttempts.toSorted((left, right) => right.attempt.updatedAt - left.attempt.updatedAt)[0]
  if (phase === 'failed') return { task: newest?.task, attempt: newest?.attempt, state: 'error' }
  if (phase === 'provisioning') return { task: newest?.task, attempt: newest?.attempt, state: 'provisioning' }
  if (phase === 'removed') return { task: newest?.task, attempt: newest?.attempt, state: 'removed' }
  // A real current running attempt outranks a later stale/rejected/cancelled observation.
  const current = currentAttempts.filter(candidate => candidate.attempt.phase === 'running').toSorted((left, right) => right.attempt.updatedAt - left.attempt.updatedAt)[0] ?? newest
  if (current?.attempt.phase === 'running') return { task: current.task, attempt: current.attempt, state: 'running' }
  if (current !== undefined) return { task: current.task, attempt: current.attempt, state: current.attempt.phase }
  return { task: undefined, attempt: undefined, state: 'idle' }
}

function memberActivityLabel(activity: MemberActivity, t: TranslateNS<typeof TEAM_DASHBOARD_NS>): string {
  if (activity.state === 'running') return t('memberRunning')
  if (activity.state === 'idle') return t('memberIdle')
  if (activity.state === 'error') return t('memberError')
  if (activity.state === 'provisioning') return t('memberProvisioning')
  if (activity.state === 'removed') return t('memberRemoved')
  return enumLabel(activity.state, t)
}

type WireEnum = SwarmHostReadProjectionV1['team']['phase'] | SwarmHostReadProjectionV1['tasks'][number]['status'] | SwarmHostReadProjectionV1['attempts'][number]['phase']
const enumKey = Object.freeze({ active: 'enum.active', archived: 'enum.archived', pending: 'enum.pending', in_progress: 'enum.in_progress', submitted: 'enum.submitted', verifying: 'enum.verifying', completed: 'enum.completed', failed: 'enum.failed', cancelled: 'enum.cancelled', running: 'enum.running', accepted: 'enum.accepted', rejected: 'enum.rejected', stale: 'enum.stale' } as const satisfies Record<WireEnum, TeamDashboardKey>)
function enumLabel(value: WireEnum, t: TranslateNS<typeof TEAM_DASHBOARD_NS>): string { return t(enumKey[value]) }
