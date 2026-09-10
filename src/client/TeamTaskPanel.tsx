import { useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'
import type { SwarmReadCaptainMembersV1, SwarmReadTaskDetailV1 } from '../rpc/read-rpc-contract.js'
import type { TeamDashboardController, TeamDashboardState } from './team-dashboard-controller.js'
import { useTaskDetail, type TaskDetailRead } from './team-task-detail.js'
import type { TeamWorkspaceSelection } from './team-dashboard-surface-coordinator.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import { enumLabel, formatTime, taskProgressState, type TaskProgressState } from './team-dashboard-view-helpers.js'

type Task = SwarmHostReadProjectionV1['tasks'][number]
type Attempt = SwarmHostReadProjectionV1['attempts'][number]
type Translate = TranslateNS<typeof TEAM_DASHBOARD_NS>
interface Props {
  readonly controller: TeamDashboardController
  readonly state: TeamDashboardState
  readonly data: SwarmHostReadProjectionV1
  readonly selection: TeamWorkspaceSelection
  readonly memberAssets: SwarmReadCaptainMembersV1 | undefined
  readonly localeTag: () => 'zh-CN' | 'en-US'
  readonly onSelect: (id: string) => void
  readonly onBack: () => void
  readonly onChange: (patch: Partial<TeamWorkspaceSelection>) => void
  readonly t: Translate
}
const css = `
[data-swarm-task-panel] { min-width:0; }
[data-swarm-task-panel] .swarm-task-group { margin:16px 0 0; }
[data-swarm-task-panel] .swarm-task-group-heading { display:flex; justify-content:space-between; gap:8px; color:var(--dsw-alias-label-secondary); font-size:12px; font-weight:500; }
[data-swarm-task-panel] .swarm-task-row { display:block; width:100%; padding:12px; margin:8px 0; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; color:inherit; background:var(--dsw-alias-bg-layer-1); text-align:left; cursor:pointer; }
[data-swarm-task-panel] .swarm-task-row:hover { background:var(--dsw-alias-bg-base); }
[data-swarm-task-panel] .swarm-task-title { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; }
[data-swarm-task-panel] .swarm-task-title strong { min-width:0; overflow-wrap:anywhere; font-size:14px; line-height:1.5; font-weight:600; }
[data-swarm-task-panel] .swarm-task-status { flex:none; font-size:12px; color:var(--dsw-alias-label-secondary); }
[data-swarm-task-panel] [data-swarm-task-progress="review"] .swarm-task-status, [data-swarm-task-panel] [data-swarm-task-progress="failed"] .swarm-task-status { color:var(--dsw-alias-state-warn-primary); }
[data-swarm-task-panel] .swarm-task-owner, [data-swarm-task-panel] .swarm-task-time { display:block; margin-top:6px; font-size:12px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
[data-swarm-task-panel] .swarm-task-now { display:block; padding-top:8px; margin-top:8px; border-top:1px solid var(--dsw-alias-border-l2); font-size:13px; overflow-wrap:anywhere; }
[data-swarm-task-panel] .swarm-task-step { padding:12px; margin:14px 0; border-radius:8px; background:var(--dsw-alias-bg-layer-1); font-size:13px; }
[data-swarm-task-panel] .swarm-task-step small { display:block; margin-bottom:5px; color:var(--dsw-alias-label-secondary); }
[data-swarm-task-panel] .swarm-task-heading { margin:12px 0 8px; font-size:17px; line-height:1.45; overflow-wrap:anywhere; }
[data-swarm-task-panel] .swarm-task-tabs { display:flex; gap:20px; margin:16px 0; border-bottom:1px solid var(--dsw-alias-border-l2); }
[data-swarm-task-panel] .swarm-task-tabs button { padding:0 0 9px; border:0; border-bottom:2px solid transparent; background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:12px; cursor:pointer; }
[data-swarm-task-panel] .swarm-task-tabs button[aria-selected=true] { color:var(--dsw-alias-label-primary); border-bottom-color:var(--dsw-alias-state-business-primary); }
[data-swarm-task-panel] .swarm-task-facts { display:grid; grid-template-columns:minmax(65px,auto) minmax(0,1fr); gap:8px 12px; margin:12px 0; font-size:13px; }
[data-swarm-task-panel] .swarm-task-facts dt { color:var(--dsw-alias-label-secondary); }
[data-swarm-task-panel] .swarm-task-facts dd { margin:0; overflow-wrap:anywhere; }
[data-swarm-task-panel] .swarm-task-note { color:var(--dsw-alias-label-secondary); font-size:12px; overflow-wrap:anywhere; }
[data-swarm-task-panel] .swarm-task-text { white-space:pre-wrap; overflow-wrap:anywhere; font-size:13px; line-height:1.6; }
[data-swarm-task-panel] .swarm-task-record { margin:16px 0; }
[data-swarm-task-panel] .swarm-task-record h4 { margin:0 0 7px; font-size:13px; font-weight:500; }
[data-swarm-task-panel] .swarm-task-attempt { padding:10px 0 10px 12px; border-left:2px solid var(--dsw-alias-border-l2); margin:12px 0; }
[data-swarm-task-panel] .swarm-task-attempt[data-swarm-current-attempt=true] { border-left-color:var(--dsw-alias-state-business-primary); }
[data-swarm-task-panel] .swarm-task-attempt summary { cursor:pointer; font-size:13px; overflow-wrap:anywhere; }
[data-swarm-task-panel] .swarm-task-link { display:inline-block; padding:3px 0; border:0; background:transparent; color:var(--dsw-alias-state-business-primary); font:inherit; font-size:12px; text-align:left; cursor:pointer; overflow-wrap:anywhere; }
`

function currentAttempt(task: Task, data: SwarmHostReadProjectionV1): Attempt | undefined {
  return data.attempts.find(a => a.id === task.currentAttemptId && a.taskId === task.id
    && (task.ownerName === undefined || a.memberName === task.ownerName))
}
function currentStep(task: Task, data: SwarmHostReadProjectionV1, t: Translate): string {
  const progress = taskProgressState(task, data.tasks)
  if (task.currentAttemptId !== undefined && ['in_progress', 'submitted', 'verifying'].includes(task.status)) {
    const attempt = currentAttempt(task, data)
    if (attempt === undefined) return t('taskPanel.currentMissing')
    return `${t('progress.attempt', { count: attempt.generation })} · ${enumLabel(attempt.phase, t)}${attempt.assignmentPhase === 'reserved' ? ` · ${t('taskPanel.reserved')}` : ''}`
  }
  return t(`progress.${progress}`)
}
function TaskTime({ value, localeTag, t }: { readonly value: number; readonly localeTag: Props['localeTag']; readonly t: Translate }) {
  const formatted = formatTime(value, localeTag)
  return formatted === undefined ? <span>{t('taskPanel.unavailable')}</span> : <time dateTime={new Date(value).toISOString()}>{formatted}</time>
}

/** Read-only product projection. UI preferences never introduce task, review or event facts. */
export function TeamTaskPanel(props: Props) {
  const { data, selection, onSelect, onBack, onChange, localeTag, t } = props
  const taskId = selection.detail?.kind === 'task' ? selection.detail.id : undefined
  const read = useTaskDetail(props.controller, props.state, taskId)
  const value = read.phase === 'available' ? read.value : undefined
  const task = value?.task ?? data.tasks.find(row => row.id === taskId)
  const heading = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => { if (taskId !== undefined) heading.current?.focus() }, [taskId])
  const partial = data.truncated.tasks || data.tasks.length !== data.totals.tasks
  if (taskId !== undefined) return <section data-swarm-task-panel data-swarm-detail-view data-swarm-detail-kind="task" role="region" aria-label={task?.subject ?? taskId} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onBack() } }}>
    <style>{css}</style>
    <button type="button" className="swarm-task-link" data-swarm-detail-back onClick={onBack}>← {t('detail.back')}</button>
    {task === undefined ? <><p role="status">{t('taskPanel.taskMissing')}</p><DetailReadStatus read={read} t={t} /></> : <>
      <div className="swarm-task-owner">{task.id} · {enumLabel(task.status, t)}</div>
      <h3 className="swarm-task-heading" ref={heading} tabIndex={-1}>{task.subject}</h3>
      <div className="swarm-task-owner">{t('taskOwner')}: {task.ownerName ?? t('taskPanel.unassigned')}</div>
      <div className="swarm-task-tabs" role="tablist" aria-label={t('taskDetailHeading', { subject: task.subject })}>
        {(['overview', 'trace'] as const).map((view, index) => <button key={view} type="button" role="tab" id={`swarm-task-${view}`} aria-controls="swarm-task-detail-content"
          tabIndex={selection.taskView === view ? 0 : -1} aria-selected={selection.taskView === view} data-swarm-task-view={view}
          onClick={() => { onChange({ taskView: view }) }} onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault(); const next = event.key === 'Home' ? 'overview' : event.key === 'End' ? 'trace' : index === 0 ? 'trace' : 'overview'
            onChange({ taskView: next }); queueMicrotask(() => { document.querySelector<HTMLButtonElement>(`[data-swarm-task-view="${next}"]`)?.focus() })
          }}>{t(`taskPanel.${view}`)}</button>)}
      </div>
      <div id="swarm-task-detail-content" role="tabpanel" aria-labelledby={`swarm-task-${selection.taskView}`} data-swarm-task-detail>
        <DetailReadStatus read={read} t={t} />
        {selection.taskView === 'trace' ? value === undefined ? null : <TaskTrace {...props} task={task} value={value} /> : <>
          <div className="swarm-task-step"><small>{t('taskPanel.now')}</small>{currentStep(task, value === undefined ? data : { ...data, attempts: value.attempts.entries }, t)}</div>
          <dl className="swarm-task-facts">
            <dt>{t('taskTarget')}</dt><dd>{task.targetMemberName ?? t('memberNone')}</dd>
            <dt>{t('taskPanel.created')}</dt><dd><TaskTime value={task.createdAt} localeTag={localeTag} t={t} /></dd>
            <dt>{t('taskPanel.lastUpdated')}</dt><dd><TaskTime value={task.updatedAt} localeTag={localeTag} t={t} /></dd>
            <dt>{t('taskCurrentAttempt')}</dt><dd>{task.currentAttemptId ?? t('taskPanel.noAttempt')}</dd>
            <dt>{t('taskBlocked', { count: task.blockedBy.length })}</dt><dd>{task.blockedBy.length === 0 ? t('empty') : task.blockedBy.map(id => {
              const dependency = data.tasks.find(row => row.id === id)
              return dependency === undefined ? <div key={id}>{id} · {t('taskPanel.dependencyUnknown')}</div>
                : <div key={id}><button type="button" className="swarm-task-link" onClick={() => { onSelect(id) }}>{dependency.subject} · {enumLabel(dependency.status, t)} →</button></div>
            })}</dd>
          </dl>
          {value === undefined ? null : <>
            <section className="swarm-task-record"><h4>{t('taskPanel.description')}</h4><div className="swarm-task-text" data-swarm-task-description><RecordedText value={value.task.description} t={t} /></div></section>
            <section className="swarm-task-record"><h4>{t('taskPanel.criteria')}</h4><div data-swarm-task-criteria><RecordedList values={value.task.acceptanceCriteria} t={t} /></div></section>
            <section className="swarm-task-record"><h4>{t('taskPanel.output')}</h4><div className="swarm-task-text" data-swarm-task-output><RecordedText value={value.task.output} t={t} /></div></section>
          </>}
        </>}
      </div>
    </>}
  </section>
  const groups: readonly { id: string; label: string; states: readonly TaskProgressState[]; folded?: boolean }[] = [
    { id: 'attention', label: t('taskPanel.attention'), states: ['review', 'failed'] },
    { id: 'running', label: t('progress.running'), states: ['running'] },
    { id: 'waiting', label: t('taskPanel.waiting'), states: ['blocked', 'unknown', 'ready'] },
    { id: 'completed', label: t('progress.completed'), states: ['completed'], folded: true },
    { id: 'cancelled', label: t('progress.cancelled'), states: ['cancelled'] },
  ]
  return <section data-swarm-task-panel data-swarm-task-rows aria-label={t('tasks')}>
    <style>{css}</style>
    {partial ? <p className="swarm-task-note" data-swarm-tasks-partial>{t('progress.partial', { shown: data.tasks.length, total: data.totals.tasks })}</p> : null}
    {data.tasks.length === 0 ? <p data-swarm-task-empty>{partial ? t('taskPanel.taskMissing') : t('taskPanel.noTasks')}</p> : null}
    {groups.map(group => {
      const rows = data.tasks.filter(row => group.states.includes(taskProgressState(row, data.tasks)))
      if (rows.length === 0) return null
      const title = <span className="swarm-task-group-heading"><span>{group.label}</span><span>{rows.length}</span></span>
      const content = rows.map(row => <button key={row.id} type="button" className="swarm-task-row" data-swarm-task-id={row.id} data-swarm-task-status={row.status}
        data-swarm-task-progress={taskProgressState(row, data.tasks)} onClick={() => { onSelect(row.id) }}>
        <span className="swarm-task-title"><strong>{row.subject}</strong><span className="swarm-task-status" data-swarm-task-state>{t(`progress.${taskProgressState(row, data.tasks)}`)}</span></span>
        <span className="swarm-task-owner" data-swarm-task-owner={`${t('taskOwner')}: ${row.ownerName ?? t('taskPanel.unassigned')}`} title={`${t('taskOwner')}: ${row.ownerName ?? t('taskPanel.unassigned')}`}>{row.ownerName ?? t('taskPanel.unassigned')}{row.ownerName === undefined && row.targetMemberName !== undefined ? ` · ${t('taskTarget')}: ${row.targetMemberName}` : ''}</span>
        <span className="swarm-task-now">{currentStep(row, data, t)}</span>
        <span className="swarm-task-time">{t('taskPanel.updated', { time: formatTime(row.updatedAt, localeTag) ?? t('taskPanel.unavailable') })}</span>
      </button>)
      return group.folded ? <details key={group.id} className="swarm-task-group" data-swarm-task-group={group.id} open={selection.historyOpen}
        onToggle={event => { onChange({ historyOpen: event.currentTarget.open }) }}><summary>{title}</summary>{content}</details>
        : <section key={group.id} className="swarm-task-group" data-swarm-task-group={group.id}>{title}{content}</section>
    })}
  </section>
}

function TaskTrace({ task, value, data, selection, onChange, localeTag, t }: Props & { readonly task: Task; readonly value: SwarmReadTaskDetailV1 }) {
  const attempts = value.attempts.entries
  const current = currentAttempt(task, { ...data, attempts })
  return <section data-swarm-task-trace>
    <p className="swarm-task-note">{t('taskPanel.traceSource')}</p>
    <p className="swarm-task-note" data-swarm-retained-scope>{t('taskPanel.retained', { returned: value.attempts.returnedCount, retained: value.attempts.retainedCount, limit: value.attempts.limit })}</p>
    <p className="swarm-task-note">{t('taskPanel.unsavedHistory')}</p>
    {value.attempts.truncated ? <p className="swarm-task-note" role="status" data-swarm-attempts-partial>{t('taskPanel.retainedPartial')}</p> : null}
    {task.currentAttemptId !== undefined && current === undefined ? <p role="status">{t('taskPanel.currentMissing')}</p> : null}
    {attempts.length === 0 ? <p>{t('taskPanel.retainedEmpty')}</p> : attempts.map(attempt => {
      const isCurrent = current?.id === attempt.id
      return <details key={attempt.id} className="swarm-task-attempt" data-swarm-task-attempt={attempt.id} data-swarm-current-attempt={String(isCurrent)}
        open={selection.rounds[attempt.id] ?? isCurrent} onToggle={event => {
          onChange({ rounds: { ...selection.rounds, [attempt.id]: event.currentTarget.open } })
        }}>
        <summary>{t('progress.attempt', { count: attempt.generation })} · {enumLabel(attempt.phase, t)}{isCurrent ? ` · ${t('taskPanel.current')}` : ''}</summary>
        <dl className="swarm-task-facts">
          <dt>{t('taskOwner')}</dt><dd>{attempt.memberName ?? t('taskPanel.unavailable')}</dd>
          <dt>{t('taskPanel.assignment')}</dt><dd>{t(`taskPanel.${attempt.assignmentPhase}`)}</dd>
          <dt>{t('taskPanel.created')}</dt><dd><TaskTime value={attempt.createdAt} localeTag={localeTag} t={t} /></dd>
          <dt>{t('taskPanel.lastUpdated')}</dt><dd><TaskTime value={attempt.updatedAt} localeTag={localeTag} t={t} /></dd>
          <dt>{t('taskPanel.deliveryCheckpoint')}</dt><dd data-swarm-delivery-checkpoint>{attempt.assignmentDeliveredAt === undefined ? t('taskPanel.notRecorded') : <TaskTime value={attempt.assignmentDeliveredAt} localeTag={localeTag} t={t} />}</dd>
          <dt>{t('taskPanel.replaces')}</dt><dd><RecordedText value={attempt.replacesAttemptId} t={t} /></dd>
        </dl>
        <section className="swarm-task-record"><h4>{t('taskPanel.output')}</h4><div className="swarm-task-text"><RecordedText value={attempt.output} t={t} /></div></section>
        <section className="swarm-task-record"><h4>{t('taskPanel.diagnostic')}</h4><div className="swarm-task-text"><RecordedText value={attempt.diagnostic} t={t} /></div></section>
        <section className="swarm-task-record"><h4>{t('taskPanel.evidence')}</h4><RecordedList values={attempt.evidence} t={t} /><p className="swarm-task-note">{t('taskPanel.evidenceHint')}</p></section>
      </details>
    })}
  </section>
}

function DetailReadStatus({ read, t }: { readonly read: TaskDetailRead; readonly t: Translate }) {
  if (read.phase === 'available') return null
  const key = read.phase === 'loading' ? 'taskPanel.detailLoading' : read.phase === 'waiting' ? 'taskPanel.detailWaiting'
    : read.code === 'TEAM_TASK_NOT_FOUND' ? 'taskPanel.detailNotFound' : read.code === 'SWARM_RPC_PROJECTION_LIMIT' ? 'taskPanel.detailLimit' : 'taskPanel.detailFailed'
  return <p className="swarm-task-note" role={read.phase === 'failed' ? 'alert' : 'status'} data-swarm-task-detail-state>{t(key)}{read.phase === 'failed' ? <> <code>{read.code}</code></> : null}</p>
}

function RecordedText({ value, t }: { readonly value: string | undefined; readonly t: Translate }) {
  return <>{value === undefined ? t('taskPanel.notRecorded') : value === '' ? t('taskPanel.emptyText') : value}</>
}

function RecordedList({ values, t }: { readonly values: readonly string[]; readonly t: Translate }) {
  return values.length === 0 ? <span>{t('taskPanel.notRecorded')}</span> : <ul>{values.map((value, index) => <li className="swarm-task-text" key={index}><RecordedText value={value} t={t} /></li>)}</ul>
}
