import { useId, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkRequestController } from './work-request-controller.js'
import type { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'

export function TeamWorkRequestForm({ work, t }: { readonly work: WorkRequestController; readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS> }) {
  const state = useSyncExternalStore(work.subscribe, work.getSnapshot, work.getSnapshot)
  const button = useRef<HTMLButtonElement>(null), description = useRef<HTMLTextAreaElement>(null), id = useId()
  const wasOpen = useRef(false)
  useLayoutEffect(() => {
    if (state.formOpen) description.current?.focus()
    else if (wasOpen.current) button.current?.focus()
    wasOpen.current = state.formOpen
  }, [state.formOpen, state.selection?.key])
  const limits = state.activity?.limits, draft = state.draft
  const canSend = state.verified && state.activity?.submitEligibility.state === 'available' && limits !== undefined
    && ['ready', 'saving'].includes(state.draftStatus) && !state.pending && !state.sending && draft.description.trim().length > 0
    && draft.description.trim().length <= limits.maxDescriptionChars && draft.acceptanceCriteria.trim().length <= limits.maxAcceptanceCriteriaChars
  const close = (): void => { work.setFormOpen(false) }
  return <section data-swarm-work-proposal>
    <style>{`
      [data-swarm-work-proposal] header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
      [data-swarm-work-proposal] h3 { margin:0; font-size:14px; }
      [data-swarm-work-proposal] button { border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:6px 8px; color:inherit; background:var(--dsw-alias-bg-layer-1); cursor:pointer; }
      [data-swarm-work-proposal] button:disabled { opacity:.5; cursor:default; }
      [data-swarm-work-proposal] form { display:grid; gap:10px; padding:12px 0; }
      [data-swarm-work-proposal] label { display:grid; gap:5px; }
      [data-swarm-work-proposal] textarea { box-sizing:border-box; width:100%; resize:vertical; min-height:70px; padding:8px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; font:inherit; color:inherit; background:var(--dsw-alias-bg-base); }
      [data-swarm-work-proposal] p { margin:0; overflow-wrap:anywhere; font-size:12px; }
      [data-swarm-work-proposal] small { color:var(--dsw-alias-label-secondary); }
    `}</style>
    <header><h3>{t('tasks')}</h3><button ref={button} type="button" data-work-open aria-expanded={state.formOpen} aria-controls={id} disabled={state.selection === undefined}
      onClick={() => { if (state.formOpen) close(); else { work.setFormOpen(true) } }}>{t('work.propose')}</button></header>
    {state.formOpen ? <form id={id} data-work-form aria-label={t('work.propose')} onSubmit={event => { event.preventDefault(); if (canSend) void work.send() }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}>
      <p>{t('work.hint')}</p>
      <label>{t('work.description')}<textarea ref={description} data-work-description required rows={4} disabled={state.draftStatus === 'loading'} value={draft.description} onChange={event => { work.edit('description', event.currentTarget.value) }} />
        <small>{draft.description.trim().length}/{limits?.maxDescriptionChars ?? 8192}</small></label>
      <label>{t('work.criteria')}<textarea data-work-criteria rows={3} disabled={state.draftStatus === 'loading'} value={draft.acceptanceCriteria} onChange={event => { work.edit('acceptanceCriteria', event.currentTarget.value) }} />
        <small>{draft.acceptanceCriteria.trim().length}/{limits?.maxAcceptanceCriteriaChars ?? 4096}</small></label>
      {state.draftStatus === 'ready' ? null : <p role={['conflict', 'unavailable'].includes(state.draftStatus) ? 'alert' : 'status'}>{t(state.draftStatus === 'loading' ? 'public.draftLoading' : state.draftStatus === 'saving' ? 'public.draftSaving' : state.draftStatus === 'conflict' ? 'public.draftConflict' : 'public.draftUnavailable')}
        {state.draftStatus === 'unavailable' ? <button type="button" onClick={() => { void work.retryDraftStorage() }}>{t('public.retryDraft')}</button> : state.draftStatus === 'conflict' ? <button type="button" onClick={() => { void work.useStoredDraft() }}>{t('public.useStoredDraft')}</button> : null}</p>}
      {state.pending ? <p role="status" data-work-pending>{t('work.unknown')} <button type="button" disabled={!state.verified || state.sending} onClick={() => { void work.recover() }}>{t('work.recover')}</button></p> : null}
      {state.lastSubmitted === undefined ? null : <p role="status" data-work-submitted>{t('work.submitted')}</p>}
      {!state.verified || state.activity?.submitEligibility.state === 'unavailable' ? <p role="status">{t('work.unavailable')}</p> : null}
      {state.error === undefined ? null : <p role="alert">{state.error}</p>}
      <div><button type="submit" data-work-submit disabled={!canSend}>{t(state.sending ? 'public.sending' : 'work.submit')}</button> <button type="button" onClick={close}>{t('work.close')}</button></div>
    </form> : null}
  </section>
}
