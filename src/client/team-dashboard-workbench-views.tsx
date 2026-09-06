import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'
import type { SwarmReadCaptainAnnouncementsV1, SwarmReadCaptainMembersV1, SwarmReadTeamsV1 } from '../rpc/read-rpc-contract.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import { TaskDag } from './team-task-dag.js'
import { ExecutionTree, TaskProgressSummary } from './team-workbench-summary.js'
import { enumLabel, formatTime } from './team-dashboard-view-helpers.js'

export function WorkspacePrimary({ data, number, boundCaptain, memberAssets, handoffBusy, viewingCaptain, selectedTaskId, onSelectTask, onCaptainSession, onOpenMember, onOpenTask, t }: {
  readonly data: SwarmHostReadProjectionV1
  readonly number: Intl.NumberFormat
  readonly boundCaptain: SwarmReadTeamsV1['teams'][number] | undefined
  readonly memberAssets: SwarmReadCaptainMembersV1 | undefined
  readonly handoffBusy: boolean
  readonly viewingCaptain: boolean
  readonly selectedTaskId?: string | undefined
  readonly onSelectTask: (taskId: string) => void
  readonly onCaptainSession: () => void
  readonly onOpenMember: (name: string) => void
  readonly onOpenTask: (id: string) => void
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  const summaries = data.tasks.filter(task => ['in_progress', 'submitted', 'verifying'].includes(task.status)).toSorted((left, right) => right.updatedAt - left.updatedAt).slice(0, 2)
  const activities = data.attempts.toSorted((left, right) => right.updatedAt - left.updatedAt).slice(0, 3)
  return <div role="tabpanel" id="swarm-panel-workspace" aria-labelledby="swarm-tab-workspace" data-swarm-panel="workspace">
    <TaskProgressSummary tasks={data.tasks} number={number} t={t} />
    <ExecutionTree data={data} boundCaptain={boundCaptain} memberAssets={memberAssets} handoffBusy={handoffBusy} viewingCaptain={viewingCaptain} onCaptainSession={onCaptainSession} onOpenMember={onOpenMember} number={number} t={t} />
    {data.tasks.length > 0 ? <TaskDag tasks={data.tasks} selectedTaskId={selectedTaskId ?? ''} onSelectTask={onSelectTask} onOpenTaskDetail={onOpenTask} t={t} /> : null}
    <div className="swarm-team-workspace__block-head"><span>{t('workspace.execSummary')}</span><small data-swarm-summary-count>{number.format(summaries.length)}</small></div>
    {summaries.length === 0 ? <p className="swarm-team-workspace__muted" data-swarm-summary-empty>{t('empty')}</p> : <section className="swarm-team-workspace__activity" data-swarm-exec-summaries aria-label={t('workspace.execSummary')}>
      {summaries.map(task => <div key={task.id} className="swarm-team-workspace__activity-row" data-swarm-summary-task={task.id}>
        <i className="swarm-team-workspace__activity-signal" data-swarm-signal={task.status === 'in_progress' ? 'executing' : 'pending'} aria-hidden="true" />
        <span className="swarm-team-workspace__activity-copy"><span className="swarm-team-workspace__activity-title" title={task.subject}>{task.subject}</span><span className="swarm-team-workspace__activity-meta">{task.ownerName ?? t('hostUnavailable')}</span></span>
        <span className="swarm-team-workspace__activity-state">{enumLabel(task.status, t)}</span>
      </div>)}
    </section>}
    <div className="swarm-team-workspace__block-head"><span>{t('workspace.teamActivity')}</span><small data-swarm-activity-count>{number.format(activities.length)}</small></div>
    {activities.length === 0 ? <p className="swarm-team-workspace__muted" data-swarm-activity-empty>{t('empty')}</p> : <section className="swarm-team-workspace__activity" data-swarm-team-activity aria-label={t('workspace.teamActivity')}>
      {activities.map(attempt => {
        const task = data.tasks.find(candidate => candidate.id === attempt.taskId)
        const signal = attempt.phase === 'running' ? 'executing' : attempt.phase === 'submitted' || attempt.phase === 'verifying' ? 'pending' : 'settled'
        return <div key={attempt.id} className="swarm-team-workspace__activity-row" data-swarm-activity-attempt={attempt.id}>
          <i className="swarm-team-workspace__activity-signal" data-swarm-signal={signal} aria-hidden="true" />
          <span className="swarm-team-workspace__activity-copy"><span className="swarm-team-workspace__activity-title">{attempt.memberName ?? t('hostUnavailable')}</span><span className="swarm-team-workspace__activity-meta">{task?.subject ?? t('hostUnavailable')}</span></span>
          <span className="swarm-team-workspace__activity-state">{enumLabel(attempt.phase, t)}</span>
        </div>
      })}
    </section>}
  </div>
}

export function LegacyTasks({ data, number, selectedTaskId, onSelectTask, onOpenTask, t }: {
  readonly data: SwarmHostReadProjectionV1
  readonly number: Intl.NumberFormat
  readonly selectedTaskId?: string | undefined
  readonly onSelectTask: (taskId: string) => void
  readonly onOpenTask: (id: string) => void
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  return <div role="tabpanel" id="swarm-panel-tasks" aria-labelledby="swarm-tab-tasks" data-swarm-panel="tasks">
    <div className="swarm-team-workspace__block-head"><span>{t('tasks')}</span><small data-swarm-task-count>{number.format(data.tasks.length)} {t('taskCount')}</small></div>
    {data.tasks.length === 0 ? <p className="swarm-team-workspace__muted" data-swarm-task-empty>{t('empty')}</p> : <>
      <TaskDag tasks={data.tasks} selectedTaskId={selectedTaskId ?? ''} onSelectTask={onSelectTask} onOpenTaskDetail={onOpenTask} t={t} />
      <section className="swarm-team-workspace__table" data-swarm-task-rows>
        {data.tasks.map(task => <button key={task.id} className="swarm-team-workspace__table-row" type="button" aria-haspopup="dialog" data-swarm-task-id={task.id} data-swarm-task-status={task.status} onClick={() => { onOpenTask(task.id) }}>
          <span className="swarm-team-workspace__table-copy"><strong title={task.subject}>{task.subject}</strong><small>{task.id}</small></span>
          <span className="swarm-team-workspace__table-side" data-swarm-task-owner={`${t('taskOwner')}: ${task.ownerName ?? t('hostUnavailable')}`} title={`${t('taskOwner')}: ${task.ownerName ?? t('hostUnavailable')}`}>{task.ownerName ?? t('hostUnavailable')}</span>
          <span className="swarm-team-workspace__table-side" data-swarm-task-state>{enumLabel(task.status, t)}</span>
        </button>)}
      </section>
    </>}
  </div>
}

export function Notices({ entries, announcements, number, localeTag, t }: {
  readonly entries: readonly { readonly id: string; readonly text: string; readonly createdAt: number }[]
  readonly announcements: SwarmReadCaptainAnnouncementsV1 | undefined
  readonly number: Intl.NumberFormat
  readonly localeTag: () => 'zh-CN' | 'en-US'
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
}) {
  return <div role="tabpanel" id="swarm-panel-notices" aria-labelledby="swarm-tab-notices" data-swarm-panel="notices">
    <div className="swarm-team-workspace__block-head"><span>{t('announcements')}</span><small data-swarm-notice-count>{number.format(entries.length)} {t('announcementCount')}</small></div>
    {announcements === undefined ? <p className="swarm-team-workspace__muted">{t('loading')}</p>
      : announcements.state !== 'available' ? <p className="swarm-team-workspace__muted" data-swarm-announcement-reason={announcements.reason}>{t('announcementsUnavailable')}</p>
        : entries.length === 0 ? <p className="swarm-team-workspace__muted" data-swarm-announcements-empty>{t('announcementsEmpty')}</p>
          : <section className="swarm-team-workspace__table" data-swarm-announcements-state="available" data-swarm-announcements-list>
            {entries.map(entry => {
              const formatted = formatTime(entry.createdAt, localeTag)
              return <div key={entry.id} className="swarm-team-workspace__table-row" data-swarm-announcement-entry={entry.id}>
                <span className="swarm-team-workspace__table-copy"><strong title={entry.text}>{entry.text}</strong>{formatted === undefined ? null : <time dateTime={new Date(entry.createdAt).toISOString()}>{formatted}</time>}</span>
              </div>
            })}
          </section>}
  </div>
}

