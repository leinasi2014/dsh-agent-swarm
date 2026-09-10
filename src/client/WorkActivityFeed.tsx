import { useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkRequestController } from './work-request-controller.js'
import type { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import { WorkParticipant, workMemberLabels, type WorkDirectory } from './WorkParticipant.js'

export function WorkActivityFeed({ work, teamId, taskId, openTask, directory, t }: {
  readonly work: WorkRequestController; readonly teamId: string; readonly taskId?: string | undefined; readonly openTask?: ((id: string) => void) | undefined
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
  readonly directory?: WorkDirectory | undefined
}) {
  const state = useSyncExternalStore(work.subscribe, work.getSnapshot, work.getSnapshot)
  if (state.selection?.team !== teamId) return null
  const page = state.activity
  const visible = taskId === undefined ? state.entries : state.entries.filter(entry => entry.taskId === taskId)
  const members = workMemberLabels(state.verified ? directory : undefined, { rootSessionId: state.selection.captain, teamId })
  return <section data-work-activity aria-label={t('work.activity')} aria-busy={state.loading}>
    <style>{`
      [data-work-activity] { margin:8px 0 16px; padding:12px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; }
      [data-work-activity] h2 { font-size:14px; margin:0 0 8px; }
      [data-work-activity] article { padding:10px; margin:8px 0; border-left:3px solid var(--dsw-alias-state-business-primary); background:var(--dsw-alias-bg-layer-1); border-radius:4px; overflow-wrap:anywhere; }
      [data-work-activity] header { display:flex; flex-wrap:wrap; gap:5px 12px; font-size:12px; }
      [data-work-activity] p { white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; }
      [data-work-activity] summary, [data-work-activity] button { cursor:pointer; }
      [data-work-activity] button { padding:4px; color:var(--dsw-alias-state-business-primary); border:0; background:transparent; font:inherit; font-size:12px; }
      [data-work-activity] small { font-size:11px; color:var(--dsw-alias-label-secondary); }
    `}</style>
    <h2>{t('work.activity')}</h2>
    {page === undefined ? <p role="status">{t(state.loading ? 'loading' : 'error')}</p> : visible.length === 0 ? null : <small data-work-retained>{t('work.range', { from: page.retainedFromSequence, through: page.throughSequence, first: visible[0]!.sequence, last: visible.at(-1)!.sequence })}</small>}
    {visible.length === 0 && page !== undefined ? <p>{t('work.empty')}</p> : null}
    {visible.map(entry => {
      const request = state.referencedRequests.find(row => row.id === entry.workRequestId)
      const actor = entry.actor.kind === 'local-operator' ? t('public.operator') : <WorkParticipant sessionId={entry.actor.sessionId} members={members} main={entry.actor.kind === 'main'} t={t} />
      return <article key={`${state.selection!.key}:${entry.id}`} data-work-event={entry.id} data-work-kind={entry.kind}>
        <header><strong>{t(`work.${entry.kind}`)}{entry.decision === undefined ? '' : ` · ${t(`work.${entry.decision}`)}`}</strong><span>{actor}</span><time dateTime={new Date(entry.occurredAt).toISOString()}>{new Date(entry.occurredAt).toLocaleString()}</time></header>
        {entry.assigneeSessionId === undefined ? null : <p>{t('work.assignee')}: <WorkParticipant sessionId={entry.assigneeSessionId} members={members} t={t} /></p>}
        {entry.taskId === undefined ? null : openTask === undefined ? <p>{entry.taskId}</p> : <button type="button" data-work-task={entry.taskId} disabled={!state.verified} onClick={() => { openTask(entry.taskId!) }}>{t('work.task', { id: entry.taskId })} →</button>}
        {entry.workRequestId === undefined ? null : <details data-work-request={entry.workRequestId}><summary title={entry.workRequestId}>{t('work.request')}</summary>
          <p><code>{entry.workRequestId}</code></p>
          {request === undefined ? <p>{t('work.requestMissing')}</p> : <>
            <p>{request.description}</p>{request.acceptanceCriteria === undefined ? null : <p>{t('work.criteria')}: {request.acceptanceCriteria}</p>}
            {request.resolution === undefined ? <p>{t('work.awaiting')}</p> : request.resolution.kind === 'reject' ? <p>{t('work.reject')}: {request.resolution.publicReason}</p>
              : Object.entries(request.resolution.taskIdsByItemKey).map(([item, linkedTaskId]) => <div key={item}>{item} · {openTask === undefined ? linkedTaskId : <button type="button" data-work-task={linkedTaskId} disabled={!state.verified} onClick={() => { openTask(linkedTaskId) }}>{t('work.task', { id: linkedTaskId })} →</button>}</div>)}
          </>}
        </details>}
      </article>
    })}
    {state.error === undefined ? null : <p role="alert">{state.error}</p>}
    {page?.hasMore ? <button type="button" disabled={state.loading || !state.verified} onClick={() => { void work.more() }}>{t('work.more')}</button> : null}
    <button type="button" disabled={state.loading || !state.verified} onClick={() => { void work.refresh() }}>{t('refresh')}</button>
  </section>
}
