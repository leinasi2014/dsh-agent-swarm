import { useId, useState, useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkRequestController } from './work-request-controller.js'
import type { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import { WorkParticipant, workMemberLabels, type WorkDirectory } from './WorkParticipant.js'

export function WorkActivityFeed({ work, teamId, taskId, openTask, directory, collapsed, setCollapsed, t }: {
  readonly work: WorkRequestController; readonly teamId: string; readonly taskId?: string | undefined; readonly openTask?: ((id: string) => void) | undefined
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
  readonly collapsed?: boolean | undefined; readonly setCollapsed?: ((value: boolean) => void) | undefined
  readonly directory?: WorkDirectory | undefined
}) {
  const bodyId = useId(), [localCollapsed, setLocalCollapsed] = useState(false)
  const folded = collapsed ?? localCollapsed
  const state = useSyncExternalStore(work.subscribe, work.getSnapshot, work.getSnapshot)
  if (state.selection?.team !== teamId) return null
  const page = state.activity
  const visible = taskId === undefined ? state.entries : state.entries.filter(entry => entry.taskId === taskId)
  const members = workMemberLabels(state.verified ? directory : undefined, { rootSessionId: state.selection.captain, teamId })
  return <section data-work-activity aria-label={t('work.activity')} aria-busy={state.loading}>
    <style>{`
      [data-work-activity] { margin:0 0 20px; padding:0 0 12px; border-bottom:1px solid var(--dsw-alias-border-l2); min-width:0; }
      [data-work-heading] { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }
      [data-work-heading] h2 { font-size:14px; margin:0; } [data-work-heading] h2 small { margin-left:8px; font-weight:normal; }
      [data-work-activity] article { display:grid; grid-template-columns:28px 60px minmax(0,1fr) auto; gap:6px 10px; padding:10px 0; border-top:1px solid var(--dsw-alias-border-l2); overflow-wrap:anywhere; font-size:12px; }
      [data-work-activity] header { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 10px; min-width:0; }
      [data-work-activity] time { color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
      [data-work-activity] p { white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; }
      [data-work-activity] summary, [data-work-activity] button { cursor:pointer; }
      [data-work-activity] button { padding:4px; color:var(--dsw-alias-state-business-primary); border:0; background:transparent; font:inherit; font-size:12px; }
      [data-work-activity] small { font-size:11px; color:var(--dsw-alias-label-secondary); }
      [data-work-activity] [data-work-request] { grid-column:3/-1; min-width:0; }
      [data-work-activity] article>button { align-self:start; }
      [data-work-activity] [data-work-folded] { margin:0; font-size:12px; color:var(--dsw-alias-label-secondary); }
      @container(max-width:600px) { [data-work-activity] article { grid-template-columns:24px 54px minmax(0,1fr); gap:5px 7px; } [data-work-activity] article>button { grid-column:3; justify-self:start; } }
    `}</style>
    <div data-work-heading><h2>{t('work.activity')}<small>{t('work.loadedCount', { count: visible.length })}</small></h2><button type="button" data-work-collapse aria-expanded={!folded} aria-controls={bodyId} onClick={() => { (setCollapsed ?? setLocalCollapsed)(!folded) }}>{t(folded ? 'public.expand' : 'public.collapse')}</button></div>
    {folded ? <p data-work-folded>{visible.at(-1) === undefined ? t('work.empty') : `#${visible.at(-1)!.sequence} · ${t(`work.${visible.at(-1)!.kind}`)}`}</p> : null}
    <div id={bodyId} hidden={folded}>
    {page === undefined ? <p role="status">{t(state.loading ? 'loading' : 'error')}</p> : visible.length === 0 ? null : <small data-work-retained>{t('work.range', { from: page.retainedFromSequence, through: page.throughSequence, first: visible[0]!.sequence, last: visible.at(-1)!.sequence })}</small>}
    {visible.length === 0 && page !== undefined ? <p>{t('work.empty')}</p> : null}
    {visible.map(entry => {
      const request = state.referencedRequests.find(row => row.id === entry.workRequestId)
      const actor = entry.actor.kind === 'local-operator' ? t('public.operator') : <WorkParticipant sessionId={entry.actor.sessionId} members={members} main={entry.actor.kind === 'main'} t={t} />
      return <article key={`${state.selection!.key}:${entry.id}`} data-work-event={entry.id} data-work-kind={entry.kind}>
        <small>#{entry.sequence}</small><time title={new Date(entry.occurredAt).toLocaleString()} dateTime={new Date(entry.occurredAt).toISOString()}>{new Date(entry.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
        <header><strong>{t(`work.${entry.kind}`)}{entry.decision === undefined ? '' : ` · ${t(`work.${entry.decision}`)}`}</strong><span>{actor}</span>{entry.assigneeSessionId === undefined ? null : <span>{t('work.assignee')}: <WorkParticipant sessionId={entry.assigneeSessionId} members={members} t={t} /></span>}</header>
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
    </div>
  </section>
}
