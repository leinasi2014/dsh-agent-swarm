import { useId, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'
import type { GoalController, GoalState } from './goal-controller.js'
import { goalDefinitionFromDraft } from './goal-draft-store.js'
import { goalDefinitionSchema, GOAL_INTERVAL_MIN_MS, GOAL_INTERVAL_MAX_MS } from '../shared/goal-lifecycle.js'

type Translation = TranslateNS<typeof TEAM_DASHBOARD_NS>
interface Props { readonly goal: GoalController; readonly teamId: string; readonly t: Translation }

/** One authoritative goal snapshot, with local drafts kept distinct from committed coordination. */
export function TeamGoalHeader({ goal, teamId, t }: Props) {
  const state = useSyncExternalStore(goal.subscribe, goal.getSnapshot, goal.getSnapshot)
  const id = useId(), toggle = useRef<HTMLButtonElement>(null)
  const sameTeam = state.selection?.team === teamId, snapshot = sameTeam ? state.response?.snapshot : undefined
  const lifecycle = snapshot?.lifecycle
  const available = sameTeam && state.verified && snapshot?.eligibility.state === 'available'
  const canOperate = available && !state.pending && !state.sending && ['ready', 'saving'].includes(state.draftStatus)
  const action = lifecycle?.phase === 'paused' ? 'resume' : lifecycle?.phase === 'draft' ? 'start' : lifecycle?.phase === 'running' || lifecycle?.phase === 'waiting' ? 'pause' : undefined
  const close = (): void => { goal.closeEditor(); toggle.current?.focus() }
  return <section data-swarm-goal>
    <style>{`
      [data-swarm-goal] { min-width:0; font-size:12px; }
      .swarm-public__header:has([data-swarm-goal]) { max-height:55%; overflow-y:auto; align-items:flex-start; overscroll-behavior:contain; }
      .swarm-public__header [data-swarm-goal] p { display:block; overflow:visible; -webkit-line-clamp:unset; }
      [data-swarm-goal] button { font:inherit; color:inherit; cursor:pointer; padding:5px 8px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:var(--dsw-alias-bg-layer-1); }
      [data-swarm-goal] button:disabled { opacity:.5; cursor:default; }
      [data-swarm-goal] [data-goal-toggle] { display:block; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:left; }
      [data-swarm-goal] [data-goal-details], [data-swarm-goal] form { display:grid; gap:8px; padding-top:10px; }
      [data-swarm-goal] label { display:grid; gap:4px; }
      [data-swarm-goal] textarea, [data-swarm-goal] input, [data-swarm-goal] select { box-sizing:border-box; width:100%; min-width:0; font:inherit; padding:6px; color:inherit; background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l2); border-radius:5px; }
      [data-swarm-goal] textarea { resize:vertical; }
      [data-swarm-goal] p, [data-swarm-goal] dd { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; }
      [data-swarm-goal] dl { display:grid; gap:4px; margin:0; } [data-swarm-goal] dt { font-weight:600; }
      [data-swarm-goal] small { color:var(--dsw-alias-label-secondary); }
    `}</style>
    <button ref={toggle} type="button" data-goal-toggle aria-expanded={sameTeam && state.expanded} aria-controls={id}
      title={t(state.expanded ? 'goal.collapse' : 'goal.expand')} disabled={!sameTeam}
      onClick={() => { goal.setExpanded(!state.expanded) }}>{snapshot?.text || t(snapshot ? 'public.goalEmpty' : 'loading')}{lifecycle ? ` · ${t(`goal.${lifecycle.phase}`)}` : ''}</button>
    {sameTeam && state.expanded ? <div id={id} data-goal-details>
      {!state.verified ? <p role="status">{t('reconnecting')}</p> : null}
      {snapshot ? <>
        <p data-goal-text>{snapshot.text || t('public.goalEmpty')}</p>
        {lifecycle ? <dl>
          <dt>{t('goal.criteria')}</dt><dd>{lifecycle.acceptanceCriteria || '—'}</dd>
          <dt>{t('goal.constraints')}</dt><dd>{lifecycle.constraints || '—'}</dd>
          <dt>{t('goal.mode')}</dt><dd>{t(`goal.${lifecycle.mode}`)}{lifecycle.mode === 'maintenance' ? ` · ${(lifecycle.intervalMs ?? 0) / 1000}s` : ''}</dd>
          {lifecycle.nextAction ? <><dt>{t('goal.nextAction')}</dt><dd>{lifecycle.nextAction}</dd></> : null}
          {lifecycle.nextDueAt !== undefined ? <><dt>{t('goal.nextDue')}</dt><dd><time dateTime={new Date(lifecycle.nextDueAt).toISOString()}>{new Date(lifecycle.nextDueAt).toLocaleString()}</time></dd></> : null}
          {lifecycle.lastCoordination ? <><dt>{t('goal.coordinated')}</dt><dd data-goal-coordinated>{lifecycle.lastCoordination.summary}</dd></> : null}
          {lifecycle.completion ? <><dt>{t('goal.completion')}</dt><dd data-goal-completion>{lifecycle.completion.summary}</dd></> : null}
        </dl> : null}
        {lifecycle?.currentTrigger ? <p role="status">{t('goal.coordinationPending')}</p> : null}
        <p data-goal-budget>{t('goal.used')}: {snapshot.budget.usedTokens} · {t('goal.remaining')}: {snapshot.budget.tokenLimit === undefined ? t('goal.unlimited') : Math.max(0, snapshot.budget.tokenLimit - snapshot.budget.usedTokens)}</p>
        <p data-goal-cleanup>{t('goal.cleanup', { tasks: snapshot.remainingActiveTasks, attempts: snapshot.remainingActiveAttempts })}</p>
        {snapshot.waitingReason ? <p role="status">{t(`goal.wait.${snapshot.waitingReason}`)}</p> : null}
        {!available ? <p role="status">{t('goal.unavailable')}</p> : null}
        <div>{action ? <button type="button" data-goal-primary disabled={!canOperate || (action !== 'pause' && snapshot.waitingReason === 'unsupported')}
          onClick={() => { void goal.control(action) }}>{t(`goal.${action}`)}</button> : null} <button type="button" data-goal-edit disabled={!available || !['ready', 'saving'].includes(state.draftStatus)} onClick={() => { goal.beginEdit() }}>{t('goal.edit')}</button></div>
      </> : <p role="status">{t('loading')}</p>}
      {state.pending ? <p role="status" data-goal-pending>{t('goal.unknown')} <button type="button" disabled={!state.verified || state.sending} onClick={() => { void goal.recover() }}>{t('goal.recover')}</button></p> : null}
      {state.outcome?.state === 'committed' ? <p role="status" data-goal-saved>{t('goal.saved')}</p> : state.outcome?.state === 'expired' ? <p role="alert" data-goal-expired>{t('goal.expired')}</p> : null}
      {state.error ? <p role="alert">{state.error}</p> : null}
      {state.draftStatus !== 'ready' ? <p data-goal-draft-state role={['conflict', 'unavailable'].includes(state.draftStatus) ? 'alert' : 'status'}>{t(state.draftStatus === 'loading' ? 'public.draftLoading' : state.draftStatus === 'saving' ? 'public.draftSaving' : state.draftStatus === 'conflict' ? 'public.draftConflict' : 'public.draftUnavailable')}
        {state.draftStatus === 'unavailable' ? <button type="button" onClick={() => { void goal.retryStorage() }}>{t('public.retryDraft')}</button> : state.draftStatus === 'conflict' ? <button type="button" onClick={() => { void goal.useStoredDraft() }}>{t('public.useStoredDraft')}</button> : null}</p> : null}
      {state.editing ? <GoalEditor goal={goal} state={state} t={t} close={close} /> : null}
    </div> : null}
  </section>
}

function GoalEditor({ goal, state, t, close }: { goal: GoalController; state: GoalState; t: Translation; close: () => void }) {
  const text = useRef<HTMLTextAreaElement>(null), draft = state.draft, snapshot = state.response?.snapshot
  useLayoutEffect(() => { text.current?.focus() }, [state.selection?.key])
  const budget = draft.tokenLimit.trim(), validBudget = budget === '' || (Number.isSafeInteger(Number(budget)) && Number(budget) > 0)
  const valid = validBudget && goalDefinitionSchema.safeParse(goalDefinitionFromDraft(draft)).success
  const stale = draft.baseLifecycleRevision !== (snapshot?.lifecycle?.revision ?? 0)
  const canSave = valid && !stale && state.verified && snapshot?.eligibility.state === 'available' && !state.pending && !state.sending && ['ready', 'saving'].includes(state.draftStatus)
  const phase = snapshot?.lifecycle?.phase
  const canStart = canSave && snapshot?.waitingReason !== 'unsupported' && (draft.mode !== 'maintenance' || (budget !== '' && Number(budget) > (snapshot?.budget.usedTokens ?? 0)))
  return <form data-goal-form aria-label={t('goal.edit')} onSubmit={event => { event.preventDefault(); if (canSave) void goal.save(false) }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}>
    {(['text', 'acceptanceCriteria', 'constraints'] as const).map(field => <label key={field}>{t(field === 'text' ? 'goal.text' : field === 'constraints' ? 'goal.constraints' : 'goal.criteria')}
      <textarea ref={field === 'text' ? text : undefined} data-goal-field={field} required={field === 'text'} rows={field === 'text' ? 3 : 2} value={draft[field]} disabled={state.draftStatus === 'loading'} onChange={event => { goal.edit(field, event.currentTarget.value) }} />
      <small>{[...draft[field].trim()].length}/4096</small></label>)}
    <label>{t('goal.mode')}<select data-goal-mode value={draft.mode} onChange={event => { goal.edit('mode', event.currentTarget.value) }}><option value="finite">{t('goal.finite')}</option><option value="maintenance">{t('goal.maintenance')}</option></select></label>
    {draft.mode === 'maintenance' ? <label>{t('goal.interval')}<input data-goal-interval type="number" min={GOAL_INTERVAL_MIN_MS / 1000} max={GOAL_INTERVAL_MAX_MS / 1000} step="any" value={draft.intervalSeconds} onChange={event => { goal.edit('intervalSeconds', event.currentTarget.value) }} /></label> : null}
    <label>{t('goal.tokenLimit')}<input data-goal-token-limit type="number" min={1} step={1} value={draft.tokenLimit} onChange={event => { goal.edit('tokenLimit', event.currentTarget.value) }} /><small>{t('goal.budgetHint')}</small></label>
    {!valid ? <p role="alert">{t('goal.invalid')}</p> : null}
    {stale ? <p role="alert">{t('goal.staleDraft')}</p> : null}
    <button type="button" disabled={!state.verified || !!state.pending || state.sending} onClick={() => { goal.beginEdit(true) }}>{t('goal.latest')}</button>
    <div><button type="submit" data-goal-save disabled={!canSave}>{t('goal.save')}</button> {phase === undefined || phase === 'draft' || phase === 'paused' || phase === 'achieved' ? <button type="button" data-goal-save-start disabled={!canStart} onClick={() => { void goal.save(true) }}>{t(phase === 'paused' ? 'goal.saveResume' : 'goal.saveStart')}</button> : null} <button type="button" onClick={close}>{t('goal.close')}</button></div>
  </form>
}
