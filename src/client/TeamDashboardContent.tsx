import { Button, IconCloseOutline16, IconRefreshOutline16, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'
import type { TeamDashboardController, TeamDashboardState } from './team-dashboard-controller.js'
import type { TeamDashboardSurfaceCoordinator } from './team-dashboard-surface-coordinator.js'
import { TEAM_DASHBOARD_NS, type TeamDashboardKey } from './team-dashboard-locales.js'

type Selection = { readonly kind: 'team' } | { readonly kind: 'member'; readonly name: string } | { readonly kind: 'task'; readonly id: string }
type FocusIntent = { readonly kind: 'roster' | 'tasks' } | { readonly kind: 'member'; readonly name: string } | { readonly kind: 'task'; readonly id: string }

export const shellCss = `
[data-swarm-team-dashboard] .swarm-team-workspace { container-type:inline-size; display:grid; grid-template-rows:auto minmax(0,1fr) auto; height:100%; min-width:0; overflow:hidden; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__header, [data-swarm-team-dashboard] .swarm-team-workspace__footer { display:flex; justify-content:space-between; gap:12px; padding:16px 20px; border-color:var(--dsw-alias-border-l2); border-style:solid; }
[data-swarm-team-dashboard] .swarm-team-workspace__header { align-items:flex-start; border-width:0 0 1px; }
[data-swarm-team-dashboard] .swarm-team-workspace__footer { align-items:center; border-width:1px 0 0; }
[data-swarm-team-dashboard] .swarm-team-workspace__title { margin:0; font-size:18px; }
[data-swarm-team-dashboard] .swarm-team-workspace__title-row, [data-swarm-team-dashboard] .swarm-team-workspace__member-identity { display:flex; align-items:center; gap:8px; min-width:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__member-identity { flex:1 1 0; }
[data-swarm-team-dashboard] .swarm-team-workspace__member-activity { flex:0 1 auto; min-width:0; max-width:55%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__description, [data-swarm-team-dashboard] .swarm-team-workspace__muted { color:var(--dsw-alias-label-secondary); font-size:12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__description { margin:6px 0 0; }
[data-swarm-team-dashboard] .swarm-team-workspace__body { min-width:0; min-height:0; overflow:auto; padding:12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__status { display:flex; gap:8px; align-items:center; min-width:0; margin:0 0 12px; }
[data-swarm-team-dashboard] .swarm-team-workspace__error { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__columns { display:grid; grid-template-columns:minmax(0,1fr); gap:12px; min-width:0; min-height:100%; }
[data-swarm-team-dashboard] .swarm-team-workspace__column { min-width:0; min-height:0; padding:12px; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background:var(--dsw-alias-bg-base); }
[data-swarm-team-dashboard] .swarm-team-workspace__column-title { margin:0 0 10px; font-size:14px; }
[data-swarm-team-dashboard] .swarm-team-workspace__summary { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin-top:10px; }
[data-swarm-team-dashboard] .swarm-team-workspace__metric { padding:10px; border-radius:8px; background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__metric strong { display:block; font-size:16px; }
[data-swarm-team-dashboard] .swarm-team-workspace__rows, [data-swarm-team-dashboard] .swarm-team-workspace__rows > li { min-width:0; max-width:100%; }
[data-swarm-team-dashboard] .swarm-team-workspace__rows { display:grid; gap:8px; margin:0; padding:0; list-style:none; }
[data-swarm-team-dashboard] .swarm-team-workspace__row { display:block; box-sizing:border-box; width:100%; max-width:100%; min-width:0; overflow:hidden; padding:10px; color:inherit; text-align:left; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:transparent; cursor:pointer; }
[data-swarm-team-dashboard] .swarm-team-workspace__row[aria-current="true"] { border-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-1); }
[data-swarm-team-dashboard] .swarm-team-workspace__row-main, [data-swarm-team-dashboard] .swarm-team-workspace__fact { display:flex; justify-content:space-between; gap:8px; min-width:0; max-width:100%; }
[data-swarm-team-dashboard] .swarm-team-workspace__avatar { display:grid; flex:0 0 28px; inline-size:28px; block-size:28px; place-items:center; border-radius:50%; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-brand-primary); font-weight:600; }
[data-swarm-team-dashboard] .swarm-team-workspace__captain-badge { flex:0 0 auto; padding:2px 8px; border-radius:999px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-brand-primary); font-size:12px; font-weight:600; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__truncate { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__task-assignee { display:block; min-width:0; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__facts { display:grid; gap:8px; }
[data-swarm-team-dashboard] .swarm-team-workspace__facts dt { color:var(--dsw-alias-label-secondary); }
[data-swarm-team-dashboard] .swarm-team-workspace__facts dd { margin:0; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
[data-swarm-team-dashboard] .swarm-team-workspace__collapsible { margin:0; }
[data-swarm-team-dashboard] .swarm-team-workspace__collapsible > summary { cursor:pointer; font-size:14px; font-weight:600; }
[data-swarm-team-dashboard] .swarm-team-workspace__collapsible > summary + * { margin-top:10px; }
[data-swarm-team-dashboard] .swarm-team-workspace__diagnostics { margin-top:12px; padding-top:12px; border-top:1px solid var(--dsw-alias-border-l2); }
[data-swarm-team-dashboard] .swarm-team-workspace__notice { margin:0 0 10px; }
@container (min-width: 720px) { [data-swarm-team-dashboard] .swarm-team-workspace__columns { grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) minmax(0,.8fr); } }
/* Narrow viewports: the official details track can overflow the visible viewport (~813px, member buttons land at x≈912), so the Team panel escapes the track and overlays the viewport. z-index 20 mirrors the official shell overlay layer constant; wide viewports never hit this media query and keep the docked details fill. The cap covers the official details auto-close threshold (columns.ts: SIDEBAR_COLLAPSED 56 + DETAILS_MIN 300 + CENTER_MIN 640 = 996px), so no 961–995px dead band remains where the panel would be zeroed and clipped. */
@media (max-width: 995.98px) { [data-swarm-team-dashboard][data-swarm-team-panel] { position:fixed; inset:0; z-index:20; } }
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
  const [selection, setSelection] = useState<Selection>({ kind: 'team' })
  const [workspaceRef, workspaceLayout] = useTeamWorkspaceLayout()
  const handoff = (): void => {
    if (handoffBusy) return
    setHandoffBusy(true)
    void coordinator.openCaptainChat().catch(() => {}).finally(() => { setHandoffBusy(false) })
  }
  const data = state.data?.projection
  return <div className="swarm-team-workspace" data-swarm-team-layout={workspaceLayout} ref={workspaceRef}>
    <style>{shellCss}</style>
    <header className="swarm-team-workspace__header">
      <div><div className="swarm-team-workspace__title-row"><h2 className="swarm-team-workspace__title swarm-team-workspace__truncate" id={headingId} title={data?.team.name}>{data?.team.name ?? t('title')}</h2>{data === undefined ? null : <span className="swarm-team-workspace__muted">{enumLabel(data.team.phase, t)}</span>}</div><p className="swarm-team-workspace__description" id={descriptionId}>{t('description')}</p></div>
      <Button size="sm" variant="toolbar" aria-label={t('close')} title={t('close')} onClick={() => { coordinator.closeAndRestoreFocus() }}><IconCloseOutline16 /></Button>
    </header>
    <main className="swarm-team-workspace__body">
      <Status state={state} t={t} />
      {data === undefined ? <Empty state={state} controller={controller} t={t} /> : <Workspace data={data} handoffBusy={handoffBusy} localeTag={localeTag} selection={selection} setSelection={setSelection} t={t} onMainChat={handoff} />}
    </main>
    <footer className="swarm-team-workspace__footer">
      <Button size="sm" variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => { controller.refresh() }}>{t('refresh')}</Button>
      <Button size="sm" variant="primary" disabled={data === undefined || handoffBusy} onClick={handoff}>{handoffBusy ? t('openingChat') : t('openChat')}</Button>
    </footer>
  </div>
}

export const TEAM_WORKSPACE_WIDE_MIN_WIDTH = 720
export type TeamWorkspaceLayout = 'compact' | 'wide'
/** The Details container, rather than the browser viewport, chooses the layout branch. */
export function teamWorkspaceLayoutForWidth(width: number): TeamWorkspaceLayout { return width >= TEAM_WORKSPACE_WIDE_MIN_WIDTH ? 'wide' : 'compact' }

function useTeamWorkspaceLayout(): readonly [RefObject<HTMLDivElement>, TeamWorkspaceLayout] {
  const ref = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<TeamWorkspaceLayout>('compact')
  useLayoutEffect(() => {
    const workspace = ref.current
    if (workspace === null || typeof ResizeObserver === 'undefined') return undefined
    const setWidth = (width: number): void => { setLayout(teamWorkspaceLayoutForWidth(width)) }
    setWidth(workspace.getBoundingClientRect().width)
    const observer = new ResizeObserver(entries => { const entry = entries.find(candidate => candidate.target === workspace); if (entry !== undefined) setWidth(entry.contentRect.width) })
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

function Empty({ state, controller, t }: { readonly state: TeamDashboardState; readonly controller: TeamDashboardController; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) { return state.phase === 'error' ? <Button variant="outline" onClick={() => { controller.reconnect() }}>{t('retry')}</Button> : null }

function Workspace({ data, handoffBusy, localeTag, selection, setSelection, t, onMainChat }: {
  readonly data: SwarmHostReadProjectionV1
  readonly handoffBusy: boolean
  readonly localeTag: () => 'zh-CN' | 'en-US'
  readonly selection: Selection
  readonly setSelection: (selection: Selection) => void
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
  readonly onMainChat: () => void
}) {
  const number = new Intl.NumberFormat(localeTag())
  const [missingMember, setMissingMember] = useState<string>()
  const [missingTask, setMissingTask] = useState<string>()
  const rosterHeadingRef = useRef<HTMLHeadingElement>(null)
  const taskSummaryRef = useRef<HTMLElement>(null)
  const memberTriggers = useRef(new Map<string, HTMLButtonElement>())
  const taskTriggers = useRef(new Map<string, HTMLButtonElement>())
  const focusIntent = useRef<FocusIntent>()
  const registerMemberTrigger = (name: string, element: HTMLButtonElement | null): void => {
    if (element === null) memberTriggers.current.delete(name)
    else memberTriggers.current.set(name, element)
  }
  const registerTaskTrigger = (id: string, element: HTMLButtonElement | null): void => {
    if (element === null) taskTriggers.current.delete(id)
    else taskTriggers.current.set(id, element)
  }
  useLayoutEffect(() => {
    const intent = focusIntent.current
    if (intent === undefined) return
    focusIntent.current = undefined
    let target: HTMLElement | null | undefined
    switch (intent.kind) {
      case 'roster': target = rosterHeadingRef.current; break
      case 'tasks': target = taskSummaryRef.current; break
      case 'member': target = memberTriggers.current.get(intent.name) ?? rosterHeadingRef.current; break
      case 'task': target = taskTriggers.current.get(intent.id) ?? taskSummaryRef.current; break
    }
    target?.focus()
  }, [data.roster, data.tasks, selection])
  useLayoutEffect(() => {
    if (selection.kind !== 'member' || data.roster.some(member => member.name === selection.name)) return
    setMissingMember(selection.name)
    focusIntent.current = { kind: 'roster' }
    setSelection({ kind: 'team' })
  }, [data.roster, selection, setSelection])
  useLayoutEffect(() => {
    if (selection.kind !== 'task' || data.tasks.some(task => task.id === selection.id)) return
    setMissingTask(selection.id)
    focusIntent.current = { kind: 'tasks' }
    setSelection({ kind: 'team' })
  }, [data.tasks, selection, setSelection])
  const selectMember = (name: string): void => { setMissingMember(undefined); setSelection({ kind: 'member', name }) }
  const selectTask = (id: string): void => { setMissingTask(undefined); setSelection({ kind: 'task', id }) }
  const returnToMembers = (name: string): void => { focusIntent.current = { kind: 'member', name }; setSelection({ kind: 'team' }) }
  const returnToTasks = (id: string): void => { focusIntent.current = { kind: 'task', id }; setSelection({ kind: 'team' }) }
  const selected = selection.kind === 'member' ? data.roster.find(member => member.name === selection.name) : undefined
  return <div className="swarm-team-workspace__columns" aria-label={t('tabs.label')}>
    <section className="swarm-team-workspace__column swarm-team-workspace__roster"><h3 className="swarm-team-workspace__column-title" ref={rosterHeadingRef} tabIndex={-1}>{t('members')}</h3>
      <CaptainRow busy={handoffBusy} onMainChat={onMainChat} t={t} />
      {missingMember === undefined ? null : <p className="swarm-team-workspace__muted swarm-team-workspace__notice" role="status">{t('memberNoLongerAvailable', { name: missingMember })}</p>}
      {selected === undefined ? <MemberRows data={data} onSelect={selectMember} onTrigger={registerMemberTrigger} t={t} /> : <MemberDetail data={data} member={selected} onBack={() => { returnToMembers(selected.name) }} t={t} />}
      {data.truncated.roster ? <p className="swarm-team-workspace__muted swarm-team-workspace__notice">{t('rosterTruncated', { shown: number.format(data.roster.length), total: number.format(data.totals.roster) })}</p> : null}
    </section>
    <section className="swarm-team-workspace__column">{missingTask === undefined ? null : <p className="swarm-team-workspace__muted swarm-team-workspace__notice" role="status">{t('taskNoLongerAvailable')}</p>}<details className="swarm-team-workspace__collapsible"><summary ref={taskSummaryRef}>{t('tasks')}</summary>{selection.kind === 'task' ? <TaskDetail data={data} id={selection.id} number={number} onBack={() => { returnToTasks(selection.id) }} t={t} /> : <TaskRows data={data} onSelect={selectTask} onTrigger={registerTaskTrigger} t={t} />}</details></section>
    <section className="swarm-team-workspace__column"><details className="swarm-team-workspace__collapsible"><summary>{t('tabs.overview')}</summary><div className="swarm-team-workspace__summary"><Metric label={t('members')} value={number.format(data.totals.roster)} /><Metric label={t('tasks')} value={number.format(data.totals.tasks)} /><Metric label={t('interactions')} value={number.format(data.totals.pendingInteractions)} /><Metric label={t('attempts')} value={number.format(data.totals.attempts)} /></div></details><Diagnostics data={data} number={number} t={t} /></section>
  </div>
}

function CaptainRow({ busy, onMainChat, t }: { readonly busy: boolean; readonly onMainChat: () => void; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  return <button className="swarm-team-workspace__row" type="button" disabled={busy} onClick={onMainChat} title={t('captainMainChatTitle')}><span className="swarm-team-workspace__row-main"><span className="swarm-team-workspace__member-identity"><span className="swarm-team-workspace__avatar" aria-hidden="true">C</span><strong className="swarm-team-workspace__truncate" title={t('captainCurrent')}>{t('captainCurrent')}</strong></span><span className="swarm-team-workspace__captain-badge">{t('captainRole')}</span></span></button>
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) { return <div className="swarm-team-workspace__metric"><strong>{value}</strong><span className="swarm-team-workspace__muted">{label}</span></div> }

function MemberRows({ data, onSelect, onTrigger, t }: { readonly data: SwarmHostReadProjectionV1; readonly onSelect: (name: string) => void; readonly onTrigger: (name: string, element: HTMLButtonElement | null) => void; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  return <ul className="swarm-team-workspace__rows" data-swarm-member-rows>{data.roster.length === 0 ? <li className="swarm-team-workspace__muted">{t('empty')}</li> : data.roster.map(member => {
    const activity = deriveMemberActivity(data, member.name, member.phase)
    const task = activity.task
    const attempt = activity.attempt
    const taskText = isCurrentMemberWork(activity) ? `${t('memberTask')}: ${task?.subject ?? t('hostUnavailable')} · ${t('memberAttempt')}: ${enumLabel(attempt!.phase, t)}` : activity.attempt === undefined ? t('memberNone') : t('memberRecentAttempt', { phase: enumLabel(activity.attempt.phase, t) })
    const lifecycleText = `${t('memberLifecycle')}: ${enumLabel(member.phase, t)}`
    const activityText = memberActivityLabel(activity, t)
    return <li key={member.name}><button className="swarm-team-workspace__row" data-swarm-member-name={member.name} data-swarm-member-role={member.role} data-swarm-member-lifecycle={member.phase} data-swarm-member-activity={activity.state} type="button" ref={element => { onTrigger(member.name, element) }} onClick={() => { onSelect(member.name) }}><span className="swarm-team-workspace__row-main"><span className="swarm-team-workspace__member-identity"><span className="swarm-team-workspace__avatar" aria-hidden="true">{memberRosterInitial(member.name)}</span><strong className="swarm-team-workspace__truncate" title={member.name}>{member.name}</strong></span><span className="swarm-team-workspace__muted swarm-team-workspace__member-activity" data-swarm-member-visible-activity={activityText} title={activityText}><StateDot state={memberActivityDot(activity.state)} />{activityText}</span></span><small className="swarm-team-workspace__muted swarm-team-workspace__task-assignee" data-swarm-member-visible-lifecycle={lifecycleText} title={lifecycleText}>{lifecycleText}</small><small className="swarm-team-workspace__muted swarm-team-workspace__truncate" title={member.role}>{member.role}</small><small className="swarm-team-workspace__muted swarm-team-workspace__task-assignee" title={taskText}>{taskText}</small></button></li>
  })}</ul>
}

function MemberDetail({ data, member, onBack, t }: { readonly data: SwarmHostReadProjectionV1; readonly member: SwarmHostReadProjectionV1['roster'][number]; readonly onBack: () => void; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  const activity = deriveMemberActivity(data, member.name, member.phase)
  const current = isCurrentMemberWork(activity)
  const headingRef = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => { headingRef.current?.focus() }, [])
  return <div><h4 className="swarm-team-workspace__column-title swarm-team-workspace__truncate" ref={headingRef} tabIndex={-1} title={member.name}>{t('memberDetailHeading', { name: member.name })}</h4><Button size="sm" variant="ghost" onClick={onBack}>{t('backToMembers')}</Button><Facts rows={[[t('memberName'), member.name], [t('memberRole'), member.role], [t('memberLifecycle'), enumLabel(member.phase, t)], [t('memberTask'), current ? activity.task?.subject ?? t('hostUnavailable') : t('memberNone')], [t('memberAttempt'), activity.attempt === undefined ? t('memberNone') : current ? enumLabel(activity.attempt.phase, t) : t('memberRecentAttempt', { phase: enumLabel(activity.attempt.phase, t) })]]} /></div>
}

function TaskRows({ data, onSelect, onTrigger, t }: { readonly data: SwarmHostReadProjectionV1; readonly onSelect: (id: string) => void; readonly onTrigger: (id: string, element: HTMLButtonElement | null) => void; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  return <ul className="swarm-team-workspace__rows" data-swarm-task-rows>{data.tasks.length === 0 ? <li className="swarm-team-workspace__muted">{t('empty')}</li> : data.tasks.map(task => {
    const owner = task.ownerName ?? t('hostUnavailable')
    const target = task.targetMemberName ?? t('hostUnavailable')
    return <li key={task.id}><button className="swarm-team-workspace__row" type="button" ref={element => { onTrigger(task.id, element) }} onClick={() => { onSelect(task.id) }}><span className="swarm-team-workspace__row-main"><strong className="swarm-team-workspace__truncate" title={task.subject}>{task.subject}</strong><span className="swarm-team-workspace__muted">{enumLabel(task.status, t)}</span></span><small className="swarm-team-workspace__muted swarm-team-workspace__task-assignee" data-swarm-task-owner={`${t('taskOwner')}: ${owner}`} title={`${t('taskOwner')}: ${owner}`}>{t('taskOwner')}: {owner}</small><small className="swarm-team-workspace__muted swarm-team-workspace__task-assignee" data-swarm-task-target={`${t('taskTarget')}: ${target}`} title={`${t('taskTarget')}: ${target}`}>{t('taskTarget')}: {target}</small></button></li>
  })}</ul>
}

function TaskDetail({ data, id, number, onBack, t }: { readonly data: SwarmHostReadProjectionV1; readonly id: string; readonly number: Intl.NumberFormat; readonly onBack: () => void; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  const task = data.tasks.find(candidate => candidate.id === id)
  if (task === undefined) return <p className="swarm-team-workspace__muted">{t('detailEmpty')}</p>
  return <TaskDetailBody data={data} number={number} onBack={onBack} t={t} task={task} />
}

function TaskDetailBody({ data, number, onBack, t, task }: { readonly data: SwarmHostReadProjectionV1; readonly number: Intl.NumberFormat; readonly onBack: () => void; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>; readonly task: SwarmHostReadProjectionV1['tasks'][number] }) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => { headingRef.current?.focus() }, [])
  return <div data-swarm-task-detail><h4 className="swarm-team-workspace__column-title swarm-team-workspace__truncate" ref={headingRef} tabIndex={-1} title={task.subject}>{t('taskDetailHeading', { subject: task.subject })}</h4><Button size="sm" variant="ghost" onClick={onBack}>{t('backToTasks')}</Button><Facts rows={[[t('status'), enumLabel(task.status, t)], [t('taskOwner'), task.ownerName ?? t('hostUnavailable')], [t('taskTarget'), task.targetMemberName ?? t('hostUnavailable')], [t('taskBlocked', { count: number.format(task.blockedBy.length) }), task.blockedBy.length === 0 ? t('empty') : task.blockedBy.join(', ')]]} /><details className="swarm-team-workspace__diagnostics"><summary>{t('taskDiagnostics')}</summary><Facts rows={[[t('taskId'), task.id], [t('taskCurrentAttempt'), task.currentAttemptId ?? t('memberNone')]]} /></details><Diagnostics data={data} number={number} t={t} /></div>
}

function Facts({ rows }: { readonly rows: readonly (readonly [string, string])[] }) { return <dl className="swarm-team-workspace__facts">{rows.map(([label, value]) => <div className="swarm-team-workspace__fact" key={label}><dt>{label}</dt><dd title={value}>{value}</dd></div>)}</dl> }

function Diagnostics({ data, number, t }: { readonly data: SwarmHostReadProjectionV1; readonly number: Intl.NumberFormat; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  return <details className="swarm-team-workspace__diagnostics"><summary>{t('diagnostics')}</summary><p className="swarm-team-workspace__muted">{t('diagnosticsDescription')}</p><Facts rows={[[t('diagnosticsSession'), data.binding.rootSessionId], [t('diagnosticsRevision'), number.format(data.team.revision)], [t('diagnosticsAttempts'), number.format(data.totals.attempts)], [t('diagnosticsTrace'), t('diagnosticsTraceUnavailable')]]} /></details>
}

/** Pure display-only initials: NFC normalization plus the first grapheme cluster, never persisted. */
export function memberRosterInitial(name: string): string {
  const normalized = name.normalize('NFC')
  const segmenter = typeof Intl.Segmenter === 'undefined' ? undefined : new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return segmenter === undefined ? (Array.from(normalized)[0] ?? '') : (segmenter.segment(normalized)[Symbol.iterator]().next().value?.segment ?? '')
}

export type MemberActivity = {
  readonly task: SwarmHostReadProjectionV1['tasks'][number] | undefined
  readonly attempt: SwarmHostReadProjectionV1['attempts'][number] | undefined
  readonly state: 'running' | 'idle' | 'error' | 'provisioning' | 'removed' | SwarmHostReadProjectionV1['attempts'][number]['phase']
}

/** Strictly derives an activity only from a task's current attempt and matching member/task identifiers. */
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
  const current = currentAttempts.filter(candidate => candidate.attempt.phase === 'running').toSorted((left, right) => right.attempt.updatedAt - left.attempt.updatedAt)[0] ?? newest
  if (current?.attempt.phase === 'running') return { task: current.task, attempt: current.attempt, state: 'running' }
  if (current !== undefined) return { task: current.task, attempt: current.attempt, state: current.attempt.phase }
  return { task: undefined, attempt: undefined, state: 'idle' }
}

function isCurrentMemberWork(activity: MemberActivity): boolean {
  return activity.task !== undefined && activity.attempt !== undefined
    && ['in_progress', 'submitted', 'verifying'].includes(activity.task.status)
    && ['running', 'submitted', 'verifying'].includes(activity.attempt.phase)
}

function memberActivityLabel(activity: MemberActivity, t: TranslateNS<typeof TEAM_DASHBOARD_NS>): string {
  if (activity.state === 'error') return t('memberError')
  if (activity.state === 'provisioning') return t('memberProvisioning')
  if (activity.state === 'removed') return t('memberRemoved')
  if (isCurrentMemberWork(activity)) return enumLabel(activity.attempt!.phase, t)
  if (activity.attempt !== undefined) return t('memberRecentAttempt', { phase: enumLabel(activity.attempt.phase, t) })
  return t('memberIdle')
}

/** Maps only the derived real activity to the official StateDot semantic: running → ongoing, failed/error → warning, everything else → neutral/available (done). */
function memberActivityDot(state: MemberActivity['state']): StateDotState {
  if (state === 'running') return 'ongoing'
  if (state === 'error') return 'warning'
  return 'done'
}

type WireEnum = SwarmHostReadProjectionV1['team']['phase'] | SwarmHostReadProjectionV1['roster'][number]['phase'] | SwarmHostReadProjectionV1['tasks'][number]['status'] | SwarmHostReadProjectionV1['attempts'][number]['phase']
const enumKey = Object.freeze({ active: 'enum.active', archived: 'enum.archived', provisioning: 'enum.provisioning', failed: 'enum.failed', removed: 'enum.removed', pending: 'enum.pending', in_progress: 'enum.in_progress', submitted: 'enum.submitted', verifying: 'enum.verifying', completed: 'enum.completed', cancelled: 'enum.cancelled', running: 'enum.running', accepted: 'enum.accepted', rejected: 'enum.rejected', stale: 'enum.stale' } as const satisfies Record<WireEnum, TeamDashboardKey>)
function enumLabel(value: WireEnum, t: TranslateNS<typeof TEAM_DASHBOARD_NS>): string { return t(enumKey[value]) }
